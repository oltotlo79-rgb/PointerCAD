import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEM_PROTOCOL, FEM_RUNTIME_VERSION } from './protocol.js';
import { decodeNativeBoltPreload, prepareNativeBoltPreload } from './nativeBoltPreload.js';
import { decodeNativeBoltPreloadOwned, NATIVE_BOLT_KIND, prepareNativeBoltPreloadJob } from './nativeBoltPreloadBinding.js';
import type { PyodideRuntime } from './runtime.js';

// Fixed input and actual one-assembly/six-stage result; these are controlled replies, not another native execution.
const inputBytes = readFileSync(new URL('./nativeBoltPreload.input.fixture.json', import.meta.url), 'utf8');
const input: unknown = JSON.parse(inputBytes);
const raw: unknown = JSON.parse(readFileSync(new URL('./nativeBoltPreload.result.fixture.json', import.meta.url), 'utf8'));
if (raw === null || typeof raw !== 'object' || !('result' in raw) || raw.result === null || typeof raw.result !== 'object') throw Error('Invalid fixed raw');
const numeric = raw.result;
const source = { documentId: 'controlled-native-stages', revision: 7 };
const identity = { ...source, generation: 3, requestId: 'native-stages:3' };

function gateway(options: { corrupt?: string; missing?: string; foreignDigest?: boolean } = {}) {
  const files = new Map<string, string | Uint8Array>();
  const runPython = vi.fn((python: string): string => {
    expect(python).toContain('run_beam_bolt_preload_stages()');
    expect(python).not.toContain('run_beam_joint_initial_strain()');
    const encoded = files.get('/pcad_fem/bolt-preload-native-input.json');
    if (typeof encoded !== 'string') throw Error('Missing canonical plan');
    return JSON.stringify({ ...numeric, planSha256: options.foreignDigest ? 'a'.repeat(64) : createHash('sha256').update(encoded).digest('hex') });
  });
  const loadPackage = vi.fn(() => Promise.resolve(undefined));
  const runtime: PyodideRuntime = { version: FEM_RUNTIME_VERSION, FS: { mkdirTree: () => undefined, writeFile: (p, v) => { files.set(p, v); } }, runPython, loadPackage };
  // The loader execution gateway alone is controlled. Actual production inventory, bytes, sizes, hashes and fixed URL policy remain active.
  vi.stubGlobal('__pcadControlledBoltRuntime', runtime);
  const loaderURL = 'data:text/javascript,' + encodeURIComponent('export function loadPyodide(){return Promise.resolve(globalThis.__pcadControlledBoltRuntime);}');
  let blobCount = 0;
  const createBlob = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => ++blobCount === 1 ? loaderURL : 'blob:controlled-glue');
  const revokeBlob = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const assetFetch = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
    expect(init).toEqual({ redirect: 'error', credentials: 'same-origin', cache: 'no-store' });
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://pointercad.invalid');
    expect(parsed.pathname.startsWith('/fem/assets/')).toBe(true);
    const name = parsed.pathname.slice('/fem/assets/'.length);
    if (name.includes('/') || name.includes('..')) throw Error('Unexpected asset path');
    if (name === options.missing) return Promise.resolve(new Response(null, { status: 404 }));
    const bytes = new Uint8Array(readFileSync(new URL('../runtime/assets/' + name, import.meta.url)));
    if (name === options.corrupt) bytes[0] ^= 1;
    return Promise.resolve(new Response(bytes));
  });
  const replies: unknown[] = [];
  let finish: () => void = () => { throw Error('Not initialized'); };
  const closed = new Promise<void>(resolve => { finish = resolve; });
  const close = vi.fn(() => finish());
  const worker: {
    location: URL; fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    importScripts: (...scripts: string[]) => void; postMessage: (reply: unknown) => void;
    close: () => void; onmessage: ((event: MessageEvent<unknown>) => void) | null;
  } = {
    location: new URL('https://pointercad.invalid/fem/worker.js'),
    fetch: (url, init) => assetFetch(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url, init), importScripts: () => undefined,
    postMessage: reply => { replies.push(reply); }, close, onmessage: null,
  };
  vi.stubGlobal('self', worker);
  return { worker, replies, closed, assetFetch, loadPackage, runPython, files, createBlob, revokeBlob, close };
}
async function dispatch(g: ReturnType<typeof gateway>, plan: unknown = input) {
  // Reset module state between the one-shot Workers; this is module evaluation, not a browser/app process.
  await import('./worker.js');
  if (g.worker.onmessage === null) throw Error('Actual Worker dispatch was not registered');
  g.worker.onmessage(new MessageEvent<unknown>('message', { data: { protocol: FEM_PROTOCOL, kind: 'analyze-native-bolt-preload', identity, input: { source, plan } } }));
  await g.closed;
}
function resultReply(rows: readonly unknown[]): unknown {
  const row = rows.find(v => v !== null && typeof v === 'object' && 'kind' in v && v.kind === 'result');
  if (row === null || typeof row !== 'object' || !('result' in row)) throw Error('Missing dedicated result');
  return row.result;
}
function phases(rows: readonly unknown[]): unknown[] {
  return rows.flatMap(v => v !== null && typeof v === 'object' && 'kind' in v && v.kind === 'phase' && 'phase' in v ? [v.phase] : []);
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

describe('native preload actual Worker dispatch and verified offline path (controlled interpreter)', () => {
  it('dispatches to the dedicated native entry, preserves source/digest and releases only owned blobs', async () => {
    const g = gateway();
    await dispatch(g);
    const job = await prepareNativeBoltPreloadJob({ source, plan: input });
    const decoded = decodeNativeBoltPreloadOwned(resultReply(g.replies), job);
    expect(decoded.kind).toBe(NATIVE_BOLT_KIND); expect(decoded.source).toEqual(source);
    expect(decoded.planSha256).toBe(job.prepared.inputSha256);
    // Independent two-spring values: cb=10nm/N, cm=2.5nm/N, Fi=4000N, s=50um; P=1000N gives N=4200/Q=3200.
    expect(decoded.states[1].boltTensionN).toBeCloseTo(4200, 8); expect(decoded.states[1].memberCompressionN).toBeCloseTo(3200, 8);
    expect(Math.abs(decoded.states[4].gapM - 1e-8)).toBeLessThan(1e-12);
    expect(decoded.nativeContactSolver).toBe(false); expect(decoded.structuralCertification).toBe(false);
    expect(phases(g.replies)).toEqual(['loading-assets', 'loading-runtime', 'loading-packages', 'solving']);
    expect(g.replies.every(v => v !== null && typeof v === 'object' && 'identity' in v && JSON.stringify(v.identity) === JSON.stringify(identity))).toBe(true);
    expect(g.loadPackage).toHaveBeenCalledWith('https://pointercad.invalid/fem/assets/oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl', { checkIntegrity: true });
    expect(g.runPython).toHaveBeenCalledTimes(1); expect(g.files.size).toBe(6);
    expect(g.createBlob).toHaveBeenCalledTimes(2); expect(g.revokeBlob).toHaveBeenCalledTimes(2); expect(g.close).toHaveBeenCalledTimes(1);
    await expect(g.worker.fetch('https://outside.invalid/fem/assets/beamContact.py')).rejects.toThrow('offline-request-denied');
    await expect(g.worker.fetch('https://pointercad.invalid/fem/assets/beamContact.py', { method: 'POST' })).rejects.toThrow('offline-request-denied');
  });
  it('maps unsupported physics to invalid-protocol before any asset read or loader execution', async () => {
    const g = gateway(); await dispatch(g, { schema: 'unsupported-physics' });
    expect(g.replies).toHaveLength(1);
    expect(g.replies[0]).toMatchObject({ protocol: FEM_PROTOCOL, kind: 'failure', identity, failure: { code: 'invalid-protocol' } });
    const row = g.replies[0];
    if (row === null || typeof row !== 'object' || !('failure' in row) || row.failure === null || typeof row.failure !== 'object' || !('message' in row.failure)) throw Error('Missing validation failure');
    expect(row.failure.message).toContain('native-preload-input:');
    expect(g.assetFetch).not.toHaveBeenCalled(); expect(g.createBlob).not.toHaveBeenCalled(); expect(g.runPython).not.toHaveBeenCalled();
  });
  it('rejects a foreign native digest before producing a result and cleans up on decoder failure', async () => {
    const g = gateway({ foreignDigest: true }); await dispatch(g);
    expect(g.replies.at(-1)).toMatchObject({ kind: 'failure', identity, failure: { code: 'solver-failed' } });
    expect(g.replies.some(v => v !== null && typeof v === 'object' && 'kind' in v && v.kind === 'result')).toBe(false);
    expect(g.revokeBlob).toHaveBeenCalledTimes(2); expect(g.close).toHaveBeenCalledTimes(1);
    // A shape discriminator is never the physics/digest oracle.
    const prepared = await prepareNativeBoltPreload(input);
    expect(() => decodeNativeBoltPreload({ ...numeric, planSha256: 'a'.repeat(64) }, prepared)).toThrow();
  });
  it.each(['missing', 'corrupt'] as const)('refuses a %s pinned preload program before creating the interpreter', async failure => {
    const g = gateway(failure === 'missing' ? { missing: 'beamJointInitialStrain.py' } : { corrupt: 'beamJointInitialStrain.py' });
    await dispatch(g);
    const code = failure === 'missing' ? 'asset-missing' : 'asset-corrupt';
    expect(g.replies.at(-1)).toMatchObject({ kind: 'failure', identity, failure: { code } });
    expect(g.createBlob).not.toHaveBeenCalled(); expect(g.runPython).not.toHaveBeenCalled(); expect(g.close).toHaveBeenCalledTimes(1);
  });
});
