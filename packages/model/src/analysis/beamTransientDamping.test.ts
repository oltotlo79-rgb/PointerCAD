import { describe, expect, it } from 'vitest';
import { readBeamTransientHistory } from './beamTransientHistory.js';
import { readBeamAnalysisInputs, withBeamAnalysisInputs, type StandardBeamTransientDefinition } from './beamInputs.js';
import { bucklingCadFixture } from './beamBuckling.testSupport.js';
import { analysisPropertyEvidenceStatus, rayleighPropertySeries, type AnalysisPropertyEvidence } from './analysisPropertyEvidence.js';

const history = { timeStepS: 0.01, stepCount: 10, outputEvery: 1,
  loadFactor: [{ timeS: 0, factor: 1 }, { timeS: 0.1, factor: 1 }],
  damping: { kind: 'rayleigh', massCoefficientPerS: 4, stiffnessCoefficientS: 0.002 },
  initialConditions: 'zero-at-rest' };

describe('explicit saved Rayleigh damping', () => {
  it('owns coefficients, preserves units and old none, and normalizes negative zero', () => {
    const result = readBeamTransientHistory(history, 'history');
    expect(result).toEqual(history);
    expect(result.damping).not.toBe(history.damping);
    expect(readBeamTransientHistory({ ...history, damping: 'none' }, 'history').damping).toBe('none');
    expect(readBeamTransientHistory({ ...history, damping: { kind: 'rayleigh',
      massCoefficientPerS: -0, stiffnessCoefficientS: -0 } }, 'history').damping)
      .toEqual({ kind: 'rayleigh', massCoefficientPerS: 0, stiffnessCoefficientS: 0 });
  });

  it.each([
    'rayleigh', 'modal', null, [], {},
    { kind: 'rayleigh', massCoefficientPerS: 1 },
    { kind: 'rayleigh', massCoefficientPerS: 1, stiffnessCoefficientS: 0, extra: 0 },
    { kind: 'modal', massCoefficientPerS: 1, stiffnessCoefficientS: 0 },
    ...['massCoefficientPerS', 'stiffnessCoefficientS'].flatMap(key =>
      [-1, true, '1', Number.NaN, Number.POSITIVE_INFINITY].map(value => ({ ...history.damping, [key]: value }))),
  ])('rejects malformed or active damping before numerical work: %j', damping => {
    expect(() => readBeamTransientHistory({ ...history, damping }, 'history')).toThrow('transient-damping:');
  });

  it('rejects hidden/symbol/inherited coefficient fields rather than silently losing them in JSON', () => {
    const inherited: unknown = Object.create(history.damping);
    const symbol = { ...history.damping, [Symbol('hidden')]: 1 };
    const hidden = Object.defineProperty({ ...history.damping }, 'extra', { value: 1 });
    for (const damping of [inherited, symbol, hidden]) {
      expect(() => readBeamTransientHistory({ ...history, damping }, 'history')).toThrow('transient-damping:');
    }
  });

  it('roundtrips coefficients through actual saved analysis decoding without storing derived loss', () => {
    const fixture = bucklingCadFixture();
    const { buckling: mesh, ...base } = fixture.definition;
    const definition: StandardBeamTransientDefinition = { ...base, schema: 'pointercad-standard-beam/4',
      transient: { segmentsPerMember: mesh.segmentsPerMember,
        history: readBeamTransientHistory(history, 'history') } };
    const input = { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition }] };
    const saved = withBeamAnalysisInputs(fixture.document, input);
    const reloaded = readBeamAnalysisInputs(JSON.parse(JSON.stringify(saved.beamAnalysisInputs)), fixture.document.id);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) throw new Error(reloaded.issue.message);
    expect(reloaded.value).toEqual(input);
    expect(JSON.stringify(reloaded.value)).not.toContain('dissipatedEnergyJ');
    expect(fixture.document.beamAnalysisInputs).toBeUndefined();
  });
});

describe('saved Rayleigh source contract', () => {
  const evidence: AnalysisPropertyEvidence = { property: 'rayleigh', sourceId: 'synthetic-damping', sourceKind: 'user-provided',
    citation: 'Synthetic test table, row 1', materialConditionId: 's45c-normalized-reference',
    heatTreatment: '焼ならし・適用寸法未指定の参考値', temperatureC: 20, temperatureRange: { lower: 10, upper: 30, unit: 'degC' },
    units: { massCoefficientPerS: '1/s', stiffnessCoefficientS: 's' },
    testConditions: { description: 'Synthetic linear viscous test', parameters: { law: 'C=alpha*M+beta*K' } },
    validRange: { massCoefficientPerS: { lower: 0, upper: 4, unit: '1/s' },
      stiffnessCoefficientS: { lower: 0, upper: 0.002, unit: 's' } } };

  it('derives unverified for legacy coefficients and verified for a matching optional source', () => {
    const legacy = readBeamTransientHistory(history, 'history');
    if (legacy.damping === 'none') throw new Error('Expected Rayleigh coefficients');
    expect(analysisPropertyEvidenceStatus(legacy.damping.evidence, rayleighPropertySeries(legacy.damping)))
      .toEqual({ status: 'unverified', reason: '出典未取得' });
    const checked = readBeamTransientHistory({ ...history, damping: { ...history.damping, evidence } }, 'history');
    if (checked.damping === 'none') throw new Error('Expected Rayleigh coefficients');
    expect(analysisPropertyEvidenceStatus(checked.damping.evidence, rayleighPropertySeries(checked.damping)).status).toBe('verified');
    expect(checked.damping.evidence).toEqual(evidence);
    expect(checked.damping.evidence).not.toBe(evidence);
    expect(readBeamTransientHistory(JSON.parse(JSON.stringify(checked)), 'history')).toEqual(checked);
    expect(JSON.stringify(checked)).not.toContain('verified');
  });

  it('preserves the source through the actual saved attachment reader', () => {
    const fixture = bucklingCadFixture();
    const { buckling: mesh, ...base } = fixture.definition;
    const definition: StandardBeamTransientDefinition = { ...base, schema: 'pointercad-standard-beam/4',
      transient: { segmentsPerMember: mesh.segmentsPerMember,
        history: readBeamTransientHistory({ ...history, damping: { ...history.damping, evidence } }, 'history') } };
    const input = { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition }] };
    const before = new TextEncoder().encode(JSON.stringify(fixture.document));
    const saved = withBeamAnalysisInputs(fixture.document, input);
    const checked = readBeamAnalysisInputs(JSON.parse(JSON.stringify(saved.beamAnalysisInputs)), fixture.document.id);
    expect(checked.ok).toBe(true);
    if (!checked.ok) throw new Error(checked.issue.message);
    expect(checked.value).toEqual(input);
    expect(new TextEncoder().encode(JSON.stringify(fixture.document))).toEqual(before);
  });

  it.each([
    ['unit-mismatch', { ...evidence, units: { ...evidence.units, massCoefficientPerS: 's' } }],
    ['condition-mismatch', { ...evidence, heatTreatment: '焼入焼戻・適用寸法未指定の参考値' }],
    ['outside-range', { ...evidence, temperatureC: 31 }],
    ['outside-range', { ...evidence, validRange: { ...evidence.validRange, massCoefficientPerS: { lower: 0, upper: 3, unit: '1/s' } } }],
    ['shape', undefined], ['shape', null],
  ])('rejects %s and preserves the full document bytes', (code, invalid) => {
    const fixture = bucklingCadFixture();
    const { buckling: mesh, ...base } = fixture.definition;
    const definition = { ...base, schema: 'pointercad-standard-beam/4', transient: { segmentsPerMember: mesh.segmentsPerMember,
      history: { ...history, damping: { ...history.damping, evidence: invalid } } } };
    const document = { ...fixture.document, beamAnalysisInputs: { schema: 'pointercad-beam-inputs/1',
      analyses: [{ kind: 'standard-members', definition }] } };
    const before = new TextEncoder().encode(JSON.stringify(document));
    const checked = readBeamAnalysisInputs(document.beamAnalysisInputs, document.id);
    expect(checked.ok).toBe(false);
    if (checked.ok) throw new Error('Expected evidence refusal');
    expect(checked.issue.code).toBe(`property-evidence-${code}`);
    expect(checked.issue.path).toContain('damping.evidence');
    expect(new TextEncoder().encode(JSON.stringify(document))).toEqual(before);
  });
});
