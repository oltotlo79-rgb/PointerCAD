import { describe, expect, it } from 'vitest';
import { readBeamAnalysisInputs } from './index.js';
import { FATIGUE_SAVED_GOODMAN_SCHEMA, readFatigueSavedInput } from './fatigueInput.js';
import { analysisPropertyEvidenceStatus, fatiguePropertySeries, type AnalysisPropertyEvidence } from './analysisPropertyEvidence.js';

/** Synthetic values, independent of a material catalogue and of the reader being checked. */
function saved() {
  const source = { kind: 'user-supplied', reference: 'synthetic test only', condition: 'uniaxial elastic test' };
  return { schema: FATIGUE_SAVED_GOODMAN_SCHEMA, id: 'fatigue', source: { documentId: 'owner' }, axial: [],
    input: { schema: 'pointercad-fatigue/1', curve: { id: 'curve', unit: 'MPa', stressDefinition: 'amplitude',
      meanStressAssumption: 'fully-reversed-only', referenceStressMpa: 100, referenceCycles: 1e6, slope: 2,
      cutoffStressMpa: null, source }, histories: [{ id: 'history-1', unit: 'MPa', stressMpa: [150, 250],
      sequence: 'repeated-periodic', repeats: 1, source }] },
    correction: { schema: 'pointercad-fatigue-goodman/1', method: 'goodman-tension-only/1', unit: 'MPa',
      applicability: 'uniaxial-elastic-symmetric-yield', ultimateTensileStrengthMpa: 400, yieldStrengthMpa: 300,
      minimumCycles: 1001, source } };
}

describe('versioned saved fatigue correction', () => {
  it('preserves v3 exactly with fresh nested ownership and no calculated results', () => {
    const value = saved(), checked = readFatigueSavedInput(value, 'fatigue');
    expect(checked).toEqual(value);
    expect(checked.input).not.toBe(value.input);
    if (checked.schema !== FATIGUE_SAVED_GOODMAN_SCHEMA) throw new Error('Expected version 3');
    expect(checked.correction).not.toBe(value.correction);
    expect(checked.correction.source).not.toBe(value.correction.source);
    expect(Object.keys(checked).sort()).toEqual(['axial', 'correction', 'id', 'input', 'schema', 'source']);
  });

  it('keeps v1/v2 uncorrected even when the curve states fully-reversed applicability', () => {
    const value = saved();
    const withoutAxial = { id: value.id, source: value.source, input: value.input };
    const version2 = { ...withoutAxial, axial: [], schema: 'pointercad-fatigue-saved/2' };
    expect(readFatigueSavedInput(version2, 'fatigue')).toEqual(version2);
    expect(readFatigueSavedInput({ ...withoutAxial, schema: 'pointercad-fatigue-saved/1' }, 'fatigue')).toEqual(version2);
    expect(readFatigueSavedInput(version2, 'fatigue')).not.toHaveProperty('correction');
  });

  const invalid: readonly (readonly [string, (value: ReturnType<typeof saved>) => unknown])[] = [
    ['missing correction', value => ({ ...value, correction: undefined })],
    ['unknown version', value => ({ ...value, schema: 'pointercad-fatigue-saved/4' })],
    ['legacy injection', value => ({ ...value, schema: 'pointercad-fatigue-saved/2' })],
    ['unknown method', value => ({ ...value, correction: { ...value.correction, method: 'other' } })],
    ['wrong units', value => ({ ...value, correction: { ...value.correction, unit: 'Pa' } })],
    ['unstated applicability', value => ({ ...value, correction: { ...value.correction, applicability: '' } })],
    ['zero strength', value => ({ ...value, correction: { ...value.correction, yieldStrengthMpa: 0 } })],
    ['yield exceeds tensile', value => ({ ...value, correction: { ...value.correction, yieldStrengthMpa: 401 } })],
    ['strength out of bounds', value => ({ ...value, correction: { ...value.correction, ultimateTensileStrengthMpa: 10001 } })],
    ['nonfinite strength', value => ({ ...value, correction: { ...value.correction, ultimateTensileStrengthMpa: NaN } })],
    ['coerced strength', value => ({ ...value, correction: { ...value.correction, ultimateTensileStrengthMpa: '400' } })],
    ['minimum boundary', value => ({ ...value, correction: { ...value.correction, minimumCycles: 1000 } })],
    ['minimum out of bounds', value => ({ ...value, correction: { ...value.correction, minimumCycles: 1e12 + 1 } })],
    ['blank source', value => ({ ...value, correction: { ...value.correction, source: { ...value.correction.source, reference: ' ' } } })],
    ['source injection', value => ({ ...value, correction: { ...value.correction, source: { ...value.correction.source, grade: 'invented' } } })],
    ['result injection', value => ({ ...value, result: { damage: 0 } })],
    ['incompatible curve', value => ({ ...value, input: { ...value.input,
      curve: { ...value.input.curve, meanStressAssumption: 'mean-independent' } } })],
  ];
  it.each(invalid)('refuses %s through the actual document attachment reader', (_label, change) => {
    const checked = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1', analyses: [
      { kind: 'fatigue', definition: change(saved()) },
    ] }, 'owner');
    expect(checked.ok).toBe(false);
  });
});

describe('optional S-N evidence without a saved schema change', () => {
  const curveEvidence: AnalysisPropertyEvidence = { property: 'sn', sourceId: 'synthetic-sn', sourceKind: 'user-provided',
    citation: 'Synthetic test table, row 1', materialConditionId: 's45c-normalized-reference',
    heatTreatment: '焼ならし・適用寸法未指定の参考値', temperatureC: 20, temperatureRange: { lower: 20, upper: 20, unit: 'degC' },
    units: { referenceStressMpa: 'MPa', referenceCycles: 'cycle', slope: '1' },
    testConditions: { description: 'Synthetic uniaxial test', parameters: { law: 'single-slope',
      stressDefinition: 'amplitude', meanStressAssumption: 'fully-reversed-only' } },
    validRange: { referenceStressMpa: { lower: 100, upper: 100, unit: 'MPa' },
      referenceCycles: { lower: 1e6, upper: 1e6, unit: 'cycle' }, slope: { lower: 2, upper: 2, unit: '1' } } };

  it.each(['pointercad-fatigue-saved/1', 'pointercad-fatigue-saved/2', FATIGUE_SAVED_GOODMAN_SCHEMA])(
    'keeps %s compatible, with evidence separate from the solver problem and correction', schema => {
      const value = saved();
      const base = { id: value.id, source: value.source, input: value.input, schema };
      const versioned = schema === 'pointercad-fatigue-saved/1' ? base : { ...base, axial: value.axial,
        ...(schema === FATIGUE_SAVED_GOODMAN_SCHEMA ? { correction: value.correction } : {}) };
      const legacy = readFatigueSavedInput(versioned, 'fatigue');
      expect(analysisPropertyEvidenceStatus(legacy.curveEvidence, fatiguePropertySeries(legacy.input.curve)))
        .toEqual({ status: 'unverified', reason: '出典未取得' });
      const checked = readFatigueSavedInput({ ...versioned, curveEvidence }, 'fatigue');
      expect(checked.schema).toBe(legacy.schema);
      expect(checked.input).toEqual(legacy.input);
      expect(analysisPropertyEvidenceStatus(checked.curveEvidence, fatiguePropertySeries(checked.input.curve)).status).toBe('verified');
      expect(readFatigueSavedInput(JSON.parse(JSON.stringify(checked)), 'fatigue')).toEqual(checked);
      expect(checked.input.curve.source).not.toHaveProperty('evidence');
      if (checked.schema === FATIGUE_SAVED_GOODMAN_SCHEMA) expect(checked.correction).toEqual(value.correction);
    });
});
