/**
 * Framework-agnostic core of the FPL proxy.
 *
 * Deliberately contains no Express import and no module-load side effects, so it
 * can be used from three places without dragging a framework in:
 *
 *  - `api/index.ts`  — the Vercel serverless function (Web `fetch` handler)
 *  - `src/server.ts` — the local/self-hosted Express server
 *  - `test/proxy.live.ts` — the live end-to-end checks
 *
 * Why this split exists: mounting a full Express app inside a Vercel function
 * failed repeatedly (FUNCTION_INVOCATION_FAILED), so the deployed path now uses a
 * plain Web Standard handler over exactly the same logic.
 *
 * The proxy is required, not optional: fantasy.premierleague.com sends no
 * `Access-Control-Allow-Origin` header, so the browser cannot call it directly.
 */

export const FPL_API_BASE = 'https://fantasy.premierleague.com/api/';

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
        headers: {
          'User-Agent': 'FPL-Pilot/1.0',
          Accept: 'application/json',
        },
      });

      if (response.ok) return (await response.json()) as unknown;

      lastStatus = response.status;
      lastError = new Error(`FPL API error: ${response.status} ${response.statusText}`);

      if (response.status < 500) {
        throw new UpstreamError(lastError.message, response.status);
      }
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
 *
 * `path` is everything after `/api/fpl/`, e.g. `bootstrap-static/` or
 * `entry/123/event/6/picks/`.
 */
export async function proxyFplPath(path: string, search = ''): Promise<ProxyResult> {
  // Guard against a caller smuggling a full URL through the path segment.
  const safePath = path.replace(/^\/+/, '').replace(/\.\./g, '');
  const key = `fpl:${safePath}${search}`;

  try {
    const data = await cached(key, () => fetchUpstream(`${FPL_API_BASE}${safePath}${search}`));
    return { status: 200, body: data };
  } catch (error) {
    const status = error instanceof UpstreamError ? error.status : 500;
    const message = error instanceof Error ? error.message : 'Unknown server error';
    // Never return an empty payload on failure: the client cannot distinguish
    // "the API failed" from "you own zero players" otherwise.
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