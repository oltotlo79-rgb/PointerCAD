import { describe, expect, it } from 'vitest';
import { readSolidFiniteCadSavedInput, SOLID_FINITE_CAD_SCHEMA } from './solidFiniteCadInput.js';
import { readSolidPlasticCadSavedInput } from './solidPlasticCadInput.js';
import { findStrengthMaterial } from '../measure/strengthMaterials.js';
import type { AnalysisPropertyEvidence } from './analysisPropertyEvidence.js';

/** Synthetic benchmark constants only, not a material specification. */
function saved() {
  return { schema: SOLID_FINITE_CAD_SCHEMA, id: 'solid-finite-cad', source: { documentId: 'part' }, bodyFeatureId: 'box',
    fixedFaces: ['bottom'], loadedFaces: ['top'], youngMPa: 200000, poisson: 0.3, yieldStressMPa: 250,
    hardeningModulusMPa: 2000, materialReference: 'Synthetic benchmark material source', tractionMPa: [0, 0, -2],
    forceFactors: [1, 1, 0, -1], prescribedDisplacementFactors: [0, -1, -1, 2],
    linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 1 };
}
function evidence(): AnalysisPropertyEvidence {
  const material = findStrengthMaterial('s45c-normalized-reference');
  if (!material) throw new Error('Missing existing evidence fixture condition');
  return { property: 'hardening', sourceId: 'synthetic-hardening', sourceKind: 'user-provided',
    citation: 'Synthetic test table, row 1', materialConditionId: material.id, heatTreatment: material.condition,
    temperatureC: 20, temperatureRange: { lower: 20, upper: 20, unit: 'degC' },
    units: { yieldStressMPa: 'MPa', hardeningModulusMPa: 'MPa' },
    testConditions: { description: 'Synthetic hardening test', parameters: { law: 'linear-isotropic' } },
    validRange: { yieldStressMPa: { lower: 250, upper: 250, unit: 'MPa' },
      hardeningModulusMPa: { lower: 2000, upper: 2000, unit: 'MPa' } } };
}
describe('strict finite CAD saved definition', () => {
  it('keeps explicit repeated, negative and nonzero-first steps, owns arrays and preserves missing optional fields', () => {
    const raw = saved(), result = readSolidFiniteCadSavedInput(raw);
    expect(readSolidFiniteCadSavedInput(JSON.parse(JSON.stringify(result)))).toEqual(result);
    raw.forceFactors[0] = 99; raw.fixedFaces[0] = 'changed'; raw.tractionMPa[2] = 12;
    expect(result.forceFactors).toEqual([1, 1, 0, -1]); expect(result.fixedFaces).toEqual(['bottom']);
    expect(result.tractionMPa).toEqual([0, 0, -2]); expect(Object.hasOwn(result, 'hardeningEvidence')).toBe(false);
    expect(Object.hasOwn(result, 'supports')).toBe(false); expect(Object.hasOwn(result, 'gravity')).toBe(false);
  });
  it.each([
    { schema: 'pointercad-solid-plastic-cad-input/1' }, { id: 'solid-plastic-cad' }, { loadFactor: [0, 1] },
    { stepsPerSegment: 4 }, { mesh: {} }, { result: {} }, { generation: 1 }, { youngMPa: 0 }, { youngMPa: Infinity },
    { poisson: -0.1 }, { poisson: 0.5 }, { yieldStressMPa: 0 }, { hardeningModulusMPa: -1 },
    { forceFactors: [] }, { forceFactors: [1, NaN, 0, 0] }, { forceFactors: Array(201).fill(1) },
    { prescribedDisplacementFactors: [1] }, { prescribedDisplacementFactors: [0, 0, Infinity, 0] },
    { materialReference: '  ' }, { materialReference: '\u{1d465}'.repeat(251) },
    { linearDeflectionMm: 0 }, { angularDeflectionRad: -1 }, { maximumChordDeviationMm: -1 },
    { maximumVolumeDeviationMm3: NaN }, { tractionMPa: [0, 0] }, { tractionMPa: [0, 0, Infinity] },
    { fixedFaces: [] }, { loadedFaces: [] }, { fixedFaces: ['same', 'same'] }, { loadedFaces: ['same', 'same'] },
    { bodyFeatureId: '' }, { referenceForceN: 0 }, { referenceForceN: undefined }, { referenceForceN: Infinity },
    { forceFactors: [0, 0, 0, 0] }, { supports: [] }, { gravity: undefined },
  ])('refuses malformed or cross-schema input %j', patch => {
    expect(() => readSolidFiniteCadSavedInput({ ...saved(), ...patch })).toThrow();
  });
  it('accepts yield above E, 200 native steps and exactly 500 JS string units without interpolation', () => {
    const result = readSolidFiniteCadSavedInput({ ...saved(), yieldStressMPa: 300000,
      materialReference: '\u{1d465}'.repeat(250), forceFactors: Array(200).fill(-1), prescribedDisplacementFactors: Array(200).fill(2) });
    expect(result.yieldStressMPa).toBe(300000); expect(result.forceFactors).toHaveLength(200);
    expect(result.materialReference).toHaveLength(500);
  });
  it('rejects inherited, accessor, symbol, hidden and sparse fields without evaluating getters', () => {
    const inherited: unknown = Object.create({ schema: SOLID_FINITE_CAD_SCHEMA });
    if (inherited === null || typeof inherited !== 'object') throw new Error('Expected inherited-field fixture object');
    Object.assign(inherited, saved());
    Reflect.deleteProperty(inherited, 'schema');
    expect(() => readSolidFiniteCadSavedInput(inherited)).toThrow();
    const hidden = { ...saved() }; Object.defineProperty(hidden, 'id', { value: 'solid-finite-cad', enumerable: false });
    expect(() => readSolidFiniteCadSavedInput(hidden)).toThrow();
    expect(() => readSolidFiniteCadSavedInput({ ...saved(), [Symbol('extra')]: 1 })).toThrow();
    let reads = 0; const accessor = { ...saved() };
    Object.defineProperty(accessor, 'forceFactors', { enumerable: true, get: () => { reads++; return [1]; } });
    expect(() => readSolidFiniteCadSavedInput(accessor)).toThrow(); expect(reads).toBe(0);
    for (const name of ['fixedFaces', 'loadedFaces', 'forceFactors', 'prescribedDisplacementFactors', 'tractionMPa']) {
      const sparse = Array(name === 'tractionMPa' ? 3 : 4); sparse[0] = 1;
      expect(() => readSolidFiniteCadSavedInput({ ...saved(), [name]: sparse })).toThrow();
      const extra = Object.assign([1, 1, 1, 1], { extra: 1 });
      expect(() => readSolidFiniteCadSavedInput({ ...saved(), [name]: extra })).toThrow();
    }
    const inheritedSource: unknown = Object.create({ documentId: 'part' });
    if (inheritedSource === null || typeof inheritedSource !== 'object') throw new Error('Expected inherited-source fixture object');
    expect(() => readSolidFiniteCadSavedInput({ ...saved(), source: inheritedSource })).toThrow();
  });
  it('preserves signed prescribed supports and gravity and requires the explicit reference for displacement control', () => {
    const supports = [{ face: 'side', fixed: [true, false, true], prescribedMm: [-2, 0, 1] }];
    const raw = { ...saved(), fixedFaces: [], loadedFaces: [], supports, referenceForceN: 10 };
    const result = readSolidFiniteCadSavedInput(raw);
    expect(result.supports?.[0].prescribedMm).toEqual([-2, 0, 1]);
    supports[0].prescribedMm[0] = 55; expect(result.supports?.[0].prescribedMm?.[0]).toBe(-2);
    expect(() => readSolidFiniteCadSavedInput({ ...raw, referenceForceN: undefined })).toThrow();
    const gravity = { accelerationMps2: [0, 0, -9.81], densityKgM3: 7800 };
    expect(readSolidFiniteCadSavedInput({ ...saved(), loadedFaces: [], gravity }).gravity).toEqual(gravity);
    expect(() => readSolidFiniteCadSavedInput({ ...saved(), loadedFaces: [], gravity: { ...gravity, densityKgM3: 0 } })).toThrow();
    expect(() => readSolidFiniteCadSavedInput({ ...saved(), gravity: { ...gravity, accelerationMps2: [0, 0, NaN] } })).toThrow();
    expect(readSolidFiniteCadSavedInput({ ...saved(), forceFactors: [0, 0, 0, 0], referenceForceN: 1 }).referenceForceN).toBe(1);
  });
  it('refuses duplicate, conflicting, malformed and all-free supports', () => {
    for (const supports of [
    [{ face: 'bottom', fixed: [true, true, true] }],
    [{ face: 'side', fixed: [false, false, false] }],
    [{ face: 'side', fixed: [true, false, false], prescribedMm: [0, 1, 0] }],
    [{ face: 'side', fixed: [1, true, false] }],
    [{ face: 'side', fixed: [true, false, false] }, { face: 'side', fixed: [true, true, true] }],
    ]) expect(() => readSolidFiniteCadSavedInput({ ...saved(), supports })).toThrow();
  });
  it('retains authored evidence, rejects a changed coefficient and never migrates an old schema', () => {
    const result = readSolidFiniteCadSavedInput({ ...saved(), hardeningEvidence: evidence() });
    expect(result.hardeningEvidence).toEqual(evidence());
    expect(() => readSolidFiniteCadSavedInput({ ...result, hardeningModulusMPa: 2001 })).toThrow();
    expect(() => readSolidFiniteCadSavedInput({ ...saved(), hardeningEvidence: undefined })).toThrow();
    expect(() => readSolidPlasticCadSavedInput(result)).toThrow();
  });
});
