import { proxyFplPath, purgeCache, searchString } from '../src/proxy';

/**
 * Vercel serverless entry point for every `/api/*` path.
 *
 * IMPORTANT: this is a **Node-style** `(req, res)` handler, and it must be.
 *
 * The platform invokes the default export with `(req, res)` and expects the
 * response to be written onto `res`. A Web Standard handler that returns a
 * `Response` instead is accepted at build time and then never completes the
 * invocation - the request hangs until it times out and surfaces as
 * FUNCTION_INVOCATION_FAILED (500). That mismatch, not any application code,
 * was the cause of every failing deployment: a probe handler containing no
 * imports at all failed identically to the full implementation.
 *
 * Routing: this file is `api/[...path].ts`, so Vercel's filesystem router maps
 * `/api/*` here natively. `req.url` keeps the original path and query.
 *
 * The proxy is required rather than optional: fantasy.premierleague.com sends
 * no `Access-Control-Allow-Origin` header, so the browser cannot call it
 * directly.
 */

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
      const search = req.query ? buildQueryString(req.query) : searchString(url.searchParams);

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