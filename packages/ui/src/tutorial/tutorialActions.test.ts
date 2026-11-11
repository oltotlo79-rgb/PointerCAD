import { beforeEach, describe, expect, it, vi } from 'vitest';
import { absoluteCoordinate, appendFeature, appendSolid, createDrawingDocument, createEmptyPartDocument,
  createPointFeature, embedDrawingSource, emptyDrawingSourceLibrary, replaceSketch } from '@pointercad/model';
import { encodeSaveDocument, writePcadFile } from '@pointercad/io';
import { savePart, type PartFileDeps } from '../file/partFile.js';
import type { FileGateway } from '../file/fileGateway.js';
import { applyNumericTransition } from '../sketch/commitToStore.js';
import { commitNumericInput, reduceNumericInput } from '../sketch/numericInput.js';
import { useAppStore } from '../store/useAppStore.js';
import { bodyFor, extrudeFeature, resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { advanceTutorial, openTutorial, pauseTutorial } from './tutorialActions.js';
import { parameterNumericDraft, parameterTutorialInput } from './tutorialInput.js';
import { createParameterTutorialSession } from './tutorialProgress.js';
import { saveTutorialCheckpoint, TUTORIAL_CHECKPOINT_KEY } from './tutorialCheckpoint.js';

function settled(): void {
  const state = useAppStore.getState();
  state.applyRecompute(state.document, resultFor(state.document));
  useAppStore.setState({ isComputing: false, requestedGeneration: 1, completedGeneration: 1, lastOutcome: 'success' });
}
function enter(): void {
  const state = useAppStore.getState(), input = state.numericInput;
  if (input === null) throw new Error('input missing');
  applyNumericTransition(commitNumericInput(input));
  settled();
}
beforeEach(() => {
  resetTestStore();
  useAppStore.setState({ tutorialSession: null, tutorialOpen: false, viewportSize: [760, 623] });
  settled();
});

describe('初回案内は通常の作図を通り、途中入力・失敗・別文書を保護する', () => {
  it('案内を中断して開き直しても入力と連続作図の設定を保つ', () => {
    openTutorial(); expect(advanceTutorial()).toBe(true);
    const state = useAppStore.getState(), input = state.numericInput;
    if (input === null) throw new Error('input missing');
    state.updateNumericInput(reduceNumericInput(input, { type: 'edit', index: 0, source: '12/2' }));
    const before = useAppStore.getState();
    pauseTutorial(); openTutorial();
    expect(useAppStore.getState().numericInput).toBe(before.numericInput);
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    expect(useAppStore.getState().chaining).toBe(before.chaining);
  });
  it('通常のEnterで点と輪郭を作り、面の確定はUndo一回で戻る', () => {
    openTutorial(); advanceTutorial(); enter();
    expect(useAppStore.getState().numericInput).toBeNull();
    advanceTutorial(); enter(); enter();
    const beforeFace = useAppStore.getState().document;
    expect(advanceTutorial()).toBe(true); settled();
    expect(useAppStore.getState().sketch.features.map(item => item.kind)).toEqual(['point', 'rectangle', 'face']);
    useAppStore.getState().undo(); settled();
    expect(useAppStore.getState().document).toEqual(beforeFace);
  });
  it.each(['failed', 'cancelled', 'workerBroken'] as const)('%sの計算を成功と数えない', lastOutcome => {
    openTutorial(); const before = useAppStore.getState();
    useAppStore.setState({ lastOutcome });
    expect(advanceTutorial()).toBe(false);
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().numericInput).toBeNull();
  });
  it('同じIDで新規を開いても古い案内を自動実行しない', () => {
    openTutorial(); const before = useAppStore.getState();
    useAppStore.setState({ documentVersion: before.documentVersion + 1 });
    expect(advanceTutorial()).toBe(false);
    expect(useAppStore.getState().document).toBe(before.document);
  });
  it('穴の面は実際の高さから選び、先頭の面番号を決め打ちしない', () => {
    openTutorial(); advanceTutorial(); enter(); advanceTutorial(); enter(); enter(); advanceTutorial(); settled();
    const state = useAppStore.getState(), session = state.tutorialSession;
    if (session === null) throw new Error('session missing');
    state.applyDocument(appendSolid(state.document, extrudeFeature(session.extrudeId))); settled();
    const face = { surfaceKind: 'plane' as const, area: 2400, axis: [0, 0, 1] as const,
      radius: null, triangleOffset: 0, triangleCount: 2 };
    useAppStore.setState({ bodies: [{ ...bodyFor(session.extrudeId), faces: [
      { ...face, index: 1, centroid: [0, 0, 0] }, { ...face, index: 7, centroid: [0, 0, 8] },
    ] }] });
    expect(advanceTutorial()).toBe(true);
    expect(useAppStore.getState().selection).toEqual([session.extrudeId + '#face:7', session.pointId]);
    expect(useAppStore.getState().numericInput?.toolId).toBe('hole');
  });
});

describe('5段案内は未確定の数値入力を文書と区別する', () => {
  it('同じpart-1 IDの別の新規courseは保存済み原票の所有を自動取得しない', async () => {
    // Keep the same-ID collision explicit; new sessions normally use unique IDs.
    useAppStore.setState({ document: { ...useAppStore.getState().document, id: 'part-1' } });
    const original = { ...createEmptyPartDocument(), name: '前の部品' };
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(await saveTutorialCheckpoint({ stageHint: 'pointCoordinates',
      owned: { sketchId: original.activeSketchId } },
      { part: { document: original, savedBytes: writePcadFile(original) } }, storage)).toMatchObject({ ok: true });
    const raw = values.get(TUTORIAL_CHECKPOINT_KEY);
    const state = useAppStore.getState();
    expect(state.document.id).toBe(original.id);
    state.setTutorialCheckpointStorage(storage);
    const document = state.document, undo = state.undoStack;
    openTutorial('parameterToExport');
    expect(useAppStore.getState().tutorialSession?.course).toBe('parameterToExport');
    expect(useAppStore.getState().tutorialSession?.checkpointIdentity).toBeUndefined();
    expect(values.get(TUTORIAL_CHECKPOINT_KEY)).toBe(raw);
    expect(useAppStore.getState().document).toBe(document);
    expect(useAppStore.getState().undoStack).toBe(undo);
  });
  it('別保存実体の同ID・同内容でも通常保存を成功させ、数値草稿は旧原票へ書かない', async () => {
    const initial = useAppStore.getState();
    const prior = { ...initial.document };
    const oldBytes = writePcadFile(prior, { savedAt: '2026-10-04T00:00:00.000Z' });
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(await saveTutorialCheckpoint({ stageHint: 'pointCoordinates',
      owned: { sketchId: prior.activeSketchId } },
      { part: { document: prior, savedBytes: oldBytes } }, storage)).toMatchObject({ ok: true });
    const oldRaw = values.get(TUTORIAL_CHECKPOINT_KEY);
    initial.setTutorialCheckpointStorage(storage);
    openTutorial('parameterToExport');
    const savedBytes: Uint8Array[] = [];
    const gateway: FileGateway = { openPcad: () => Promise.resolve(null),
      savePcad: (_name, bytes) => { savedBytes.push(bytes); return Promise.resolve('new.pcad'); },
      hasSaveTarget: () => false };
    useAppStore.setState({ fileGateway: gateway });
    const deps: PartFileDeps = { captureThumbnail: () => null, encodeSave: encodeSaveDocument,
      confirmDiscard: () => Promise.resolve(true), recentFilesStorage: null };
    const undo = useAppStore.getState().undoStack;
    await savePart(deps, true);
    expect(savedBytes).toHaveLength(1);
    expect(savedBytes[0]).not.toEqual(oldBytes);
    const saved = useAppStore.getState();
    expect(saved.savedDocument).toBe(saved.document);
    expect(saved.tutorialSession?.checkpointIdentity).toBeUndefined();
    expect(values.get(TUTORIAL_CHECKPOINT_KEY)).toBe(oldRaw);
    expect(saved.undoStack).toBe(undo);
    expect(advanceTutorial()).toBe(true);
    const input = useAppStore.getState().numericInput;
    if (input === null) throw new Error('numeric input missing');
    useAppStore.getState().updateNumericInput(reduceNumericInput(input, { type: 'edit', index: 0, source: '7mm' }));
    expect(useAppStore.getState().tutorialDraft?.kind).toBe('numeric');
    expect(values.get(TUTORIAL_CHECKPOINT_KEY)).toBe(oldRaw);
    expect(useAppStore.getState().tutorialCheckpointFailure).toBe('storageConflict');
  });
  it('受入済み同一guideの数値草稿だけを保存ZIPを増やさず更新する', async () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); } };
    const state = useAppStore.getState();
    state.setTutorialCheckpointStorage(storage);
    openTutorial('parameterToExport');
    const savedBytes: Uint8Array[] = [];
    const gateway: FileGateway = { openPcad: () => Promise.resolve(null),
      savePcad: (_name, bytes) => { savedBytes.push(bytes); return Promise.resolve('guide.pcad'); },
      hasSaveTarget: () => false };
    useAppStore.setState({ fileGateway: gateway });
    await savePart({ captureThumbnail: () => null, encodeSave: encodeSaveDocument,
      confirmDiscard: () => Promise.resolve(true),
      recentFilesStorage: null }, true);
    const firstRaw = values.get(TUTORIAL_CHECKPOINT_KEY);
    expect(firstRaw).toBeDefined();
    expect(useAppStore.getState().tutorialSession?.checkpointIdentity).toBeDefined();
    expect(advanceTutorial()).toBe(true);
    const input = useAppStore.getState().numericInput;
    if (input === null) throw new Error('numeric input missing');
    useAppStore.getState().updateNumericInput(reduceNumericInput(input, { type: 'edit', index: 0, source: '3/2mm' }));
    await vi.waitFor(() => expect(values.get(TUTORIAL_CHECKPOINT_KEY)).not.toBe(firstRaw));
    const stored = JSON.parse(values.get(TUTORIAL_CHECKPOINT_KEY) ?? '') as {
      savedSha256: string; draft?: { fields?: readonly { source: string }[] } };
    const first = JSON.parse(firstRaw ?? '') as { savedSha256: string };
    expect(stored.savedSha256).toBe(first.savedSha256);
    expect(stored.draft?.fields?.[0]?.source).toBe('3/2mm');
    expect(savedBytes).toHaveLength(1);
  });
  it('3欄の原式と焦点を中断・再開で保ち、Undoや確定済み点を増やさない', () => {
    openTutorial('parameterToExport');
    expect(advanceTutorial()).toBe(true);
    const started = useAppStore.getState();
    const document = started.document, undo = started.undoStack;
    for (const [index, source] of ['1/2mm', '2+3mm', '-4mm'].entries()) {
      const input = useAppStore.getState().numericInput;
      if (input === null) throw new Error('numeric input missing');
      useAppStore.getState().updateNumericInput(reduceNumericInput(input, { type: 'edit', index, source }));
    }
    const before = useAppStore.getState();
    expect(before.tutorialDraft?.kind).toBe('numeric');
    if (before.tutorialDraft?.kind !== 'numeric') throw new Error('draft missing');
    expect(before.tutorialDraft.fields.map(field => field.source)).toEqual(['1/2mm', '2+3mm', '-4mm']);
    expect(before.tutorialDraft.focusedKey).toBe(before.numericInput?.fields[2]?.key);
    pauseTutorial(); openTutorial('parameterToExport');
    const resumed = useAppStore.getState();
    expect(resumed.numericInput).toBe(before.numericInput);
    expect(resumed.tutorialDraft).toBe(before.tutorialDraft);
    expect(resumed.document).toBe(document);
    expect(resumed.undoStack).toBe(undo);
    expect(resumed.sketch.features).toHaveLength(0);
  });
  it('点を保存済みの文書へ古い点入力draftを再表示しない', () => {
    const initial = useAppStore.getState();
    const session = createParameterTutorialSession(initial.document, initial.documentVersion);
    if (session === null) throw new Error('session missing');
    const point = createPointFeature(initial.sketch, absoluteCoordinate(0, 0, 0));
    initial.applyDocument(replaceSketch(initial.document, appendFeature(initial.sketch, point)));
    settled();
    const current = useAppStore.getState();
    const draft = parameterNumericDraft(parameterTutorialInput('pointCoordinates'));
    if (draft === null) throw new Error('draft missing');
    current.setTutorialSession({ ...session, documentVersion: current.documentVersion, paused: true });
    current.setTutorialDraft(draft);
    const undo = current.undoStack;
    openTutorial('parameterToExport');
    expect(useAppStore.getState().numericInput).toBeNull();
    expect(useAppStore.getState().tutorialDraft).toBe(draft);
    expect(useAppStore.getState().document).toBe(current.document);
    expect(useAppStore.getState().undoStack).toBe(undo);
  });
  it('同じpart-1 IDの初期文書からも実pcadd埋込部品へ明示的に戻る', async () => {
    // Keep the same-ID collision explicit; new sessions normally use unique IDs.
    useAppStore.setState({ document: { ...useAppStore.getState().document, id: 'part-1' } });
    const initial = useAppStore.getState();
    const part = createEmptyPartDocument();
    expect(initial.document.id).toBe(part.id);
    expect(initial.document).not.toBe(part);
    const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(),
      { sourceKind: 'part', document: part }, 'guide.pcad', '');
    const drawing = createDrawingDocument('保存図面', embedded.source);
    initial.openDrawing(drawing, { saved: true, sources: embedded.library });
    const opened = useAppStore.getState();
    const session = createParameterTutorialSession(part, opened.documentVersion);
    if (session === null) throw new Error('session missing');
    opened.setTutorialSession({ ...session, paused: true });
    opened.setTutorialDrawingProof({ document: drawing, sourcePart: part,
      sourceRef: drawing.source.sourceRef, sourceHash: drawing.source.contentHash });
    openTutorial('parameterToExport');
    expect(useAppStore.getState().tutorialSession?.paused).toBe(false);
    expect(advanceTutorial()).toBe(true);
    await vi.waitFor(() => expect(useAppStore.getState().drawing).toBeNull());
    const returned = useAppStore.getState();
    expect(returned.document).toBe(part);
    expect(returned.fileGateway.hasSaveTarget()).toBe(false);
    expect(returned.tutorialSession?.documentVersion).toBe(returned.documentVersion);
  });
});
