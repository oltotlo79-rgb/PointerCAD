import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as FrictionRuntimeModule from './frictionContactRuntime.js';
import type * as FrictionAssetsModule from './frictionContactAssets.js';
import { analyzeFrictionContactInBrowser } from './offlineBrowser.js';
import { bucklingFixture } from './buckling.testSupport.js';
import { FEM_RUNTIME_VERSION } from './protocol.js';
import type { BeamFrictionContactInput } from './frictionContactTranslation.js';
import type { FrictionSolveOptions } from './frictionContactResults.js';
import coreSource from '../runtime/assets/beamFrictionContact.py?raw';
import runtimeSource from '../runtime/assets/beamFrictionRuntime.py?raw';

const admitted = vi.hoisted(() => ({ analyze: vi.fn<typeof FrictionRuntimeModule.analyzeBeamFrictionContact>() }));
vi.mock('./frictionContactRuntime.js', async importOriginal => ({
  ...await importOriginal<typeof FrictionRuntimeModule>(), analyzeBeamFrictionContact: admitted.analyze,
}));
vi.mock('./assets.js', () => ({ FEM_ASSETS: [
  'pyodide.mjs', 'pyodide.asm.js', 'beamContact.py', 'pyodide-lock.json', 'python_stdlib.zip',
  'oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl',
].map(file => ({ file, bytes: 1, sha256: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a' })) }));
vi.mock('./frictionContactAssets.js', () => ({ FRICTION_CONTACT_ASSETS: [
  'beamFrictionContact.py', 'beamFrictionRuntime.py',
].map(file => ({ file, bytes: 1, sha256: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a' })) }));

const files = ['pyodide.mjs', 'pyodide.asm.js', 'beamContact.py', 'pyodide-lock.json', 'python_stdlib.zip',
  'oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl', 'beamFrictionContact.py', 'beamFrictionRuntime.py'];
const base = 'https://pointercad.invalid/fem/assets/';
const options: FrictionSolveOptions = { solver: 'newton', iterationLimit: 64 };

function fixture(): BeamFrictionContactInput {
  const beam = bucklingFixture({ segments: 1 });
  return { schema: 'pointercad-beam-friction-contact/1', geometry: beam.geometry, supports: beam.supports,
    contacts: [{ kind: 'node-plane', id: 'floor', nodeId: 'node-1', normal: [0, 0, 1], gapM: 0 }],
    friction: { floor: 0.3 },
    stepLoads: [[{ id: 'load', kind: 'nodal', nodeId: 'node-1', force: [5, 0, -10], moment: [0, 0, 0] }]] };
}

function workerWith(failure?: { file: string; kind: 'missing' | 'size' | 'hash' }) {
  const requests: string[] = [];
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    expect(init).toEqual({ redirect: 'error', credentials: 'same-origin', cache: 'no-store' });
    if (failure !== undefined && url.endsWith('/' + failure.file)) {
      if (failure.kind === 'missing') return Promise.resolve(new Response(null, { status: 404 }));
      return Promise.resolve(new Response(failure.kind === 'size' ? Uint8Array.of(1, 1) : Uint8Array.of(2)));
    }
    return Promise.resolve(new Response(Uint8Array.of(1)));
  });
  const worker = { location: new URL('https://pointercad.invalid/fem/worker.js'), fetch,
    importScripts: vi.fn(() => { throw new Error('No native interpreter may start'); }) };
  vi.stubGlobal('self', worker);
  return { worker, requests, fetch };
}

function fakeLoader() {
  const runtime = { version: FEM_RUNTIME_VERSION, FS: { mkdirTree: vi.fn(), writeFile: vi.fn() },
    runPython: vi.fn(), loadPackage: vi.fn(() => Promise.resolve(undefined)) };
  const load = vi.fn(() => Promise.resolve(runtime));
  vi.stubGlobal('__frictionOfflineLoad', load);
  const module = 'data:text/javascript,' + encodeURIComponent('export const loadPyodide = options => globalThis.__frictionOfflineLoad(options);');
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce(module).mockReturnValueOnce('blob:friction-glue');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  return { runtime, load, create, revoke, module };
}

afterEach(() => { admitted.analyze.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('friction-only offline admission (mock interpreter, no native execution)', () => {
  it('pins the actual two program bytes without changing the shared contact descriptor', async () => {
    const actual = await vi.importActual<typeof FrictionAssetsModule>('./frictionContactAssets.js');
    expect(actual.FRICTION_CONTACT_ASSETS).toEqual([
      { file: 'beamFrictionContact.py', bytes: 39720, sha256: 'd21581ea5eb16b2cb587000c19db91479cc8cbba5d2314cfcc9d0abe0190d803' },
      { file: 'beamFrictionRuntime.py', bytes: 2257, sha256: '88d9e94bdd3512a0f31769a6fce2730e23b4eacafc084edc14f29edb647b4cdb' },
    ]);
    for (const [index, source] of [coreSource, runtimeSource].entries()) {
      const bytes = new TextEncoder().encode(source), pin = actual.FRICTION_CONTACT_ASSETS[index];
      expect(bytes.byteLength).toBe(pin.bytes);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
      expect(hash).toBe(pin.sha256);
    }
  });

  it('rejects invalid input before origin, fetch, phases or interpreter access', async () => {
    const read = vi.fn(() => { throw new Error('Origin must not be read'); });
    vi.stubGlobal('self', { get location() { return read(); } });
    const phase = vi.fn();
    await expect(analyzeFrictionContactInBrowser({}, options, phase)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled(); expect(phase).not.toHaveBeenCalled();
    expect(admitted.analyze).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN, Infinity, 1.5])('rejects iterationLimit %s before origin or fetch', async iterationLimit => {
    const read = vi.fn(() => { throw new Error('Origin must not be read'); });
    vi.stubGlobal('self', { get location() { return read(); } });
    await expect(analyzeFrictionContactInBrowser(fixture(), { solver: 'newton', iterationLimit }, () => undefined)).rejects.toThrow('friction-options');
    expect(read).not.toHaveBeenCalled(); expect(admitted.analyze).not.toHaveBeenCalled();
  });

  it('rejects extra options and accessors without invoking their getter', async () => {
    const { fetch } = workerWith();
    const extra = { ...options, extra: true };
    await expect(analyzeFrictionContactInBrowser(fixture(), extra, () => undefined)).rejects.toThrow();
    const get = vi.fn(() => 'newton');
    const accessor = Object.defineProperty({ ...options }, 'solver', { enumerable: true, get });
    await expect(analyzeFrictionContactInBrowser(fixture(), accessor, () => undefined)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['beamFrictionContact.py', 'beamFrictionRuntime.py'])('rejects missing/size/hash substitution of %s before interpreter loading', async file => {
    for (const kind of ['missing', 'size', 'hash'] as const) {
      const { requests, worker } = workerWith({ file, kind });
      const phase = vi.fn();
      await expect(analyzeFrictionContactInBrowser(fixture(), options, phase)).rejects.toThrow(
        kind === 'missing' ? 'asset-missing: ' + file : 'asset-corrupt: ' + file);
      expect(requests).toContain(base + file);
      expect(phase.mock.calls).toEqual([['loading-assets']]);
      expect(worker.importScripts).not.toHaveBeenCalled(); expect(admitted.analyze).not.toHaveBeenCalled();
    }
  });

  it('keeps the same origin/redirect policy and denies replacement programs and external requests', async () => {
    const { requests, worker, fetch } = workerWith();
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:friction-module').mockReturnValueOnce('blob:friction-glue');
    const stop = new Error('Cancel before interpreter import');
    await expect(analyzeFrictionContactInBrowser(fixture(), options, phase => {
      if (phase === 'loading-runtime') throw stop;
    })).rejects.toBe(stop);
    expect(requests).toEqual(files.map(file => base + file));
    const admittedBytes = await worker.fetch(base + 'beamFrictionContact.py');
    expect(new Uint8Array(await admittedBytes.arrayBuffer())).toEqual(Uint8Array.of(1));
    await expect(worker.fetch('https://outside.invalid/beamFrictionContact.py')).rejects.toThrow('offline-request-denied');
    await expect(worker.fetch(base + 'replacement.py')).rejects.toThrow('offline-request-denied');
    await expect(worker.fetch(base + 'beamFrictionContact.py', { method: 'POST', body: 'replacement' })).rejects.toThrow('offline-request-denied');
    expect(fetch).toHaveBeenCalledTimes(files.length);
    expect(revoke.mock.calls).toEqual([['blob:friction-module'], ['blob:friction-glue']]);
    expect(admitted.analyze).not.toHaveBeenCalled();
  });

  it('owns input/options before the first asset await and passes only verified programs', async () => {
    const { requests } = workerWith(), loader = fakeLoader();
    const input = fixture(), mutableOptions = { solver: 'newton' as const, iterationLimit: 64 };
    const stop = new Error('Mock friction solver reached');
    admitted.analyze.mockRejectedValueOnce(stop);
    const pending = analyzeFrictionContactInBrowser(input, mutableOptions, () => undefined);
    Object.defineProperty(input.friction, 'floor', { value: 99 });
    Object.defineProperty(input.stepLoads[0][0], 'force', { value: [99, 0, -10] });
    mutableOptions.iterationLimit = 1;
    await expect(pending).rejects.toBe(stop);
    expect(loader.load).toHaveBeenCalledOnce(); expect(admitted.analyze).toHaveBeenCalledOnce();
    const call = admitted.analyze.mock.calls[0];
    expect(call[1]).toMatchObject({ friction: { floor: 0.3 }, stepLoads: [[{ force: [5, 0, -10] }]] });
    expect(call[3]).toEqual({ solver: 'newton', iterationLimit: 64 });
    expect(call[2]).toEqual({ contactWrapper: Uint8Array.of(1), coreWrapper: Uint8Array.of(1), runtimeWrapper: Uint8Array.of(1),
      wheelLocation: base + 'oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl' });
    expect(requests).toEqual(files.map(file => base + file));
    expect(loader.revoke.mock.calls).toEqual([[loader.module], ['blob:friction-glue']]);
  });

  it('rejects invalid origin before any asset fetch', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('self', { location: new URL('file:///fem/worker.js'), fetch });
    await expect(analyzeFrictionContactInBrowser(fixture(), options, () => undefined)).rejects.toThrow('Invalid FEM asset origin');
    expect(fetch).not.toHaveBeenCalled();
  });
});
