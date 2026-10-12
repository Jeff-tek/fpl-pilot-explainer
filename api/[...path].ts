import { proxyFplPath, purgeCache, searchString } from '../src/proxy';

/**
 * Vercel serverless entry point.
 *
 * Vercel's Node runtime supports two handler conventions and does not always
 * tell you which one it will use for a given project: the Web Standard
 * `fetch(request) => Response` and the Node-style `(req, res)`. Guessing wrong
 * makes the invocation fail with FUNCTION_INVOCATION_FAILED (500) *before* any
 * of the handler body runs — which is why even a branch that returns a plain
 * 404 without touching the network still returned 500.
 *
 * So this handler satisfies both: it builds a `Response`, and then either
 * returns it (Web style) or writes it onto the supplied Node response. Which
 * style is in use is detected from the second argument at runtime, so no
 * assumption about the platform is baked in.
 */

/** The subset of ServerResponse this handler uses, so no `any` is needed. */
interface NodeLikeResponse {
  status(code: number): NodeLikeResponse;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

/** Anything with a `url` string: both `Request` and `IncomingMessage` have one. */
interface RequestLike {
  url: string;
  method?: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function buildResponse(request: RequestLike): Promise<Response> {
  const url = new URL(request.url, 'http://localhost');
  const original = url.pathname + url.search;
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/^\/+/, '');
  const search = searchString(url.searchParams);

  try {
    if (path === 'health') {
      return json(200, { status: 'ok', uptime: process.uptime(), path: original });
    }

    if (path.startsWith('fpl/')) {
      const upstreamPath = path.slice('fpl/'.length);
      if (!upstreamPath) return json(400, { error: 'Missing FPL path', path: original });

      if (request.method === 'POST' && upstreamPath === 'purge-cache') {
        purgeCache();
        return json(200, { status: 'Cache purged' });
      }

      const result = await proxyFplPath(upstreamPath, search);
      return json(result.status, result.body);
    }

    return json(404, { error: 'Not found', path: original });
  } catch (error) {
    // Surfacing the message in the body is what makes a failure diagnosable
    // from the browser instead of an opaque 500.
    return json(500, {
      error: error instanceof Error ? error.message : 'Unknown server error',
      path: original,
    });
  }
}

export default async function handler(
  request: RequestLike,
  nodeResponse?: NodeLikeResponse
): Promise<Response | void> {
  const response = await buildResponse(request);

  if (nodeResponse && typeof nodeResponse.status === 'function') {
    nodeResponse.status(response.status);
    response.headers.forEach((value, key) => nodeResponse.setHeader(key, value));
    nodeResponse.end(await response.text());
    return undefined;
  }

  return response;
}