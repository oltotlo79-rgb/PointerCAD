import { readBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bucklingUiFixture } from '../beam/beamBuckling.testSupport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachFatigue } from './attachFatigue.js';
import { BASE_EDITS, edited } from './fatigue.testSupport.js';
import { currentFatigueResult, fatigueDraftIsSaved, fatigueSavedInput, savedFatigueInput,
  type FatigueEdit, type FatigueSession } from './fatigueSession.js';

beforeEach(resetTestStore);
afterEach(resetTestStore);

function session(): FatigueSession {
  const value = useAppStore.getState().fatigueSession;
  if (value === null) throw new Error('No fatigue session');
  return value;
}
function openAssemblyWithStrength(): void {
  const fixture = bucklingUiFixture();
  const assembly = fixture.state.assembly;
  if (assembly === null) throw new Error('Fixture without assembly');
  // The real action creates the Undo stack that applyAssembly needs.
  useAppStore.getState().openAssembly(assembly, fixture.state.assemblyLibrary);
  useAppStore.setState({ strengthSession: fixture.state.strengthSession });
}

describe('fatigue inputs in the document', () => {
  it('saves into the open assembly through Undo, keeps other inputs, never stores a result, and reopens without one', async () => {
    openAssemblyWithStrength();
    const before = useAppStore.getState().assembly;
    if (before === null) throw new Error('Assembly closed');
    const others = before.beamAnalysisInputs?.analyses ?? [];
    useAppStore.getState().openFatigue();
    expect(session().draft.stressDefinition).toBe('');
    for (const edit of BASE_EDITS) useAppStore.getState().editFatigue(edit);
    await useAppStore.getState().runFatigue();
    expect(session().analyzed).not.toBeNull();
    useAppStore.getState().saveFatigue();
    expect(useAppStore.getState().canUndo).toBe(true);
    const assembly = useAppStore.getState().assembly;
    if (assembly === null) throw new Error('Assembly closed');
    expect(assembly.beamAnalysisInputs?.analyses.filter(input => input.kind !== 'fatigue')).toEqual(others);
    const stored = savedFatigueInput(assembly);
    expect(stored?.source.documentId).toBe(assembly.id);
    expect(stored?.input.histories[0]?.stressMpa).toEqual([0, 200, 0]);
    expect(JSON.stringify(assembly.beamAnalysisInputs)).not.toMatch(/"(?:damage|cycles|life|analyzed|result)"/u);
    // Saving changes neither inputs nor parameters: the result stays current.
    expect(currentFatigueResult(session(), assembly.parameters)).not.toBeNull();
    expect(fatigueDraftIsSaved(session(), assembly.parameters, stored)).toBe(true);
    useAppStore.getState().closeFatigue();
    useAppStore.getState().openFatigue();
    expect(session().analyzed).toBeNull();
    expect(fatigueDraftIsSaved(session(), assembly.parameters, stored)).toBe(true);
    useAppStore.getState().editFatigue({ kind: 'history-stress', index: 0, source: '0, 150, 0' });
    expect(fatigueDraftIsSaved(session(), assembly.parameters, stored)).toBe(false);
    useAppStore.getState().saveFatigue();
    const again = useAppStore.getState().assembly?.beamAnalysisInputs?.analyses.filter(input => input.kind === 'fatigue');
    expect(again).toHaveLength(1);
    expect(again?.[0]?.kind === 'fatigue' ? again[0].definition.input.histories[0]?.stressMpa : null).toEqual([0, 150, 0]);
    // Undo restores the first saved configuration, a second Undo removes it, Redo brings it back.
    useAppStore.getState().undoAssembly();
    expect(savedFatigueInput(useAppStore.getState().assembly ?? before)?.input.histories[0]?.stressMpa).toEqual([0, 200, 0]);
    useAppStore.getState().undoAssembly();
    expect(savedFatigueInput(useAppStore.getState().assembly ?? before)).toBeNull();
    useAppStore.getState().redoAssembly();
    expect(savedFatigueInput(useAppStore.getState().assembly ?? before)?.input.histories[0]?.stressMpa).toEqual([0, 200, 0]);
  });

  it('saves into the part when no assembly is open and refuses an unsavable draft without editing the document', () => {
    const fixture = bucklingUiFixture();
    useAppStore.setState({ strengthSession: fixture.state.strengthSession, assembly: null });
    const owner = useAppStore.getState().activeDocumentId;
    useAppStore.setState({ fatigueSession: edited(BASE_EDITS.filter(edit => edit.kind !== 'cutoff-mode'), owner) });
    const before = useAppStore.getState().document;
    useAppStore.getState().saveFatigue();
    expect(session().errorKey).toBe('fatigue.error.cutoffMode');
    expect(session().focusedField).toBe('cutoffMode');
    expect(useAppStore.getState().document).toBe(before);
    useAppStore.setState({ fatigueSession: edited(BASE_EDITS, owner) });
    useAppStore.getState().saveFatigue();
    const part = useAppStore.getState().document;
    expect(savedFatigueInput(part)?.source.documentId).toBe(part.id);
    expect(savedFatigueInput(before)).toBeNull();
  });

  it('a refused run shows the reason at its field and no result', async () => {
    const fixture = bucklingUiFixture();
    useAppStore.setState({ strengthSession: fixture.state.strengthSession, assembly: null });
    const owner = useAppStore.getState().activeDocumentId;
    useAppStore.setState({ fatigueSession: edited([...BASE_EDITS, { kind: 'mean-assumption', value: 'fully-reversed-only' }], owner) });
    await useAppStore.getState().runFatigue();
    expect([session().errorKey, session().focusedField, session().analyzed]).toEqual(['fatigue.error.mean', 'history:0:stress', null]);
  });

  it('keeps documents independent and allows one fatigue configuration per document', () => {
    const checked = fatigueSavedInput(edited(BASE_EDITS), [], 'document-a');
    if (!checked.ok) throw new Error('Draft not savable');
    const one = { kind: 'fatigue', definition: checked.saved };
    expect(readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1', analyses: [one] }, 'document-a').ok).toBe(true);
    const foreign = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1', analyses: [one] }, 'document-b');
    expect(foreign.ok ? null : foreign.issue.code).toBe('wrong-document');
    const two = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1', analyses: [one, one] }, 'document-a');
    expect(two.ok).toBe(false);
  });

  it('closes when the strength panel closes or the document changes', () => {
    const fixture = bucklingUiFixture();
    useAppStore.setState({ strengthSession: fixture.state.strengthSession, assembly: null });
    const original = useAppStore.getState().activeDocumentId;
    const detach = attachFatigue();
    try {
      useAppStore.getState().openFatigue();
      expect(session().ownerId).toBe(original);
      useAppStore.setState({ activeDocumentId: 'another-document' });
      expect(useAppStore.getState().fatigueSession).toBeNull();
      useAppStore.setState({ activeDocumentId: original });
      useAppStore.getState().openFatigue();
      expect(useAppStore.getState().fatigueSession).not.toBeNull();
      useAppStore.setState({ strengthSession: null });
      expect(useAppStore.getState().fatigueSession).toBeNull();
    } finally {
      detach();
    }
  });
});

const CORRECTED_EDITS: readonly FatigueEdit[] = [...BASE_EDITS,
  { kind: 'stress-definition', value: 'amplitude' }, { kind: 'mean-assumption', value: 'fully-reversed-only' },
  { kind: 'value', field: 'referenceCycles', source: '1000000' }, { kind: 'value', field: 'slope', source: '2' },
  { kind: 'history-stress', index: 0, source: '150, 250' },
  { kind: 'history-sequence', index: 0, value: 'repeated-periodic' }, { kind: 'history-repeats', index: 0, source: '1' },
  { kind: 'correction-mode', value: 'goodman' }, { kind: 'correction-applicability', value: true },
  { kind: 'correction-value', field: 'ultimateTensileStrengthMpa', source: '400' },
  { kind: 'correction-value', field: 'yieldStrengthMpa', source: '300' },
  { kind: 'correction-value', field: 'minimumCycles', source: '1001' },
  { kind: 'correction-source', field: 'reference', source: 'synthetic strengths only' },
  { kind: 'correction-source', field: 'condition', source: 'uniaxial elastic test only' },
];

describe('Goodman through the actual fatigue store', () => {
  it('calculates, saves v3 through Undo, restores a changed correction, and cold-loads without old results', async () => {
    openAssemblyWithStrength();
    const before = useAppStore.getState().assembly;
    if (before === null) throw new Error('Assembly closed');
    const otherInputs = before.beamAnalysisInputs?.analyses ?? [];
    useAppStore.getState().openFatigue();
    for (const edit of CORRECTED_EDITS) useAppStore.getState().editFatigue(edit);
    await useAppStore.getState().runFatigue();
    const result = currentFatigueResult(session(), []);
    if (result === null || !('correction' in result)) throw new Error('Expected corrected result');
    expect(Math.abs(result.damage / 1e-6 - 1)).toBeLessThan(1e-12);
    expect(result.life.kind === 'finite' ? result.life.spectrumRepetitions : NaN).toBeCloseTo(1e6, 6);
    useAppStore.getState().saveFatigue();
    const first = useAppStore.getState().assembly;
    if (first === null) throw new Error('Assembly closed');
    const firstSaved = savedFatigueInput(first);
    if (firstSaved?.schema !== 'pointercad-fatigue-saved/3') throw new Error('Expected v3');
    expect(firstSaved.correction.ultimateTensileStrengthMpa).toBe(400);
    expect(first.beamAnalysisInputs?.analyses.filter(input => input.kind !== 'fatigue')).toEqual(otherInputs);
    expect(JSON.stringify(firstSaved)).not.toMatch(/"(?:result|damage|life|cycles|equivalentStressMpa)"/u);
    expect(currentFatigueResult(session(), [])).toBe(result);
    useAppStore.getState().editFatigue({ kind: 'correction-value', field: 'ultimateTensileStrengthMpa', source: '500' });
    expect(session().analyzed).toBeNull();
    useAppStore.getState().saveFatigue();
    const second = savedFatigueInput(useAppStore.getState().assembly ?? before);
    expect(second?.schema === 'pointercad-fatigue-saved/3' ? second.correction.ultimateTensileStrengthMpa : NaN).toBe(500);
    useAppStore.getState().undoAssembly();
    expect(savedFatigueInput(useAppStore.getState().assembly ?? before)).toEqual(firstSaved);
    useAppStore.getState().redoAssembly();
    expect(savedFatigueInput(useAppStore.getState().assembly ?? before)).toEqual(second);
    // Fresh deserialized attachment and actual open action; IO byte serialization is covered independently in IO.
    const current = useAppStore.getState().assembly;
    if (current === null) throw new Error('Assembly closed');
    const raw: unknown = JSON.parse(JSON.stringify(current.beamAnalysisInputs));
    const parsed = readBeamAnalysisInputs(raw, current.id);
    if (!parsed.ok) throw new Error(parsed.issue.message);
    useAppStore.getState().closeFatigue();
    useAppStore.getState().openAssembly({ ...current, beamAnalysisInputs: parsed.value }, useAppStore.getState().assemblyLibrary);
    useAppStore.setState({ strengthSession: bucklingUiFixture().state.strengthSession });
    useAppStore.getState().openFatigue();
    expect(session().analyzed).toBeNull();
    expect(session().draft.correction.values.ultimateTensileStrengthMpa).toBe('500');
    expect(fatigueDraftIsSaved(session(), current.parameters, second)).toBe(true);
  });

  it('refuses outside the elastic domain without accepting a stale result or changing the document', async () => {
    openAssemblyWithStrength();
    useAppStore.getState().openFatigue();
    for (const edit of CORRECTED_EDITS) useAppStore.getState().editFatigue(edit);
    await useAppStore.getState().runFatigue();
    expect(session().analyzed).not.toBeNull();
    const before = useAppStore.getState().assembly;
    useAppStore.getState().editFatigue({ kind: 'history-stress', index: 0, source: '150, 300' });
    await useAppStore.getState().runFatigue();
    expect(session().analyzed).toBeNull();
    expect(session().errorKey).toBe('fatigue.error.correctionDomain');
    expect(session().focusedField).toBe('history:0:stress');
    expect(useAppStore.getState().assembly).toBe(before);
  });

  it('refuses incomplete correction on save and preserves the original uncorrected API path when disabled', async () => {
    openAssemblyWithStrength();
    useAppStore.getState().openFatigue();
    for (const edit of BASE_EDITS) useAppStore.getState().editFatigue(edit);
    await useAppStore.getState().runFatigue();
    expect(currentFatigueResult(session(), [])?.schema).toBe('pointercad-fatigue-result/1');
    const before = useAppStore.getState().assembly;
    useAppStore.getState().editFatigue({ kind: 'correction-mode', value: 'goodman' });
    useAppStore.getState().saveFatigue();
    expect(session().errorKey).toBe('fatigue.error.correctionApplicability');
    expect(useAppStore.getState().assembly).toBe(before);
    expect(session().analyzed).toBeNull();
    useAppStore.getState().editFatigue({ kind: 'correction-mode', value: 'none' });
    await useAppStore.getState().runFatigue();
    expect(Math.abs((currentFatigueResult(session(), [])?.damage ?? NaN) / 4e-6 - 1)).toBeLessThan(1e-12);
    useAppStore.getState().saveFatigue();
    expect(savedFatigueInput(useAppStore.getState().assembly ?? { })?.schema).toBe('pointercad-fatigue-saved/2');
  });
});