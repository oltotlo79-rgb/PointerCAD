import type { FrameBoltContactInput } from './beamBoltContact.js';
import { axialOscillator, transientHistory } from './transient.testSupport.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
