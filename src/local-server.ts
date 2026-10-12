import express, { Request, Response, Express } from 'express';
import path from 'path';
import { existsSync } from 'fs';
import dns from 'dns';

// The `.js` extension is required: Node's ESM resolver does not do extensionless
// specifiers, so a bare `from './proxy'` compiles fine under tsx but throws
// ERR_MODULE_NOT_FOUND for `node dist/local-server.js`. TypeScript maps it back to
// proxy.ts under `moduleResolution: bundler`.
import { proxyFplPath, purgeCache } from './proxy.js';

// Enforce IPv4 DNS resolution to prevent cloud container networking timeouts
dns.setDefaultResultOrder('ipv4first');

/**
 * Locate the built client without `import.meta.url`.
 *
 * `import.meta` does not exist in CommonJS, and a bundler may compile this file
 * to CommonJS even though package.json says `"type": "module"`, so it cannot be
 * relied on. Instead, probe the known locations: alongside this file (the normal
 * `dist/local-server.js` case) and relative to the working directory.
 */
function resolvePublicDir(): string {
  const moduleDir: string =
    typeof __dirname !== 'undefined' ? __dirname : process.cwd();

  const candidates = [
    // Alongside the server bundle (tsconfig.server.json emits server-dist/).
    path.join(moduleDir, 'public'),
    // Sibling of the server bundle.
    path.join(moduleDir, '..', 'dist'),
    // Vite's output, relative to the working directory.
    path.join(process.cwd(), 'dist'),
    path.join(process.cwd(), 'public'),
  ];

  return candidates.find((dir) => existsSync(dir)) ?? candidates[2];
}

const PORT = process.env.PORT || 3001;

/** Serve the built SPA when running standalone. Serverless hosts do this themselves. */
export interface CreateAppOptions {
  serveStatic?: boolean;
}

/** Convert Express's parsed query object back into a query string. */
function queryToSearch(query: Request['query']): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else if (value !== undefined) {
      params.append(key, String(value));
    }
  }

  const serialised = params.toString();
  return serialised.length > 0 ? `?${serialised}` : '';
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  app.post('/api/fpl/purge-cache', (_req: Request, res: Response) => {
    purgeCache();
    res.json({ status: 'Cache purged' });
  });

  app.get('/api/fpl/*', async (req: Request, res: Response) => {
    const result = await proxyFplPath(req.params[0], queryToSearch(req.query));
    res.status(result.status).json(result.body);
  });

  if (options.serveStatic) {
    // `tsc --project tsconfig.server.json` emits server-dist/local-server.js and vite emits
    // dist/, so the client sits next to the server bundle at ../dist.
    const publicDir = resolvePublicDir();
    app.use(express.static(publicDir));

    // SPA fallback. Never let it shadow API routes, otherwise a missing /api
    // endpoint would be answered with HTML instead of a JSON 404.
    app.get('*', (req: Request, res: Response) => {
      if (req.path.startsWith('/api')) {
        res.status(404).json({ error: 'Not found', path: req.path });
        return;
      }
      if (req.path.match(/\.\w+$/)) {
        res.status(404).send('Not Found');
      } else {
        res.sendFile(path.join(publicDir, 'index.html'));
      }
    });
  }

  return app;
}

/** Default export is used by any consumer that mounts the app directly. */
const app = createApp();
export default app;
export { app };

/**
 * Start listening only when this module is the entry point.
 *
 * The check uses a `process.argv[1]` basename rather than comparing module paths,
 * because that comparison needs `import.meta.url`, which is unavailable under
 * CommonJS. The Vercel guard is belt-and-braces: a serverless runtime never
 * wants a listening socket.
 */
const isServerless = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
const entry = process.argv[1] ?? '';
const invokedDirectly = /local-server\.(ts|js|mjs|cjs)$/.test(entry);

if (invokedDirectly && !isServerless) {
  createApp({ serveStatic: true }).listen(PORT, () => {
    console.log(`FPL Pilot server running on http://localhost:${PORT}`);
    console.log('Proxy: /api/fpl/* -> https://fantasy.premierleague.com/api/');
  });
}