import { describe, expect, it } from 'vitest';
import type { SolidAnalysisInput } from './solidAnalysisModel.js';
import { decodeSolidAnalysis, solidResultMatches } from './solidAnalysisResults.js';
import { solidInputSha256 } from './solidAnalysisTranslation.js';

function fixture(length = 1, youngMPa = 210000, force = 1): SolidAnalysisInput {
  return { schema: 'pointercad-solid-tet4/1', source: { documentId: 'tet', revision: 1, meshKey: 'tet:1' },
    units: 'N-mm-MPa', numericBudgetBytes: 16 * 1024 * 1024,
    nodes: [[0, 0, 0], [length, 0, 0], [0, length, 0], [0, 0, length]],
    elements: [{ nodes: [0, 1, 2, 3], materialId: 'm' }], materials: [{ id: 'm', youngMPa, poisson: 0 }],
    constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, true, true] },
      { node: 2, fixed: [true, true, true] }, { node: 3, fixed: [true, true, true] }],
    nodalLoads: [{ node: 1, forceN: [force, 0, 0] }], surfaceLoads: [] };
}
const digest = '1'.repeat(64);
function native(input: SolidAnalysisInput) {
  const length = input.nodes[1][0], force = input.nodalLoads[0].forceN[0], e = input.materials[0].youngMPa;
  // Independent single free DOF: stiffness E*L/6; the tetra volume is L^3/6.
  return { schema: 'pointercad-solid-tet4-native/1', source: input.source,
    displacementMm: [[0, 0, 0], [6 * force / (e * length), 0, 0], [0, 0, 0], [0, 0, 0]],
    elementForcesN: [[-force, 0, 0, force, 0, 0, 0, 0, 0, 0, 0, 0]],
    reservedNumericBytes: 50000, minimumScaledPivot: 1 };
}

describe('independent solid native result acceptance', () => {
  it.each([[1, 210000, 1], [1, 420000, -2], [1000, 210000, 1000]] as const)(
    'preserves coherent mm/MPa, signed loading and material scaling L=%s E=%s F=%s', (length, young, force) => {
      const input = fixture(length, young, force), result = decodeSolidAnalysis(native(input), input, digest);
      expect(result.displacementMm[1][0]).toBeCloseTo(6 * force / (young * length), 12);
      expect(result.elements[0].strain[0]).toBeCloseTo(6 * force / (young * length * length), 12);
      expect(result.elements[0].stressMPa[0]).toBeCloseTo(6 * force / (length * length), 12);
      expect(result.reactionN[0]).toEqual([-force, 0, 0]);
      expect(result.strainEnergyNmm).toBeCloseTo(3 * force * force / (young * length), 12);
      expect(solidResultMatches(result, input, digest)).toBe(true);
    });
  it('rotates the geometry and load together instead of treating global y as x', () => {
    const base = fixture(), input: SolidAnalysisInput = { ...base,
      nodes: base.nodes.map(([x, y, z]) => [-y, x, z]),
      constraints: base.constraints.map(row => ({ ...row, fixed: [row.fixed[1], row.fixed[0], row.fixed[2]] })),
      nodalLoads: [{ node: 1, forceN: [0, 1, 0] }] };
    const raw = native(base);
    const result = decodeSolidAnalysis({ ...raw,
      displacementMm: raw.displacementMm.map(([x, y, z]) => [-y, x, z]),
      elementForcesN: [[0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]] }, input, digest);
    expect(result.elements[0].stressMPa).toEqual([0, 6, 0, 0, 0, 0]);
    expect(result.reactionN[0]).toEqual([0, -1, 0]);
  });
  it('validates pure shear against independent G gamma and boundary reactions', () => {
    const base = fixture(), shearForce = 1.6 / 6;
    const input: SolidAnalysisInput = { ...base, materials: [{ id: 'm', youngMPa: 200, poisson: 0.25 }],
      constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [true, true, true] },
        { node: 2, fixed: [false, true, true] }, { node: 3, fixed: [true, true, true] }],
      nodalLoads: [{ node: 2, forceN: [shearForce, 0, 0] }] };
    const result = decodeSolidAnalysis({ ...native(base),
      displacementMm: [[0, 0, 0], [0, 0, 0], [0.02, 0, 0], [0, 0, 0]],
      elementForcesN: [[-shearForce, -shearForce, 0, 0, shearForce, 0, shearForce, 0, 0, 0, 0, 0]] }, input, digest);
    expect(result.elements[0].strain[5]).toBe(0.02);
    expect(result.elements[0].stressMPa[5]).toBe(1.6);
    expect(result.strainEnergyNmm).toBeCloseTo(1.6 * 0.02 / 12, 14);
  });
  it('binds every constraint/material/load/source value into the digest and rejects stale or forged values', async () => {
    const input = fixture(), hash = await solidInputSha256(input), result = decodeSolidAnalysis(native(input), input, hash);
    expect(solidResultMatches(result, input, hash)).toBe(true);
    expect(await solidInputSha256({ ...input, source: { ...input.source, revision: 2 } })).not.toBe(hash);
    expect(solidResultMatches({ ...result, reactionN: [[0, 0, 0], ...result.reactionN.slice(1)] }, input, hash)).toBe(false);
    expect(solidResultMatches({ ...result, elements: [{ strain: result.elements[0].strain, stressMPa: [60, 0, 0, 0, 0, 0] }] }, input, hash)).toBe(false);
    expect(solidResultMatches(result, { ...input, source: { ...input.source, revision: 2 } }, hash)).toBe(false);
  });
  it.each([0, -1, Number.NaN, 1e-16])('rejects invalid or unresolved native factor pivot %s', minimumScaledPivot => {
    const input = fixture();
    expect(() => decodeSolidAnalysis({ ...native(input), minimumScaledPivot }, input, digest)).toThrow();
  });
  it('rejects sparse arrays, zero displacement under load, changed action and excessive allocation', () => {
    const input = fixture(), raw = native(input);
    expect(() => decodeSolidAnalysis({ ...raw, displacementMm: new Array<unknown>(4) }, input, digest)).toThrow();
    expect(() => decodeSolidAnalysis({ ...raw, displacementMm: input.nodes.map(() => [0, 0, 0]) }, input, digest)).toThrow();
    expect(() => decodeSolidAnalysis({ ...raw, elementForcesN: [[-2, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]] }, input, digest)).toThrow();
    expect(() => decodeSolidAnalysis({ ...raw, reservedNumericBytes: input.numericBudgetBytes + 1 }, input, digest)).toThrow();
  });
});
