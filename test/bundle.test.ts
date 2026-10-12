import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

type FetchHandler = (request: Request) => Promise<Response> | Response;

/**
 * Guards the serverless entry point.
 *
 * Mounting an Express app inside the Vercel function failed repeatedly with
 * FUNCTION_INVOCATION_FAILED (500) — the module threw while initialising — even
 * though the identical code bundled fine locally and the static site deployed
 * correctly. The deployed path is now a plain Web Standard handler over
 * src/proxy.ts, with no Express and no module-load side effects.
 *
 * These tests bundle `api/index.ts` exactly as the Vercel Node builder does
 * (CommonJS, platform=node) and then invoke the handler for real, so a future
 * ESM-only construct or import-time crash fails here rather than in production.
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

  const loadHandler = async (format: 'cjs' | 'esm'): Promise<FetchHandler> => {
    const outfile = await bundle(format);
    const mod = require(outfile) as { default: FetchHandler };
    return mod.default;
  };

  it('loads as CommonJS, which is what the Vercel builder emits', async () => {
    const handler = await loadHandler('cjs');
    assert.equal(typeof handler, 'function', 'default export must be the handler function');
  });

  it('contains no ESM-only syntax that would crash under CommonJS', async () => {
    const outfile = await bundle('cjs');
    const source = readFileSync(outfile, 'utf8');
    assert.doesNotMatch(source, /import\.meta\b/, 'import.meta is unavailable under CommonJS');
    assert.doesNotMatch(source, /\bawait\s+import\s*\(/, 'dynamic import needs ESM semantics');
  });

  it('pulls no web framework into the deployed bundle', () => {
    // Express in the function was the source of the 500s; keep it out so the
    // regression cannot come back unnoticed.
    const outfile = path.join(dir, 'framework-check.cjs');
    return build({
      entryPoints: [path.join(projectRoot, 'api/index.ts')],
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      outfile,
      write: false,
      logLevel: 'silent',
    }).then((result) => {
      const source = result.outputFiles[0].text;
      assert.doesNotMatch(source, /require\(["']express["']\)/);
      assert.doesNotMatch(source, /express\/lib/);
    });
  });

  it('answers /api/health through the bundled handler', async (t) => {
    const handler = await loadHandler('cjs');
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    const response = await handler(new Request('https://example.test/api/health'));
    assert.equal(response.status, 200);

    const body = (await response.json()) as { status: string };
    assert.equal(body.status, 'ok');
  });

  it('returns a JSON 404 for an unknown API path', async () => {
    const handler = await loadHandler('cjs');
    const response = await handler(new Request('https://example.test/api/nope'));
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  });

  it('proxies the FPL API in both trailing-slash forms', async () => {
    const handler = await loadHandler('cjs');

    // The client requests the trailing-slash form; a rewrite may deliver either.
    for (const path of ['/api/fpl/fixtures/', '/api/fpl/fixtures']) {
      const response = await handler(new Request(`https://example.test${path}`));
      assert.equal(response.status, 200, `${path} failed`);

      const body = (await response.json()) as unknown[];
      assert.equal(body.length, 380, `${path} returned the wrong payload`);
    }
  });

  it('returns a real 404 for an unknown manager, never an empty squad', async () => {
    const handler = await loadHandler('cjs');
    const response = await handler(
      new Request('https://example.test/api/fpl/entry/999999999/')
    );

    assert.equal(response.status, 404);
    const body = (await response.json()) as { error?: string };
    assert.ok(typeof body.error === 'string' && body.error.length > 0);
  });
});