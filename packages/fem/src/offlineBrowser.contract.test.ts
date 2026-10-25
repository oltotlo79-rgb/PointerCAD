import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeImpactInBrowser, analyzeSolidInBrowser, qualifyInBrowser } from './offlineBrowser.js';
import { bucklingFixture } from './buckling.testSupport.js';
import type { BeamImpactInput } from './beamImpactModel.js';
import type { SolidAnalysisInput } from './solidAnalysisModel.js';

vi.mock('./assets.js', () => ({ FEM_ASSETS: ['pyodide.mjs', 'pyodide.asm.js'].map(file => ({
  file, bytes: 1, sha256: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a',
})), SOLID_ASSETS: [{ file: 'solidAnalysis.py', bytes: 1,
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
