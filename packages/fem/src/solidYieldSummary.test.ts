import { describe, expect, it } from 'vitest';
import type { AnalysisMaterialCapacity } from '@pointercad/model/beam-analysis';
import type { SolidAnalysisInput } from './solidAnalysisModel.js';
import { decodeSolidAnalysis } from './solidAnalysisResults.js';
import { solidInputSha256 } from './solidAnalysisTranslation.js';
import { summarizeSolidYield } from './solidYieldSummary.js';

function capacity(thick = false): AnalysisMaterialCapacity {
  // Existing W01 catalog / analysisMaterialCapacity.test.ts independent published-draft rows.
  return { materialConditionId: thick ? 'ss400-plate-16-40' : 'ss400-plate-0-16',
    yieldMPa: thick ? 235 : 245, sourceId: 'jisf-g3101-draft', thicknessMm: thick ? 40 : 16,
    condition: '圧延鋼板（熱処理の指定なし）', evidence: 'standard-draft', basis: 'minimum' };
}
function fixture(force = 1): SolidAnalysisInput {
  return { schema: 'pointercad-solid-tet4/1', source: { documentId: 'tet', revision: 1, meshKey: 'tet:1' },
    units: 'N-mm-MPa', numericBudgetBytes: 16 * 1024 * 1024,
    nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
    elements: [{ nodes: [0, 1, 2, 3], materialId: 'm' }],
    materials: [{ id: 'm', youngMPa: 210000, poisson: 0, capacity: capacity() }],
    constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, true, true] },
      { node: 2, fixed: [true, true, true] }, { node: 3, fixed: [true, true, true] }],
    nodalLoads: [{ node: 1, forceN: [force, 0, 0] }], surfaceLoads: [] };
}
async function solved(input: SolidAnalysisInput, force = 1) {
  // Independent one free DOF K=E*L/6, sigma=6F/L^2, U=3F^2/(E*L).
  return decodeSolidAnalysis({ schema: 'pointercad-solid-tet4-native/1', source: input.source,
    displacementMm: [[0, 0, 0], [6 * force / 210000, 0, 0], [0, 0, 0], [0, 0, 0]],
    elementForcesN: [[-force, 0, 0, force, 0, 0, 0, 0, 0, 0, 0, 0]],
    reservedNumericBytes: 50000, minimumScaledPivot: 1 }, input, await solidInputSha256(input));
}
describe('source-bound solid yield benchmark (pure native-action decoding, no native solver)', () => {
  it.each([1, -1, 2])('uses actual signed-load stress magnitude and independent yield/stress ratio F=%s', async force => {
    const input = fixture(force), result = await solved(input, force), summary = await summarizeSolidYield(input, result);
    expect(summary.elements[0].vonMisesMPa).toBeCloseTo(6 * Math.abs(force), 12);
    expect(summary.minimumYieldRatio).toBeCloseTo(245 / (6 * Math.abs(force)), 12);
    expect(summary.structuralCertification).toBe(false); expect(summary.elements[0].capacity).toEqual(capacity());
    expect(result.displacementMm[1][0]).toBeCloseTo(6 * force / 210000, 15);
    expect(result.reactionN[0]).toEqual([-force, 0, 0]);
    expect(result.strainEnergyNmm).toBeCloseTo(3 * force * force / 210000, 15);
  });
  it('represents zero stress without an infinite safety claim', async () => {
    const input = fixture(0), summary = await summarizeSolidYield(input, await solved(input, 0));
    expect(summary.minimumYieldRatio).toBeNull(); expect(summary.elements[0]).toMatchObject({ zeroStress: true, yieldRatio: null, vonMisesMPa: 0 });
  });
  it('does not invent absent capacity', async () => {
    const base = fixture(), input = { ...base, materials: [{ id: 'm', youngMPa: 210000, poisson: 0 }] };
    const summary = await summarizeSolidYield(input, await solved(input));
    expect(summary.missingMaterialIds).toEqual(['m']); expect(summary.minimumYieldRatio).toBeNull();
    expect(summary.elements[0].capacity).toBeNull(); expect(summary.elements[0].yieldRatio).toBeNull();
  });
  it.each(['sourceId', 'condition', 'thicknessMm', 'yieldMPa'] as const)('rejects invalid material evidence %s', async key => {
    const input = fixture(), result = await solved(input);
    const invalid = { ...capacity(), [key]: key === 'thicknessMm' ? 17 : key === 'yieldMPa' ? 246 : 'invalid' };
    await expect(summarizeSolidYield({ ...input, materials: [{ ...input.materials[0], capacity: invalid }] }, result)).rejects.toThrow();
  });
  it('rejects stale source, material, load and modified result instead of trusting its digest', async () => {
    const input = fixture(), result = await solved(input);
    for (const changed of [{ ...input, source: { ...input.source, revision: 2 } },
      { ...input, materials: [{ ...input.materials[0], capacity: capacity(true) }] }, fixture(2)]) {
      await expect(summarizeSolidYield(changed, result)).rejects.toThrow();
    }
    await expect(summarizeSolidYield(input, { ...result, elements: [{ strain: result.elements[0].strain, stressMPa: [60, 0, 0, 0, 0, 0] }] })).rejects.toThrow();
  });
  it('rejects mutation while the digest is pending and returns owned capacity', async () => {
    const input = fixture(), result = await solved(input), mutable = { ...input, source: { ...input.source } };
    const pending = summarizeSolidYield(mutable, result); mutable.source.revision = 2;
    await expect(pending).rejects.toThrow();
    const summary = await summarizeSolidYield(input, result);
    expect(summary.elements[0].capacity).not.toBe(input.materials[0].capacity);
  });
  it('takes the minimum of each actual material ratio, not min(yield)/max(stress)', async () => {
    const base = fixture();
    const input: SolidAnalysisInput = { ...base, nodes: [...base.nodes, [1, 1, 1]],
      elements: [base.elements[0], { nodes: [1, 2, 3, 4], materialId: 'second' }],
      materials: [{ id: 'm', youngMPa: 200, poisson: 0, capacity: capacity(true) },
        { id: 'second', youngMPa: 400, poisson: 0, capacity: capacity() }],
      constraints: [...base.constraints, { node: 4, fixed: [false, true, true] }],
      nodalLoads: [{ node: 1, forceN: [3, 0, 0] }, { node: 4, forceN: [2, 0, 0] }] };
    // Both strains=.03, sigma1=200*.03=6, sigma2=400*.03=12. V1=1/6,V2=1/3.
    const result = decodeSolidAnalysis({ schema: 'pointercad-solid-tet4-native/1', source: input.source,
      displacementMm: [[0, 0, 0], [.03, 0, 0], [0, 0, 0], [0, 0, 0], [.03, 0, 0]],
      elementForcesN: [[-1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0], [2, 0, 0, -2, 0, 0, -2, 0, 0, 2, 0, 0]],
      reservedNumericBytes: 50000, minimumScaledPivot: 1 }, input, await solidInputSha256(input));
    const summary = await summarizeSolidYield(input, result);
    expect(summary.elements[0].yieldRatio).toBeCloseTo(235 / 6, 12);
    expect(summary.elements[1].yieldRatio).toBeCloseTo(245 / 12, 12);
    expect(summary.minimumYieldRatio).toBeCloseTo(245 / 12, 12); expect(summary.minimumYieldRatio).not.toBe(235 / 12);
  });
});
