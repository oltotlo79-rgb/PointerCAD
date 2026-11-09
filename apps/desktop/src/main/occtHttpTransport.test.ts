import { EventEmitter } from 'node:events';
import { get } from 'node:http';
import type { Server } from 'node:http';
import type { ListenOptions } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { session } from 'electron';
import { createOcctHttpTransport, readOcctHttpAsset, readSessionOcctCache } from './occtHttpTransport.js';
import { desktopOcctTransportOrigin, desktopOcctTransportUrl } from '@pointercad/ui/desktop-occt-transport';
import type * as ImportedNodeZlibTypes from 'node:zlib';
import type * as ImportedNodeHttpTypes from 'node:http';

const native = vi.hoisted(() => ({
  holdDecode: false, throwDecode: false, pendingDecodes: new Set<() => void>(),
  decodeOptions: new Array<{ maxOutputLength?: number; chunkSize?: number }>(),
  decodeQueued: (): void => undefined, decodeCompleted: (): void => undefined,
  request: vi.fn(), fetch: vi.fn<(url: string, options: RequestInit) => Promise<Response>>(),
}));
vi.mock('electron', () => ({ net: { request: native.request }, session: { defaultSession: { fetch: native.fetch } } }));
vi.mock('node:zlib', async importOriginal => {
  const zlib = await importOriginal<typeof ImportedNodeZlibTypes>();
  return { ...zlib, gunzip: (...args: Parameters<typeof zlib.gunzip>) => {
    if (native.throwDecode) throw new Error('Synchronous gunzip failure');
    const [input, options, callback] = args;
    native.decodeOptions.push(options);
    const run = (): void => { zlib.gunzip(input, options, (error, result) => {
      callback(error, result); native.decodeCompleted();
    }); };
    if (native.holdDecode) { native.pendingDecodes.add(run); native.decodeQueued(); }
    else run();
  } };
});
vi.mock('node:http', async importOriginal => {
  const http = await importOriginal<typeof ImportedNodeHttpTypes>();
  return { ...http, createServer: (...args: Parameters<typeof http.createServer>) => isolateListener(http.createServer(...args)) };
});

// Keep real TCP/HTTP, but reserve one OS-assigned port per test for ownership checks.
// Capture the product's arguments before replacing only its physical destination.
let testPort = 0;
// The product's requested port: fixed 49721 unless a test asks the transport to bind port 0 itself.
let requestedPort = 49721;
let listenerError: NodeJS.ErrnoException | undefined;
const listenRequests: { server: Server; options: ListenOptions; events: MockInstance<Server['emit']> }[] = [];
const physicalListens: ListenOptions[] = [];
const ownedServers: Server[] = [];
function isListenCallback(value: unknown): value is () => void {
  return typeof value === 'function';
}
function isolateListener(server: Server): Server {
  ownedServers.push(server);
  const events = vi.spyOn(server, 'emit');
  const listen = server.listen.bind(server);
  vi.spyOn(server, 'listen').mockImplementation((...args: unknown[]) => {
    const [options, callback] = args;
    if (typeof options !== 'object' || options === null || !('port' in options)
        || typeof options.port !== 'number' || !('host' in options) || typeof options.host !== 'string'
        || !('signal' in options) || !(options.signal instanceof AbortSignal) || !isListenCallback(callback)) {
      throw new Error('Unexpected OCCT listener arguments');
    }
    const requested = { port: options.port, host: options.host, signal: options.signal };
    listenRequests.push({ server, options: requested, events });
    expect({ port: requested.port, host: requested.host }).toEqual({ port: requestedPort, host: '127.0.0.1' });
    expect(requested.signal).toBeInstanceOf(AbortSignal);
    if (listenerError !== undefined) {
      const error = listenerError;
      queueMicrotask(() => { server.emit('error', error); });
      return server;
    }
    const start = (port: number): Server => {
      expect(port).not.toBe(49721);
      const physical = { ...requested, port };
      physicalListens.push(physical);
      return listen(physical, () => {
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('Missing test listener address');
        // An ephemeral allocation may itself pick 49721; never reuse it explicitly.
        if (address.port === 49721) {
          server.close(error => { if (error) throw error; start(0); });
          return;
        }
        testPort = address.port;
        callback();
      });
    };
    return start(testPort);
  });
  return server;
}

async function closeListener(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close(error => { if (error) reject(error); else resolve(); });
  });
}
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const bytes = Buffer.from('verified OCCT test payload');
const gzip = gzipSync(bytes);
const asset = { sha256: digest(bytes), byteLength: bytes.length, gzip, transportSha256: digest(gzip) };
type Mode = 'hit' | 'miss' | 'failure' | 'incomplete' | 'aborted' | 'close-first' | 'corrupt' | 'stall'
  | 'same-length-corrupt' | 'oversized' | 'response-miss';
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
        if (mode === 'response-miss') { request.emit('error', new Error('net::ERR_CACHE_MISS')); return; }
        if (mode === 'aborted') { response.emit('aborted'); return; }
        const body = mode === 'same-length-corrupt' ? Buffer.alloc(bytes.length, 120)
          : mode === 'oversized' ? Buffer.concat([bytes, Buffer.from([0])])
            : mode === 'corrupt' ? Buffer.from('invalid') : bytes;
        response.emit('data', body);
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
  native.holdDecode = false; native.throwDecode = false;
  for (const release of native.pendingDecodes) release();
  native.pendingDecodes.clear();
  native.decodeOptions.splice(0);
  native.decodeQueued = () => undefined; native.decodeCompleted = () => undefined;
  vi.unstubAllEnvs();
  for (const transport of transports.splice(0)) await transport.close();
  const remaining = ownedServers.filter(server => server.listening);
  for (const server of remaining) await closeListener(server);
  for (const server of listeners.splice(0)) await closeListener(server);
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
  const physical = physicalListens.splice(0);
  ownedServers.splice(0); listenRequests.splice(0); testPort = 0; requestedPort = 49721; listenerError = undefined;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  expect(remaining).toEqual([]);
  expect(physical.every(options => options.port !== 49721 && options.host === '127.0.0.1')).toBe(true);
});
async function fixture(corrupt = false, compressed = gzip): Promise<string> {
  const parent = join(process.cwd(), 'scratchpad/temp');
  await mkdir(parent, { recursive: true });
  const folder = await mkdtemp(join(parent, 'occt-http-unit-'));
  folders.push(folder);
  await mkdir(join(folder, 'occt/stream'), { recursive: true });
  await writeFile(join(folder, 'occt/manifest.json'), JSON.stringify({ compression: 'gzip',
    sha256: asset.sha256, byteLength: bytes.length,
    parts: [{ order: 0, file: `opencascade.full-${asset.sha256.slice(0, 16)}.bin`, byteLength: compressed.length }], stream: {
      compression: 'gzip', file: `stream/opencascade.full-${asset.sha256}.wasm`,
      transportByteLength: compressed.length, transportSha256: digest(compressed),
      decodedByteLength: bytes.length, decodedSha256: asset.sha256,
    } }));
  await writeFile(join(folder, 'occt/stream', `opencascade.full-${asset.sha256}.wasm`), corrupt ? bytes : compressed);
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
    const request = get(`http://127.0.0.1:${testPort}${path}`, { headers: { Host: host, Origin: origin } }, response => {
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
    expect(listenRequests).toHaveLength(1);
    expect(listenRequests[0]?.options).toMatchObject({ port: 49721, host: '127.0.0.1' });
    expect(listenRequests[0]?.options.signal).toBeInstanceOf(AbortSignal);
    expect(testPort).toBeGreaterThan(0);
    expect(physicalListens[0]).toEqual({ port: 0, host: '127.0.0.1', signal: listenRequests[0]?.options.signal });
    expect(listenRequests[0]?.server.listening).toBe(true);
    expect(native.request).toHaveBeenCalledOnce(); expect(native.fetch).not.toHaveBeenCalled();
    expect(native.request).toHaveBeenCalledWith(expect.objectContaining({ cache: 'only-if-cached', redirect: 'error' }));
    const good = await raw(`/occt/${asset.sha256}.wasm`);
    expect(good.status).toBe(200); expect(good.body).toEqual(gzip);
    expect(good.headers).toMatchObject({ 'content-type': 'application/wasm', 'content-encoding': 'gzip',
      'content-length': String(gzip.length), 'access-control-allow-origin': 'app://pointercad',
      'access-control-allow-credentials': 'true', 'access-control-expose-headers': 'Content-Encoding',
      'cross-origin-resource-policy': 'cross-origin', 'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff', etag: `"${asset.transportSha256}"` });
    for (const path of [`/occt/${asset.sha256}.wasm?x`, '/occt/other.wasm', '/secret']) {
      const denied = await raw(path);
      expect(denied.status).toBe(403);
      expect(denied.headers['cache-control']).toBe('no-store'); expect(denied.body).toEqual(Buffer.alloc(0));
    }
    expect((await raw(`/occt/${asset.sha256}.wasm`, 'localhost:49721')).status).toBe(403);
    expect((await raw(`/occt/${asset.sha256}.wasm`, '127.0.0.1:49722')).status).toBe(403);
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
    const { createServer } = await vi.importActual<typeof ImportedNodeHttpTypes>('node:http');
    const foreign = createServer((_request, response) => { response.end('foreign'); });
    listeners.push(foreign);
    do {
      await closeListener(foreign);
      await new Promise<void>((resolve, reject) => { foreign.once('error', reject); foreign.listen(0, '127.0.0.1', resolve); });
      const address = foreign.address();
      if (address === null || typeof address === 'string') throw new Error('Missing foreign listener address');
      testPort = address.port;
    } while (testPort === 49721);
    const foreignClose = vi.spyOn(foreign, 'close');
    const visits = vi.fn(); foreign.on('request', visits);
    const value = transport(await fixture());
    await expect(value.prepare()).resolves.toEqual({ kind: 'direct', reason: 'port-unavailable' });
    expect(listenRequests[0]?.events).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'EADDRINUSE' }));
    await value.close();
    expect(foreign.listening).toBe(true); expect(foreignClose).not.toHaveBeenCalled();
    expect(ownedServers.every(server => !server.listening)).toBe(true);
    expect(visits).not.toHaveBeenCalled(); expect(native.request).not.toHaveBeenCalled();
    expect(native.fetch).not.toHaveBeenCalled();
  });
  it('a second application cannot take ownership and the owner releases the port', async () => {
    requests('hit');
    const folder = await fixture();
    const first = transport(folder);
    await expect(first.prepare()).resolves.toMatchObject({ kind: 'http' });
    const port = testPort;
    await expect(transport(folder).prepare()).resolves.toEqual({ kind: 'direct', reason: 'port-unavailable' });
    expect(listenRequests[1]?.events).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'EADDRINUSE' }));
    expect(native.request).toHaveBeenCalledOnce();
    expect(native.fetch).not.toHaveBeenCalled();
    await first.close();
    expect(ownedServers.every(server => !server.listening)).toBe(true);
    await expect(transport(folder).prepare()).resolves.toMatchObject({ kind: 'http' });
    expect(testPort).toBe(port);
    expect(native.request).toHaveBeenCalledTimes(2);
  });
  it('a test launch binds port 0 in the owning server itself and uses that one owned origin for Host, cache and reply', async () => {
    requests('hit');
    requestedPort = 0;
    const value = createOcctHttpTransport(await fixture(), session.defaultSession, true);
    transports.push(value);
    const reply = await value.prepare();
    expect(listenRequests).toHaveLength(1);
    expect(listenRequests[0]?.options).toMatchObject({ port: 0, host: '127.0.0.1' });
    // No other socket chose the number: the server that bound port 0 is still listening on the replied port.
    const address = listenRequests[0]?.server.address();
    if (address === null || address === undefined || typeof address === 'string') throw new Error('Missing owned test address');
    expect(listenRequests[0]?.server.listening).toBe(true);
    expect(address.port).toBe(testPort);
    const url = desktopOcctTransportUrl(asset.sha256, desktopOcctTransportOrigin(testPort));
    expect(reply).toEqual({ kind: 'http', url, sha256: asset.sha256, byteLength: asset.byteLength });
    expect(value.prepare()).toBe(value.prepare());
    expect(native.request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ url, cache: 'only-if-cached', redirect: 'error' }));
    expect(native.fetch).not.toHaveBeenCalled();
    const authority = `127.0.0.1:${String(testPort)}`;
    const good = await raw(`/occt/${asset.sha256}.wasm`, authority);
    expect(good.status).toBe(200); expect(good.body).toEqual(gzip);
    const foreignPort = testPort === 49721 ? 49722 : 49721;
    expect(foreignPort).not.toBe(testPort);
    const foreignHost = `127.0.0.1:${String(foreignPort)}`;
    for (const [path, host, requestOrigin] of [[`/occt/${asset.sha256}.wasm`, foreignHost, 'app://pointercad'],
      [`/occt/${asset.sha256}.wasm`, `localhost:${String(testPort)}`, 'app://pointercad'],
      [`/occt/${asset.sha256}.wasm`, `127.0.0.1:${String(testPort + 1)}`, 'app://pointercad'],
      [`/occt/${asset.sha256}.wasm?x`, authority, 'app://pointercad'], ['/occt/manifest.json', authority, 'app://pointercad'],
      [`/occt/${asset.sha256}.wasm`, authority, 'https://elsewhere']] as const) {
      const denied = await raw(path, host, requestOrigin);
      expect(denied.status).toBe(403);
      expect(denied.headers['cache-control']).toBe('no-store'); expect(denied.body).toEqual(Buffer.alloc(0));
    }
    await value.close();
    expect(ownedServers.every(server => !server.listening)).toBe(true);
  });
  it('a denied fixed port (EACCES) returns direct after the bundled check, without network use or cleanup errors', async () => {
    // CI run 42358862597 (windows-latest): listen EACCES at 127.0.0.1:49721 rejected preparation,
    // so every Desktop solid failed. Denied ownership is the same situation as an occupied port.
    const error = Object.assign(new Error('listen EACCES: permission denied 127.0.0.1:49721'), {
      code: 'EACCES', syscall: 'listen', address: '127.0.0.1', port: 49721,
    });
    listenerError = error;
    vi.stubEnv('PCAD_OCCT_TRANSPORT_TRACE', '1');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const value = transport(await fixture());
    await expect(value.prepare()).resolves.toEqual({ kind: 'direct', reason: 'port-unavailable' });
    const traces = info.mock.calls.flatMap(([message]: unknown[]) =>
      typeof message === 'string' && message.startsWith('[pcad:occt-http-phases] ') ? [message] : []);
    expect(traces).toHaveLength(1);
    const trace: unknown = JSON.parse((traces[0] ?? '').slice('[pcad:occt-http-phases] '.length));
    if (typeof trace !== 'object' || trace === null || !('events' in trace) || !Array.isArray(trace.events)) {
      throw new Error('Missing OCCT transport trace');
    }
    const phases: unknown[] = trace.events.map((event: unknown) =>
      typeof event === 'object' && event !== null && 'phase' in event ? event.phase : undefined);
    // The bundled decoded asset is still verified before the direct reply.
    expect(phases).toEqual(['prepare-start', 'manifest-start', 'manifest-validated', 'gzip-read', 'transport-verified',
      'listener-start', 'listener-denied', 'decoded-inflated', 'decoded-verified', 'prepare-direct-port-unavailable',
      'prepare-settled']);
    expect(listenRequests).toHaveLength(1);
    expect(ownedServers).toHaveLength(1);
    expect(ownedServers.every(server => !server.listening && server.address() === null)).toBe(true);
    const [server] = ownedServers;
    if (server === undefined) throw new Error('Missing denied listener');
    expect(listenRequests[0]?.events).toHaveBeenCalledWith('error', error);
    const close = vi.spyOn(server, 'close');
    await expect(value.close()).resolves.toBeUndefined();
    await expect(closeListener(server)).resolves.toBeUndefined();
    expect(close).not.toHaveBeenCalled();
    expect(physicalListens).toEqual([]);
    expect(native.request).not.toHaveBeenCalled(); expect(native.fetch).not.toHaveBeenCalled();
  });
  it.each(['same-length', 'oversized', 'truncated'] as const)(
    'a denied fixed port still rejects a %s corrupt bundled asset instead of a direct reply', async mode => {
    listenerError = Object.assign(new Error('listen EACCES: permission denied 127.0.0.1:49721'), {
      code: 'EACCES', syscall: 'listen', address: '127.0.0.1', port: 49721,
    });
    const compressed = mode === 'same-length' ? gzipSync(Buffer.alloc(bytes.length, 120))
      : mode === 'oversized' ? gzipSync(Buffer.alloc(bytes.length + 1)) : gzip.subarray(0, -3);
    const value = transport(await fixture(false, compressed));
    await expect(value.prepare()).rejects.toThrow();
    expect(listenRequests[0]?.events).toHaveBeenCalledWith('error', listenerError);
    expect(ownedServers.every(server => !server.listening && server.address() === null)).toBe(true);
    const [server] = ownedServers;
    if (server === undefined) throw new Error('Missing denied listener');
    const close = vi.spyOn(server, 'close');
    await expect(value.close()).resolves.toBeUndefined();
    expect(close).not.toHaveBeenCalled();
    expect(physicalListens).toEqual([]);
    expect(native.request).not.toHaveBeenCalled(); expect(native.fetch).not.toHaveBeenCalled();
  });
  it.each(['EADDRNOTAVAIL', 'EIO'] as const)(
    'rejects %s with the original error, without fallback, network use or cleanup errors', async code => {
    const error = Object.assign(new Error(`listen ${code} 127.0.0.1:49721`), {
      code, syscall: 'listen', address: '127.0.0.1', port: 49721,
    });
    listenerError = error;
    const value = transport(await fixture());
    await expect(value.prepare()).rejects.toBe(error);
    expect(listenRequests).toHaveLength(1);
    expect(ownedServers).toHaveLength(1);
    expect(ownedServers.every(server => !server.listening && server.address() === null)).toBe(true);
    const [server] = ownedServers;
    if (server === undefined) throw new Error('Missing denied listener');
    expect(listenRequests[0]?.events).toHaveBeenCalledWith('error', error);
    const close = vi.spyOn(server, 'close');
    await expect(value.close()).resolves.toBeUndefined();
    await expect(closeListener(server)).resolves.toBeUndefined();
    expect(close).not.toHaveBeenCalled();
    expect(physicalListens).toEqual([]);
    expect(native.request).not.toHaveBeenCalled(); expect(native.fetch).not.toHaveBeenCalled();
  });
});

describe('OCCT取得の段階記録', () => {
  // matcherの戻り値をunknownへ限定し、検査対象への型の流入を防ぐ。
  const numberMatcher: unknown = expect.any(Number);
  const stringMatcher: unknown = expect.any(String);
  const signalMatcher: unknown = expect.any(AbortSignal);
  function objectContaining(value: Record<string, unknown>): unknown {
    return expect.objectContaining(value);
  }
  function arrayContaining(value: unknown[]): unknown {
    return expect.arrayContaining(value);
  }

  function evidence(log: MockInstance<typeof console.info>): unknown {
    const messages = log.mock.calls.filter(([message]) =>
      typeof message === 'string' && message.startsWith('[pcad:occt-http-phases] '));
    expect(messages).toHaveLength(1);
    const text: unknown = messages[0]?.[0];
    if (typeof text !== 'string') throw new Error('取得の段階記録がありません');
    const parsed: unknown = JSON.parse(text.slice('[pcad:occt-http-phases] '.length));
    return parsed;
  }

  it('独立した本文長と全照合の順序を記録し、同じ準備を共有する', async () => {
    vi.stubEnv('PCAD_OCCT_TRANSPORT_TRACE', '1');
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    requests('close-first');
    const value = transport(await fixture());
    const first = value.prepare();
    expect(value.prepare()).toBe(first);
    await expect(first).resolves.toEqual({ kind: 'http', url: desktopOcctTransportUrl(digest(bytes)),
      sha256: digest(bytes), byteLength: bytes.length });
    const phases = ['prepare-start', 'manifest-start', 'manifest-validated', 'gzip-read', 'transport-verified',
      'decoded-inflated', 'decoded-verified', 'listener-start', 'listener-ready', 'cache-start',
      'cache-headers', 'cache-body-end', 'cache-hit', 'prepare-http', 'prepare-settled'];
    const recorded = evidence(log);
    expect(recorded).toMatchObject({ version: 1, pid: process.pid, startedAtEpochMs: numberMatcher });
    if (typeof recorded !== 'object' || recorded === null || !('events' in recorded)
        || !Array.isArray(recorded.events)) throw new Error('段階配列がありません');
    expect(Object.keys(recorded).sort()).toEqual(['events', 'pid', 'startedAtEpochMs', 'version']);
    const actualPhases = recorded.events.map((event: unknown) => {
      expect(event).toEqual(objectContaining({ phase: stringMatcher, elapsedMs: numberMatcher,
        userCpuUs: numberMatcher, systemCpuUs: numberMatcher }));
      if (typeof event !== 'object' || event === null || !('phase' in event)
          || typeof event.phase !== 'string') throw new Error('段階名がありません');
      return event.phase;
    });
    expect([...actualPhases].sort()).toEqual([...phases].sort());
    const assertOrder = (order: string[]): void => {
      const positions = order.map(phase => actualPhases.indexOf(phase));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    };
    assertOrder(['prepare-start', 'manifest-start', 'manifest-validated', 'gzip-read', 'transport-verified',
      'listener-start', 'listener-ready', 'decoded-inflated', 'decoded-verified', 'prepare-http', 'prepare-settled']);
    assertOrder(['listener-ready', 'cache-start', 'cache-headers', 'cache-body-end', 'cache-hit', 'prepare-http']);
    expect(evidence(log)).toMatchObject({ events: arrayContaining([
      objectContaining({ phase: 'gzip-read', byteLength: gzipSync(bytes).length }),
      objectContaining({ phase: 'cache-body-end', byteLength: bytes.length }),
    ]) });
    expect(native.fetch).not.toHaveBeenCalled();
  });

  it('cache missと照合済み補充を区別し、取得条件を保つ', async () => {
    vi.stubEnv('PCAD_OCCT_TRANSPORT_TRACE', '1');
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    requests('miss');
    native.fetch.mockResolvedValueOnce(new Response(bytes.toString(), { headers: {
      'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip', 'Content-Length': String(gzip.length),
    } }));
    await expect(transport(await fixture()).prepare()).resolves.toMatchObject({ kind: 'http' });
    expect(evidence(log)).toMatchObject({ events: arrayContaining([
      objectContaining({ phase: 'cache-miss' }),
      objectContaining({ phase: 'fill-body-end', byteLength: bytes.length }),
      objectContaining({ phase: 'fill-verified', byteLength: bytes.length }),
    ]) });
    expect(native.fetch).toHaveBeenCalledExactlyOnceWith(desktopOcctTransportUrl(digest(bytes)),
      objectContaining({ credentials: 'include', redirect: 'error', signal: signalMatcher }));
  });

  it.each(['same-length-corrupt', 'oversized', 'response-miss'] as const)(
    '%sをmissへ変えず拒否し、所有listenerを閉じる', async mode => {
      vi.stubEnv('PCAD_OCCT_TRANSPORT_TRACE', '1');
      const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      requests(mode);
      await expect(transport(await fixture()).prepare()).rejects.toThrow();
      const result = evidence(log);
      expect(result).toMatchObject({ events: arrayContaining([
        objectContaining({ phase: 'cache-rejected' }),
        objectContaining({ phase: 'prepare-rejected' }),
      ]) });
      expect(result).not.toMatchObject({ events: arrayContaining([
        objectContaining({ phase: 'cache-miss' }),
      ]) });
      expect(native.fetch).not.toHaveBeenCalled();
      expect(ownedServers.every(server => !server.listening)).toBe(true);
    },
  );

  it('headersとrequest closeだけでは本文終端前に完了しない', async () => {
    vi.stubEnv('PCAD_OCCT_TRANSPORT_TRACE', '1');
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let release = (): void => undefined;
    let notifyHeaders = (): void => undefined;
    const headersReceived = new Promise<void>(resolve => { notifyHeaders = resolve; });
    native.request.mockImplementation(() => {
      const request = new EventEmitter();
      return Object.assign(request, {
        abort: () => { request.emit('abort'); },
        end: () => { queueMicrotask(() => {
          const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {
            'content-type': ['application/wasm'], 'content-encoding': ['gzip'],
            'content-length': [String(gzip.length)],
          } });
          request.emit('response', response);
          response.emit('data', bytes);
          request.emit('close');
          release = () => { response.emit('end'); response.emit('close'); };
          notifyHeaders();
        }); },
      });
    });
    const prepared = transport(await fixture()).prepare();
    let settled = false;
    void prepared.then(() => { settled = true; }, () => { settled = true; });
    await headersReceived;
    try {
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(log.mock.calls.filter(([message]) => typeof message === 'string'
        && message.startsWith('[pcad:occt-http-phases] '))).toEqual([]);
    } finally { release(); }
    await expect(prepared).resolves.toMatchObject({ kind: 'http' });
    expect(evidence(log)).toMatchObject({ events: arrayContaining([
      objectContaining({ phase: 'cache-body-end', byteLength: bytes.length }),
      objectContaining({ phase: 'cache-hit' }),
    ]) });
    expect(native.fetch).not.toHaveBeenCalled();
  });

  it('markとflushの失敗が本来の成功と拒否を変えない', async () => {
    vi.stubEnv('PCAD_OCCT_TRANSPORT_TRACE', '1');
    const log = vi.spyOn(console, 'info').mockImplementation(() => {
      throw new Error('診断の出力に失敗しました');
    });
    const originalCpuUsage = process.cpuUsage.bind(process);
    for (const mode of ['hit', 'same-length-corrupt'] as const) {
      // 初期値の取得後はmarkを失敗させ、flushの失敗も同時に確認する。
      const cpu = vi.spyOn(process, 'cpuUsage')
        .mockImplementationOnce(() => originalCpuUsage())
        .mockImplementation(() => { throw new Error('診断のCPU記録に失敗しました'); });
      requests(mode);
      const value = transport(await fixture());
      const prepared = value.prepare();
      if (mode === 'hit') {
        await expect(prepared).resolves.toMatchObject({ kind: 'http' });
      } else {
        await expect(prepared).rejects.toThrow('Cached OCCT response integrity mismatch');
      }
      await value.close();
      cpu.mockRestore();
    }
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('診断が無効なら段階記録を出力しない', async () => {
    vi.stubEnv('PCAD_OCCT_TRANSPORT_TRACE', '0');
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    requests('hit');
    await expect(transport(await fixture()).prepare()).resolves.toMatchObject({ kind: 'http' });
    expect(log).not.toHaveBeenCalled();
  });
});


/** Control event order, never wall-clock sleeps or a different production asset policy. */
function pausedDecode(): { queued: Promise<void>; completed: Promise<void>; release: () => void } {
  native.holdDecode = true;
  const queued = new Promise<void>(resolve => { native.decodeQueued = resolve; });
  const completed = new Promise<void>(resolve => { native.decodeCompleted = resolve; });
  return { queued, completed, release: () => {
    expect(native.pendingDecodes.size).toBe(1);
    for (const run of native.pendingDecodes) run();
    native.pendingDecodes.clear();
  } };
}

function pausedCache(encodedLength = gzip.length): { started: Promise<void>; release: () => void } {
  let release = (): void => { throw new Error('Cache request not started'); };
  const started = new Promise<void>(resolve => {
    native.request.mockImplementation(() => {
      const request = new EventEmitter();
      return Object.assign(request, {
        abort: () => { request.emit('abort'); },
        end: () => {
          release = () => {
            const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {
              'content-type': ['application/wasm'], 'content-encoding': ['gzip'],
              'content-length': [String(encodedLength)],
            } });
            request.emit('response', response); response.emit('data', bytes);
            request.emit('close'); response.emit('end'); response.emit('close');
          };
          resolve();
        },
      });
    });
  });
  return { started, release: () => { release(); } };
}

describe('独立したlocal/cache検証の並行境界', () => {
  it.each(['cache-first', 'local-first'] as const)('%sでも片方だけでは配信も準備も完了しない', async order => {
    const decoded = pausedDecode(), cache = pausedCache();
    const value = transport(await fixture()); const prepared = value.prepare();
    let settled = false;
    void prepared.then(() => { settled = true; }, () => { settled = true; });
    await Promise.all([decoded.queued, cache.started]);
    const pending = await raw(`/occt/${asset.sha256}.wasm`);
    expect(pending.status).toBe(503); expect(pending.body).toEqual(Buffer.alloc(0));
    expect(pending.headers['cache-control']).toBe('no-store'); expect(settled).toBe(false);
    if (order === 'cache-first') cache.release();
    else { decoded.release(); await decoded.completed; }
    const half = await raw(`/occt/${asset.sha256}.wasm`);
    expect(half.status).toBe(503); expect(half.body).toEqual(Buffer.alloc(0));
    expect(half.headers['cache-control']).toBe('no-store'); expect(settled).toBe(false);
    if (order === 'cache-first') { decoded.release(); await decoded.completed; } else cache.release();
    await expect(prepared).resolves.toEqual({ kind: 'http', url: desktopOcctTransportUrl(asset.sha256),
      sha256: digest(bytes), byteLength: bytes.length });
    expect(native.fetch).not.toHaveBeenCalled();
    const accepted = await raw(`/occt/${asset.sha256}.wasm`);
    expect(accepted.status).toBe(200); expect(accepted.body).toEqual(gzip);
  });

  it.each(['same-length', 'oversized', 'truncated'] as const)(
    '正しいcacheでもlocal decodedの%s不正を拒否する', async mode => {
      const compressed = mode === 'same-length' ? gzipSync(Buffer.alloc(bytes.length, 120))
        : mode === 'oversized' ? gzipSync(Buffer.alloc(bytes.length + 1)) : gzip.subarray(0, -3);
      const decoded = pausedDecode(), cache = pausedCache(compressed.length);
      const value = transport(await fixture(false, compressed)); const prepared = value.prepare();
      const rejected = expect(prepared).rejects.toThrow();
      await Promise.all([decoded.queued, cache.started]); cache.release(); decoded.release();
      await rejected; await decoded.completed;
      expect(native.fetch).not.toHaveBeenCalled(); expect(ownedServers.every(server => !server.listening)).toBe(true);
    },
  );

  it('close後の遅いlocal完了から成功せずcache待ちとlistenerを閉じる', async () => {
    const decoded = pausedDecode(), cache = pausedCache();
    const value = transport(await fixture()); const prepared = value.prepare();
    const rejected = expect(prepared).rejects.toThrow('aborted');
    let successful = false; void prepared.then(() => { successful = true; }, () => undefined);
    await Promise.all([decoded.queued, cache.started]); await value.close(); await rejected;
    decoded.release(); await decoded.completed;
    expect(successful).toBe(false); expect(native.fetch).not.toHaveBeenCalled();
    expect(ownedServers.every(server => !server.listening)).toBe(true);
    await expect(value.prepare()).rejects.toThrow('closed');
  });

  it('decodeの25000ms期限を延ばさず拒否しtimerとlistenerを残さない', async () => {
    vi.useFakeTimers();
    const decoded = pausedDecode(), cache = pausedCache();
    const value = transport(await fixture()); const prepared = value.prepare();
    const rejected = expect(prepared).rejects.toThrow('OCCT decode timeout');
    await Promise.all([decoded.queued, cache.started]); cache.release();
    await vi.advanceTimersByTimeAsync(24999);
    expect(ownedServers.some(server => server.listening)).toBe(true);
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(vi.getTimerCount()).toBe(0);
    decoded.release(); await decoded.completed;
    expect(native.fetch).not.toHaveBeenCalled(); expect(ownedServers.every(server => !server.listening)).toBe(true);
  });

  it('gunzipの同期throwでもtimeout/abort listenerを残さず元の拒否を保つ', async () => {
    vi.useFakeTimers(); native.throwDecode = true; requests('stall');
    const removed = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
    const value = transport(await fixture());
    await expect(value.prepare()).rejects.toThrow('Synchronous gunzip failure');
    expect(vi.getTimerCount()).toBe(0);
    expect(removed.mock.calls.filter(([name]) => name === 'abort').length).toBeGreaterThanOrEqual(2);
    expect(native.fetch).not.toHaveBeenCalled(); expect(ownedServers.every(server => !server.listening)).toBe(true);
  });
});


describe('固定decoded長を使う復号bufferの境界', () => {
  it('小さい資産でもzlibの最小容量を守り、出力上限は増やさない', async () => {
    requests('hit');
    await expect(transport(await fixture()).prepare()).resolves.toMatchObject({ kind: 'http' });
    expect(native.decodeOptions).toEqual([{ maxOutputLength: bytes.length,
      chunkSize: Math.max(64, bytes.length + 1) }]);
  });

  it('上限を1byte超えるlocal本文を正しいcacheで正当化しない', async () => {
    const compressed = gzipSync(Buffer.concat([bytes, Buffer.from([0])]));
    const cache = pausedCache(compressed.length);
    const prepared = transport(await fixture(false, compressed)).prepare();
    const rejected = expect(prepared).rejects.toMatchObject({ code: 'ERR_BUFFER_TOO_LARGE' });
    await cache.started; cache.release(); await rejected;
    expect(native.decodeOptions).toEqual([{ maxOutputLength: bytes.length,
      chunkSize: Math.max(64, bytes.length + 1) }]);
    expect(native.fetch).not.toHaveBeenCalled();
    expect(ownedServers.every(server => !server.listening)).toBe(true);
  });
});
