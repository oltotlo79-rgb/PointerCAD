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
import { desktopOcctTransportUrl } from '@pointercad/ui/desktop-occt-transport';

const native = vi.hoisted(() => ({
  request: vi.fn(), fetch: vi.fn<(url: string, options: RequestInit) => Promise<Response>>(),
}));
vi.mock('electron', () => ({ net: { request: native.request }, session: { defaultSession: { fetch: native.fetch } } }));
vi.mock('node:http', async importOriginal => {
  const http = await importOriginal<typeof import('node:http')>();
  return { ...http, createServer: (...args: Parameters<typeof http.createServer>) => isolateListener(http.createServer(...args)) };
});

// Keep real TCP/HTTP, but reserve one OS-assigned port per test for ownership checks.
// Capture the product's arguments before replacing only its physical destination.
let testPort = 0;
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
    expect({ port: requested.port, host: requested.host }).toEqual({ port: 49721, host: '127.0.0.1' });
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
  vi.unstubAllEnvs();
  for (const transport of transports.splice(0)) await transport.close();
  const remaining = ownedServers.filter(server => server.listening);
  for (const server of remaining) await closeListener(server);
  for (const server of listeners.splice(0)) await closeListener(server);
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
  const physical = physicalListens.splice(0);
  ownedServers.splice(0); listenRequests.splice(0); testPort = 0; listenerError = undefined;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  expect(remaining).toEqual([]);
  expect(physical.every(options => options.port !== 49721 && options.host === '127.0.0.1')).toBe(true);
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
    const { createServer } = await vi.importActual<typeof import('node:http')>('node:http');
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
  it('rejects the original EACCES without fallback, network use or cleanup errors', async () => {
    const error = Object.assign(new Error('listen EACCES: permission denied 127.0.0.1:49721'), {
      code: 'EACCES', syscall: 'listen', address: '127.0.0.1', port: 49721,
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
    expect(evidence(log)).toEqual({ version: 1, pid: process.pid, startedAtEpochMs: numberMatcher,
      events: phases.map(phase => objectContaining({ phase, elapsedMs: numberMatcher,
        userCpuUs: numberMatcher, systemCpuUs: numberMatcher })) });
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
