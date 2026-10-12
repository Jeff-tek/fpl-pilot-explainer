import app from '../src/server';

/**
 * The single API entry point for the Vercel deployment.
 *
 * Vercel's own guidance is to keep one function in the root `api/` directory and
 * funnel every API path into it with a rewrite, rather than creating a separate
 * function per endpoint. `vercel.json` rewrites `/api/:path*` here, so every
 * `/api/fpl/*` request arrives with its original URL intact and the Express app
 * routes it exactly as it does when run standalone.
 *
 * The proxy is not optional: fantasy.premierleague.com sends no
 * `Access-Control-Allow-Origin` header, so the browser cannot call it directly.
 */
export default app;