import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STRENGTH_MATERIALS } from '../measure/strengthMaterials.js';
import { analysisPropertyEvidenceStatus, fatiguePropertySeries, hardeningPropertySeries, rayleighPropertySeries,
  readAnalysisPropertyEvidence, type AnalysisPropertyEvidence, type AnalysisPropertySeries } from './analysisPropertyEvidence.js';
import { plasticBarSiValues, readPlasticBarSavedInput } from './plasticBarInput.js';
import { readSolidPlasticCadSavedInput } from './solidPlasticCadInput.js';
import { FATIGUE_SAVED_SCHEMA, readFatigueSavedInput } from './fatigueInput.js';
import { readBeamAnalysisInputs } from './beamInputs.js';
import { readBeamTransientHistory } from './beamTransientHistory.js';

// All numbers and the citation are synthetic contract fixtures, not acquired material data.
const hardening = hardeningPropertySeries({ yieldStressMPa: 250, hardeningModulusMPa: 2000 });
const sn = fatiguePropertySeries({ referenceStressMpa: 100, referenceCycles: 1e6, slope: 2,
  cutoffStressMpa: null, stressDefinition: 'amplitude', meanStressAssumption: 'fully-reversed-only' });
const rayleigh = rayleighPropertySeries({ massCoefficientPerS: 4, stiffnessCoefficientS: 0.002 });
const rate: AnalysisPropertySeries = { kind: 'rate-law', values: { referenceRate: { value: 0.01, unit: '1/s' },
  exponent: { value: 0.2, unit: '1' } }, conditions: { law: 'synthetic-contract-only' } };
const seriesCases = [hardening, sn, rayleigh, rate];

function evidence(series: AnalysisPropertySeries): AnalysisPropertyEvidence {
  return { property: series.kind, sourceId: 'synthetic-user-series', sourceKind: 'user-provided',
    citation: 'Synthetic fixture, table 1, row 2; not a material specification',
    materialConditionId: 's45c-normalized-reference', heatTreatment: '焼ならし・適用寸法未指定の参考値',
    temperatureC: 20, temperatureRange: { lower: 10, upper: 30, unit: 'degC' },
    units: Object.fromEntries(Object.entries(series.values).map(([name, item]) => [name, item.unit])),
    testConditions: { description: 'Explicit synthetic test conditions', parameters: { ...series.conditions } },
    validRange: Object.fromEntries(Object.entries(series.values).map(([name, item]) => [name,
      { lower: 0, upper: 2 * item.value, unit: item.unit }])) };
}
function bytes(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(value)); }
function failsWith(value: unknown, series: AnalysisPropertySeries, code: string): void {
  const before = bytes(value);
  expect(() => readAnalysisPropertyEvidence(value, series)).toThrow(expect.objectContaining({ code }));
  expect(bytes(value)).toEqual(before);
}

describe.each(seriesCases)('$kind evidence contract (synthetic data)', series => {
  it('returns verified only for explicit matching evidence and owns nested input', () => {
    const value = evidence(series), before = bytes(value);
    const status = analysisPropertyEvidenceStatus(value, series);
    expect(status.status).toBe('verified');
    if (status.status !== 'verified') throw new Error('Expected matching evidence');
    expect(status.evidence).toEqual(value);
    expect(status.evidence).not.toBe(value);
    expect(status.evidence.units).not.toBe(value.units);
    expect(status.evidence.validRange).not.toBe(value.validRange);
    expect(status.evidence.temperatureRange).not.toBe(value.temperatureRange);
    expect(status.evidence.testConditions.parameters).not.toBe(value.testConditions.parameters);
    for (const name of Object.keys(value.validRange)) expect(status.evidence.validRange[name]).not.toBe(value.validRange[name]);
    expect(bytes(value)).toEqual(before);
  });

  it('reports absent evidence as unverified, without a catalogue default', () => {
    expect(analysisPropertyEvidenceStatus(undefined, series)).toEqual({ status: 'unverified', reason: '出典未取得' });
  });

  it('rejects mismatched units and preserves input bytes', () => {
    const value = evidence(series), name = Object.keys(series.values)[0];
    failsWith({ ...value, units: { ...value.units, [name]: 'wrong-unit' } }, series, 'property-evidence-unit-mismatch');
    failsWith({ ...value, validRange: { ...value.validRange, [name]: { ...value.validRange[name], unit: 'wrong-unit' } } },
      series, 'property-evidence-unit-mismatch');
  });

  it('rejects a different heat treatment for the W01 condition ID and preserves bytes', () => {
    failsWith({ ...evidence(series), heatTreatment: '焼入焼戻・適用寸法未指定の参考値' }, series, 'property-evidence-condition-mismatch');
  });

  it('rejects temperature and coefficient values outside the source range without mutation', () => {
    const value = evidence(series), name = Object.keys(series.values)[0];
    failsWith({ ...value, temperatureC: 30.0001 }, series, 'property-evidence-outside-range');
    failsWith({ ...value, temperatureC: 9.9999 }, series, 'property-evidence-outside-range');
    failsWith({ ...value, validRange: { ...value.validRange, [name]: {
      lower: 0, upper: series.values[name].value / 2, unit: series.values[name].unit } } }, series, 'property-evidence-outside-range');
  });

  it('accepts both inclusive bounds without changing values or inventing a tolerance', () => {
    const value = evidence(series);
    const validRange = Object.fromEntries(Object.entries(series.values).map(([name, item]) => [name,
      { lower: item.value, upper: item.value, unit: item.unit }]));
    for (const temperatureC of [10, 30]) expect(analysisPropertyEvidenceStatus({ ...value, temperatureC, validRange }, series).status)
      .toBe('verified');
  });
});

describe('evidence shape and applicability', () => {
  it.each([undefined, null, {}, [], 'S45C', { materialName: 'SS400' }])('refuses malformed explicitly supplied evidence: %j', value => {
    expect(() => readAnalysisPropertyEvidence(value, hardening)).toThrow(expect.objectContaining({ code: 'property-evidence-shape' }));
  });

  it.each(['standard-draft', 'manufacturer-reference', 'user-provided'] as const)('retains the declared classification %s', sourceKind => {
    expect(readAnalysisPropertyEvidence({ ...evidence(sn), sourceKind }, sn).sourceKind).toBe(sourceKind);
  });

  it('requires every quantity, finite ordered intervals and an explicit source', () => {
    const value = evidence(hardening);
    for (const patch of [
      { sourceId: '' }, { citation: '' }, { sourceKind: 'standard-certified' }, { materialConditionId: 'S45C' },
      { temperatureC: NaN }, { temperatureC: '20' }, { temperatureRange: { lower: 30, upper: 10, unit: 'degC' } },
      { temperatureRange: { lower: -274, upper: 30, unit: 'degC' } },
      { temperatureRange: { lower: 10, upper: Infinity, unit: 'degC' } },
      { units: { yieldStressMPa: 'MPa' } }, { validRange: {} },
      { testConditions: { description: '', parameters: value.testConditions.parameters } },
      { unexpected: true },
    ]) expect(() => readAnalysisPropertyEvidence({ ...value, ...patch }, hardening)).toThrow();
  });

  it('rejects hidden, symbol and inherited evidence fields and does not invoke accessors', () => {
    const value = evidence(hardening);
    const inherited: unknown = Object.create(value);
    const accessor = Object.defineProperty({ ...value }, 'sourceId', { enumerable: true,
      get: () => { throw new Error('must not invoke getter'); } });
    for (const invalid of [inherited, accessor, { ...value, [Symbol('hidden')]: 1 },
      Object.defineProperty({ ...value }, 'hidden', { value: 1 })]) {
      expect(() => readAnalysisPropertyEvidence(invalid, hardening)).toThrow(expect.objectContaining({ code: 'property-evidence-shape' }));
    }
  });

  it('refuses a different series, law, stress definition or mean-stress assumption', () => {
    failsWith({ ...evidence(hardening), property: 'rayleigh' }, hardening, 'property-evidence-series-mismatch');
    for (const parameters of [
      { ...sn.conditions, law: 'piecewise' }, { ...sn.conditions, stressDefinition: 'range' },
      { ...sn.conditions, meanStressAssumption: 'mean-independent' },
    ]) failsWith({ ...evidence(sn), testConditions: { description: 'synthetic', parameters } }, sn, 'property-evidence-test-condition-mismatch');
  });

  it('checks the optional S-N cutoff and keeps cycle/reversal units distinct', () => {
    const cutoff = fatiguePropertySeries({ referenceStressMpa: 100, referenceCycles: 1e6, slope: 2,
      cutoffStressMpa: 20, stressDefinition: 'range', meanStressAssumption: 'mean-independent' });
    const value = evidence(cutoff);
    expect(analysisPropertyEvidenceStatus(value, cutoff).status).toBe('verified');
    failsWith({ ...value, units: { ...value.units, referenceCycles: 'reversal' } }, cutoff, 'property-evidence-unit-mismatch');
    failsWith({ ...value, validRange: { ...value.validRange, cutoffStressMpa: { lower: 21, upper: 40, unit: 'MPa' } } },
      cutoff, 'property-evidence-outside-range');
  });
});

function plastic() {
  return { schema: 'pointercad-plastic-bar-input/1', id: 'plastic-bar', source: { documentId: 'owner' }, units: 'N-mm',
    lengthMm: 1000, areaMm2: 100, youngModulusMPa: 200000, poisson: 0.3, yieldStressMPa: 250, hardeningModulusMPa: 2000,
    materialSource: { kind: 'user-supplied', reference: 'Synthetic only' }, endDisplacementMm: [0, 2.5, 0], stepsPerSegment: 1 };
}
function solid() {
  return { schema: 'pointercad-solid-plastic-cad-input/1', id: 'solid-plastic-cad', source: { documentId: 'owner' },
    bodyFeatureId: 'box', fixedFaces: ['fixed'], loadedFaces: ['loaded'], youngMPa: 200000, poisson: 0.3,
    yieldStressMPa: 250, hardeningModulusMPa: 2000, materialReference: 'Synthetic only', tractionMPa: [0, 0, -2],
    loadFactor: [0, 1, 0], stepsPerSegment: 1, linearDeflectionMm: 0.1, angularDeflectionRad: 0.3,
    maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 1 };
}
function fatigue() {
  const source = { kind: 'user-supplied', reference: 'Synthetic only', condition: 'Synthetic uniaxial test' };
  return { schema: FATIGUE_SAVED_SCHEMA, id: 'fatigue', source: { documentId: 'owner' }, axial: [],
    input: { schema: 'pointercad-fatigue/1', curve: { id: 'curve', unit: 'MPa', stressDefinition: 'amplitude',
      meanStressAssumption: 'fully-reversed-only', referenceStressMpa: 100, referenceCycles: 1e6, slope: 2,
      cutoffStressMpa: null, source }, histories: [{ id: 'history', unit: 'MPa', stressMpa: [0, 100, 0],
      sequence: 'once', repeats: 1, source }] } };
}
const savedCases = [
  { kind: 'plastic-bar', make: plastic, key: 'hardeningEvidence', series: hardening },
  { kind: 'solid-plastic-cad', make: solid, key: 'hardeningEvidence', series: hardening },
  { kind: 'fatigue', make: fatigue, key: 'curveEvidence', series: sn },
];

describe.each(savedCases)('$kind saved evidence', ({ kind, make, key, series }) => {
  function attachment(value: unknown) { return { schema: 'pointercad-beam-inputs/1', analyses: [{ kind, definition: value }] }; }

  it('preserves old saved bytes without adding status, evidence or coefficients', () => {
    const value = attachment(make()), before = bytes(value), checked = readBeamAnalysisInputs(value, 'owner');
    expect(checked.ok).toBe(true);
    if (!checked.ok) throw new Error(checked.issue.message);
    expect(checked.value).toEqual(value);
    expect(bytes(value)).toEqual(before);
    expect(JSON.stringify(checked.value)).not.toContain(key);
    expect(JSON.stringify(checked.value)).not.toContain('unverified');
  });

  it('round-trips an optional source with the same schema and without changing any input value', () => {
    const value = attachment({ ...make(), [key]: evidence(series) }), before = bytes(value);
    const checked = readBeamAnalysisInputs(value, 'owner');
    expect(checked.ok).toBe(true);
    if (!checked.ok) throw new Error(checked.issue.message);
    expect(checked.value).toEqual(value);
    const reopened = readBeamAnalysisInputs(JSON.parse(JSON.stringify(checked.value)), 'owner');
    expect(reopened).toEqual(checked);
    expect(bytes(value)).toEqual(before);
  });

  it('rejects non-enumerable evidence instead of silently losing it on save', () => {
    const value = Object.defineProperty(make(), key, { value: evidence(series) });
    const checked = readBeamAnalysisInputs(attachment(value), 'owner');
    expect(checked.ok).toBe(false);
    expect(Object.hasOwn(value, key)).toBe(true);
  });

  it.each(['unit', 'treatment', 'temperature', 'value', 'explicit-undefined'] as const)('refuses %s mismatch with document bytes unchanged', change => {
    const base = evidence(series), name = Object.keys(series.values)[0];
    const bad = change === 'unit' ? { ...base, units: { ...base.units, [name]: 'Pa' } }
      : change === 'treatment' ? { ...base, heatTreatment: '焼入焼戻・適用寸法未指定の参考値' }
        : change === 'temperature' ? { ...base, temperatureC: 31 }
          : change === 'value' ? { ...base, validRange: { ...base.validRange, [name]: { lower: 0, upper: 0, unit: base.units[name] } } }
            : undefined;
    const document = { id: 'owner', beamAnalysisInputs: attachment({ ...make(), [key]: bad }) }, before = bytes(document);
    const checked = readBeamAnalysisInputs(document.beamAnalysisInputs, 'owner');
    expect(checked.ok).toBe(false);
    if (checked.ok) throw new Error('Expected evidence refusal');
    expect(checked.issue.code).toMatch(/^property-evidence-/u);
    expect(checked.issue.path).toContain(key);
    expect(checked.issue.message.length).toBeGreaterThan(0);
    expect(bytes(document)).toEqual(before);
  });
});

it('derives plastic-bar status without changing SI conversion or supplying a missing source', () => {
  const legacy = readPlasticBarSavedInput(plastic(), 'bar');
  expect(analysisPropertyEvidenceStatus(legacy.hardeningEvidence, hardeningPropertySeries(legacy)))
    .toEqual({ status: 'unverified', reason: '出典未取得' });
  const checked = readPlasticBarSavedInput({ ...plastic(), hardeningEvidence: evidence(hardening) }, 'bar');
  expect(analysisPropertyEvidenceStatus(checked.hardeningEvidence, hardeningPropertySeries(checked)).status).toBe('verified');
  expect(plasticBarSiValues(checked)).toEqual(plasticBarSiValues(legacy));
});

describe('no material-name coefficient generation', () => {
  it.each(['analysisPropertyEvidence.ts', 'plasticBarInput.ts', 'solidPlasticCadInput.ts', 'fatigueInput.ts', 'beamTransientHistory.ts'])(
    '%s contains no material grade/condition keyed coefficient table or branch', name => {
      const source = readFileSync(new URL(name, import.meta.url), 'utf8');
      const literals = source.match(/(['"`])(?:[^\\]|\\.)*?\1/gu) ?? [];
      const identifiers = STRENGTH_MATERIALS.flatMap(material => [material.grade, material.id]);
      for (const literal of literals) for (const id of identifiers) expect(literal.toLowerCase()).not.toContain(id.toLowerCase());
      expect(source).not.toMatch(/(?:material|preset)\.(?:yieldStress|tensileStrength|youngModulus|shearModulus)/u);
    });

  it.each(['S45C', 'SS400'])('cannot manufacture a coefficient from %s alone', grade => {
    const value = { materialName: grade };
    const before = bytes(value);
    for (const read of [readPlasticBarSavedInput, readSolidPlasticCadSavedInput, readFatigueSavedInput, readBeamTransientHistory]) {
      expect(() => read(value, 'input')).toThrow();
    }
    for (const series of seriesCases) expect(() => readAnalysisPropertyEvidence(value, series)).toThrow();
    expect(bytes(value)).toEqual(before);
  });

  it('does not fill missing hardening or S-N coefficients even when a free-text source names a grade', () => {
    const bar = plastic(), curve = fatigue();
    expect(() => readPlasticBarSavedInput({ ...bar, hardeningModulusMPa: undefined,
      materialSource: { kind: 'user-supplied', reference: 'S45C' } }, 'input')).toThrow();
    expect(() => readFatigueSavedInput({ ...curve, input: { ...curve.input, curve: { ...curve.input.curve,
      slope: undefined, source: { ...curve.input.curve.source, reference: 'SS400' } } } }, 'input')).toThrow();
  });
});
