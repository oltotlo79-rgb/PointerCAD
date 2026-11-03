import { expect, it } from 'vitest';
import { readAnalysisPropertyEvidence, sameAnalysisPropertyEvidence,
  type AnalysisPropertyEvidence, type AnalysisPropertyKind } from './analysisPropertyEvidence.js';

// Synthetic coefficient vocabulary exercises dynamic records, not acquired material properties.
const series = { kind: 'rate-law', values: { alpha: { value: 2, unit: '1/s' }, beta: { value: 3, unit: '1' } },
  conditions: { law: 'synthetic-contract-only', direction: 'axial' } } as const;
function evidence(): AnalysisPropertyEvidence {
  return readAnalysisPropertyEvidence({ property: 'rate-law', sourceId: 'synthetic-source', sourceKind: 'user-provided',
    citation: 'Synthetic contract fixture, not material data', materialConditionId: 's45c-normalized-reference',
    heatTreatment: '焼ならし・適用寸法未指定の参考値', temperatureC: 20,
    temperatureRange: { lower: 10, upper: 30, unit: 'degC' }, units: { alpha: '1/s', beta: '1' },
    testConditions: { description: 'Synthetic conditions', parameters: { law: 'synthetic-contract-only', direction: 'axial' } },
    validRange: { alpha: { lower: 1, upper: 4, unit: '1/s' }, beta: { lower: 2, upper: 6, unit: '1' } } }, series);
}

it.each<AnalysisPropertyKind>(['hardening', 'sn', 'rayleigh', 'rate-law'])('compares all record orders independently for %s', property => {
  const left = { ...evidence(), property };
  const right = { ...left,
    temperatureRange: { unit: 'degC', upper: 30, lower: 10 },
    units: { beta: '1', alpha: '1/s' },
    testConditions: { parameters: { direction: 'axial', law: 'synthetic-contract-only' }, description: 'Synthetic conditions' },
    validRange: { beta: { unit: '1', upper: 6, lower: 2 }, alpha: { upper: 4, lower: 1, unit: '1/s' } } };
  expect(sameAnalysisPropertyEvidence(left, right)).toBe(true);
  expect(sameAnalysisPropertyEvidence(right, left)).toBe(true);
  expect(sameAnalysisPropertyEvidence(left, structuredClone(left))).toBe(true);
});

const differences: readonly Partial<AnalysisPropertyEvidence>[] = [
  { property: 'sn' }, { sourceId: 'another-source' }, { sourceKind: 'manufacturer-reference' },
  { citation: 'another citation' }, { materialConditionId: 'another-condition' }, { heatTreatment: 'another-treatment' },
  { temperatureC: 21 }, { temperatureRange: { lower: 11, upper: 30, unit: 'degC' } },
  { temperatureRange: { lower: 10, upper: 31, unit: 'degC' } },
  { temperatureRange: { lower: 10, upper: 30, unit: 'K' } },
  { units: { alpha: '1/s', beta: 'MPa' } }, { units: { alpha: '1/s' } },
  { units: { alpha: '1/s', gamma: '1' } }, { units: { alpha: '1/s', beta: '1', gamma: '1' } },
  { testConditions: { description: 'different', parameters: { law: 'synthetic-contract-only', direction: 'axial' } } },
  { testConditions: { description: 'Synthetic conditions', parameters: { law: 'another-law', direction: 'axial' } } },
  { testConditions: { description: 'Synthetic conditions', parameters: { law: 'synthetic-contract-only' } } },
  { testConditions: { description: 'Synthetic conditions', parameters: { law: 'synthetic-contract-only', axis: 'axial' } } },
  { validRange: { alpha: { lower: 0, upper: 4, unit: '1/s' }, beta: { lower: 2, upper: 6, unit: '1' } } },
  { validRange: { alpha: { lower: 1, upper: 5, unit: '1/s' }, beta: { lower: 2, upper: 6, unit: '1' } } },
  { validRange: { alpha: { lower: 1, upper: 4, unit: 'Pa' }, beta: { lower: 2, upper: 6, unit: '1' } } },
  { validRange: { alpha: { lower: 1, upper: 4, unit: '1/s' } } },
  { validRange: { alpha: { lower: 1, upper: 4, unit: '1/s' }, gamma: { lower: 2, upper: 6, unit: '1' } } },
];
it.each(differences)('distinguishes metadata and exact dynamic key sets: %j', patch => {
  const left = evidence(), right = { ...left, ...patch }, before = structuredClone(left);
  expect(sameAnalysisPropertyEvidence(left, right)).toBe(false);
  expect(sameAnalysisPropertyEvidence(right, left)).toBe(false);
  expect(left).toEqual(before);
});

it('preserves legacy absence and never equates absence with authored evidence', () => {
  expect(sameAnalysisPropertyEvidence(undefined, undefined)).toBe(true);
  expect(sameAnalysisPropertyEvidence(undefined, evidence())).toBe(false);
  expect(sameAnalysisPropertyEvidence(evidence(), undefined)).toBe(false);
});

it.each(['units', 'validRange', 'testConditions'])('keeps arrays outside the strict %s record contract', field => {
  expect(() => readAnalysisPropertyEvidence({ ...evidence(), [field]: [] }, series)).toThrow();
});
