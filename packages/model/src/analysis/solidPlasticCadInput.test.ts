import { describe, expect, it } from 'vitest';
import { readSolidPlasticCadSavedInput, SOLID_PLASTIC_CAD_SCHEMA } from './solidPlasticCadInput.js';
import { readSolidCadSavedInput } from './solidCadInput.js';
import { readBeamAnalysisInputs, withBeamAnalysisInputs } from './beamInputs.js';
import { analysisPropertyEvidenceStatus, hardeningPropertySeries, type AnalysisPropertyEvidence } from './analysisPropertyEvidence.js';

/** Benchmark constants stated for this test only, not a material specification. */
function saved() {
  return { schema: SOLID_PLASTIC_CAD_SCHEMA, id: 'solid-plastic-cad', source: { documentId: 'part' }, bodyFeatureId: 'box',
    fixedFaces: ['fixed-origin'], loadedFaces: ['loaded-origin'], youngMPa: 200000, poisson: 0.3, yieldStressMPa: 250,
    hardeningModulusMPa: 2000, materialReference: 'Test benchmark constants, not a material specification',
    tractionMPa: [0, 0, -2], loadFactor: [0, 1, 0, -1, 0], stepsPerSegment: 4,
    linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 1 };
}
function linear() {
  return { schema: 'pointercad-solid-cad-input/1', id: 'solid-cad', source: { documentId: 'part' }, bodyFeatureId: 'box',
    fixedFaces: ['fixed-origin'], loadedFaces: ['loaded-origin'], youngMPa: 210000, poisson: 0.3, tractionMPa: [0, 0, -2],
    linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 1 };
}

describe('versioned CAD solid plasticity input persistence (authored, unexecuted)', () => {
  it('round-trips a load, unload and reverse history and owns every array', () => {
    const value = saved(), input = readSolidPlasticCadSavedInput(value);
    value.loadFactor[1] = 9; value.tractionMPa[2] = 100; value.fixedFaces[0] = 'changed';
    expect(input.loadFactor).toEqual([0, 1, 0, -1, 0]);
    expect(input.tractionMPa).toEqual([0, 0, -2]);
    expect(input.fixedFaces).toEqual(['fixed-origin']);
    expect(readSolidPlasticCadSavedInput(JSON.parse(JSON.stringify(input)))).toEqual(input);
  });

  it.each([
    ['newer version', { schema: 'pointercad-solid-plastic-cad-input/2' }],
    ['saved results', { results: [] }],
    ['zero Young modulus', { youngMPa: 0 }],
    ['incompressible Poisson ratio', { poisson: 0.5 }],
    ['negative Poisson ratio (solver range is [0, 0.5))', { poisson: -0.1 }],
    ['yield stress not below E', { yieldStressMPa: 200000 }],
    ['softening', { hardeningModulusMPa: -1 }],
    ['missing material source', { materialReference: '' }],
    ['whitespace-only material source', { materialReference: String.fromCodePoint(0x3000, 0xa0) }],
    ['material source over 500 code points', { materialReference: String.fromCodePoint(0x1d465).repeat(501) }],
    ['history not starting at 0', { loadFactor: [1, 0] }],
    ['single knot', { loadFactor: [0] }],
    ['repeated knot', { loadFactor: [0, 1, 1] }],
    ['non-finite knot', { loadFactor: [0, Infinity] }],
    ['zero steps', { stepsPerSegment: 0 }],
    ['fractional steps', { stepsPerSegment: 1.5 }],
    ['more than 2000 steps', { loadFactor: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1], stepsPerSegment: 200 }],
    ['non-finite traction', { tractionMPa: [0, Infinity, 0] }],
    ['no fixed faces', { fixedFaces: [] }],
    ['duplicate loaded faces', { loadedFaces: ['same', 'same'] }],
    ['empty body', { bodyFeatureId: '' }],
    ['negative accuracy limit', { maximumVolumeDeviationMm3: -1 }],
  ])('refuses %s without defaults', (_label, patch) => {
    expect(() => readSolidPlasticCadSavedInput({ ...saved(), ...patch })).toThrow();
  });

  it('accepts the 500-code-point source boundary (1000 UTF-16 units)', () => {
    expect(readSolidPlasticCadSavedInput({ ...saved(), materialReference: String.fromCodePoint(0x1d465).repeat(500) })
      .materialReference).toHaveLength(1000);
  });

  it('coexists with the linear solid input, refuses a second plasticity entry and binds the document owner', () => {
    const plastic = readSolidPlasticCadSavedInput(saved()), solid = readSolidCadSavedInput(linear());
    const both = { schema: 'pointercad-beam-inputs/1',
      analyses: [{ kind: 'solid-cad', definition: solid }, { kind: 'solid-plastic-cad', definition: plastic }] };
    const checked = readBeamAnalysisInputs(both, 'part');
    expect(checked.ok).toBe(true);
    expect(readBeamAnalysisInputs({ ...both, analyses: [...both.analyses, { kind: 'solid-plastic-cad', definition: plastic }] },
      'part').ok).toBe(false);
    expect(readBeamAnalysisInputs(both, 'other').ok).toBe(false);
    const before = { id: 'part' };
    const after = withBeamAnalysisInputs(before, { schema: 'pointercad-beam-inputs/1',
      analyses: [{ kind: 'solid-plastic-cad', definition: plastic }] });
    expect(after).not.toBe(before);
    expect(before).toEqual({ id: 'part' });
  });

  it('leaves documents without the new kind readable exactly as before', () => {
    const solid = readSolidCadSavedInput(linear());
    const only = { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'solid-cad', definition: solid }] };
    expect(readBeamAnalysisInputs(only, 'part').ok).toBe(true);
    expect(readBeamAnalysisInputs({ ...only, analyses: [{ kind: 'solid-plastic', definition: solid }] }, 'part').ok).toBe(false);
  });
});

describe('optional solid hardening evidence', () => {
  it('keeps old input unverified and binds explicit evidence to the actual saved coefficients', () => {
    const legacy = readSolidPlasticCadSavedInput(saved());
    expect(analysisPropertyEvidenceStatus(legacy.hardeningEvidence, hardeningPropertySeries(legacy)))
      .toEqual({ status: 'unverified', reason: '出典未取得' });
    const hardeningEvidence: AnalysisPropertyEvidence = { property: 'hardening', sourceId: 'synthetic-hardening', sourceKind: 'user-provided',
      citation: 'Synthetic test table, row 1', materialConditionId: 's45c-normalized-reference',
      heatTreatment: '焼ならし・適用寸法未指定の参考値', temperatureC: 20, temperatureRange: { lower: 20, upper: 20, unit: 'degC' },
      units: { yieldStressMPa: 'MPa', hardeningModulusMPa: 'MPa' },
      testConditions: { description: 'Synthetic small-strain test', parameters: { law: 'linear-isotropic' } },
      validRange: { yieldStressMPa: { lower: 250, upper: 250, unit: 'MPa' },
        hardeningModulusMPa: { lower: 2000, upper: 2000, unit: 'MPa' } } };
    const checked = readSolidPlasticCadSavedInput({ ...saved(), hardeningEvidence });
    expect(checked.schema).toBe(SOLID_PLASTIC_CAD_SCHEMA);
    expect(analysisPropertyEvidenceStatus(checked.hardeningEvidence, hardeningPropertySeries(checked)).status).toBe('verified');
    expect(readSolidPlasticCadSavedInput(JSON.parse(JSON.stringify(checked)))).toEqual(checked);
    expect(() => readSolidPlasticCadSavedInput({ ...checked, hardeningModulusMPa: 2001 }))
      .toThrow(expect.objectContaining({ code: 'property-evidence-outside-range' }));
    expect(checked.hardeningModulusMPa).toBe(2000);
  });
});
