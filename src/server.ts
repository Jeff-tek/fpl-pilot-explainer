import express, { Request, Response, Express } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dns from 'dns';

// Enforce IPv4 DNS resolution to prevent cloud container networking timeouts
dns.setDefaultResultOrder('ipv4first');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;

const FPL_API_BASE = 'https://fantasy.premierleague.com/api/';

// Upstream retry policy: 2 attempts (1 initial + 1 retry) with a short backoff.
const UPSTREAM_RETRIES = 1;
const UPSTREAM_BACKOFF_MS = 400;

// In-memory TTL cache
interface CacheEntry {
  data: unknown;
  timestamp: number;
  ttl: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedOrFetch(
  key: string,
  fetcher: () => Promise<unknown>,
  ttl = CACHE_TTL
): Promise<unknown> {
  const cached = cache.get(key);
  const now = Date.now();

  if (cached && now - cached.timestamp < cached.ttl) {
    return Promise.resolve(cached.data);
  }

  return fetcher().then((data) => {
    cache.set(key, { data, timestamp: now, ttl });
    return data;
  });
}

class UpstreamError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch from the FPL upstream with a bounded retry on network errors and 5xx.
 * 4xx responses are deterministic (e.g. a bad entry id) and are never retried.
 *
 * Uses the global `fetch` from Node 18+ rather than the `node-fetch` package:
 * node-fetch v3 is pure ESM and fails to bundle inside a Vercel serverless
 * function, which surfaced as FUNCTION_INVOCATION_FAILED (500).
 */
async function fetchUpstream(url: string): Promise<unknown> {
  let lastError: Error | null = null;
  let lastStatus = 502;

  for (let attempt = 0; attempt <= UPSTREAM_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'FPL-Pilot/1.0',
          'Accept': 'application/json',
        },
      });

      if (response.ok) {
        return response.json();
      }

      lastStatus = response.status;
      lastError = new Error(`FPL API error: ${response.status} ${response.statusText}`);

      // Client errors are deterministic - propagate immediately, no point retrying.
      if (response.status < 500) {
        throw new UpstreamError(
          `FPL API error: ${response.status} ${response.statusText}`,
          response.status
        );
      }
    } catch (error) {
      if (error instanceof UpstreamError) {
        throw error;
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      lastStatus = 502;
    }

    if (attempt < UPSTREAM_RETRIES) {
      await sleep(UPSTREAM_BACKOFF_MS);
    }
  }

  // Retry only network errors and 5xx. A 404 from the upstream is a real,
  // meaningful answer ("no such entry") and must survive to the client as 404
  // rather than being masked as an upstream outage.
  throw new UpstreamError(
    lastError?.message ?? 'Failed to fetch data from FPL API',
    lastStatus === 404 ? 404 : 502
  );
}

function buildQueryString(query: Request['query']): string {
  const keys = Object.keys(query);
  if (keys.length === 0) {
    return '';
  }
  return `?${new URLSearchParams(query as Record<string, string>).toString()}`;
}

export interface CreateAppOptions {
  /**
   * Serve the built SPA from `dist/public`. Only the standalone Node server does
   * this; Vercel serves static assets itself and ships no dist/ in the bundle.
   */
  serveStatic?: boolean;
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();

  // Health probe - never proxied upstream.
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // Proxy for /api/fpl/*. The FPL API sends no Access-Control-Allow-Origin
  // header, so the browser cannot call it directly - this proxy is required.
  app.get('/api/fpl/*', async (req: Request, res: Response) => {
    const fplPath = req.params[0];
    const queryString = buildQueryString(req.query);
    const cacheKey = `fpl:${fplPath}${queryString}`;

    try {
      const data = await getCachedOrFetch(cacheKey, () =>
        fetchUpstream(`${FPL_API_BASE}${fplPath}${queryString}`)
      );

      res.json(data);
    } catch (error) {
      if (error instanceof UpstreamError) {
        console.error(`Error fetching ${fplPath}: ${error.message}`);
        res.status(error.status).json({ error: error.message, path: `/api/fpl/${fplPath}` });
        return;
      }

      console.error(`Error fetching ${fplPath}:`, error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown server error',
        path: `/api/fpl/${fplPath}`,
      });
    }
  });

  // Purge cache route
  app.post('/api/fpl/purge-cache', (_req: Request, res: Response) => {
    cache.clear();
    res.json({ status: 'Cache purged' });
  });

  if (options.serveStatic) {
    // `tsc --project tsconfig.server.json` emits dist/server.js and vite emits
    // dist/public, so with __dirname === <root>/dist the client lives in ./public.
    const publicDir = path.join(__dirname, 'public');
    app.use(express.static(publicDir));

    // SPA fallback. Never let it shadow API routes, otherwise a missing /api
    // endpoint would be answered with HTML instead of a JSON 404.
    app.get('*', (req: Request, res: Response) => {
      if (req.path.startsWith('/api')) {
        res.status(404).json({ error: 'Not found', path: req.path });
        return;
      }

      if (req.path.match(/\.\w+$/)) {
        // Static asset request (has file extension)
        res.status(404).send('Not Found');
      } else {
        // Serve index.html for SPA routing
        res.sendFile(path.join(publicDir, 'index.html'));
      }
    });
  }

  return app;
}

/** Default export is consumed by the Vercel serverless function in /api. */
const app = createApp();
export default app;
export { app };

/**
 * Only bind a port when this module is executed directly. When imported by the
 * serverless function there is no server to start.
 */
const invokedDirectly =
  typeof process.argv[1] === 'string' && path.resolve(process.argv[1]) === __filename;

if (invokedDirectly) {
  createApp({ serveStatic: true }).listen(PORT, () => {
    console.log(`FPL Pilot server running on http://localhost:${PORT}`);
    console.log(`Proxy: /api/fpl/* → ${FPL_API_BASE}`);
  });
}