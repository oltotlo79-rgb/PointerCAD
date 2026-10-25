import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { preview } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const decoded = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const encoded = gzipSync(decoded);
const hash = createHash('sha256').update(decoded).digest('hex');
const streamPath = `/occt/stream/opencascade.full-${hash}.wasm`;
const plainStreamPath = `/occt/stream/opencascade.full-${'b'.repeat(64)}.wasm`;
const missingPath = `/occt/stream/opencascade.full-${'c'.repeat(64)}.wasm`;
const servers: Server[] = [];
let fixture = '';
let originalOrigin = '';
let fixedOrigin = '';

function getRaw(origin: string, path: string, method = 'GET') {
  return new Promise<{ status: number | undefined; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = request(`${origin}${path}`, { method }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    req.setTimeout(5_000, () => { req.destroy(new Error('Preview fixture request timed out')); });
    req.end();
  });
}

beforeAll(async () => {
  const temporary = fileURLToPath(new URL('../../../scratchpad/temp/', import.meta.url));
  await mkdir(temporary, { recursive: true });
  fixture = await mkdtemp(join(temporary, 'occt-preview-headers-'));
  await mkdir(join(fixture, 'dist/occt/stream'), { recursive: true });
  await writeFile(join(fixture, `dist${streamPath}`), encoded);
  await writeFile(join(fixture, `dist${plainStreamPath}`), decoded);
  await writeFile(join(fixture, 'dist/occt/legacy.bin'), encoded);
  await writeFile(join(fixture, 'dist/ordinary.js'), 'export const plain = true;');
  await writeFile(join(fixture, 'dist/occt/manifest.json'), '{}');
  const plugin = fileURLToPath(new URL('../build/occtPreviewHeaders.ts', import.meta.url));
  for (const enabled of [false, true]) {
    const configFile = join(fixture, `preview-${String(enabled)}.mjs`);
    // Loading through Vite also exercises the real configurePreviewServer/apply wiring.
    await writeFile(configFile, `${enabled ? `import { occtPreviewHeaders } from ${JSON.stringify(plugin)};` : ''}
export default {
  appType: 'mpa',
  plugins: [{ name: 'preceding-policy', configurePreviewServer(server) {
    server.middlewares.use((_request, response, next) => {
      response.setHeader('Content-Security-Policy', "default-src 'self'"); next();
    });
  } }${enabled ? ', occtPreviewHeaders()' : ''}],
  preview: { headers: {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp'
  } }
};
`);
    const result = await preview({ configFile, root: fixture, logLevel: 'silent',
      preview: { port: 0, host: '127.0.0.1', open: false } });
    const server = result.httpServer;
    if (!('closeAllConnections' in server)) {
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => { if (error) reject(error); else resolve(); });
      });
      throw new Error('Expected HTTP/1 preview server with closeAllConnections');
    }
    servers.push(server);
    const address = result.httpServer.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP preview address');
    const origin = `http://127.0.0.1:${address.port}`;
    if (enabled) fixedOrigin = origin;
    else originalOrigin = origin;
  }
});

afterAll(async () => {
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
    server.close(error => { if (error) reject(error); else resolve(); });
    server.closeAllConnections();
  })));
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

describe('preview serves the emitted OCCT gzip entity with its encoding', () => {
  it('reproduces the old mismatch and serves identical encoded bytes with working HTTP decoding', async () => {
    const before = await getRaw(originalOrigin, streamPath);
    expect(before.status).toBe(200);
    expect(before.headers['content-encoding']).toBeUndefined();
    expect(before.body).toEqual(encoded);
    const after = await getRaw(fixedOrigin, `${streamPath}?version=1`);
    expect(after.status).toBe(200);
    expect(after.headers['content-type']).toBe('application/wasm');
    expect(after.headers['content-encoding']).toBe('gzip');
    expect(after.headers['content-length']).toBe(String(encoded.length));
    expect(after.body).toEqual(before.body);
    expect(gunzipSync(after.body)).toEqual(decoded);
    expect(after.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(after.headers['cross-origin-embedder-policy']).toBe('require-corp');
    expect(after.headers['content-security-policy']).toBe("default-src 'self'");
    const response = await fetch(`${fixedOrigin}${streamPath}`);
    expect(response.status).toBe(200);
    const received = Buffer.from(await response.arrayBuffer());
    expect(received).toEqual(decoded);
    expect(createHash('sha256').update(received).digest('hex')).toBe(hash);
    expect(await WebAssembly.compileStreaming(fetch(`${fixedOrigin}${streamPath}`)))
      .toBeInstanceOf(WebAssembly.Module);
  });

  it('HEAD reports the encoded length and policy without sending a body', async () => {
    const response = await getRaw(fixedOrigin, `${streamPath}?head=1`, 'HEAD');
    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.headers['content-length']).toBe(String(encoded.length));
    expect(response.headers['content-type']).toBe('application/wasm');
    expect(response.body.length).toBe(0);
  });

  it('does not mark absent, ordinary, legacy, non-gzip or different-method responses as gzip', async () => {
    for (const [path, method] of [
      [missingPath, 'GET'], [missingPath, 'HEAD'], ['/ordinary.js', 'GET'],
      ['/occt/legacy.bin', 'GET'], ['/occt/manifest.json', 'GET'],
      [plainStreamPath, 'GET'], [streamPath, 'POST'],
      [`${streamPath}/extra`, 'GET'], [streamPath.replace('/stream/', '/%73tream/'), 'GET'],
    ]) {
      const response = await getRaw(fixedOrigin, path, method);
      expect(response.headers['content-encoding'], `${method} ${path}`).toBeUndefined();
      if (path === missingPath) expect(response.status).toBe(404);
      if (path === '/occt/legacy.bin') expect(response.body).toEqual(encoded);
      if (path === plainStreamPath) expect(response.body).toEqual(decoded);
    }
  });
});
