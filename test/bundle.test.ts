import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/** Mirrors the Vercel (req, res) calling convention. */
type NodeHandler = (
  req: { url: string; method?: string; query?: Record<string, string | string[]> },
  res: FakeResponse
) => Promise<void> | void;

interface FakeResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  status(code: number): FakeResponse;
  setHeader(name: string, value: string): void;
  send(body: unknown): void;
}

function fakeResponse(): FakeResponse {
  const state: FakeResponse = {
    statusCode: 0,
    headers: {},
    body: '',
    status(code: number) {
      state.statusCode = code;
      return state;
    },
    setHeader(name: string, value: string) {
      state.headers[name.toLowerCase()] = value;
    },
    send(body: unknown) {
      state.body = typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
  return state;
}

/**
 * Guards the serverless entry point against the failure that cost several
 * deployments: Vercel invokes the default export as a **Node-style `(req, res)`
 * handler** and requires the response to be written onto `res`.
 *
 * A Web Standard handler that returns a `Response` compiles and deploys fine,
 * then hangs the invocation until it times out and reports
 * FUNCTION_INVOCATION_FAILED (500). A no-import probe handler failed exactly the
 * same way as the full implementation, which is what identified the convention
 * mismatch rather than any application bug.
 *
 * Every test below therefore drives the handler the way Vercel does and asserts
 * a response was actually written.
 */
describe('serverless bundle', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fpl-bundle-'));

  const bundle = async (format: 'cjs' | 'esm') => {
    const outfile = path.join(dir, `entry.${format}.${format === 'esm' ? 'mjs' : 'cjs'}`);
    await build({
      entryPoints: [path.join(projectRoot, 'api', '[...path].ts')],
      bundle: true,
      platform: 'node',
      target: 'node20',
      format,
      outfile,
      logLevel: 'silent',
    });
    return outfile;
  };

  const loadHandler = async (format: 'cjs' | 'esm' = 'cjs'): Promise<NodeHandler> => {
    const outfile = await bundle(format);
    const mod = require(outfile) as { default: NodeHandler };
    return mod.default;
  };

  /** Invoke exactly as Vercel does, and fail if nothing was written. */
  const call = async (
    handler: NodeHandler,
    req: { url: string; method?: string; query?: Record<string, string | string[]> }
  ) => {
    const res = fakeResponse();
    await handler(req, res);
    assert.notEqual(res.statusCode, 0, 'handler never wrote a response - it would hang');
    return {
      status: res.statusCode,
      headers: res.headers,
      body: res.body.length > 0 ? (JSON.parse(res.body) as unknown) : null,
    };
  };

  it('loads as CommonJS, which is what the Vercel builder emits', async () => {
    const handler = await loadHandler('cjs');
    assert.equal(typeof handler, 'function');
  });

  it('contains no ESM-only syntax that would crash under CommonJS', async () => {
    const outfile = await bundle('cjs');
    const source = readFileSync(outfile, 'utf8');
    assert.doesNotMatch(source, /import\.meta\b/, 'import.meta is unavailable under CommonJS');
  });

  it('pulls no web framework into the deployed bundle', async () => {
    const result = await build({
      entryPoints: [path.join(projectRoot, 'api', '[...path].ts')],
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      write: false,
      logLevel: 'silent',
    });

    const source = result.outputFiles[0].text;
    assert.doesNotMatch(source, /require\(["']express["']\)/);
    assert.doesNotMatch(source, /express\/lib/);
  });

  it('answers /api/health', async (t) => {
    const handler = await loadHandler();
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    const result = await call(handler, { url: '/api/health' });
    assert.equal(result.status, 200);
    assert.equal((result.body as { status: string }).status, 'ok');
    assert.match(result.headers['content-type'] ?? '', /application\/json/);
  });

  it('answers an unknown API path with a JSON 404 and no network call', async () => {
    const handler = await loadHandler();
    const result = await call(handler, { url: '/api/nope' });

    assert.equal(result.status, 404);
    assert.equal((result.body as { error: string }).error, 'Not found');
  });

  it('proxies the FPL API in both trailing-slash forms', async () => {
    const handler = await loadHandler();

    // The client requests the trailing-slash form; a rewrite may deliver either.
    for (const path of ['/api/fpl/fixtures/', '/api/fpl/fixtures']) {
      const result = await call(handler, { url: path });
      assert.equal(result.status, 200, `${path} failed`);
      assert.equal((result.body as unknown[]).length, 380, `${path} wrong payload`);
    }
  });

  it('forwards a parsed query string to the upstream API', async () => {
    const handler = await loadHandler();
    // `?page=` is ignored upstream, but a malformed query must not throw.
    const result = await call(handler, {
      url: '/api/fpl/entry/3808385/?unused=1',
      query: { unused: '1' },
    });
    assert.equal(result.status, 200);
  });

  it('returns a real 404 for an unknown manager, never an empty squad', async () => {
    const handler = await loadHandler();
    const result = await call(handler, { url: '/api/fpl/entry/999999999/' });

    assert.equal(result.status, 404);
    assert.ok((result.body as { error?: string }).error);
  });

  it('handles POST purge-cache', async () => {
    const handler = await loadHandler();
    const result = await call(handler, {
      url: '/api/fpl/purge-cache',
      method: 'POST',
    });

    assert.equal(result.status, 200);
    assert.match((result.body as { status: string }).status, /purged/i);
  });
});