import { readPlasticBarSavedInput, withBeamAnalysisInputs, type PlasticBarSavedInput } from '@pointercad/model/beam-analysis';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { bucklingUiFixture } from '../beam/beamBuckling.testSupport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { BENCHMARK_EDITS } from './plasticBar.testSupport.js';
import { createPlasticBarSession, editPlasticBarSession, plasticBarDraftIsSaved, plasticBarInput, plasticBarSavedInput,
  restorePlasticBarSession, samePlasticBarSavedInput, savedPlasticBarInput,
  type PlasticBarEdit, type PlasticBarSession } from './plasticBarSession.js';

beforeEach(resetTestStore);
afterEach(resetTestStore);

type Evidence = NonNullable<PlasticBarSavedInput['hardeningEvidence']>;
function savedOf(session: PlasticBarSession, documentId = 'document-a'): PlasticBarSavedInput {
  const checked = plasticBarSavedInput(session, [], documentId);
  if (!checked.ok) throw new Error(`Unsavable fixture: ${checked.key}`);
  return checked.saved;
}
function legacy(): PlasticBarSavedInput {
  return savedOf(BENCHMARK_EDITS.reduce(editPlasticBarSession, createPlasticBarSession('owner')));
}
// Same synthetic contract and condition vocabulary as model/analysisPropertyEvidence.test.ts.
// These are authored test values, not acquired material data or a physical certification.
function evidence(): Evidence {
  return { property: 'hardening', sourceId: 'synthetic-user-series', sourceKind: 'user-provided',
    citation: 'Synthetic fixture, table 1, row 2; not a material specification',
    materialConditionId: 's45c-normalized-reference', heatTreatment: '焼ならし・適用寸法未指定の参考値',
    temperatureC: 20, temperatureRange: { lower: 10, upper: 30, unit: 'degC' },
    units: { yieldStressMPa: 'MPa', hardeningModulusMPa: 'MPa' },
    testConditions: { description: 'Explicit synthetic test conditions', parameters: { law: 'linear-isotropic' } },
    validRange: { yieldStressMPa: { lower: 0, upper: 500, unit: 'MPa' },
      hardeningModulusMPa: { lower: 0, upper: 4000, unit: 'MPa' } } };
}
function stored(): PlasticBarSavedInput {
  return readPlasticBarSavedInput({ ...legacy(), hardeningEvidence: evidence() }, 'bar');
}

const nonMaterialEdits: readonly PlasticBarEdit[] = [
  { kind: 'value', field: 'length', source: '1100' }, { kind: 'value', field: 'area', source: '120' },
  { kind: 'value', field: 'stepsPerSegment', source: '2' }, { kind: 'knot', index: 0, source: '3' },
  { kind: 'knot-remove', index: 3 }, { kind: 'focus', field: 'young' },
];
it.each(nonMaterialEdits)('preserves every evidence field through $kind non-material edit and strict re-read', edit => {
  const original = stored(), restored = restorePlasticBarSession('owner', original);
  const saved = savedOf(editPlasticBarSession(restored, edit));
  const reread = readPlasticBarSavedInput(saved, 'bar');
  expect(reread.hardeningEvidence).toEqual(evidence());
  expect(reread.materialSource).toEqual(original.materialSource);
  expect(savedOf(restorePlasticBarSession('owner', reread))).toEqual(reread);
  expect(original).toEqual(stored());
});

const materialEdits: readonly PlasticBarEdit[] = [
  { kind: 'value', field: 'young', source: '210000' }, { kind: 'value', field: 'poisson', source: '0.29' },
  { kind: 'value', field: 'yieldStress', source: '251' }, { kind: 'value', field: 'hardening', source: '2001' },
  { kind: 'reference', source: 'A different user reference' },
];
it.each(materialEdits)('invalidates old evidence for $kind $field even inside its cited range and after reverting', edit => {
  const original = stored(), restored = restorePlasticBarSession('owner', original);
  const changed = editPlasticBarSession(restored, edit);
  expect(Object.hasOwn(savedOf(changed), 'hardeningEvidence')).toBe(false);
  expect(plasticBarDraftIsSaved(changed, [], original)).toBe(false);
  const reverse = edit.kind === 'reference' ? { ...edit, source: restored.draft.reference }
    : edit.kind === 'value' ? { ...edit, source: restored.draft.values[edit.field] } : edit;
  const reverted = editPlasticBarSession(changed, reverse);
  expect(Object.hasOwn(savedOf(reverted), 'hardeningEvidence')).toBe(false);
  expect(plasticBarDraftIsSaved(reverted, [], original)).toBe(false);
});

it('preserves unchanged material text, but drops evidence when a material expression is replaced by an equivalent one', () => {
  const restored = restorePlasticBarSession('owner', stored());
  expect(savedOf(editPlasticBarSession(restored, { kind: 'value', field: 'young', source: restored.draft.values.young }))
    .hardeningEvidence).toEqual(evidence());
  expect(Object.hasOwn(savedOf(editPlasticBarSession(restored,
    { kind: 'value', field: 'young', source: '200000 + 0' })), 'hardeningEvidence')).toBe(false);
});

it('keeps an added displacement row after it becomes valid without losing evidence', () => {
  const added = editPlasticBarSession(restorePlasticBarSession('owner', stored()), { kind: 'knot-add' });
  expect(plasticBarSavedInput(added, [], 'document-a').ok).toBe(false);
  const filled = editPlasticBarSession(added, { kind: 'knot', index: added.draft.knots.length - 1, source: '1' });
  expect(savedOf(filled).hardeningEvidence).toEqual(evidence());
});

it('checks actual material values at serialization even if a caller replaces the draft without the edit reducer', () => {
  const restored = restorePlasticBarSession('owner', stored());
  const changed = { ...restored, draft: { ...restored.draft, values: { ...restored.draft.values, hardening: '2001' } } };
  expect(Object.hasOwn(savedOf(changed), 'hardeningEvidence')).toBe(false);
});

it('leaves legacy absence absent and produces exactly the original numerical plan', () => {
  const old = legacy(), original = stored();
  expect(savedOf(restorePlasticBarSession('owner', old))).toEqual(old);
  expect(plasticBarInput(restorePlasticBarSession('owner', original), []))
    .toEqual(plasticBarInput(restorePlasticBarSession('owner', old), []));
  expect(plasticBarDraftIsSaved(restorePlasticBarSession('owner', original), [], original)).toBe(true);
});

it('owns restored and saved nested evidence independently of the document and prior saves', () => {
  const original = stored(), restored = restorePlasticBarSession('owner', original);
  if (original.hardeningEvidence === undefined) throw new Error('Missing evidence');
  const interval = original.hardeningEvidence.validRange.yieldStressMPa;
  if (interval === undefined) throw new Error('Missing yield interval');
  Reflect.set(interval, 'upper', 999);
  const first = savedOf(restored);
  expect(first.hardeningEvidence).toEqual(evidence());
  if (first.hardeningEvidence === undefined) throw new Error('Missing evidence');
  Reflect.set(first.hardeningEvidence.testConditions.parameters, 'law', 'different-law');
  expect(savedOf(restored).hardeningEvidence).toEqual(evidence());
});

it('compares all evidence fields independently of object insertion order', () => {
  const original = stored(), e = evidence();
  const reordered = { ...original, hardeningEvidence: { ...e,
    units: { hardeningModulusMPa: 'MPa', yieldStressMPa: 'MPa' },
    validRange: { hardeningModulusMPa: { unit: 'MPa', upper: 4000, lower: 0 },
      yieldStressMPa: { upper: 500, unit: 'MPa', lower: 0 } } } };
  expect(samePlasticBarSavedInput(original, reordered)).toBe(true);
  expect(plasticBarDraftIsSaved(restorePlasticBarSession('owner', original), [], reordered)).toBe(true);
  expect(plasticBarDraftIsSaved(restorePlasticBarSession('owner', reordered), [], original)).toBe(true);
  const differences: readonly Partial<Evidence>[] = [
    { property: 'sn' }, { sourceId: 'another-source' }, { sourceKind: 'manufacturer-reference' },
    { citation: 'Another citation' }, { materialConditionId: 'another-condition' }, { heatTreatment: 'another-treatment' },
    { temperatureC: 21 }, { temperatureRange: { ...e.temperatureRange, upper: 31 } },
    { units: { ...e.units, yieldStressMPa: 'Pa' } },
    { testConditions: { ...e.testConditions, description: 'Another description' } },
    { testConditions: { ...e.testConditions, parameters: { law: 'another-law' } } },
    { validRange: { ...e.validRange, yieldStressMPa: { lower: 0, upper: 501, unit: 'MPa' } } },
  ];
  for (const patch of differences) expect(samePlasticBarSavedInput(original,
    { ...original, hardeningEvidence: { ...e, ...patch } })).toBe(false);
  expect(samePlasticBarSavedInput(original, legacy())).toBe(false);
});

it('retains evidence through actual assembly save/reopen, then removes it on material edit/save', () => {
  const fixture = bucklingUiFixture(), assembly = fixture.state.assembly;
  if (assembly === null) throw new Error('Missing fixture assembly');
  const original = { ...stored(), source: { documentId: assembly.id } };
  const otherAnalyses = assembly.beamAnalysisInputs?.analyses.filter(row => row.kind !== 'plastic-bar') ?? [];
  const loaded = withBeamAnalysisInputs(assembly, { schema: 'pointercad-beam-inputs/1',
    analyses: [...otherAnalyses, { kind: 'plastic-bar', definition: original }] });
  useAppStore.getState().openAssembly(loaded, fixture.state.assemblyLibrary);
  useAppStore.setState({ strengthSession: fixture.state.strengthSession });
  useAppStore.getState().openPlasticBar();
  useAppStore.getState().editPlasticBar({ kind: 'value', field: 'area', source: '120' });
  useAppStore.getState().savePlasticBar();
  const saved = useAppStore.getState().assembly;
  if (saved === null) throw new Error('Assembly closed');
  expect(savedPlasticBarInput(saved)?.hardeningEvidence).toEqual(evidence());
  expect(saved.beamAnalysisInputs?.analyses.filter(row => row.kind !== 'plastic-bar')).toEqual(otherAnalyses);
  useAppStore.getState().closePlasticBar();
  useAppStore.getState().openPlasticBar();
  expect(useAppStore.getState().plasticBarSession?.draft.restoredMaterial?.evidence).toEqual(evidence());
  useAppStore.getState().editPlasticBar({ kind: 'value', field: 'yieldStress', source: '251' });
  useAppStore.getState().savePlasticBar();
  const edited = useAppStore.getState().assembly;
  if (edited === null) throw new Error('Assembly closed');
  expect(savedPlasticBarInput(edited)?.hardeningEvidence).toBeUndefined();
  expect(savedPlasticBarInput(edited)?.materialSource).toEqual(original.materialSource);
});
