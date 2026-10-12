import app from '../src/server';

/**
 * Vercel serverless function backing `/api/fpl/*`.
 *
 * The Express app created in src/server.ts is mounted as-is, so the same proxy,
 * TTL cache and retry logic run locally and in production. Vercel preserves the
 * original request URL when dispatching here, so Express routes it normally.
 *
 * The client never talks to fantasy.premierleague.com directly: that API sends
 * no `Access-Control-Allow-Origin` header, so a browser-side fetch would be
 * blocked by CORS. This function is what makes the app work in the browser.
 */
export default app;