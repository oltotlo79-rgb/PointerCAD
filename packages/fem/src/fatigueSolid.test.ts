import { describe, expect, it } from 'vitest';
import { analyzeFatigue } from './fatigue.js';
import { MAX_FATIGUE_HISTORY_POINTS, MAX_FATIGUE_REPEATS } from './fatigueModel.js';
import { SOLID_FATIGUE_MEASURE, solidFatigueInput } from './fatigueSolid.js';
import { analyzeProportionalTensorFatigue } from './fatigueTensor.js';
import type { SolidAnalysisInput, SolidVector6 } from './solidAnalysisModel.js';
import { decodeSolidAnalysis } from './solidAnalysisResults.js';
import { solidInputSha256 } from './solidAnalysisTranslation.js';

const curve = { id: 'test-only', unit: 'MPa', stressDefinition: 'range', meanStressAssumption: 'mean-independent',
  referenceStressMpa: 100, referenceCycles: 2e6, slope: 3, cutoffStressMpa: null,
  source: { kind: 'user-supplied', reference: 'Analytical regression relation, not material data', condition: 'Test only' } };

/** Independent affine unit tetrahedron, E=200 MPa, nu=0, G=100 MPa, V=1/6 mm3.
 * These are hand-equilibrium native-SHAPED payloads, not evidence of a native solve in this test. The production
 * result reader must validate constitutive stress, every action, equilibrium, reactions and work before import.
 * u=(xx*x/200 + xy*y/100 + xz*z/100, yy*y/200 + yz*z/100, zz*z/200).
 * Nodal force is V*sigma*grad(N); the zero-origin node is restrained, other loads are the stated face actions.
 */
async function fixture(stress: SolidVector6 = [6, 0, 0, 0, 0, 0]) {
  const [xx, yy, zz, yz, xz, xy] = stress;
  const actions = [-(xx + xy + xz) / 6, -(xy + yy + yz) / 6, -(xz + yz + zz) / 6,
    xx / 6, xy / 6, xz / 6, xy / 6, yy / 6, yz / 6, xz / 6, yz / 6, zz / 6];
  const input: SolidAnalysisInput = { schema: 'pointercad-solid-tet4/1',
    source: { documentId: 'solid', revision: 7, meshKey: 'mesh:tet4:7' }, units: 'N-mm-MPa', numericBudgetBytes: 16 * 1024 * 1024,
    nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], elements: [{ nodes: [0, 1, 2, 3], materialId: 'm' }],
    materials: [{ id: 'm', youngMPa: 200, poisson: 0 }],
    constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, true, true] },
      { node: 2, fixed: [false, false, true] }],
    nodalLoads: [{ node: 1, forceN: [xx / 6, xy / 6, xz / 6] },
      { node: 2, forceN: [xy / 6, yy / 6, yz / 6] }, { node: 3, forceN: [xz / 6, yz / 6, zz / 6] }], surfaceLoads: [] };
  const hash = await solidInputSha256(input);
  const result = decodeSolidAnalysis({ schema: 'pointercad-solid-tet4-native/1', source: input.source,
    displacementMm: [[0, 0, 0], [xx / 200, 0, 0], [xy / 100, yy / 200, 0], [xz / 100, yz / 100, zz / 200]],
    elementForcesN: [actions], reservedNumericBytes: 50000, minimumScaledPivot: 1 }, input, hash);
  const selection = { source: { ...input.source }, inputSha256: hash, elementIndex: 0, historyId: 'element:0',
    loadFactors: [0, 1, 0, -0.5, 1], sequence: 'once', repeats: 1, reference: 'Explicit test load chronology' };
  return { input, result, selection };
}

describe('native linear solid element to existing proportional fatigue adapter', () => {
  it.each([6, -6])('imports the known uniaxial %s MPa and matches the existing scalar analysis', async stress => {
    const { input, result, selection } = await fixture([stress, 0, 0, 0, 0, 0]);
    const adapted = await solidFatigueInput(input, result, selection, curve);
    if (!adapted.ok) throw new Error(`${adapted.code}: ${adapted.path}`);
    expect(adapted.input.histories[0].stressMpa).toEqual([0, stress, 0, -stress / 2, stress]);
    const control = analyzeFatigue({ ...adapted.input,
      histories: [{ ...adapted.input.histories[0], stressMpa: [0, stress, 0, -stress / 2, stress] }] });
    expect(analyzeFatigue(adapted.input)).toEqual(control);
    expect(adapted.provenance).toMatchObject({ measure: SOLID_FATIGUE_MEASURE, source: input.source,
      inputSha256: result.inputSha256, elementIndex: 0, elementNodes: [0, 1, 2, 3], materialId: 'm', unit: 'MPa',
      loadFactors: selection.loadFactors, sequence: 'once', repeats: 1, historyId: 'element:0' });
  });

  it.each([3, 4, 5])('retains tensor shear component %s without engineering-shear factor two', async component => {
    const stresses: SolidVector6[] = [[0, 0, 0, 1.6, 0, 0], [0, 0, 0, 0, 1.6, 0], [0, 0, 0, 0, 0, 1.6]];
    const { input, result, selection } = await fixture(stresses[component - 3]);
    const adapted = await solidFatigueInput(input, result,
      { ...selection, loadFactors: [-1, 1], sequence: 'repeated-periodic', repeats: 1000 }, curve);
    if (!adapted.ok) throw new Error(`${adapted.code}: ${adapted.path}`);
    expect(result.elements[0].stressMPa[component]).toBeCloseTo(1.6, 12);
    expect(adapted.conversions[0].signTie).toBe(true);
    expect(adapted.input.histories[0].stressMpa[0]).toBeCloseTo(-Math.sqrt(3) * 1.6, 12);
    expect(adapted.input.histories[0].stressMpa[1]).toBeCloseTo(Math.sqrt(3) * 1.6, 12);
    const tensor = analyzeProportionalTensorFatigue(adapted.tensorInput);
    const scalar = analyzeFatigue(adapted.input);
    expect(tensor.ok).toBe(true);
    expect(scalar.ok).toBe(true);
    if (tensor.ok && scalar.ok) expect(tensor.result).toEqual(scalar.result);
  });

  it('preserves all six Cauchy components in MPa and preserves the given chronological factor order', async () => {
    const { input, result, selection } = await fixture([4, 8, 12, 2, 6, 10]);
    const loadFactors = [1, -0.25, 0, 0.5];
    const adapted = await solidFatigueInput(input, result, { ...selection, loadFactors }, curve);
    if (!adapted.ok) throw new Error(adapted.code);
    const [xx, yy, zz, yz, xz, xy] = result.elements[0].stressMPa;
    expect(adapted.tensorInput.histories[0].reference).toEqual({ unit: 'MPa',
      components: 'cauchy-tensor-shear-xx-yy-zz-yz-xz-xy', xx, yy, zz, yz, xz, xy });
    expect(adapted.provenance.reference).toEqual(adapted.tensorInput.histories[0].reference);
    expect(adapted.tensorInput.histories[0].loadFactors).toEqual(loadFactors);
  });

  it('rejects stale, foreign, cross-mesh and forged-digest selections and result identities', async () => {
    const { input, result, selection } = await fixture();
    for (const source of [{ ...input.source, documentId: 'other' }, { ...input.source, revision: 8 },
      { ...input.source, meshKey: 'remeshed' }]) {
      expect(await solidFatigueInput(input, result, { ...selection, source }, curve))
        .toMatchObject({ ok: false, code: 'fatigue-solid-binding' });
      expect(await solidFatigueInput(input, { ...result, source }, selection, curve))
        .toMatchObject({ ok: false, code: 'fatigue-solid-binding' });
    }
    expect(await solidFatigueInput(input, result, { ...selection, inputSha256: 'a'.repeat(64) }, curve))
      .toMatchObject({ ok: false, code: 'fatigue-solid-binding' });
    expect(await solidFatigueInput(input, { ...result, inputSha256: 'a'.repeat(64) }, selection, curve))
      .toMatchObject({ ok: false, code: 'fatigue-solid-binding' });
    // Same source labels cannot conceal an altered physical input: the adapter recomputes the canonical hash.
    expect(await solidFatigueInput({ ...input, materials: [{ ...input.materials[0], youngMPa: 400 }] }, result, selection, curve))
      .toMatchObject({ ok: false, code: 'fatigue-solid-binding' });
  });

  it('revalidates the complete native result instead of accepting labels and a plausible selected stress', async () => {
    const { input, result, selection } = await fixture();
    for (const changed of [{ ...result, elements: [] },
      { ...result, elements: [{ ...result.elements[0], stressMPa: [60, 0, 0, 0, 0, 0] }] },
      { ...result, elements: [{ ...result.elements[0], stressMPa: [Number.NaN, 0, 0, 0, 0, 0] }] },
      { ...result, displacementMm: input.nodes.map(() => [0, 0, 0]) },
      { ...result, nativeElementForcesN: [[-2, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]] },
      { ...result, units: 'Pa' }, { ...result, elements: new Array<unknown>(1) }]) {
      expect(await solidFatigueInput(input, changed, selection, curve)).toMatchObject({ ok: false, code: 'fatigue-solid-binding' });
    }
    for (const elementIndex of [-1, 0.5, 1, Number.NaN, Number.MAX_SAFE_INTEGER]) {
      expect(await solidFatigueInput(input, result, { ...selection, elementIndex }, curve))
        .toMatchObject({ ok: false, code: 'fatigue-solid-element' });
    }
  });

  it('rejects sparse, nonfinite, oversized or decorated arrays and malformed/missing selections', async () => {
    const { input, result, selection } = await fixture();
    for (const loadFactors of [new Array<number>(2), [], [0, Number.NaN], [0, Number.POSITIVE_INFINITY],
      new Array<number>(MAX_FATIGUE_HISTORY_POINTS + 1).fill(1), Object.assign([0, 1], { hidden: 1 })]) {
      expect(await solidFatigueInput(input, result, { ...selection, loadFactors }, curve))
        .toMatchObject({ ok: false, code: 'fatigue-solid-selection' });
    }
    for (const chosen of [null, {}, { ...selection, extra: true }, { ...selection, source: null },
      { ...selection, historyId: '' }, { ...selection, reference: ' ' }, { ...selection, sequence: 'sorted' },
      { ...selection, repeats: 2 }, { ...selection, sequence: 'repeated-periodic', repeats: MAX_FATIGUE_REPEATS + 1 }]) {
      expect(await solidFatigueInput(input, result, chosen, curve)).toMatchObject({ ok: false, code: 'fatigue-solid-selection' });
    }
    for (const malformed of [null, { ...input, nodes: new Array<unknown>(4) },
      { ...input, elements: [{ ...input.elements[0], nodes: [0, 1, 2, Number.NaN] }] }]) {
      expect(await solidFatigueInput(malformed, result, selection, curve)).toMatchObject({ ok: false, code: 'fatigue-solid-input' });
    }
  });

  it('retains existing fatigue reference/factor bounds, zero/hydrostatic refusal and curve validation', async () => {
    for (const [stress, code] of [[[0, 0, 0, 0, 0, 0], 'fatigue-tensor-zero-reference'],
      [[1, 1, 1, 0, 0, 0], 'fatigue-tensor-hydrostatic'], [[10001, 0, 0, 0, 0, 0], 'fatigue-tensor-bound']] as const) {
      const { input, result, selection } = await fixture(stress);
      expect(await solidFatigueInput(input, result, selection, curve)).toMatchObject({ ok: false, code });
    }
    const { input, result, selection } = await fixture([0.5, 0, 0, 0, 0, 0]);
    expect(await solidFatigueInput(input, result, { ...selection, loadFactors: [0, Number.MAX_VALUE] }, curve))
      .toMatchObject({ ok: false, code: 'fatigue-tensor-bound' });
    expect(await solidFatigueInput(input, result, { ...selection, loadFactors: [0, Number.MIN_VALUE] }, curve))
      .toMatchObject({ ok: false, code: 'fatigue-tensor-underflow' });
    expect(await solidFatigueInput(input, result, selection, { ...curve, slope: 0 }))
      .toMatchObject({ ok: false, code: 'fatigue-bound', path: 'curve.slope' });
  });

  it('owns returned factors, source, reference and element nodes without mutating inputs', async () => {
    const { input, result, selection } = await fixture();
    const before = JSON.stringify({ input, result, selection, curve });
    const adapted = await solidFatigueInput(input, result, selection, curve);
    if (!adapted.ok) throw new Error(adapted.code);
    expect(JSON.stringify({ input, result, selection, curve })).toBe(before);
    expect(adapted.provenance.source).not.toBe(input.source);
    expect(adapted.provenance.elementNodes).not.toBe(input.elements[0].nodes);
    expect(adapted.tensorInput.histories[0].loadFactors).not.toBe(selection.loadFactors);
    expect(adapted.provenance.loadFactors).not.toBe(adapted.tensorInput.histories[0].loadFactors);
    selection.loadFactors[0] = 99;
    selection.source.meshKey = 'changed-after-import';
    expect(adapted.provenance.loadFactors[0]).toBe(0);
    expect(adapted.tensorInput.histories[0].loadFactors[0]).toBe(0);
    expect(adapted.provenance.source.meshKey).toBe('mesh:tet4:7');
  });
});
