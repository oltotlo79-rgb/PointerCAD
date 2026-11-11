import { describe, expect, it } from 'vitest';
import { cadSolidFiniteInput, type CadSolidFiniteSettings } from './cadSolidFinite.js';
import type { CadSolidPrepared } from './cadSolidAnalysis.js';
import { translateSolidAnalysis } from './solidAnalysisTranslation.js';

function prepared(): CadSolidPrepared {
  const boundary = [[0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const input = translateSolidAnalysis({ schema: 'pointercad-solid-tet4/1', units: 'N-mm-MPa',
    source: { documentId: 'part', revision: 7, meshKey: 'mesh-1' }, numericBudgetBytes: 1_000_000,
    nodes: [[0, 0, 0], [2, 0, 0], [2, 3, 0], [0, 3, 0], [0, 0, 4], [2, 0, 4], [2, 3, 4], [0, 3, 4], [1, 1.5, 2]],
    elements: boundary.map(face => ({ materialId: 'm', nodes: [8, ...face] })),
    materials: [{ id: 'm', youngMPa: 200000, poisson: 0.3 }],
    constraints: [0, 1, 2, 3].map(node => ({ node, fixed: [true, true, true], prescribedMm: node === 0 ? [0.1, 0, 0] : [0, 0, 0] })),
    nodalLoads: [], surfaceLoads: [[4, 5, 6], [4, 6, 7]].map(nodes => ({ nodes, tractionMPa: [0, 0, 2] })) }).input;
  return { input, loadedAreaMm2: 6, totalForceN: [0, 0, 12] };
}
function settings(): CadSolidFiniteSettings {
  return { material: { id: 'm', youngMPa: 200000, poisson: 0.3 }, fixedFaces: [], loadedFaces: [], tractionMPa: [0, 0, 2],
    numericBudgetBytes: 1_000_000, geometry: { kind: 'planar', boundary: { boundary: 'closed', linearDeflection: 0.05, angularDeflection: 0.2 } },
    yieldStressMPa: 250, hardeningModulusMPa: 2000, materialReference: 'Synthetic input mapping fixture, not a material specification',
    forceFactors: [0.5, 1, -1], prescribedDisplacementFactors: [0.25, 1, 0] };
}
describe('CAD finite input mapping (explicit step data, unchanged numerical law)', () => {
  it('uses the existing nodal force assembly, original mm coordinates and prescribed displacements without interpolation', () => {
    const value = prepared(), input = cadSolidFiniteInput(value, settings()), linear = translateSolidAnalysis(value.input).plan;
    expect(input.source).toEqual({ documentId: 'part', revision: 7 });
    expect(input.plan.nodes).toEqual(value.input.nodes); expect(input.plan.elements).toEqual(value.input.elements.map(element => element.nodes));
    expect(input.plan.steps).toBe(3); expect(input.plan.prescribedMm).toHaveLength(12);
    expect(input.plan.prescribedMm.find(row => row.node === 0 && row.dof === 'x')?.valuesMm).toEqual([0.025, 0.1, 0]);
    expect(input.plan.forcesN).toEqual([
      { node: 4, dof: 'z', valuesN: [2, 4, -4] }, { node: 5, dof: 'z', valuesN: [1, 2, -2] },
      { node: 6, dof: 'z', valuesN: [2, 4, -4] }, { node: 7, dof: 'z', valuesN: [1, 2, -2] },
    ]);
    // Independent area 2 mm * 3 mm times traction 2 N/mm²: the full 12 N survives each explicit load factor.
    expect([0, 1, 2].map(step => input.plan.forcesN.reduce((sum, force) => sum + force.valuesN[step], 0))).toEqual([6, 12, -12]);
    expect(input.plan.forcesN[0].valuesN).toEqual(settings().forceFactors.map(factor => factor * linear.forcesN[4][2]));
    expect(input.plan.material).toEqual({ youngMPa: 200000, poisson: 0.3, yieldStressMPa: 250, hardeningModulusMPa: 2000 });
    expect(Object.hasOwn(input.plan.material, 'source')).toBe(false);
    expect(Object.isFrozen(input.plan.forcesN[0].valuesN)).toBe(true);
  });
  it.each([1, -1])('preserves the full supported-node face resultant of sign %s', sign => {
    const original = prepared();
    const input = translateSolidAnalysis({ ...original.input,
      nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], elements: [{ materialId: 'm', nodes: [0, 1, 2, 3] }],
      constraints: [0, 1, 2].map(node => ({ node, fixed: [true, true, true] })),
      surfaceLoads: [{ nodes: [1, 2, 3], tractionMPa: [0, 0, 2 * sign] }] }).input;
    const assembled = translateSolidAnalysis(input).plan;
    // Triangle area sqrt(3)/2 mm² times signed traction 2 N/mm² is ±sqrt(3) N, not ±sqrt(3)/3 N.
    expect(assembled.forcesN.reduce((sum, force) => sum + force[2], 0)).toBeCloseTo(sign * Math.sqrt(3), 12);
    expect(assembled.forcesN[1][2] + assembled.forcesN[2][2]).toBeCloseTo(sign * 2 * Math.sqrt(3) / 3, 12);
    const finite = cadSolidFiniteInput({ ...original, input }, settings());
    for (let step = 0; step < 3; step++) {
      expect(finite.plan.forcesN.reduce((sum, force) => sum + force.valuesN[step], 0))
        .toBeCloseTo(sign * Math.sqrt(3) * settings().forceFactors[step], 12);
    }
    expect(finite.plan.forcesN.filter(force => force.node === 1 || force.node === 2)).toHaveLength(2);
  });
  it('preserves the full gravity resultant including prescribed DOFs', () => {
    const value = prepared(), input = { ...value.input, surfaceLoads: [], gravity: {
      accelerationMps2: [0, 0, -10] as const, densities: [{ materialId: 'm', densityKgM3: 1000 }] } };
    const linear = translateSolidAnalysis(input).plan;
    // 24 mm³ * 1e-9 m³/mm³ * 1000 kg/m³ * -10 m/s².
    expect(linear.forcesN.reduce((sum, force) => sum + force[2], 0)).toBeCloseTo(-0.00024, 12);
    const finite = cadSolidFiniteInput({ ...value, input }, settings());
    for (let step = 0; step < 3; step++) expect(finite.plan.forcesN.reduce((sum, force) => sum + force.valuesN[step], 0))
      .toBeCloseTo(-0.00024 * settings().forceFactors[step], 12);
    expect(finite.plan.forcesN.filter(force => force.node < 4)).toHaveLength(4);
  });
  it.each([
    { forceFactors: [0, 0, 0] },
    { forceFactors: [NaN, 1, 2] },
    { prescribedDisplacementFactors: [0, Infinity, 1] },
    { prescribedDisplacementFactors: [0, 1] },
    { forceFactors: Array.from({ length: 201 }, () => 1), prescribedDisplacementFactors: Array.from({ length: 201 }, () => 1) },
    { materialReference: ' ' }, { referenceForceN: 0 }, { referenceForceN: Infinity },
  ])('refuses invalid history/reference settings %j', changed => {
    expect(() => cadSolidFiniteInput(prepared(), { ...settings(), ...changed })).toThrow();
  });
  it('preserves explicit displacement control with a positive reference force, and rejects no scale for an unloaded free set', () => {
    const input = cadSolidFiniteInput(prepared(), { ...settings(), forceFactors: [0, 0, 0], referenceForceN: 1 });
    expect(input.plan.referenceForceN).toBe(1); expect(input.plan.forcesN[0].valuesN).toEqual([0, 0, 0]);
    const value = prepared(), noLoad = { ...value, input: { ...value.input, surfaceLoads: [] } };
    expect(() => cadSolidFiniteInput(noLoad, settings())).toThrow('referenceForceN');
  });
  it('keeps W34 material/record bounds and rejects stale material pairing or overflow', () => {
    expect(() => cadSolidFiniteInput(prepared(), { ...settings(), hardeningModulusMPa: -1 })).toThrow();
    expect(() => cadSolidFiniteInput(prepared(), { ...settings(), material: { ...settings().material, youngMPa: 180000 } })).toThrow('material differs');
    const value = prepared(), largeReference = { ...value, input: { ...value.input,
      surfaceLoads: [{ nodes: [4, 5, 6] as const, tractionMPa: [0, 0, 20] as const }] } };
    expect(() => cadSolidFiniteInput(largeReference, { ...settings(), forceFactors: [Number.MAX_VALUE, 1, 1],
      prescribedDisplacementFactors: [Number.MAX_VALUE, 1, 1] })).toThrow();
  });
});
