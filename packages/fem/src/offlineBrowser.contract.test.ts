import type { BeamWeldSpanContactInput } from './beamWeldSpanContact.js';
import { modalFixture } from './modal.testSupport.js';
import { analyzeWeldSpanContactInBrowser } from './offlineBrowser.js';
import { analyzeSolidContactInBrowser } from './offlineBrowser.js';
import type { FrameBoltContactInput } from './beamBoltContact.js';
import { axialOscillator, transientHistory } from './transient.testSupport.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { analyzeImpactInBrowser, analyzeSolidInBrowser, qualifyInBrowser, analyzeFrameBoltContactInBrowser } from './offlineBrowser.js';
import { bucklingFixture } from './buckling.testSupport.js';
import type { BeamImpactInput } from './beamImpactModel.js';
import type { SolidAnalysisInput } from './solidAnalysisModel.js';

vi.mock('./assets.js', () => ({ FEM_ASSETS: ['pyodide.mjs', 'pyodide.asm.js'].map(file => ({
  file, bytes: 1, sha256: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a',
})), BOLT_CONTACT_ASSETS: ['beamContact.py', 'beamBoltContact.py'].map(file => ({ file, bytes: 1,
  sha256: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a' })), SOLID_ASSETS: [{ file: 'solidAnalysis.py', bytes: 1,
  sha256: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a' }] }));
vi.mock('./beamImpactAssets.js', () => ({ BEAM_IMPACT_ASSETS: [{ file: 'beamImpact.py', bytes: 1,
  sha256: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a' }] }));

afterEach(() => { vi.unstubAllGlobals(); });

describe('verified offline fetch contract', () => {
  it('rejects invalid contact input before origin, assets or native initialization', async () => {
    const read = vi.fn(() => { throw new Error('Asset origin must not be read'); });
    vi.stubGlobal('self', { get location() { return read(); } });
    const phases: string[] = [];
    await expect(analyzeSolidContactInBrowser({}, phase => { phases.push(phase); })).rejects.toThrow();
    expect(read).not.toHaveBeenCalled(); expect(phases).toEqual([]);
  });
  it.each(['missing', 'corrupt'] as const)('refuses a %s solid wrapper before interpreter creation', async failure => {
    const input: SolidAnalysisInput = { schema: 'pointercad-solid-tet4/1', source: { documentId: 's', revision: 1, meshKey: 's:1' },
      units: 'N-mm-MPa', numericBudgetBytes: 1000000, nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
      elements: [{ nodes: [0, 1, 2, 3], materialId: 'm' }], materials: [{ id: 'm', youngMPa: 6, poisson: 0 }],
      constraints: [0, 1, 2, 3].map(node => ({ node, fixed: [true, true, true] })), nodalLoads: [], surfaceLoads: [] };
    const phases: string[] = [], requested: string[] = [];
    vi.stubGlobal('self', { location: new URL('https://pointercad.invalid/fem/worker.js'),
      fetch: (url: string): Promise<Response> => {
        requested.push(url);
        const solid = url.endsWith('/solidAnalysis.py');
        return Promise.resolve(solid && failure === 'missing' ? new Response(null, { status: 404 })
          : new Response(Uint8Array.of(solid ? 2 : 1)));
      }, importScripts: () => { throw new Error('No native interpreter may start'); } });
    await expect(analyzeSolidInBrowser(input, phase => { phases.push(phase); }))
      .rejects.toThrow(failure === 'missing' ? 'asset-missing: solidAnalysis.py' : 'asset-corrupt: solidAnalysis.py');
    expect(phases).toEqual(['loading-assets']);
    expect(requested).toContain('https://pointercad.invalid/fem/assets/solidAnalysis.py');
  });
  it.each(['missing', 'corrupt'] as const)('refuses a %s impact wrapper before interpreter creation', async failure => {
    const phases: string[] = [], requested: string[] = [];
    vi.stubGlobal('self', { location: new URL('https://pointercad.invalid/fem/worker.js'),
      fetch: (url: string): Promise<Response> => {
        requested.push(url);
        const impact = url.endsWith('/beamImpact.py');
        return Promise.resolve(impact && failure === 'missing' ? new Response(null, { status: 404 })
          : new Response(Uint8Array.of(impact ? 2 : 1)));
      }, importScripts: () => { throw new Error('No native interpreter may start'); } });
    const input: BeamImpactInput = { schema: 'pointercad-beam-impact/1', geometry: bucklingFixture({ segments: 2 }).geometry,
      supports: [{ nodeId: 'node-0', restrained: [true, true, true, true, true, true] }],
      initialVelocities: [{ nodeId: 'node-1', velocityMPerS: [0.01, 0, 0] }],
      contacts: [{ nodeId: 'node-1', directionUnit: [1, 0, 0], gapM: 0.001 }], contactStiffnessNPerM: 1e7,
      history: { timeStepS: 1e-5, stepCount: 10, outputEvery: 5 } };
    await expect(analyzeImpactInBrowser(input, phase => { phases.push(phase); }))
      .rejects.toThrow(failure === 'missing' ? 'asset-missing: beamImpact.py' : 'asset-corrupt: beamImpact.py');
    expect(phases).toEqual(['loading-assets']);
    expect(requested).toContain('https://pointercad.invalid/fem/assets/beamImpact.py');
  });
  it('serves verified bytes and rejects disallowed methods/origins/invalid URLs through Promise', async () => {
    let initialReads = 0;
    const worker: { location: URL; fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
      importScripts: (...scripts: string[]) => void } = { location: new URL('https://pointercad.invalid/fem/worker.js'),
      fetch: (): Promise<Response> => {
        initialReads += 1;
        return Promise.resolve(new Response(Uint8Array.of(1)));
      }, importScripts: () => undefined };
    vi.stubGlobal('self', worker);
    const stop = new Error('Stop before importing the actual interpreter');
    await expect(qualifyInBrowser(phase => { if (phase === 'loading-runtime') throw stop; })).rejects.toBe(stop);
    expect(initialReads).toBe(2);
    const result = await worker.fetch('https://pointercad.invalid/fem/assets/pyodide.mjs');
    expect(result.status).toBe(200);
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(Uint8Array.of(1));
    for (const [input, init] of [
      ['https://outside.invalid/pyodide.mjs', undefined],
      ['https://pointercad.invalid/fem/assets/pyodide.mjs', { method: 'POST' }],
      ['https://pointercad.invalid/fem/assets/unknown.js', undefined],
    ] as const) {
      let rejected: Promise<Response> | undefined;
      expect(() => { rejected = worker.fetch(input, init); }).not.toThrow();
      if (rejected === undefined) throw new Error('Offline fetch did not return a Promise');
      await expect(rejected).rejects.toThrow('offline-request-denied');
    }
    let invalid: Promise<Response> | undefined;
    expect(() => { invalid = worker.fetch('http://['); }).not.toThrow();
    await expect(invalid).rejects.toBeInstanceOf(TypeError);
    expect(initialReads).toBe(2);
  });
});

const source = { kind: 'user-supplied', reference: 'Independent synthetic frame fixture', condition: 'Linear centroidal Timoshenko shank only' } as const;
const quantity = (role: string, value: number) => ({ role, value, source });
function frameInput(): FrameBoltContactInput {
  const base = axialOscillator(transientHistory(1e-4, 10, [[0, 1], [10, 1]]));
  return { schema: 'pointercad-frame-bolt-contact/1', contact: { schema: 'pointercad-beam-contact/1',
    geometry: { ...base.geometry, nodes: [{ id: 'node-0', position: [0, 0, 0] }, { id: 'node-1', position: [0.1, 0, 0] }],
      materials: base.geometry.materials.map(m => ({ ...m, youngModulus: 200e9, shearModulus: 80e9 })),
      sections: base.geometry.sections.map(s => ({ ...s, area: 1e-4, iy: 1e-8, iz: 1e-8, torsionConstant: 2e-8, shearFactor: 5 / 6 })) },
    supports: [base.supports[0]], referenceLoads: base.referenceLoads,
    contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'node-1', normal: [1, 0, 0], gapM: 0.001 }], loadFactors: [1] },
    bolt: { id: 'frame-bolt', memberId: 'member-0', model: 'centroidal-frame-shank-explicit-end-coupling', couplingSource: source,
      shorteningM: quantity('shortening-m', 0), threadCompliance: quantity('thread-compliance-m-per-n', 0),
      headCompliance: quantity('head-compliance-m-per-n', 0), bearingCompliance: quantity('bearing-compliance-m-per-n', 0),
      section: { materialConditionId: 'synthetic', tensileArea: quantity('tensile-area-m2', 8e-5), shearArea: quantity('plain-shank-shear-area-m2', 1e-4),
        modulusY: quantity('section-modulus-y-m3', 2e-6), modulusZ: quantity('section-modulus-z-m3', 2e-6),
        fibreYM: quantity('extreme-y-m', 0.005), fibreZM: quantity('extreme-z-m', 0.005), limits: null } } };
}

describe('frame offlineの検証前拒否と固定2program境界', () => {
  it('入力の拒否がorigin/資産アクセスより先に起きる', async () => {
    const read = vi.fn(() => { throw new Error('Asset boundary must not execute'); });
    vi.stubGlobal('self', { get location() { return read(); } });
    const phases: string[] = [];
    await expect(analyzeFrameBoltContactInBrowser({}, phase => { phases.push(phase); })).rejects.toThrow();
    expect(read).not.toHaveBeenCalled(); expect(phases).toEqual([]);
  });
  it.each(['beamContact.py', 'beamBoltContact.py'] as const)('%sの欠落/改変をinterpreter前に拒否する', async file => {
    for (const corrupt of [false, true]) {
      const requests: string[] = [], phases: string[] = [];
      vi.stubGlobal('self', { location: new URL('https://pointercad.invalid/fem/worker.js'),
        fetch: (url: string): Promise<Response> => { requests.push(url);
          return Promise.resolve(url.endsWith('/'+file) && !corrupt ? new Response(null, { status: 404 })
            : new Response(Uint8Array.of(url.endsWith('/'+file) ? 2 : 1))); },
        importScripts: () => { throw new Error('Interpreter must not start'); } });
      await expect(analyzeFrameBoltContactInBrowser(frameInput(), phase => { phases.push(phase); }))
        .rejects.toThrow(corrupt ? 'asset-corrupt: '+file : 'asset-missing: '+file);
      expect(requests).toContain('https://pointercad.invalid/fem/assets/'+file); expect(phases).toEqual(['loading-assets']);
    }
  });
  it('検証済み2programだけを保持し、外部fetch拒否とBlob URL解放を保つ', async () => {
    const requests: string[] = [], phases: string[] = [];
    const worker = { location: new URL('https://pointercad.invalid/fem/worker.js'),
      fetch: (url: RequestInfo | URL): Promise<Response> => { requests.push(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url); return Promise.resolve(new Response(Uint8Array.of(1))); },
      importScripts: () => undefined };
    vi.stubGlobal('self', worker);
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:frame-module').mockReturnValueOnce('blob:frame-glue');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const stop = new Error('Stop before actual interpreter import');
    try {
      await expect(analyzeFrameBoltContactInBrowser(frameInput(), phase => { phases.push(phase); if (phase === 'loading-runtime') throw stop; })).rejects.toBe(stop);
      expect(requests).toEqual(['pyodide.mjs', 'pyodide.asm.js', 'beamContact.py', 'beamBoltContact.py'].map(file => 'https://pointercad.invalid/fem/assets/'+file));
      expect(phases).toEqual(['loading-assets', 'loading-runtime']);
      await expect(worker.fetch('https://outside.invalid/fem/assets/beamBoltContact.py')).rejects.toThrow('offline-request-denied');
      expect(revoke.mock.calls).toEqual([['blob:frame-module'], ['blob:frame-glue']]);
    } finally { create.mockRestore(); revoke.mockRestore(); }
  });
});

vi.mock('./beamWeldSpanAssets.js', () => ({ WELD_SPAN_CONTACT_ASSETS: ['beamWeldSpanBase.py','beamWeldSpan.py','beamWeldSpanContact.py'].map(file => ({ file, bytes: 1, sha256: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a' })) }));

function spanInput(segments = 1): BeamWeldSpanContactInput {
  const base = modalFixture({ free: true, modes: 1, segments });
  return { schema: 'pointercad-weld-span/1', contact: { schema: 'pointercad-beam-contact/1',
    geometry: { ...base, nodes: [0, 2, 0, 2].map((x, i) => ({ id: `n${i}`, position: [x, 0, 0] })),
      members: ['a', 'b'].map((id, i) => ({ ...base.members[0], id, componentId: id, occurrencePath: [id],
        startNodeId: `n${2*i}`, endNodeId: `n${2*i+1}` })),
      materials: [{ ...base.materials[0], youngModulus: 1000, shearModulus: 400, densityKgM3: 1 }],
      sections: [{ ...base.sections[0], area: 1, iy: .1, iz: .1, torsionConstant: .1, shearFactor: 1 }] },
    supports: [0, 1, 2, 3].map(i => ({ nodeId: `n${i}`, restrained: [i%2 === 0, true, true, true, true, true] })),
    referenceLoads: [{ id: 'load', kind: 'nodal', nodeId: 'n3', force: [1, 0, 0], moment: [0, 0, 0] }],
    contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'n3', normal: [-1, 0, 0], gapM: .01 }], loadFactors: [1] },
    patches: [{ id: 'layer', centerM: [1, 0, 0], normal: [0, 1, 0], along: [1, 0, 0], widthM: 2, lengthM: 1,
      thicknessM: .2, youngPa: 1000, poisson: .25, first: { kind: 'member-span', memberId: 'a' },
      second: { kind: 'member-span', memberId: 'b' } }] };
}

describe('span-only offline asset admission without executing an interpreter', () => {
  it('rejects invalid span input before reading origin or fetching assets', async () => {
    const read = vi.fn(() => { throw new Error('origin must not be read'); });
    vi.stubGlobal('self', { get location() { return read(); } });
    await expect(analyzeWeldSpanContactInBrowser({}, () => undefined)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it.each(['beamWeldSpanBase.py', 'beamWeldSpan.py', 'beamWeldSpanContact.py'] as const)('refuses missing/corrupt %s before interpreter creation', async file => {
    for (const corrupt of [false, true]) {
      const requests: string[] = [];
      vi.stubGlobal('self', { location: new URL('https://pointercad.invalid/fem/worker.js'),
        fetch: (url: string, init?: RequestInit): Promise<Response> => {
          requests.push(url); expect(init).toEqual({ redirect: 'error', credentials: 'same-origin', cache: 'no-store' });
          return Promise.resolve(url.endsWith('/'+file) && !corrupt ? new Response(null, { status: 404 })
            : new Response(Uint8Array.of(url.endsWith('/'+file) ? 2 : 1))); },
        importScripts: () => { throw new Error('interpreter must not start'); } });
      await expect(analyzeWeldSpanContactInBrowser(spanInput(), () => undefined)).rejects.toThrow((corrupt ? 'asset-corrupt: ' : 'asset-missing: ')+file);
      expect(requests).toContain('https://pointercad.invalid/fem/assets/'+file);
      expect(requests.some(url => url.endsWith('/beamContact.py'))).toBe(false);
    }
  });
  it('selects only the span additions, denies the excluded legacy program, and revokes its Blob URLs', async () => {
    const requests: string[] = [], stop = new Error('Stop before actual interpreter');
    const worker = { location: new URL('https://pointercad.invalid/fem/worker.js'),
      fetch: (url: RequestInfo | URL): Promise<Response> => { requests.push(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url); return Promise.resolve(new Response(Uint8Array.of(1))); }, importScripts: () => undefined };
    vi.stubGlobal('self', worker);
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:span-module').mockReturnValueOnce('blob:span-glue');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    try {
      await expect(analyzeWeldSpanContactInBrowser(spanInput(), phase => { if (phase === 'loading-runtime') throw stop; })).rejects.toBe(stop);
      expect(requests).toEqual(['pyodide.mjs','pyodide.asm.js','beamWeldSpanBase.py','beamWeldSpan.py','beamWeldSpanContact.py'].map(file => 'https://pointercad.invalid/fem/assets/'+file));
      await expect(worker.fetch('https://pointercad.invalid/fem/assets/beamContact.py')).rejects.toThrow('offline-request-denied');
      await expect(worker.fetch('https://outside.invalid/fem/assets/beamWeldSpan.py')).rejects.toThrow('offline-request-denied');
      expect(revoke.mock.calls).toEqual([['blob:span-module'], ['blob:span-glue']]);
    } finally { create.mockRestore(); revoke.mockRestore(); }
  });
});

// E26: the three Pyodide runtime files are the CSP exception's precondition (blob: + unsafe-eval only in /fem/worker.js).
// Fixed known bytes; each SHA-256 was computed outside the product (Python hashlib), never from the code under test.
const encoder = new TextEncoder();
const PINNED_RUNTIME = [
  { file: 'pyodide.mjs', bytes: encoder.encode('pcad-fixed-module'),
    sha256: '5efe7cdb32a81b0e7eaf616ea7a6d19f42645fe5e546a4143f869b89cbcc11f2' },
  { file: 'pyodide.asm.js', bytes: encoder.encode('pcad-fixed-glue'),
    sha256: 'c3b5f81d5b9a26fe98eaf6afd09f8e72611161436808996b0b3a2cf12ad94656' },
  // The 8-byte empty WebAssembly module.
  { file: 'pyodide.asm.wasm', bytes: Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00),
    sha256: '93a44bbb96c751218e4c00d479e4c14358122a389acca16205b1e4d0dc5f9476' },
] as const;
const ASSET_BASE = 'https://pointercad.invalid/fem/assets/';
const INITIAL_READ = { redirect: 'error', credentials: 'same-origin', cache: 'no-store' };

/** A fresh offlineBrowser instance whose FEM_ASSETS are exactly the three pinned runtime files. */
async function pinnedRuntimeOffline() {
  vi.resetModules();
  vi.doMock('./assets.js', () => ({ FEM_ASSETS: PINNED_RUNTIME.map(({ file, bytes, sha256 }) => ({ file, bytes: bytes.byteLength, sha256 })) }));
  return await import('./offlineBrowser.js');
}
function pinnedWorker(serve: (file: string) => Response, location = 'https://pointercad.invalid/fem/worker.js') {
  const reads: { readonly url: string; readonly init: RequestInit | undefined }[] = [], scripts: string[][] = [];
  const worker = { location: new URL(location),
    fetch: (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      reads.push({ url, init });
      return Promise.resolve(serve(url.startsWith(ASSET_BASE) ? url.slice(ASSET_BASE.length) : url));
    },
    importScripts: (...names: string[]): void => { scripts.push(names); } };
  vi.stubGlobal('self', worker);
  return { worker, reads, scripts };
}
const servePinned = (file: string): Response => {
  const pin = PINNED_RUNTIME.find(row => row.file === file);
  return pin === undefined ? new Response(null, { status: 404 }) : new Response(pin.bytes.slice());
};

describe('固定Pyodide資産の照合をCSP例外の前提にする境界（E26）', () => {
  let offline: Awaited<ReturnType<typeof pinnedRuntimeOffline>>;
  beforeAll(async () => { offline = await pinnedRuntimeOffline(); });
  afterAll(() => { vi.doUnmock('./assets.js'); vi.resetModules(); });

  it.each(PINNED_RUNTIME.flatMap(({ file }) => (['missing', 'same-size'] as const).map(failure => ({ file, failure }))))(
    '$file の $failure をBlob生成・importScripts・解釈器の起動より前に拒否する', async ({ file, failure }) => {
      const create = vi.spyOn(URL, 'createObjectURL'), phases: string[] = [];
      const { worker, reads, scripts } = pinnedWorker(name => {
        if (name !== file) return servePinned(name);
        if (failure === 'missing') return new Response(null, { status: 404 });
        const pin = PINNED_RUNTIME.find(row => row.file === name), altered = pin === undefined ? new Uint8Array() : pin.bytes.slice();
        altered[altered.length - 1] ^= 0x01;
        return new Response(altered);
      });
      const fetchBefore = worker.fetch, importBefore = worker.importScripts;
      try {
        await expect(offline.qualifyInBrowser(phase => { phases.push(phase); })).rejects.toThrow(failure === 'missing'
          ? `asset-missing: ${file} (HTTP 404)` : `asset-corrupt: ${file} (SHA-256)`);
        expect(phases).toEqual(['loading-assets']);
        expect(create).not.toHaveBeenCalled();
        expect(scripts).toEqual([]);
        expect(worker.fetch).toBe(fetchBefore);
        expect(worker.importScripts).toBe(importBefore);
        expect(reads.map(read => read.url)).toContain(ASSET_BASE + file);
        for (const read of reads) expect(read.init).toEqual(INITIAL_READ);
      } finally { create.mockRestore(); }
    });

  it('照合済みの3ファイルだけでBlobを作り、外部・変えたURL・GET以外・未知の資産と台本を拒否し、失敗時にBlobを解放する', async () => {
    const blobs: Blob[] = [];
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(object => {
      if (!(object instanceof Blob)) throw new Error('Only Blob URLs are expected');
      blobs.push(object); return `blob:e26-${blobs.length}`;
    });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const { worker, reads, scripts } = pinnedWorker(servePinned), stop = new Error('Stop before importing the fixed module');
    try {
      await expect(offline.qualifyInBrowser(phase => { if (phase === 'loading-runtime') throw stop; })).rejects.toBe(stop);
      expect(reads).toEqual(PINNED_RUNTIME.map(({ file }) => ({ url: ASSET_BASE + file, init: INITIAL_READ })));
      expect(await Promise.all(blobs.map(async blob => new Uint8Array(await blob.arrayBuffer()))))
        .toEqual([PINNED_RUNTIME[0].bytes, PINNED_RUNTIME[1].bytes]);
      expect(blobs.map(blob => blob.type)).toEqual(['text/javascript', 'text/javascript']);
      expect(revoke.mock.calls).toEqual([['blob:e26-1'], ['blob:e26-2']]);
      const wasm = await worker.fetch(ASSET_BASE + 'pyodide.asm.wasm');
      expect(wasm.headers.get('Content-Type')).toBe('application/wasm');
      expect(new Uint8Array(await wasm.arrayBuffer())).toEqual(PINNED_RUNTIME[2].bytes);
      for (const [input, init] of [
        ['https://outside.invalid/fem/assets/pyodide.asm.wasm', undefined],
        [ASSET_BASE + 'pyodide.asm.wasm?redirected=1', undefined],
        [new Request(ASSET_BASE + 'pyodide.asm.wasm', { method: 'POST' }), undefined],
        [ASSET_BASE + 'pyodide.asm.wasm', { method: 'HEAD' }],
        [ASSET_BASE + 'unknown.js', undefined],
      ] as const) await expect(worker.fetch(input, init)).rejects.toThrow('offline-request-denied');
      for (const names of [['https://outside.invalid/pyodide.asm.js'], ['pyodide.asm.js', 'pyodide.asm.js'], ['unknown.js'], []])
        expect(() => { worker.importScripts(...names); }).toThrow('offline-request-denied: unexpected script');
      expect(scripts).toEqual([]);
      worker.importScripts('pyodide.asm.js');
      expect(scripts).toEqual([['blob:e26-2']]);
      expect(reads).toHaveLength(PINNED_RUNTIME.length);
    } finally { create.mockRestore(); revoke.mockRestore(); }
  });

  it.each(['file:///C:/fem/worker.js', 'app://other/fem/worker.js', 'chrome-extension://abcdef/fem/worker.js'])(
    '固定の配信元でない %s では資産を1つも読まずに拒否する', async location => {
      const create = vi.spyOn(URL, 'createObjectURL'), phases: string[] = [];
      const { reads, scripts } = pinnedWorker(servePinned, location);
      try {
        await expect(offline.qualifyInBrowser(phase => { phases.push(phase); })).rejects.toThrow('Invalid FEM asset origin');
        expect(reads).toEqual([]); expect(scripts).toEqual([]); expect(phases).toEqual([]);
        expect(create).not.toHaveBeenCalled();
      } finally { create.mockRestore(); }
    });
});
