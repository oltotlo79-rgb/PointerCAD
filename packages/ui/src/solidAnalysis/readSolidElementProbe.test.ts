import { decodeSolidAnalysis, solidInputSha256, type SolidAnalysisInput, type CadSolidOutcome } from '@pointercad/fem';
import { describe, expect, it } from 'vitest';
import { buildSolidFieldMesh } from './solidFieldView.js';
import { readSolidElementProbe } from './readSolidElementProbe.js';

type Outcome = Extract<CadSolidOutcome, { kind: 'result' }>;
type Vector = [number, number, number];
interface Case {
  readonly materials: SolidAnalysisInput['materials'];
  readonly constraints: SolidAnalysisInput['constraints'];
  readonly nodalLoads: SolidAnalysisInput['nodalLoads'];
  readonly displacementMm: readonly Vector[];
  readonly elementForcesN: readonly number[];
  readonly totalForceN: Vector;
}

/** Independent published-draft SS400 row (t <= 16 mm, 245 MPa), the same row as packages/fem/src/solidYieldSummary.test.ts. */
const SS400 = { materialConditionId: 'ss400-plate-0-16', yieldMPa: 245, sourceId: 'jisf-g3101-draft', thicknessMm: 16,
  condition: '圧延鋼板（熱処理の指定なし）', evidence: 'standard-draft', basis: 'minimum' } as const;

/** Existing axial case (exportSolidResultCsv.test.ts): node 1 free in x, F = 1 N, E = 210000 MPa, nu = 0, L = 1 mm.
 * One free DOF K = E*L/6, so u = 6F/E, eps = u/L, sigma = 6F/L^2 = 6 MPa and the reaction at node 0 is -F. */
const AXIAL: Case = {
  materials: [{ id: 'm', youngMPa: 210000, poisson: 0 }],
  constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, true, true] },
    { node: 2, fixed: [true, true, true] }, { node: 3, fixed: [true, true, true] }],
  nodalLoads: [{ node: 1, forceN: [1, 0, 0] }],
  displacementMm: [[0, 0, 0], [6 / 210000, 0, 0], [0, 0, 0], [0, 0, 0]],
  elementForcesN: [-1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0], totalForceN: [1, 0, 0] };

/**
 * Hand-computed six-component case (no product function builds any expected value below).
 * Affine field u(X) = H X on the unit Tet4 X0 = 0, X1 = e1, X2 = e2, X3 = e3 with upper-triangular
 * H = [[1e-5, 6e-5, 5e-5], [0, 2e-5, 4e-5], [0, 0, 3e-5]], so u_a = H e_a and the 3-2-1 supports
 * (node 0 xyz, node 1 yz, node 2 z) hold zero exactly. Engineering strain [xx, yy, zz, yz, xz, xy]
 * = [H11, H22, H33, H23 + H32, H13 + H31, H12 + H21] = [1, 2, 3, 4, 5, 6] * 1e-5: all different, so any swap shows.
 * E = 210000 MPa, nu = 0.25: mu = E / (2(1 + nu)) = 84000, lambda = E nu / ((1 + nu)(1 - 2 nu)) = 84000.
 * sigma_ii = lambda tr + 2 mu eps_ii with tr = 6e-5 -> [6.72, 8.40, 10.08]; tau = mu gamma -> [3.36, 4.20, 5.04] MPa.
 * Nodal forces f_a = V sigma grad N_a, V = 1/6, grad N1..3 = e1..e3, grad N0 = -(1, 1, 1):
 * f1 = (1.12, 0.84, 0.70), f2 = (0.84, 1.40, 0.56), f3 = (0.70, 0.56, 1.68), f0 = -(2.66, 2.80, 2.94) N.
 * Loads on the six free DOFs equal the element action there; reactions are the action on the fixed DOFs.
 */
const AFFINE: Case = {
  materials: [{ id: 'steel', youngMPa: 210000, poisson: 0.25, capacity: SS400 }],
  constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, true, true] }, { node: 2, fixed: [false, false, true] }],
  nodalLoads: [{ node: 1, forceN: [1.12, 0, 0] }, { node: 2, forceN: [0.84, 1.4, 0] }, { node: 3, forceN: [0.7, 0.56, 1.68] }],
  displacementMm: [[0, 0, 0], [1e-5, 0, 0], [6e-5, 2e-5, 0], [5e-5, 4e-5, 3e-5]],
  elementForcesN: [-2.66, -2.8, -2.94, 1.12, 0.84, 0.7, 0.84, 1.4, 0.56, 0.7, 0.56, 1.68], totalForceN: [2.66, 1.96, 1.68] };
const AFFINE_STRAIN = [1e-5, 2e-5, 3e-5, 4e-5, 5e-5, 6e-5];
const AFFINE_STRESS_MPA = [6.72, 8.4, 10.08, 3.36, 4.2, 5.04];
/** sqrt(1/2 (1.68^2 + 1.68^2 + 3.36^2) + 3 (3.36^2 + 4.20^2 + 5.04^2)) = sqrt(171.4608) = 7.56 sqrt(3) MPa. */
const AFFINE_MISES_MPA = 7.56 * Math.sqrt(3);
const AFFINE_REACTION_N = [[-2.66, -2.8, -2.94], [0, 0.84, 0.7], [0, 0, 0.56], [0, 0, 0]];
/** U = V/2 eps . sigma = 118.44e-5 / 12 = 9.87e-5 N mm; equals half of the external work sum F . u = 19.74e-5. */
const AFFINE_ENERGY_NMM = 9.87e-5;

/** Relative <= 1e-6 per component; every expected value here is non-zero unless it is an exact zero. */
function expectClose(actual: readonly number[] | undefined, expected: readonly number[]): void {
  expect(actual?.length).toBe(expected.length);
  expected.forEach((value, i) => {
    const got = actual?.[i] ?? Number.NaN;
    if (value === 0) expect(Math.abs(got)).toBeLessThanOrEqual(1e-12);
    else expect(Math.abs(got - value)).toBeLessThanOrEqual(1e-6 * Math.abs(value));
  });
}

/** Existing exportSolidResultCsv.test.ts uses this same physical unit-tetrahedron fixture. */
async function fixture(state: Case = AXIAL): Promise<Outcome> {
  const source = { documentId: 'd', revision: 7, meshKey: 'tet' };
  const input: SolidAnalysisInput = { schema: 'pointercad-solid-tet4/1', source, units: 'N-mm-MPa', numericBudgetBytes: 16 * 1024 * 1024,
    nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], elements: [{ nodes: [0, 1, 2, 3], materialId: state.materials[0].id }],
    materials: state.materials, constraints: state.constraints, nodalLoads: state.nodalLoads, surfaceLoads: [] };
  const hash = await solidInputSha256(input);
  const result = decodeSolidAnalysis({ schema: 'pointercad-solid-tet4-native/1', source,
    displacementMm: state.displacementMm, elementForcesN: [state.elementForcesN],
    reservedNumericBytes: 50000, minimumScaledPivot: 1 }, input, hash);
  const coordinates = input.nodes.flat(), triangles = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
  return { kind: 'result', result, prepared: { input, loadedAreaMm2: 0, totalForceN: state.totalForceN }, mesh: {
    kind: 'netgen-tetra-mesh', input: { schema: 'pointercad-convex-plc/1', source: { documentId: 'd', revision: 7,
      featureId: 'tet', bodyKey: 'tet' }, units: 'mm', coordinates, triangles, tags: [0, 1, 2, 3], tagCount: 4 },
    inputSha256: hash, coordinates, tetrahedra: [0, 1, 2, 3], boundaryTriangles: triangles, boundaryTags: [0, 1, 2, 3],
    volumeMm3: 1 / 6, minTetVolumeMm3: 1 / 6 } };
}

describe('element probe', () => {
  it('reports the known axial Tet4 with original node values independent of display magnification', async () => {
    const outcome = await fixture(), field = buildSolidFieldMesh(outcome, 'strainXx', 100);
    if (field === null) throw new Error('field');
    expect(field.triangleElements).toEqual([0, 0, 0, 0]);
    const probe = await readSolidElementProbe(outcome, field, 0);
    expect(probe?.elementIndex).toBe(0);
    expect(probe?.nodes.map(node => node.index)).toEqual([0, 1, 2, 3]);
    expect(probe?.strain[0]).toBeCloseTo(0.0000285714285714, 10);
    expect(probe?.stressMPa[0]).toBeCloseTo(6, 10);
    expect(probe?.vonMisesMPa).toBeCloseTo(6, 10);
    expect(probe?.yieldRatio).toBeNull();
    expect(probe?.nodes[1].displacementMm[0]).toBeCloseTo(0.0000285714285714, 10);
    expect(probe?.nodes[0].reactionN[0]).toBeCloseTo(-1, 10);
    // No material yield evidence: unevaluated for that reason, not for zero stress.
    expect(probe?.capacityMissing).toBe(true); expect(probe?.zeroStress).toBe(false);
  });
  it('rejects invalid indices, tampered result and a field from another mesh', async () => {
    const outcome = await fixture(), field = buildSolidFieldMesh(outcome, 'xx', 1);
    if (field === null) throw new Error('field');
    for (const index of [-1, 0.5, NaN, Infinity, 1]) expect(await readSolidElementProbe(outcome, field, index)).toBeNull();
    const bad = structuredClone(outcome);
    const modified = { ...bad, result: { ...bad.result, reactionN: [[NaN, 0, 0], ...bad.result.reactionN.slice(1)] as typeof bad.result.reactionN } };
    expect(await readSolidElementProbe(modified, field, 0)).toBeNull();
    const tampered = { ...bad, result: { ...bad.result, reactionN: [[-2, 0, 0], ...bad.result.reactionN.slice(1)] as typeof bad.result.reactionN } };
    expect(await readSolidElementProbe(tampered, field, 0)).toBeNull();
    expect(await readSolidElementProbe(outcome, { ...field, triangleElements: [7] }, 0)).toBeNull();
  });

  it('reports all six engineering strains, stresses, von Mises, yield ratio and reactions of an independent affine field', async () => {
    const outcome = await fixture(AFFINE);
    // Fixture self-check against the hand values: the real decoder accepted the forces and loads above.
    expect(outcome.result.strainEnergyNmm).toBeGreaterThan(0);
    expect(Math.abs(outcome.result.strainEnergyNmm - AFFINE_ENERGY_NMM)).toBeLessThanOrEqual(1e-6 * AFFINE_ENERGY_NMM);
    for (const scale of [0, 1, 1000]) {
      const field = buildSolidFieldMesh(outcome, 'strainYz', scale);
      if (field === null) throw new Error('field');
      const probe = await readSolidElementProbe(outcome, field, 0);
      if (probe === null) throw new Error('probe');
      expect(probe.materialId).toBe('steel');
      expectClose(probe.strain, AFFINE_STRAIN);
      expectClose(probe.stressMPa, AFFINE_STRESS_MPA);
      expect(Math.abs(probe.vonMisesMPa - AFFINE_MISES_MPA)).toBeLessThanOrEqual(1e-6 * AFFINE_MISES_MPA);
      // 245 MPa / (7.56 sqrt(3) MPa) = 18.71...: yield evidence over von Mises, not a design safety factor.
      const ratio = 245 / AFFINE_MISES_MPA;
      expect(Math.abs((probe.yieldRatio ?? Number.NaN) - ratio)).toBeLessThanOrEqual(1e-6 * ratio);
      expect(probe.capacityMissing).toBe(false); expect(probe.zeroStress).toBe(false);
      // Original positions and the real displacement u = H X; the display scale never multiplies them.
      expect(probe.nodes.map(node => node.index)).toEqual([0, 1, 2, 3]);
      expect(probe.nodes.map(node => node.positionMm)).toEqual([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]]);
      probe.nodes.forEach((node, i) => {
        expectClose(node.displacementMm, AFFINE.displacementMm[i]);
        expectClose(node.reactionN, AFFINE_REACTION_N[i]);
      });
    }
  });
  it('refuses a result whose strain or stress components were reordered', async () => {
    const outcome = await fixture(AFFINE), field = buildSolidFieldMesh(outcome, 'vonMises', 1);
    if (field === null) throw new Error('field');
    const [element] = outcome.result.elements;
    // Engineering shear yz and xy exchanged (4e-5 <-> 6e-5) in the result: not the result of these displacements.
    type Six = typeof element.strain;
    const swap = (values: Six): Six => [values[0], values[1], values[2], values[5], values[4], values[3]];
    expect(swap(element.strain)).not.toEqual(element.strain);
    for (const changed of [{ strain: swap(element.strain), stressMPa: element.stressMPa },
      { strain: element.strain, stressMPa: swap(element.stressMPa) }]) {
      const reordered = { ...outcome, result: { ...outcome.result, elements: [changed] } };
      expect(await readSolidElementProbe(reordered, field, 0)).toBeNull();
    }
    // Control: the same spread with the original order is still accepted.
    expect(await readSolidElementProbe({ ...outcome, result: { ...outcome.result, elements: [{ ...element }] } }, field, 0)).not.toBeNull();
  });
  it('keeps zero stress, absent, zero and non-finite yield capacity unevaluated', async () => {
    // Zero load with evidence: 0 MPa von Mises, no ratio (never Infinity) and the reason is zero stress.
    const zero = await fixture({ ...AXIAL, materials: [{ id: 'm', youngMPa: 210000, poisson: 0, capacity: SS400 }],
      nodalLoads: [{ node: 1, forceN: [0, 0, 0] }], displacementMm: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]],
      elementForcesN: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], totalForceN: [0, 0, 0] });
    const zeroField = buildSolidFieldMesh(zero, 'vonMises', 1);
    if (zeroField === null) throw new Error('field');
    const zeroProbe = await readSolidElementProbe(zero, zeroField, 0);
    expect(zeroProbe).toMatchObject({ vonMisesMPa: 0, yieldRatio: null, zeroStress: true, capacityMissing: false });
    // Evidence whose yield value is 0, Infinity or NaN is not a source row: no probe value at all.
    const outcome = await fixture(AFFINE), field = buildSolidFieldMesh(outcome, 'vonMises', 1);
    if (field === null) throw new Error('field');
    const withYield = (yieldMPa: number): Outcome => {
      const changed = structuredClone(outcome), material = changed.prepared.input.materials[0];
      return { ...changed, prepared: { ...changed.prepared, input: { ...changed.prepared.input,
        materials: [{ ...material, capacity: { ...SS400, yieldMPa } }] } } };
    };
    // Control: the same construction with the source value 245 MPa still gives the hand ratio.
    const control = await readSolidElementProbe(withYield(245), field, 0);
    expect(Math.abs((control?.yieldRatio ?? Number.NaN) - 245 / AFFINE_MISES_MPA)).toBeLessThanOrEqual(1e-6 * 245 / AFFINE_MISES_MPA);
    for (const yieldMPa of [0, Infinity, Number.NaN, -245]) expect(await readSolidElementProbe(withYield(yieldMPa), field, 0)).toBeNull();
  });
});
