import type { SolidBucklingInput, SolidBucklingMode, SolidBucklingResult } from '@pointercad/fem';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { projectSolidBucklingMode, solidBucklingRestraints } from './solidBucklingView.js';
import { createSolidModeLayer } from './solidModeLayer.js';

const L = 10;
/** Corner tet: vertices 0, 2, 3 fully prescribed, vertex 1 only z (the analysed reference of the request). */
function input(): SolidBucklingInput {
  return { schema: 'pointercad-solid-tet4-buckling/1', modeCount: 2, reference: {
    schema: 'pointercad-solid-tet4/1', source: { documentId: 'doc-1', revision: 4, meshKey: 'mesh-a' }, units: 'N-mm-MPa',
    numericBudgetBytes: 1_000_000, nodes: [[0, 0, 0], [L, 0, 0], [0, L, 0], [0, 0, L]],
    elements: [{ nodes: [0, 1, 2, 3], materialId: 'steel' }], materials: [{ id: 'steel', youngMPa: 205000, poisson: 0.3 }],
    constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, false, true] },
      { node: 2, fixed: [true, true, true] }, { node: 3, fixed: [true, true, true] }],
    nodalLoads: [{ node: 1, forceN: [-1000, 0, 0] }], surfaceLoads: [] } };
}
function mode(number: number, loadFactor: number, free: readonly [number, number, number]): SolidBucklingMode {
  return { number, loadFactor, normalizedResidual: 1e-12, shape: [[0, 0, 0], free, [0, 0, 0], [0, 0, 0]] };
}
function result(request: SolidBucklingInput, modes: readonly SolidBucklingMode[] = [mode(1, 26.3, [0, 1, 0]), mode(2, 91.9, [1, 0, 0])],
  source = request.reference.source): SolidBucklingResult {
  return { kind: 'oofem-solid-tet4-buckling', method: 'oofem-ltrspace-initial-stress-eigh/1', scope: 'linear-elastic-prestress-bifurcation',
    units: 'N-mm-MPa', source, inputSha256: '0'.repeat(64), freeDofs: 2, referenceEquilibriumResidual: 1e-13,
    maximumElementInitialStressError: 1e-12, modes, structuralCertification: false };
}
const current = { documentId: 'doc-1', revision: 4, meshKey: 'mesh-a' };

describe('projectSolidBucklingMode', () => {
  it('moves only free components by phase x amplitude / largest nodal length, never by the load factor', () => {
    const request = input();
    // Shape not normalized to 1 on purpose: largest length 2, so the drawn motion is amplitude x (shape / 2).
    const preview = projectSolidBucklingMode(request, result(request, [mode(1, 26.3, [0, 2, 0])]), current,
      { modeNumber: 1, amplitudeMm: 5, phase: -1 });
    if (preview.kind !== 'preview') throw new Error(`no preview: ${preview.reason}`);
    expect(preview.nodePositions).toEqual([[0, 0, 0], [L, -5, 0], [0, L, 0], [0, 0, L]]);
    expect([preview.modeNumber, preview.loadFactor, preview.amplitudeMm, preview.phase]).toEqual([1, 26.3, 5, -1]);
    const tenTimes = projectSolidBucklingMode(request, result(request, [mode(1, 263, [0, 2, 0])]), current,
      { modeNumber: 1, amplitudeMm: 5, phase: -1 });
    expect(tenTimes.kind === 'preview' ? tenTimes.nodePositions : null).toEqual(preview.nodePositions);
  });
  it('scales linearly with the amplitude and draws the reference mesh at amplitude 0', () => {
    const request = input();
    const at = (amplitudeMm: number) => {
      const preview = projectSolidBucklingMode(request, result(request), current, { modeNumber: 2, amplitudeMm, phase: 1 });
      if (preview.kind !== 'preview') throw new Error(`no preview: ${preview.reason}`);
      return preview.nodePositions[1];
    };
    expect(at(0)).toEqual([L, 0, 0]);
    expect(at(3)).toEqual([L + 3, 0, 0]);
    expect(at(6)).toEqual([L + 6, 0, 0]);
  });
  it('draws the four boundary faces of the analysed tetrahedron (12 corners) from the displaced nodes', () => {
    const request = input();
    const preview = projectSolidBucklingMode(request, result(request), current, { modeNumber: 1, amplitudeMm: 4, phase: 1 });
    if (preview.kind !== 'preview') throw new Error(`no preview: ${preview.reason}`);
    expect(preview.triangleElements).toEqual([0, 0, 0, 0]);
    expect(preview.positions).toHaveLength(36);
    const corners = new Set<string>();
    for (let index = 0; index < preview.positions.length; index += 3) corners.add(preview.positions.slice(index, index + 3).join(','));
    expect([...corners].sort()).toEqual(['0,0,0', '0,0,10', '0,10,0', '10,4,0'].sort());
  });
  it.each([
    ['another revision of the current source', { ...current, revision: 5 }, {}],
    ['another mesh of the current source', { ...current, meshKey: 'mesh-b' }, {}],
    ['a result of another request', current, { resultSource: { ...current, documentId: 'doc-2' } }],
  ] as const)('refuses %s as stale', (_name, at, options) => {
    const request = input();
    const value = 'resultSource' in options ? result(request, undefined, options.resultSource) : result(request);
    expect(projectSolidBucklingMode(request, value, at, { modeNumber: 1, amplitudeMm: 4, phase: 1 })).toEqual({ kind: 'none', reason: 'stale' });
  });
  it('refuses an unknown mode, a bad amplitude or phase, a mismatched or zero shape', () => {
    const request = input();
    const view = { modeNumber: 1, amplitudeMm: 4, phase: 1 } as const;
    expect(projectSolidBucklingMode(request, result(request), current, { ...view, modeNumber: 3 })).toEqual({ kind: 'none', reason: 'mode' });
    for (const amplitudeMm of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(projectSolidBucklingMode(request, result(request), current, { ...view, amplitudeMm })).toEqual({ kind: 'none', reason: 'amplitude' });
    }
    const short: SolidBucklingMode = { number: 1, loadFactor: 1, normalizedResidual: 0, shape: [[0, 0, 0], [0, 1, 0]] };
    expect(projectSolidBucklingMode(request, result(request, [short]), current, view)).toEqual({ kind: 'none', reason: 'mesh' });
    expect(projectSolidBucklingMode(request, result(request, [mode(1, 1, [0, 0, 0])]), current, view)).toEqual({ kind: 'none', reason: 'shape' });
    expect(projectSolidBucklingMode(request, result(request, [mode(1, 1, [0, Number.NaN, 0])]), current, view))
      .toEqual({ kind: 'none', reason: 'shape' });
  });
  it('never mutates the request, the result or the display choice', () => {
    const request = input(), value = result(request), view = { modeNumber: 2, amplitudeMm: 7, phase: -1 } as const;
    const before = JSON.stringify([request, value, view]);
    projectSolidBucklingMode(request, value, current, view);
    expect(JSON.stringify([request, value, view])).toBe(before);
  });
  it('merges repeated restraint rows of one node and refuses an out-of-range constraint', () => {
    const request = input();
    expect(solidBucklingRestraints(request)?.[1]).toEqual([false, false, true]);
    const repeated = { ...request, reference: { ...request.reference,
      constraints: [...request.reference.constraints, { node: 1, fixed: [true, false, false] as const }] } };
    expect(solidBucklingRestraints(repeated)?.[1]).toEqual([true, false, true]);
    const outside = { ...request, reference: { ...request.reference, constraints: [{ node: 9, fixed: [true, true, true] as const }] } };
    expect(solidBucklingRestraints(outside)).toBeNull();
  });
});

describe('the one viewport mode layer with a buckling shape', () => {
  it('draws the buckling triangles, replaces and disposes its geometry, and ignores calls after dispose', () => {
    const request = input();
    const preview = projectSolidBucklingMode(request, result(request), current, { modeNumber: 1, amplitudeMm: 4, phase: 1 });
    const layer = createSolidModeLayer();
    layer.set(preview);
    expect(layer.triangleCount()).toBe(4);
    const drawn = layer.group.children[0];
    if (!(drawn instanceof THREE.Mesh)) throw new Error('no drawn mesh');
    expect(drawn.name).toBe('solid-analysis-mode:1');
    const dispose = vi.spyOn(drawn.geometry, 'dispose');
    layer.set({ kind: 'none' });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect([layer.triangleCount(), layer.group.children.length]).toEqual([0, 0]);
    layer.set(preview);
    layer.dispose();
    expect([layer.triangleCount(), layer.group.children.length]).toEqual([0, 0]);
    layer.set(preview);
    expect(layer.triangleCount()).toBe(0);
  });
});
