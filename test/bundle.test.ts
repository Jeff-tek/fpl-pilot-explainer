import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/**
 * The Vercel Node builder compiles the serverless entry to **CommonJS**, even
 * though package.json declares `"type": "module"`. Express is itself CommonJS, so
 * an ESM bundle cannot work either: bundling it to ESM fails at runtime with
 * `Dynamic require of "path" is not supported`.
 *
 * A previous revision used `import.meta.url`, which is `undefined` under
 * CommonJS, so `fileURLToPath(undefined)` threw while the module was still being
 * initialised. Every request then failed with FUNCTION_INVOCATION_FAILED (500),
 * even though the same code ran perfectly under ESM locally.
 *
 * These tests bundle `api/index.ts` the way Vercel does — as CommonJS — and
 * assert the module loads and actually serves traffic, so no future ESM-only
 * syntax can silently break the deployment again.
 */
describe('serverless bundle', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fpl-bundle-'));

  const bundle = async (format: 'cjs' | 'esm') => {
    const outfile = path.join(dir, `entry.${format}.${format === 'esm' ? 'mjs' : 'cjs'}`);
    await build({
      entryPoints: [path.join(projectRoot, 'api/index.ts')],
      bundle: true,
      platform: 'node',
      target: 'node20',
      format,
      outfile,
      logLevel: 'silent',
    });
    return outfile;
  };

  it('loads when bundled as CommonJS, which is what Vercel does', async () => {
    const outfile = await bundle('cjs');
    const mod = require(outfile) as { default?: unknown };
    assert.equal(typeof mod.default, 'function', 'default export must be the Express app');
  });

  it('contains no ESM-only syntax that would crash under CommonJS', async () => {
    const outfile = await bundle('cjs');
    const source = readFileSync(outfile, 'utf8');
    // `import.meta` is the specific construct that broke the deployment; it
    // survives bundling as a bare member access rather than a syntax error.
    assert.doesNotMatch(source, /import\.meta\b/, 'import.meta is unavailable under CommonJS');
    assert.doesNotMatch(source, /top-level await/i);
  });

  it('serves the API through the CommonJS bundle', async (t) => {
    const outfile = await bundle('cjs');
    const mod = require(outfile) as { default: (req: unknown, res: unknown) => void };

    // Vercel invokes the default export with (req, res) on a Node server.
    const http = await import('http');
    const server = http.createServer(mod.default as never);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    t.after(() => {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${origin}/api/health`);
    assert.equal(health.status, 200, 'the CJS bundle must serve /api/health');

    // Both URL forms must work: the client requests the trailing-slash form.
    for (const path_ of ['/api/fpl/fixtures/', '/api/fpl/fixtures']) {
      const response = await fetch(`${origin}${path_}`);
      assert.equal(response.status, 200, `${path_} failed in the CJS bundle`);
      const body = (await response.json()) as unknown[];
      assert.equal(body.length, 380, `${path_} returned the wrong payload`);
    }
  });
});