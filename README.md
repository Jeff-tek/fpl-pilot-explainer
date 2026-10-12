# FPL Pilot

**Explainable Fantasy Premier League Assistant.**

FPL Pilot reads your real FPL squad, projects each player's points for the next
gameweek, and tells you what to do about it — then shows its working for every
recommendation it makes.

Unlike most FPL tools, it never just prints a number. Every projection comes with
an itemised breakdown whose components sum exactly to the headline figure, and you
can audit it in the app.

---

## What it does

| Feature | Description |
| --- | --- |
| **Explainable xPts** | Each player's projection is built from a positional baseline plus form, underlying metrics, fixture and availability. The modal shows every component, its signed contribution, and a strip proving they sum to the total. |
| **Optimal XI** | Enumerates every legal formation, fills each by projected points, and enforces the real FPL rule of **maximum three players per club**. |
| **Captaincy** | Ranks the XI on projection *and* risk, discounting injury doubts, with a written rationale. |
| **Transfer advisor** | Ranks in-for-out swaps by projected gain, constrained by your bank, your free transfers and the club limit. Combines them into multi-transfer plans with hit accounting and break-even maths. |
| **Chip advisor** | Gives a reasoned opinion on Wildcard, Free Hit, Bench Boost and Triple Captain, with a confidence level and timing guidance. |
| **Fixture difficulty** | Every club's next five gameweeks, ranked easiest-first, plus a view limited to the clubs you own. |
| **Player market** | Search and sort all ~667 players by projection, price or ownership. |
| **Tunable model** | Weight the five model components yourself, or force a specific formation. Both persist. |
| **Shareable card** | Export the recommended XI as a PNG or copy it as text. |

---

## Tech stack

React 18 · TypeScript (strict) · Vite 4 · Tailwind 3 · Zustand · Express 4

The FPL API sends no `Access-Control-Allow-Origin` header, so the browser cannot
call it directly. Every request goes through the app's own `/api/fpl/*` proxy,
which adds a 5-minute in-memory TTL cache and a bounded retry on 5xx.

---

## Quick start (local)

```bash
npm install
npm run dev          # Express proxy on :3001 + Vite dev server
```

Open the Vite URL, enter your FPL team ID (find it in your FPL account settings,
or at the end of your team URL), and the app loads your squad.

```bash
npm run dev:server   # proxy only
npm run dev:client   # UI only, with HMR
```

---

## Deploying to Vercel

The repository ships a ready-to-import `vercel.json` and a serverless entry point,
so there is nothing to configure beyond connecting the repo.

1. Push this repository to GitHub.
2. In Vercel, choose **Add New → Project** and import the repository.
3. Vercel detects the settings from `vercel.json`:
   - Build command: `npm run build`
   - Output directory: `dist/public`
   - Function: `api/fpl/[...path].ts` (the `/api/fpl/*` proxy)
4. Deploy.

Every redeploy on `main` is automatic. For a custom domain, add it under
**Settings → Domains**.

> **Note** — the `installCommand` in `vercel.json` is `npm ci`, which requires
> `package-lock.json` to be committed. It is, and `node_modules/` is gitignored.

---

## Testing

```bash
npm run typecheck    # tsc --noEmit, strict + noUnusedLocals
npm run test:unit    # 27 tests against recorded FPL payloads
npm run test:live    # proxy/caching/404 contract against the real API
npm run check        # typecheck + tests + production build
```

`test/fixtures/` holds real payloads captured from the live 2026/27 FPL API so the
unit tests need no network and never drift from the real payload shape. They
include regression tests for bugs that were live in earlier revisions:

- the API renames players to **`elements`** — reading `bootstrap.players` yields
  `undefined` and blanks the whole app;
- planning must target the **first unfinished gameweek**, not `events[events.length - 1]`;
- per-team fixtures arrive **unsorted**, so index 0 is an arbitrary, often already-played,
  fixture unless explicitly filtered and sorted;
- breakdowns must **sum to their total**, and lineups must respect the club limit.

`test:live` skips itself automatically when the upstream is unreachable, so it
never turns CI red offline.

---

## Project layout

```
api/fpl/[...path].ts   Vercel serverless function mounting the Express proxy
src/
  types.ts             API + domain types (verified against the live API)
  utils.ts             Parsing, formatting, fixture indexing
  engine.ts            The xPts model, lineup optimiser, transfers, chips
  store.ts             Zustand state; recomputes advice on every change
  api.ts               Client data access + error types
  server.ts            Express proxy: TTL cache, retries, SPA serving
  components/          UI
test/                  Unit tests + live proxy checks
```

---

## How the projection works

For each player, starting from a positional baseline for a fully-fit starter:

```
raw   = baseline + form + underlying + fixture
total = raw x availability
```

- **Form** — points per game, shrunk toward the baseline by games played
  (`games / (games + 3)`), so a debutant is not trusted and a 12-game regular is.
- **Underlying** — per-90 expected goal involvement plus ICT; goalkeepers are scored
  on clean sheets and saves instead, since they generate almost no xGI.
- **Fixture** — the published FDR plus a home/away adjustment.
- **Availability** — `chance_of_playing_next_round`, the status code and the news
  string, applied as a multiplier so an injured player genuinely scores near zero.

All five weights are yours to tune, and the panel normalises them for you.

---

## Disclaimer

Fan project. Not affiliated with, endorsed by, or connected to the Premier League
or Fantasy Premier League. Projections are estimates, not financial or sporting
advice.