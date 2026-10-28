import { net } from 'electron';
import type { Session } from 'electron';
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DESKTOP_OCCT_TRANSPORT_ORIGIN, desktopOcctTransportUrl,
  type DesktopOcctTransportReply } from '@pointercad/ui/desktop-occt-transport';

const TIMEOUT_MS = 25000;
const MAX_BYTES = 256 * 1024 * 1024;
const APP_ORIGIN = 'app://pointercad';

type TransportMark = (phase: string, byteLength?: number) => void;
const ignoreTransportMark: TransportMark = () => undefined;

/** 診断を明示した起動だけ、待ちを含む壁時間とmain全体のCPU時間を記録する。 */
function createTransportTrace(): { mark: TransportMark; flush: () => void } {
  if (process.env['PCAD_OCCT_TRANSPORT_TRACE'] !== '1') {
    return { mark: ignoreTransportMark, flush: () => undefined };
  }
  const started = performance.now();
  const startedAtEpochMs = performance.timeOrigin + started;
  const cpu = process.cpuUsage();
  const events: {
    phase: string;
    elapsedMs: number;
    userCpuUs: number;
    systemCpuUs: number;
    byteLength?: number;
  }[] = [];
  return {
    mark: (phase, byteLength) => {
      try {
        const elapsedMs = performance.now() - started;
        const used = process.cpuUsage(cpu);
        events.push({ phase, elapsedMs, userCpuUs: used.user, systemCpuUs: used.system,
          ...(byteLength === undefined ? {} : { byteLength }) });
      } catch { /* 診断の失敗で検証結果を変えない。 */ }
    },
    flush: () => {
      try {
        console.info('[pcad:occt-http-phases] ' + JSON.stringify({
          version: 1, pid: process.pid, startedAtEpochMs, events,
        }));
      } catch { /* 診断の出力失敗で取得の成否を変えない。 */ }
    },
  };
}

const endpoint = new URL(DESKTOP_OCCT_TRANSPORT_ORIGIN);
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid OCCT metadata');
  return Object.fromEntries(Object.entries(value));
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid OCCT hash');
  return value;
}
function length(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > MAX_BYTES) {
    throw new Error('Invalid OCCT byte length');
  }
  return value;
}
export interface OcctHttpAsset { sha256: string; byteLength: number; gzip: Buffer; transportSha256: string }

/** Only build-produced fixed names are accepted; metadata cannot choose arbitrary paths. */
export async function readOcctHttpAsset(rendererRoot: string): Promise<OcctHttpAsset> {
  return readObservedOcctHttpAsset(rendererRoot, ignoreTransportMark);
}

/** 元の資産検証を保ち、読取り・復号・照合の区間だけを記録する。 */
async function readObservedOcctHttpAsset(rendererRoot: string, mark: TransportMark): Promise<OcctHttpAsset> {
  mark('manifest-start');
  const manifest = record(JSON.parse(await readFile(join(rendererRoot, 'occt/manifest.json'), 'utf8')));
  const stream = record(manifest['stream']);
  const sha256 = hash(manifest['sha256']);
  const byteLength = length(manifest['byteLength']);
  const transportSha256 = hash(stream['transportSha256']);
  const transportLength = length(stream['transportByteLength']);
  const parts = manifest['parts'];
  if (!Array.isArray(parts) || parts.length !== 1) throw new Error('Invalid OCCT gzip parts');
  const part = record(parts[0]);
  if (part['order'] !== 0 || part['file'] !== `opencascade.full-${sha256.slice(0, 16)}.bin`
      || part['byteLength'] !== transportLength) throw new Error('OCCT gzip part metadata mismatch');
  const file = `stream/opencascade.full-${sha256}.wasm`;
  if (manifest['compression'] !== 'gzip' || stream['compression'] !== 'gzip' || stream['file'] !== file
      || stream['decodedSha256'] !== sha256 || stream['decodedByteLength'] !== byteLength) {
    throw new Error('OCCT transport metadata differs from decoded asset');
  }
  mark('manifest-validated');
  const gzip = await readFile(join(rendererRoot, 'occt', file));
  mark('gzip-read', gzip.length);
  if (gzip.length !== transportLength || sha(gzip) !== transportSha256) throw new Error('Corrupt OCCT gzip asset');
  mark('transport-verified', gzip.length);
  const decoded = gunzipSync(gzip, { maxOutputLength: byteLength });
  mark('decoded-inflated', decoded.length);
  if (decoded.length !== byteLength || sha(decoded) !== sha256) throw new Error('Corrupt decoded OCCT asset');
  mark('decoded-verified', decoded.length);
  return { sha256, byteLength, gzip, transportSha256 };
}

export function serveOcctHttpAsset(asset: OcctHttpAsset, request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  const expectedPath = new URL(desktopOcctTransportUrl(asset.sha256)).pathname;
  const count = (name: string): number => request.rawHeaders.filter((_, index) =>
    index % 2 === 0 && request.rawHeaders[index]?.toLowerCase() === name).length;
  if (request.method !== 'GET' || request.url !== expectedPath || request.headers.host !== endpoint.host
      || request.headers['transfer-encoding'] !== undefined
      || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')
      || count('host') !== 1 || count('origin') > 1 || (origin !== undefined && origin !== APP_ORIGIN)) {
    response.writeHead(403, { 'Cache-Control': 'no-store' });
    response.end();
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip',
    'Content-Length': asset.gzip.length, 'Cache-Control': 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': APP_ORIGIN, 'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Expose-Headers': 'Content-Encoding',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff', ETag: `"${asset.transportSha256}"`,
  });
  response.end(asset.gzip);
}

/** request.close is diagnostic only. Only response.end plus full decoded integrity accepts. */
export function readSessionOcctCache(targetSession: Session, url: string, asset: OcctHttpAsset): Promise<'hit' | 'miss'> {
  return readObservedSessionOcctCache(targetSession, url, asset, ignoreTransportMark);
}

/** 本文終端までの照合とmiss・破損の区別を保って記録する。 */
function readObservedSessionOcctCache(
  targetSession: Session, url: string, asset: OcctHttpAsset, mark: TransportMark,
): Promise<'hit' | 'miss'> {
  mark('cache-start');
  return new Promise((resolve, reject) => {
    const request = net.request({ session: targetSession, url, method: 'GET', credentials: 'include',
      cache: 'only-if-cached', redirect: 'error' });
    let settled = false;
    let ended = false;
    let receivedResponse = false;
    const finish = (error?: Error, result?: 'hit' | 'miss'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) {
        mark('cache-rejected');
        reject(error);
      } else if (result !== undefined) {
        mark(result === 'hit' ? 'cache-hit' : 'cache-miss');
        resolve(result);
      }
    };
    const timer = setTimeout(() => { finish(new Error('OCCT cache-only timeout')); request.abort(); }, TIMEOUT_MS);
    request.on('error', error => {
      if (!receivedResponse && /(?:^|\s|:)net::ERR_CACHE_MISS(?:\s|$)/.test(error.message)) finish(undefined, 'miss');
      else finish(error);
    });
    request.on('abort', () => { finish(new Error('OCCT cache-only aborted')); });
    request.on('close', () => { console.info('[pcad:occt-http] cache-only request closed'); });
    request.on('response', response => {
      receivedResponse = true;
      mark('cache-headers');
      const digest = createHash('sha256');
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > asset.byteLength) { finish(new Error('Oversized cached OCCT body')); request.abort(); return; }
        digest.update(chunk);
      });
      response.on('error', error => { finish(error); });
      response.on('aborted', () => { finish(new Error('Cached OCCT response aborted')); });
      // Electron narrows on/addListener overloads; its declared Node EventEmitter base retains close.
      const responseEvents: NodeJS.EventEmitter = response;
      responseEvents.addListener('close', () => { if (!ended) finish(new Error('Cached OCCT response incomplete')); });
      response.on('end', () => {
        ended = true;
        mark('cache-body-end', bytes);
        if (response.statusCode !== 200 || header(response.headers['content-type']) !== 'application/wasm'
            || header(response.headers['content-encoding']) !== 'gzip'
            || header(response.headers['content-length']) !== String(asset.gzip.length)
            || bytes !== asset.byteLength || digest.digest('hex') !== asset.sha256) {
          finish(new Error('Cached OCCT response integrity mismatch'));
        } else finish(undefined, 'hit');
      });
    });
    request.end();
  });
}

export function createOcctHttpTransport(rendererRoot: string, targetSession: Session): {
  prepare: () => Promise<DesktopOcctTransportReply>; close: () => Promise<void>;
} {
  let owned: Server | undefined;
  let pending: Promise<DesktopOcctTransportReply> | undefined;
  let closed = false;
  async function prepare(mark: TransportMark): Promise<DesktopOcctTransportReply> {
    mark('prepare-start');
    if (closed) throw new Error('OCCT transport closed');
    const asset = await readObservedOcctHttpAsset(rendererRoot, mark);
    if (closed) throw new Error('OCCT transport closed');
    const server = createServer((request, response) => { serveOcctHttpAsset(asset, request, response); });
    server.requestTimeout = TIMEOUT_MS;
    server.headersTimeout = TIMEOUT_MS;
    server.setTimeout(TIMEOUT_MS, socket => { socket.destroy(); });
    const listenerAbort = new AbortController();
    mark('listener-start');
    const listening = await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => { listenerAbort.abort(); reject(new Error('OCCT listener timeout')); }, TIMEOUT_MS);
      server.once('error', error => {
        clearTimeout(timer);
        if ('code' in error && error.code === 'EADDRINUSE') resolve(false);
        else reject(error);
      });
      server.listen({ port: Number(endpoint.port), host: endpoint.hostname, signal: listenerAbort.signal },
        () => { clearTimeout(timer); resolve(true); });
    });
    if (!listening) {
      mark('prepare-direct-port-unavailable');
      return { kind: 'direct', reason: 'port-unavailable' };
    }
    mark('listener-ready');
    owned = server;
    server.unref();
    if (closed) { await close(); throw new Error('OCCT transport closed'); }
    const url = desktopOcctTransportUrl(asset.sha256);
    if (await readObservedSessionOcctCache(targetSession, url, asset, mark) === 'miss') {
      mark('fill-start');
      const response = await targetSession.fetch(url, { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
      mark('fill-headers');
      // Electron session.fetch wraps the response; its URL is empty even on success.
      // The requested URL is fixed above and redirects are forbidden.
      if (!response.ok || response.headers.get('content-type') !== 'application/wasm'
          || response.headers.get('content-encoding') !== 'gzip'
          || response.headers.get('content-length') !== String(asset.gzip.length)) {
        throw new Error('OCCT HTTP response metadata mismatch');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      mark('fill-body-end', bytes.length);
      if (bytes.length !== asset.byteLength || sha(bytes) !== asset.sha256) throw new Error('OCCT HTTP body mismatch');
      mark('fill-verified', bytes.length);
    }
    mark('prepare-http');
    return { kind: 'http', url, sha256: asset.sha256, byteLength: asset.byteLength };
  }
  async function close(): Promise<void> {
    closed = true;
    const server = owned;
    owned = undefined;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('OCCT listener close timeout')); }, TIMEOUT_MS);
      server.close(error => { clearTimeout(timer); if (error) reject(error); else resolve(); });
    });
  }
  return { prepare: () => {
    if (closed) return Promise.reject(new Error('OCCT transport closed'));
    if (pending === undefined) {
      const trace = createTransportTrace();
      pending = prepare(trace.mark).catch(async (error: unknown) => {
        trace.mark('prepare-rejected');
        await close();
        throw error;
      }).finally(() => {
        trace.mark('prepare-settled');
        trace.flush();
      });
    }
    return pending;
  }, close };
}
