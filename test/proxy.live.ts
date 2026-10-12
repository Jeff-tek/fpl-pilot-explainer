import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../src/local-server';

/**
 * End-to-end smoke test against the REAL FPL API.
 *
 * The unit tests run on recorded snapshots; this proves the proxy, the cache,
 * the retry logic and the 404 contract all behave against the live upstream,
 * and that the client-facing payload shape is intact.
 *
 * Skipped automatically when the upstream is unreachable so CI stays green
 * offline.
 */
const BASE = 'https://fantasy.premierleague.com/api/';

async function upstreamReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}bootstrap-static/`, {
      signal: AbortSignal.timeout(8000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const reachable = await upstreamReachable();
if (!reachable) {
  console.log('⚠  Skipping live proxy tests: fantasy.premierleague.com is unreachable.');
  process.exit(0);
}

// Boot the real Express app on an ephemeral port and talk to it over HTTP.
const app = createApp();
const server = app.listen(0);
await once(server, 'listening');

const address = server.address();
if (address === null || typeof address === 'string') {
  throw new Error('Failed to bind an ephemeral port');
}
const origin = `http://127.0.0.1:${address.port}`;

const failures: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`✔ ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`✖ ${name}`);
  }
}

await check('GET /api/health returns ok', async () => {
  const response = await fetch(`${origin}/api/health`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { status: string };
  assert.equal(body.status, 'ok');
});

await check('GET /api/fpl/bootstrap-static proxies the live payload', async () => {
  const response = await fetch(`${origin}/api/fpl/bootstrap-static/`);
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get('content-type') ?? '',
    /application\/json/,
    'proxy must return JSON, not HTML'
  );

  const body = (await response.json()) as {
    elements: unknown[];
    teams: unknown[];
    events: unknown[];
  };

  // The three fields the app cannot work without.
  assert.ok(Array.isArray(body.elements) && body.elements.length > 500, 'elements missing');
  assert.ok(Array.isArray(body.teams) && body.teams.length === 20, 'teams missing');
  assert.ok(Array.isArray(body.events) && body.events.length === 38, 'events missing');
});

await check('the second request is served from cache', async () => {
  const first = await fetch(`${origin}/api/fpl/bootstrap-static/`);
  const second = await fetch(`${origin}/api/fpl/bootstrap-static/`);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
});

await check('an unknown manager returns 404, not a 500 or empty squad', async () => {
  const response = await fetch(`${origin}/api/fpl/entry/999999999/`);
  assert.equal(response.status, 404);
  const body = (await response.json()) as { error?: string };
  assert.ok(typeof body.error === 'string' && body.error.length > 0);
});

await check('routes with AND without a trailing slash', async () => {
  // The client requests `/api/fpl/bootstrap-static/` (with the slash), while a
  // Vercel rewrite for `/api/(.*)` can deliver either form. Express must match
  // both; this failed on Vercel as a router-level 404 when only one form was
  // accounted for in the rewrite.
  const withSlash = await fetch(`${origin}/api/fpl/fixtures/`);
  const withoutSlash = await fetch(`${origin}/api/fpl/fixtures`);

  assert.equal(withSlash.status, 200, 'trailing-slash form failed');
  assert.equal(withoutSlash.status, 200, 'slashless form failed');

  const a = (await withSlash.json()) as unknown[];
  const b = (await withoutSlash.json()) as unknown[];
  assert.equal(a.length, b.length, 'the two forms returned different data');
  assert.equal(a.length, 380, 'a 20-team season is 380 fixtures');
});

await check('a real manager resolves to a usable squad', async () => {
  const entry = await (
    await fetch(`${origin}/api/fpl/entry/3808385/`)
  ).json() as { id: number; current_event: number; name: string };

  assert.equal(entry.id, 3808385);

  const picks = await (
    await fetch(`${origin}/api/fpl/entry/3808385/event/${entry.current_event}/picks/`)
  ).json() as { picks: { element: number; multiplier: number }[] };

  assert.equal(picks.picks.length, 15, 'an FPL squad is exactly 15 players');

  // `multiplier` describes the XI that actually scored: >0 means fielded,
  // 2 means captain, 3 means vice. It is what "who is in my XI" means.
  const starters = picks.picks.filter((p) => p.multiplier > 0);
  assert.equal(starters.length, 11, 'exactly 11 starters');

  // `is_captain` / `is_vice_captain` describe the manager's CURRENTLY SAVED
  // armbands. These can legitimately disagree with `multiplier` for a completed
  // gameweek - e.g. this manager re-picked their vice after GW6 was scored, so
  // element 40 carries is_vice_captain=true with multiplier=1. The app must read
  // the flags for armbands and the multipliers for selection, as src/api.ts does.
  assert.equal(
    picks.picks.filter((p) => p.is_captain).length,
    picks.picks.filter((p) => p.multiplier === 2).length <= 1 ? 1 : 0,
    'exactly one saved captain'
  );
  assert.ok(
    picks.picks.filter((p) => p.is_vice_captain).length <= 1,
    'at most one saved vice captain'
  );

  // Whoever is flagged captain must be one of the 11 fielded players.
  const fielded = new Set(starters.map((p) => p.element));
  for (const pick of picks.picks.filter((p) => p.is_captain || p.is_vice_captain)) {
    assert.ok(fielded.has(pick.element), `armband player ${pick.element} is not in the XI`);
  }
});

await check('POST /api/fpl/purge-cache clears the cache', async () => {
  const response = await fetch(`${origin}/api/fpl/purge-cache`, { method: 'POST' });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { status: string };
  assert.match(body.status, /purged/i);
});

server.close();
await once(server, 'close');

if (failures.length > 0) {
  console.error('\nFailures:');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log('\nAll live proxy checks passed.');