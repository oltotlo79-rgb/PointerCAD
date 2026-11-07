import { create } from 'zustand';
import { createFatigueSlice } from '../store/fatigueSlice.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { BASE_EDITS, edited } from './fatigue.testSupport.js';
import { savedFatigueEntry } from './fatigueSession.js';
import { currentSolidFatigueResult, type FatigueSolidSource } from './fatigueSolidSession.js';
import { analyticalSolid, solidDraft } from './fatigueSolid.testSupport.js';
import { createSolidAnalysisSession } from '../solidAnalysis/solidAnalysisSession.js';

function installSolid(source: FatigueSolidSource): void {
  const state = useAppStore.getState();
  useAppStore.setState({ solidAnalysisSession: { ...createSolidAnalysisSession(state.activeDocumentId),
    status: 'complete', result: source }, fatigueSession: solidDraft(source, state.activeDocumentId) });
}

beforeEach(() => { resetTestStore(); useAppStore.getState().toggleStrength(); });
afterEach(resetTestStore);

function seedDocumentHistory(): void {
  const initial = useAppStore.getState();
  initial.applyDocument({ ...initial.document, name: 'atomic history first' });
  const first = useAppStore.getState();
  first.applyDocument({ ...first.document, name: 'atomic history redo' });
  useAppStore.getState().undo();
  const seeded = useAppStore.getState();
  expect(seeded.undoStack.past).toHaveLength(1);
  expect(seeded.undoStack.future).toHaveLength(1);
  expect(seeded.undoStack.present).toBe(seeded.document);
  expect(seeded.canUndo).toBe(true);
  expect(seeded.canRedo).toBe(true);
}

function expectDocumentHistoryUnchanged(before: ReturnType<typeof useAppStore.getState>): void {
  const after = useAppStore.getState();
  expect(after.document).toBe(before.document);
  expect(after.undoStack).toBe(before.undoStack);
  expect(after.undoStack.past).toBe(before.undoStack.past);
  expect(after.undoStack.present).toBe(before.undoStack.present);
  expect(after.undoStack.future).toBe(before.undoStack.future);
  expect(after.canUndo).toBe(before.canUndo);
  expect(after.canRedo).toBe(before.canRedo);
}

describe('solid fatigue through actual UI store actions', () => {
  it('uses decoded native-shaped actions and existing fatigue core, saves/reopens only definition, and replaces old/new fatigue with Undo', async () => {
    const initial = useAppStore.getState(), owner = initial.activeDocumentId;
    expect(owner).not.toBe(initial.document.id);
    const other = { kind: 'solid-cad', definition: { schema: 'pointercad-solid-cad-input/1', id: 'solid-cad',
      source: { documentId: initial.document.id }, bodyFeatureId: 'tet', fixedFaces: ['fixed'], loadedFaces: ['loaded'], youngMPa: 200,
      poisson: 0, tractionMPa: [1, 0, 0], linearDeflectionMm: 0.1, angularDeflectionRad: 0.3,
      maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 1 } };
    initial.applyDocument(withBeamAnalysisInputs(initial.document, { schema: 'pointercad-beam-inputs/1', analyses: [other] }));
    useAppStore.setState({ fatigueSession: edited(BASE_EDITS, owner) });
    useAppStore.getState().saveFatigue();
    const old = savedFatigueEntry(useAppStore.getState().document);
    expect(old?.kind).toBe('fatigue');
    const source = await analyticalSolid(initial.document.id, useAppStore.getState().completedGeneration);
    installSolid(source);
    await useAppStore.getState().runFatigue();
    const session = useAppStore.getState().fatigueSession;
    if (session === null) throw new Error('No session');
    const accepted = currentSolidFatigueResult(session, [], source);
    expect(accepted?.provenance.reference.xx).toBe(6);
    expect(accepted?.provenance.components).toBe('cauchy-tensor-shear-xx-yy-zz-yz-xz-xy');
    expect(accepted?.result.damage).toBeGreaterThan(0);
    useAppStore.getState().saveFatigue();
    const part = useAppStore.getState().document;
    expect(part.beamAnalysisInputs?.analyses).toHaveLength(2);
    expect(part.beamAnalysisInputs?.analyses.find(row => row.kind === 'solid-cad')).toEqual(other);
    expect(savedFatigueEntry(part)?.kind).toBe('fatigue-solid-proportional');
    expect(JSON.stringify(part.beamAnalysisInputs)).not.toMatch(/"(?:result|stressMPa|damage|cycles|solidAnalyzed)"/u);
    useAppStore.getState().closeFatigue();
    useAppStore.getState().openFatigue();
    expect(useAppStore.getState().fatigueSession?.draft.inputMode).toBe('solid-proportional');
    expect(useAppStore.getState().fatigueSession?.solidAnalyzed).toBeNull();
    useAppStore.getState().undo();
    expect(savedFatigueEntry(useAppStore.getState().document)).toEqual(old);
    useAppStore.getState().redo();
    expect(savedFatigueEntry(useAppStore.getState().document)?.kind).toBe('fatigue-solid-proportional');
    useAppStore.setState({ fatigueSession: edited(BASE_EDITS, owner) });
    useAppStore.getState().saveFatigue();
    expect(savedFatigueEntry(useAppStore.getState().document)?.kind).toBe('fatigue');
    expect(useAppStore.getState().document.beamAnalysisInputs?.analyses).toHaveLength(2);
  });
  it('refuses changed revision/mesh/input/element against the actual accepted input/result pair', async () => {
    seedDocumentHistory();
    const source = await analyticalSolid(useAppStore.getState().document.id, useAppStore.getState().completedGeneration);
    for (const binding of [{ source: { ...source.result.source, revision: 4 }, inputSha256: source.result.inputSha256, elementIndex: 0 },
      { source: { ...source.result.source, meshKey: 'remeshed' }, inputSha256: source.result.inputSha256, elementIndex: 0 },
      { source: source.result.source, inputSha256: 'a'.repeat(64), elementIndex: 0 },
      { source: source.result.source, inputSha256: source.result.inputSha256, elementIndex: 1 }]) {
      installSolid(source);
      const session = useAppStore.getState().fatigueSession;
      if (session === null) throw new Error('No session');
      useAppStore.setState({ fatigueSession: { ...session, draft: { ...session.draft, solid: binding,
        solidElement: String(binding.elementIndex + 1) } } });
      const before = useAppStore.getState();
      await useAppStore.getState().runFatigue();
      expect(useAppStore.getState().fatigueSession?.solidAnalyzed ?? null).toBeNull();
      expect(useAppStore.getState().fatigueSession?.errorKey).toBe('fatigue.error.solidRefused');
      expectDocumentHistoryUnchanged(before);
    }
  });
  it('does not open solid fatigue for a foreign persistent part even when the session owner is current', async () => {
    const state = useAppStore.getState();
    expect(state.activeDocumentId).not.toBe(state.document.id);
    const source = await analyticalSolid('foreign-persistent-part', state.completedGeneration);
    installSolid(source);
    useAppStore.setState({ fatigueSession: null });
    useAppStore.getState().openSolidFatigue();
    expect(useAppStore.getState().fatigueSession).toBeNull();
    expect(useAppStore.getState().solidAnalysisSession?.result).toBe(source);
  });
  it('cannot publish after close, input edit, native cancellation, generation or owner change during actual asynchronous validation', async () => {
    seedDocumentHistory();
    const source = await analyticalSolid(useAppStore.getState().document.id, useAppStore.getState().completedGeneration);
    const original = useAppStore.getState();
    const changes: readonly (() => void)[] = [
      () => useAppStore.getState().closeFatigue(),
      () => useAppStore.getState().editFatigue({ kind: 'history-stress', index: 0, source: '0, -1, 0' }),
      () => useAppStore.setState({ solidAnalysisSession: null }),
      () => useAppStore.setState({ completedGeneration: original.completedGeneration + 1 }),
      () => useAppStore.setState({ activeDocumentId: 'another-owner' }),
    ];
    for (const change of changes) {
      useAppStore.setState({ activeDocumentId: original.activeDocumentId, completedGeneration: original.completedGeneration });
      installSolid(source);
      const before = useAppStore.getState();
      const pending = useAppStore.getState().runFatigue();
      change();
      expectDocumentHistoryUnchanged(before);
      await pending;
      expectDocumentHistoryUnchanged(before);
      expect(useAppStore.getState().fatigueSession?.solidAnalyzed ?? null).toBeNull();
    }
  });
});

describe('別storeのsolid fatigue所有', () => {
  it('singletonの変更と独立に自身のgetで採用し、別storeへ結果を混ぜない', async () => {
    const source = await analyticalSolid(useAppStore.getState().document.id, useAppStore.getState().completedGeneration);
    installSolid(source);
    const seed = useAppStore.getState();
    const local = create<typeof seed>()((...args) => ({ ...seed, ...createFatigueSlice(...args) }));
    local.setState({ fatigueSession: seed.fatigueSession });
    const pending = local.getState().runFatigue();
    const foreignDocument = { ...seed.document, name: 'foreign singleton edit' };
    useAppStore.setState({ document: foreignDocument });
    await pending;
    const session = local.getState().fatigueSession;
    if (session === null) throw new Error('No local fatigue session');
    expect(currentSolidFatigueResult(session, [], source)?.result.damage).toBeGreaterThan(0);
    expect(local.getState().document).toBe(seed.document);
    expect(local.getState().undoStack).toBe(seed.undoStack);
    expect(useAppStore.getState().document).toBe(foreignDocument);
    expect(useAppStore.getState().fatigueSession).toBe(seed.fatigueSession);
    expect(useAppStore.getState().fatigueSession?.solidAnalyzed).toBeNull();
  });

  it('自身のdocumentが待機中に変われば結果を捨て、singletonにも後着させない', async () => {
    const source = await analyticalSolid(useAppStore.getState().document.id, useAppStore.getState().completedGeneration);
    installSolid(source);
    const seed = useAppStore.getState();
    const local = create<typeof seed>()((...args) => ({ ...seed, ...createFatigueSlice(...args) }));
    local.setState({ fatigueSession: seed.fatigueSession });
    const pending = local.getState().runFatigue();
    const changedDocument = { ...seed.document, name: 'local edit while pending' };
    local.setState({ document: changedDocument });
    await pending;
    expect(local.getState().fatigueSession?.solidAnalyzed ?? null).toBeNull();
    expect(local.getState().document).toBe(changedDocument);
    expect(local.getState().undoStack).toBe(seed.undoStack);
    expect(useAppStore.getState().document).toBe(seed.document);
    expect(useAppStore.getState().fatigueSession).toBe(seed.fatigueSession);
    expect(useAppStore.getState().fatigueSession?.solidAnalyzed).toBeNull();
  });
});
