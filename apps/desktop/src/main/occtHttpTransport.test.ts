import { EventEmitter } from 'node:events';
import { createServer, get } from 'node:http';
import type { Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { session } from 'electron';
import { createOcctHttpTransport, readOcctHttpAsset, readSessionOcctCache } from './occtHttpTransport.js';
import { desktopOcctTransportUrl, DESKTOP_OCCT_TRANSPORT_ORIGIN } from '@pointercad/ui/desktop-occt-transport';

const native = vi.hoisted(() => ({
  request: vi.fn(), fetch: vi.fn<(url: string, options: RequestInit) => Promise<Response>>(),
}));
vi.mock('electron', () => ({ net: { request: native.request }, session: { defaultSession: { fetch: native.fetch } } }));
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const bytes = Buffer.from('verified OCCT test payload');
const gzip = gzipSync(bytes);
const asset = { sha256: digest(bytes), byteLength: bytes.length, gzip, transportSha256: digest(gzip) };
type Mode = 'hit' | 'miss' | 'failure' | 'incomplete' | 'aborted' | 'close-first' | 'corrupt' | 'stall';
function requests(mode: Mode): void {
  native.request.mockImplementation(() => {
    const request = new EventEmitter();
    return Object.assign(request, {
      abort: () => { request.emit('abort'); },
      end: () => { queueMicrotask(() => {
        if (mode === 'stall') return;
        if (mode === 'miss' || mode === 'failure') {
          request.emit('error', new Error(mode === 'miss' ? 'net::ERR_CACHE_MISS' : 'net::ERR_FAILED')); return;
        }
        if (mode === 'close-first') request.emit('close');
        const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {
          'content-type': ['application/wasm'], 'content-encoding': ['gzip'], 'content-length': [String(gzip.length)],
        } });
        request.emit('response', response);
        if (mode === 'aborted') { response.emit('aborted'); return; }
        response.emit('data', mode === 'corrupt' ? Buffer.from('invalid') : bytes);
        if (mode !== 'incomplete') response.emit('end');
        response.emit('close');
      }); },
    });
  });
}
const folders: string[] = [];
const transports: ReturnType<typeof createOcctHttpTransport>[] = [];
const listeners: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const transport of transports.splice(0)) await transport.close();
  for (const server of listeners.splice(0)) await new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close(error => { if (error) reject(error); else resolve(); });
  });
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
  vi.clearAllMocks();
});
async function fixture(corrupt = false): Promise<string> {
  const parent = join(process.cwd(), 'scratchpad/temp');
  await mkdir(parent, { recursive: true });
  const folder = await mkdtemp(join(parent, 'occt-http-unit-'));
  folders.push(folder);
  await mkdir(join(folder, 'occt/stream'), { recursive: true });
  await writeFile(join(folder, 'occt/manifest.json'), JSON.stringify({ compression: 'gzip',
    sha256: asset.sha256, byteLength: bytes.length,
    parts: [{ order: 0, file: `opencascade.full-${asset.sha256.slice(0, 16)}.bin`, byteLength: gzip.length }], stream: {
      compression: 'gzip', file: `stream/opencascade.full-${asset.sha256}.wasm`,
      transportByteLength: gzip.length, transportSha256: asset.transportSha256,
      decodedByteLength: bytes.length, decodedSha256: asset.sha256,
    } }));
  await writeFile(join(folder, 'occt/stream', `opencascade.full-${asset.sha256}.wasm`), corrupt ? bytes : gzip);
  return folder;
}
function transport(folder: string): ReturnType<typeof createOcctHttpTransport> {
  const value = createOcctHttpTransport(folder, session.defaultSession);
  transports.push(value); return value;
}
async function raw(path: string, host = '127.0.0.1:49721', origin = 'app://pointercad'): Promise<{
  status: number | undefined; headers: Record<string, string | string[] | undefined>; body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const request = get(DESKTOP_OCCT_TRANSPORT_ORIGIN + path, { headers: { Host: host, Origin: origin } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => { resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }); });
    });
    request.setTimeout(2000, () => { request.destroy(new Error('Unit HTTP timeout')); });
    request.on('error', reject);
  });
}

describe('fixed owned Desktop OCCT HTTP transport', () => {
  it('rejects corrupt bundled gzip before listener or network use', async () => {
    await expect(readOcctHttpAsset(await fixture(true))).rejects.toThrow('Corrupt OCCT gzip');
    expect(native.request).not.toHaveBeenCalled(); expect(native.fetch).not.toHaveBeenCalled();
  });
  it('cache hit is full-body verified, request close is not premature completion, and preparation is idempotent', async () => {
    requests('close-first');
    const value = transport(await fixture());
    const first = value.prepare();
    expect(value.prepare()).toBe(first);
    await expect(first).resolves.toMatchObject({ kind: 'http', url: desktopOcctTransportUrl(asset.sha256) });
    expect(native.request).toHaveBeenCalledOnce(); expect(native.fetch).not.toHaveBeenCalled();
    expect(native.request).toHaveBeenCalledWith(expect.objectContaining({ cache: 'only-if-cached', redirect: 'error' }));
    const good = await raw(`/occt/${asset.sha256}.wasm`);
    expect(good.status).toBe(200); expect(good.body).toEqual(gzip);
    expect(good.headers).toMatchObject({ 'content-type': 'application/wasm', 'content-encoding': 'gzip',
      'content-length': String(gzip.length), 'access-control-allow-origin': 'app://pointercad',
      'access-control-allow-credentials': 'true', 'access-control-expose-headers': 'Content-Encoding',
      'cross-origin-resource-policy': 'cross-origin', 'cache-control': 'public, max-age=31536000, immutable' });
    for (const path of [`/occt/${asset.sha256}.wasm?x`, '/occt/other.wasm', '/secret']) {
      expect((await raw(path)).status).toBe(403);
    }
    expect((await raw(`/occt/${asset.sha256}.wasm`, 'localhost:49721')).status).toBe(403);
    expect((await raw(`/occt/${asset.sha256}.wasm`, '127.0.0.1:49721', 'https://elsewhere')).status).toBe(403);
    await value.close(); await expect(value.prepare()).rejects.toThrow('closed');
  });
  it('only ERR_CACHE_MISS fetches once and accepts the actual Electron empty-URL response with complete integrity', async () => {
    requests('miss');
    native.fetch.mockImplementation(() => {
      const response = new Response(bytes.toString(), { headers: { 'Content-Type': 'application/wasm',
        'Content-Encoding': 'gzip', 'Content-Length': String(gzip.length) } });
      expect(response.url).toBe('');
      return Promise.resolve(response);
    });
    await expect(transport(await fixture()).prepare()).resolves.toMatchObject({ kind: 'http' });
    expect(native.fetch).toHaveBeenCalledOnce();
    expect(native.fetch).toHaveBeenCalledWith(desktopOcctTransportUrl(asset.sha256),
      expect.objectContaining({ credentials: 'include', redirect: 'error' }));
  });
  it('an empty-URL Electron response still rejects corrupt decoded fetch bytes', async () => {
    requests('miss');
    native.fetch.mockImplementation(() => Promise.resolve(new Response('corrupt decoded bytes', {
      headers: { 'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip',
        'Content-Length': String(gzip.length) },
    })));
    await expect(transport(await fixture()).prepare()).rejects.toThrow('OCCT HTTP body mismatch');
    expect(native.fetch).toHaveBeenCalledOnce();
  });
  it.each(['failure', 'incomplete', 'aborted', 'corrupt'] as const)('rejects %s instead of a direct fallback', async mode => {
    requests(mode);
    await expect(readSessionOcctCache(session.defaultSession, desktopOcctTransportUrl(asset.sha256), asset)).rejects.toThrow();
    expect(native.fetch).not.toHaveBeenCalled();
  });
  it('rejects a full valid body closed without response end', async () => {
    requests('incomplete');
    await expect(readSessionOcctCache(session.defaultSession, desktopOcctTransportUrl(asset.sha256), asset))
      .rejects.toThrow('Cached OCCT response incomplete');
    expect(native.fetch).not.toHaveBeenCalled();
  });
  it('cache-only has a finite deadline', async () => {
    vi.useFakeTimers(); requests('stall');
    const promise = readSessionOcctCache(session.defaultSession, desktopOcctTransportUrl(asset.sha256), asset);
    const rejected = expect(promise).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(25000); await rejected;
  });
  it('an occupied fixed port returns direct without contacting its owner', async () => {
    const foreign = createServer((_request, response) => { response.end('foreign'); });
    listeners.push(foreign);
    await new Promise<void>((resolve, reject) => { foreign.once('error', reject); foreign.listen(49721, '127.0.0.1', resolve); });
    const visits = vi.fn(); foreign.on('request', visits);
    await expect(transport(await fixture()).prepare()).resolves.toEqual({ kind: 'direct', reason: 'port-unavailable' });
    expect(visits).not.toHaveBeenCalled(); expect(native.request).not.toHaveBeenCalled();
    expect(native.fetch).not.toHaveBeenCalled();
  });
  it('a second application cannot take ownership and the owner releases the port', async () => {
    requests('hit');
    const folder = await fixture();
    const first = transport(folder);
    await expect(first.prepare()).resolves.toMatchObject({ kind: 'http' });
    await expect(transport(folder).prepare()).resolves.toEqual({ kind: 'direct', reason: 'port-unavailable' });
    expect(native.request).toHaveBeenCalledOnce();
    await first.close();
    await expect(transport(folder).prepare()).resolves.toMatchObject({ kind: 'http' });
    expect(native.request).toHaveBeenCalledTimes(2);
  });
});
