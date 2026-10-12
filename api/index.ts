import { proxyFplPath, purgeCache, searchString } from '../src/proxy';

/**
 * Vercel serverless function backing the whole `/api/*` surface.
 *
 * This is a plain Web Standard handler rather than a mounted Express app.
 * Mounting Express inside a Vercel function failed repeatedly with
 * FUNCTION_INVOCATION_FAILED (a crash while the module was initialising), so the
 * deployed path uses this handler over the same shared logic in src/proxy.ts.
 * Express is still used for the local/self-hosted server in src/server.ts.
 *
 * `vercel.json` rewrites `/api/(.*)` here, and `req.url` arrives with the
 * original path intact, so the prefix can simply be stripped.
 */
export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // Preserve the original path/query for logging even though Express is gone.
  const original = url.pathname + url.search;
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/^\/+/, '');
  const search = searchString(url.searchParams);

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });

  try {
    if (path === 'health') {
      return json(200, { status: 'ok', uptime: process.uptime(), path: original });
    }

    if (path.startsWith('fpl/')) {
      const upstreamPath = path.slice('fpl/'.length);
      if (!upstreamPath) {
        return json(400, { error: 'Missing FPL path', path: original });
      }

      if (request.method === 'POST' && upstreamPath === 'purge-cache') {
        purgeCache();
        return json(200, { status: 'Cache purged' });
      }

      const result = await proxyFplPath(upstreamPath, search);
      return json(result.status, result.body);
    }

    return json(404, { error: 'Not found', path: original });
  } catch (error) {
    // Returning the message (rather than letting it bubble into a generic 500)
    // is what makes the failure diagnosable from the browser.
    return json(500, {
      error: error instanceof Error ? error.message : 'Unknown server error',
      path: original,
    });
  }
}