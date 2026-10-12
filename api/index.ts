/**
 * Vercel serverless entry point and the shared FPL proxy core.
 *
 * SELF-CONTAINED BY DESIGN. This module deliberately imports nothing outside its
 * own file. A relative import such as `../src/proxy` builds and passes every
 * local test, yet the deployed function fails to initialise and Vercel reports
 * FUNCTION_INVOCATION_FAILED (500) - the function's bundle does not resolve the
 * file, so the module load throws before the handler runs. Keeping the proxy
 * here removes that entire class of failure.
 *
 * IMPORTANT: the default export is a **Node-style `(req, res)` handler** and it
 * must stay that way. Vercel invokes the default export with `(req, res)` and
 * expects the response to be written onto `res`. A Web Standard handler that
 * returns a `Response` deploys cleanly and then never completes the invocation:
 * the request hangs until it times out and surfaces as
 * FUNCTION_INVOCATION_FAILED. That mismatch - not any application code - caused
 * every failing deployment; a probe handler with no imports at all failed
 * identically to the full implementation.
 *
 * Routing: this file is `api/[...path].ts`, so Vercel's filesystem router maps
 * every `/api/*` path here natively and `req.url` keeps the original path.
 *
 * The proxy is required rather than optional: fantasy.premierleague.com sends
 * no `Access-Control-Allow-Origin` header, so the browser cannot call it
 * directly.
 */

// ---------------------------------------------------------------------------
// Proxy core (also consumed by the local Express server in src/local-server.ts)
// ---------------------------------------------------------------------------

const FPL_API_BASE = 'https://fantasy.premierleague.com/api/';
const UPSTREAM_RETRIES = 1;
const UPSTREAM_BACKOFF_MS = 400;
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  data: unknown;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

export class UpstreamError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch from the FPL upstream, retrying only network errors and 5xx.
 * A 4xx is a real answer ("no such entry") and is never retried.
 */
export async function fetchUpstream(url: string): Promise<unknown> {
  let lastError: Error | null = null;
  let lastStatus = 502;

  for (let attempt = 0; attempt <= UPSTREAM_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'FPL-Pilot/1.0', Accept: 'application/json' },
      });

      if (response.ok) return (await response.json()) as unknown;

      lastStatus = response.status;
      lastError = new Error(`FPL API error: ${response.status} ${response.statusText}`);

      if (response.status < 500) throw new UpstreamError(lastError.message, response.status);
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      lastStatus = 502;
    }

    if (attempt < UPSTREAM_RETRIES) await sleep(UPSTREAM_BACKOFF_MS);
  }

  throw new UpstreamError(
    lastError?.message ?? 'Failed to fetch data from FPL API',
    lastStatus === 404 ? 404 : 502
  );
}

async function cached(key: string, loader: () => Promise<unknown>): Promise<unknown> {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.timestamp < CACHE_TTL_MS) return hit.data;

  const data = await loader();
  cache.set(key, { data, timestamp: now });
  return data;
}

export interface ProxyResult {
  status: number;
  body: unknown;
}

/**
 * Proxy one `/api/fpl/<path>` request through to the upstream FPL API.
 * `path` is everything after `/api/fpl/`, e.g. `bootstrap-static/`.
 */
export async function proxyFplPath(path: string, search = ''): Promise<ProxyResult> {
  // Guard against a caller smuggling a path traversal through the segment.
  const safePath = path.replace(/^\/+/, '').replace(/\.\./g, '');
  const key = `fpl:${safePath}${search}`;

  try {
    const data = await cached(key, () => fetchUpstream(`${FPL_API_BASE}${safePath}${search}`));
    return { status: 200, body: data };
  } catch (error) {
    const status = error instanceof UpstreamError ? error.status : 500;
    const message = error instanceof Error ? error.message : 'Unknown server error';
    // Never return an empty payload on failure: the client cannot otherwise
    // tell "the API failed" from "you own zero players".
    return { status, body: { error: message, path: `/api/fpl/${safePath}` } };
  }
}

/** Discard every cached upstream response. */
export function purgeCache(): void {
  cache.clear();
}

/** Build a query string from URLSearchParams, or '' when empty. */
export function searchString(params: URLSearchParams | string): string {
  const query = typeof params === 'string' ? params : params.toString();
  return query.length > 0 ? `?${query}` : '';
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

/** The subset of VercelResponse this handler uses, so no `any` is required. */
interface VercelLikeResponse {
  status(code: number): VercelLikeResponse;
  setHeader(name: string, value: string): void;
  send(body: unknown): void;
}

interface VercelLikeRequest {
  url?: string;
  method?: string;
  query?: Record<string, string | string[] | undefined>;
}

function buildQueryString(query: VercelLikeRequest['query']): string {
  if (!query) return '';

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else if (value !== undefined) {
      params.append(key, value);
    }
  }

  const serialised = params.toString();
  return serialised.length > 0 ? `?${serialised}` : '';
}

export default async function handler(
  req: VercelLikeRequest,
  res: VercelLikeResponse
): Promise<void> {
  const rawUrl = req.url ?? '/';

  try {
    let url: URL;
    try {
      url = new URL(rawUrl, 'http://localhost');
    } catch {
      res.status(400).send({ error: 'Malformed request URL', path: rawUrl });
      return;
    }

    const original = url.pathname + url.search;
    const path = url.pathname.replace(/^\/api\/?/, '').replace(/^\/+/, '');

    if (path === 'health') {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.status(200).send({ status: 'ok', uptime: process.uptime(), path: original });
      return;
    }

    if (path.startsWith('fpl/')) {
      const upstreamPath = path.slice('fpl/'.length);
      if (!upstreamPath) {
        res.status(400).send({ error: 'Missing FPL path', path: original });
        return;
      }

      if (req.method === 'POST' && upstreamPath === 'purge-cache') {
        purgeCache();
        res.status(200).send({ status: 'Cache purged' });
        return;
      }

      // Prefer the query Vercel parsed; fall back to parsing the raw URL.
      const search = req.query
        ? buildQueryString(req.query)
        : searchString(url.searchParams);

      const result = await proxyFplPath(upstreamPath, search);
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.status(result.status).send(result.body);
      return;
    }

    res.status(404).send({ error: 'Not found', path: original });
  } catch (error) {
    // Surfacing the message in the body is what makes a failure diagnosable
    // from the browser instead of an opaque 500.
    res.status(500).send({
      error: error instanceof Error ? error.message : 'Unknown server error',
      path: rawUrl,
    });
  }
}