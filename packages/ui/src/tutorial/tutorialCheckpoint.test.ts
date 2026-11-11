import { describe, expect, it } from 'vitest';
import { readPcadFile, writePcadFile } from '@pointercad/io';
import { createDrawingDocument, createEmptyPartDocument, drawingSourceInputHash } from '@pointercad/model';
import { parameterTutorialStep, resumeParameterTutorialSession } from './tutorialProgress.js';
import {
  discardTutorialCheckpoint, readTutorialCheckpoint, saveTutorialCheckpoint,
  updateTutorialCheckpointDraft, TUTORIAL_CHECKPOINT_KEY,
  type TutorialCheckpointStorage,
} from './tutorialCheckpoint.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const part = createEmptyPartDocument();
const evidence = { part: { document: part, savedBytes: bytes('saved .pcad A') } };
const candidate = {
  stageHint: 'pointCoordinates' as const,
  owned: { sketchId: part.activeSketchId },
  draft: { kind: 'numeric' as const, operation: 'point' as const, mode: 'absolute' as const,
    fields: [{ key: 'x', source: '2*thickness + ' }, { key: 'y', source: '4mm' }, { key: 'z', source: '' }],
    focusedKey: 'x' },
};

function memoryStorage(): TutorialCheckpointStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); },
    removeItem: key => { data.delete(key); } };
}

describe('five-stage guide checkpoint', () => {
  it('resumes unfinished input from a real saved file in a fresh session without claiming step completion', async () => {
    const storage = memoryStorage();
    const savedBytes = writePcadFile(part);
    expect(await saveTutorialCheckpoint(candidate, { part: { document: part, savedBytes } }, storage))
      .toMatchObject({ ok: true });
    const persisted = storage.data.get(TUTORIAL_CHECKPOINT_KEY);
    if (persisted === undefined) throw new Error('checkpoint missing');
    const reopened = readPcadFile(savedBytes);
    if (!reopened.ok) throw new Error('saved file could not be reopened');
    expect(reopened.document).not.toBe(part);
    expect(reopened.document).toEqual(part);
    const freshStorage = memoryStorage();
    freshStorage.data.set(TUTORIAL_CHECKPOINT_KEY, persisted);
    const restored = await readTutorialCheckpoint({ part: { document: reopened.document, savedBytes } }, freshStorage);
    if (!restored.ok) throw new Error(`checkpoint refused: ${restored.reason}`);
    expect(restored.checkpoint.draft).toEqual(candidate.draft);
    const session = resumeParameterTutorialSession(restored.checkpoint, reopened.document, 7);
    if (session === null) throw new Error('guide session missing');
    expect(session).toMatchObject({ paused: true, documentVersion: 7, course: 'parameterToExport' });
    expect(parameterTutorialStep(session, reopened.document, 7, {
      ready: true, bodies: [], savedPart: reopened.document, activeDrawing: null,
    })).toBe('pointCoordinates');
    expect(reopened.document.sketches[0].features).toEqual([]);
    expect(freshStorage.data.get(TUTORIAL_CHECKPOINT_KEY)).toBe(persisted);
  });

  it.each([0, 2, '1', null])('preserves a checkpoint with unsupported version %s across every write entry', async version => {
    const storage = memoryStorage();
    const saved = await saveTutorialCheckpoint(candidate, evidence, storage);
    if (!saved.ok) throw new Error('checkpoint missing');
    const raw = JSON.stringify({ ...saved.checkpoint, version });
    storage.data.set(TUTORIAL_CHECKPOINT_KEY, raw);
    expect(await readTutorialCheckpoint(evidence, storage)).toEqual({ ok: false, reason: 'unsupportedVersion' });
    expect(await saveTutorialCheckpoint(candidate, evidence, storage)).toEqual({ ok: false, reason: 'unsupportedVersion' });
    expect(await updateTutorialCheckpointDraft(null, part, storage)).toEqual({ ok: false, reason: 'unsupportedVersion' });
    expect(storage.data.get(TUTORIAL_CHECKPOINT_KEY)).toBe(raw);
  });

  it('rejects corrupt ownership, stages and drafts without replacing the original record', async () => {
    const storage = memoryStorage();
    const saved = await saveTutorialCheckpoint(candidate, evidence, storage);
    if (!saved.ok) throw new Error('checkpoint missing');
    for (const corruption of [
      { course: 'other' }, { stageHint: 'complete' }, { owned: {} }, { savedSha256: 'invalid' },
      { draft: { ...candidate.draft, focusedKey: 'missing' } },
      { draft: { ...candidate.draft, fields: candidate.draft.fields.slice(1) } },
    ]) {
      const raw = JSON.stringify({ ...saved.checkpoint, ...corruption });
      storage.data.set(TUTORIAL_CHECKPOINT_KEY, raw);
      expect(await readTutorialCheckpoint(evidence, storage)).toEqual({ ok: false, reason: 'corrupt' });
      expect(await saveTutorialCheckpoint(candidate, evidence, storage)).toEqual({ ok: false, reason: 'corrupt' });
      expect(await updateTutorialCheckpointDraft(null, part, storage)).toEqual({ ok: false, reason: 'corrupt' });
      expect(storage.data.get(TUTORIAL_CHECKPOINT_KEY)).toBe(raw);
    }
  });

  it('does not overwrite a checkpoint replaced while an ordinary save is being checked', async () => {
    const storage = memoryStorage();
    expect(await saveTutorialCheckpoint(candidate, evidence, storage)).toMatchObject({ ok: true });
    let reads = 0, writes = 0;
    const newer = '{"owner":"another session"}';
    const competing: TutorialCheckpointStorage = {
      getItem: key => {
        if (++reads === 2) storage.data.set(key, newer);
        return storage.getItem(key);
      },
      setItem: () => { writes += 1; },
    };
    expect(await saveTutorialCheckpoint(candidate, evidence, competing))
      .toEqual({ ok: false, reason: 'storageConflict' });
    expect(writes).toBe(0);
    expect(storage.data.get(TUTORIAL_CHECKPOINT_KEY)).toBe(newer);
  });

  it('keeps only guide-owned expression/focus and saved-document identity, with no document or completion claim', async () => {
    const storage = memoryStorage();
    const before = JSON.stringify(part);
    const written = await saveTutorialCheckpoint(candidate, evidence, storage);
    expect(written.ok).toBe(true);
    const raw = storage.data.get(TUTORIAL_CHECKPOINT_KEY) ?? '';
    expect(raw).toContain('2*thickness + '); // invalid partial expression is a draft, never success proof
    expect(raw).toContain('4mm'); // all simultaneous coordinate fields survive restart
    expect(raw).not.toContain('sketches');
    expect(raw).not.toContain('completed');
    expect(raw).not.toContain('undoStack');
    expect(JSON.stringify(part)).toBe(before);
    const restored = await readTutorialCheckpoint(evidence, storage);
    expect(restored).toMatchObject({ ok: true, checkpoint: { stageHint: 'pointCoordinates', draft: candidate.draft } });
    expect(JSON.stringify(part)).toBe(before);
  });

  it('rejects a different document and the same document ID with different saved bytes', async () => {
    const storage = memoryStorage();
    expect((await saveTutorialCheckpoint(candidate, evidence, storage)).ok).toBe(true);
    expect(await readTutorialCheckpoint({ part: { document: { ...part, id: 'other' }, savedBytes: evidence.part.savedBytes } }, storage))
      .toMatchObject({ ok: false, reason: 'differentDocument' });
    expect(await saveTutorialCheckpoint(candidate,
      { part: { document: { ...part, id: 'other' }, savedBytes: evidence.part.savedBytes } }, storage))
      .toMatchObject({ ok: false, reason: 'differentDocument' });
    expect(await readTutorialCheckpoint({ part: { document: part, savedBytes: bytes('saved .pcad B') } }, storage))
      .toMatchObject({ ok: false, reason: 'staleContent' });
    expect(await readTutorialCheckpoint({ part: { document: { ...part, name: 'changed' }, savedBytes: evidence.part.savedBytes } }, storage))
      .toMatchObject({ ok: false, reason: 'staleContent' });
  });

  it('keeps pending parameter text and all coordinate modes without treating either as a committed feature', async () => {
    const storage = memoryStorage();
    const parameterDraft = { stageHint: 'thicknessParameter' as const, owned: candidate.owned,
      draft: { kind: 'parameter' as const, parameterName: 'thickness', source: '6mm + ', focusedKey: 'source' as const } };
    expect(await saveTutorialCheckpoint(parameterDraft, evidence, storage)).toMatchObject({ ok: true });
    expect(await readTutorialCheckpoint(evidence, storage)).toMatchObject({ ok: true, checkpoint: parameterDraft });
    for (const [mode, keys] of [
      ['relative', ['dx', 'dy', 'dz']], ['polar', ['distance', 'azimuth', 'elevation']],
    ] as const) {
      const draft = { kind: 'numeric' as const, operation: 'point' as const, mode,
        fields: keys.map(key => ({ key, source: '1 +' })), focusedKey: keys[1] };
      expect(await saveTutorialCheckpoint({ ...candidate, draft }, evidence, storage))
        .toMatchObject({ ok: true, checkpoint: { draft } });
      expect(await readTutorialCheckpoint(evidence, storage)).toMatchObject({ ok: true, checkpoint: { draft } });
    }
    expect(storage.data.get(TUTORIAL_CHECKPOINT_KEY)).not.toContain('completed');
  });

  it('keeps both edited rectangle corners and focus in a bounded draft without recording a feature', async () => {
    const storage = memoryStorage();
    const draft = { kind: 'numeric' as const, operation: 'rectangleCorner2' as const, mode: 'relative' as const,
      fields: [{ key: 'dx', source: '60mm +' }, { key: 'dy', source: '40mm' }, { key: 'dz', source: '0mm' }],
      focusedKey: 'dx', previousStage: { operation: 'rectangleCorner1' as const, mode: 'absolute' as const,
        fields: [{ key: 'x', source: '-30mm + ' }, { key: 'y', source: '-20mm' }, { key: 'z', source: '0mm' }],
        focusedKey: 'y' } };
    const input = { stageHint: 'thicknessParameter' as const, owned: candidate.owned, draft };
    expect(await saveTutorialCheckpoint(input, evidence, storage)).toMatchObject({ ok: true });
    expect(await readTutorialCheckpoint(evidence, storage)).toMatchObject({ ok: true, checkpoint: input });
    expect(await saveTutorialCheckpoint({ ...input, draft: { ...draft, operation: 'point' as const } }, evidence, storage))
      .toMatchObject({ ok: false, reason: 'corrupt' });
    expect(await saveTutorialCheckpoint({ ...input, draft: { ...draft, previousStage: {
      ...draft.previousStage, fields: [{ key: 'x', source: '1' }, { key: 'x', source: '2' }, { key: 'z', source: '3' }],
    } } }, evidence, storage)).toMatchObject({ ok: false, reason: 'corrupt' });
    expect(await saveTutorialCheckpoint({ ...input, draft: { ...draft,
      fields: draft.fields.map(field => ({ ...field, source: 'x'.repeat(180) })), previousStage: {
        ...draft.previousStage, fields: draft.previousStage.fields.map(field => ({ ...field, source: 'x'.repeat(180) })),
      } } }, evidence, storage)).toMatchObject({ ok: false, reason: 'corrupt' });
  });

  it('updates only draft against the same saved part, rejecting stale owner, changed storage and cancellation', async () => {
    const storage = memoryStorage();
    expect((await saveTutorialCheckpoint(candidate, evidence, storage)).ok).toBe(true);
    const first = storage.data.get(TUTORIAL_CHECKPOINT_KEY) ?? '';
    const original = JSON.parse(first) as Record<string, unknown>;
    const draft = { ...candidate.draft, fields: candidate.draft.fields.map(field => ({ ...field, source: field.source + 'x' })) };
    const changed = await updateTutorialCheckpointDraft(draft, part, storage);
    expect(changed).toMatchObject({ ok: true, checkpoint: { draft, savedSha256: original.savedSha256 } });
    expect(changed.ok && changed.checkpoint.stageHint).toBe('pointCoordinates');
    const stable = storage.data.get(TUTORIAL_CHECKPOINT_KEY);
    expect(await updateTutorialCheckpointDraft(null, { ...part, name: 'changed' }, storage))
      .toMatchObject({ ok: false, reason: 'staleContent' });
    expect(await updateTutorialCheckpointDraft(null, { ...part, id: 'other' }, storage))
      .toMatchObject({ ok: false, reason: 'differentDocument' });
    expect(await updateTutorialCheckpointDraft(null, part, storage, () => false))
      .toMatchObject({ ok: false, reason: 'staleRequest' });
    let reads = 0;
    const conflicting: TutorialCheckpointStorage = { getItem: () => ++reads === 1 ? stable ?? null : first,
      setItem: () => { throw new Error('must not write'); } };
    expect(await updateTutorialCheckpointDraft(null, part, conflicting))
      .toMatchObject({ ok: false, reason: 'storageConflict' });
    expect(storage.data.get(TUTORIAL_CHECKPOINT_KEY)).toBe(stable);
    let calls = 0;
    const cancelled = await saveTutorialCheckpoint(candidate, evidence, storage, () => ++calls < 2);
    expect(cancelled).toMatchObject({ ok: false, reason: 'staleRequest' });
    expect(storage.data.get(TUTORIAL_CHECKPOINT_KEY)).toBe(stable);
  });

  it('rejects forged ownership, unknown keys, versions and corrupt JSON without deleting it', async () => {
    const storage = memoryStorage();
    expect(await saveTutorialCheckpoint({ ...candidate, owned: { sketchId: part.activeSketchId, pointId: 'missing' } }, evidence, storage))
      .toMatchObject({ ok: false, reason: 'missingOwner' });
    expect((await saveTutorialCheckpoint(candidate, evidence, storage)).ok).toBe(true);
    const valid = JSON.parse(storage.data.get(TUTORIAL_CHECKPOINT_KEY) ?? '{}') as Record<string, unknown>;
    for (const [value, reason] of [
      [{ ...valid, version: 2 }, 'unsupportedVersion'],
      [{ ...valid, completed: true }, 'corrupt'],
      [{ ...valid, draft: { ...candidate.draft, extra: 1 } }, 'corrupt'],
    ] as const) {
      storage.data.set(TUTORIAL_CHECKPOINT_KEY, JSON.stringify(value));
      expect(await readTutorialCheckpoint(evidence, storage)).toMatchObject({ ok: false, reason });
    }
    storage.data.set(TUTORIAL_CHECKPOINT_KEY, '{bad');
    expect(await readTutorialCheckpoint(evidence, storage)).toMatchObject({ ok: false, reason: 'corrupt' });
    expect(await saveTutorialCheckpoint(candidate, evidence, storage)).toMatchObject({ ok: false, reason: 'corrupt' });
    expect(storage.data.get(TUTORIAL_CHECKPOINT_KEY)).toBe('{bad');
  });

  it('checks drawing owner and embedded part source against the saved part', async () => {
    const storage = memoryStorage();
    const drawing = createDrawingDocument('sheet', {
      sourceRef: 'part-ref', sourceKind: 'part', fileName: 'part.pcad', path: '', contentHash: 'wrong', importedAt: '',
    });
    const withDrawing = { ...evidence, drawing: {
      document: drawing, source: { sourceKind: 'part' as const, document: part }, savedBytes: bytes('saved .pcadd'),
    } };
    expect(await saveTutorialCheckpoint({ stageHint: 'drawing', owned: candidate.owned }, withDrawing, storage))
      .toMatchObject({ ok: false, reason: 'staleSource' });
  });

  it('keeps the export-stage hint after returning to the part without claiming drawing or export completion', async () => {
    const storage = memoryStorage();
    const result = await saveTutorialCheckpoint({ stageHint: 'stepStl', owned: candidate.owned }, evidence, storage);
    expect(result).toMatchObject({ ok: true, checkpoint: { savedKind: 'part', stageHint: 'stepStl' } });
    if (!result.ok) return;
    expect(result.checkpoint.drawing).toBeUndefined();
    expect(storage.data.get(TUTORIAL_CHECKPOINT_KEY)).not.toContain('completed');
    expect(await readTutorialCheckpoint(evidence, storage))
      .toMatchObject({ ok: true, checkpoint: { savedKind: 'part', stageHint: 'stepStl' } });
  });

  it('accepts a normal drawing source hash and rejects a different drawing or saved content', async () => {
    const storage = memoryStorage();
    const source = { sourceKind: 'part' as const, document: part };
    const sourceHash = await drawingSourceInputHash(source);
    const drawing = createDrawingDocument('sheet', {
      sourceRef: 'part-ref', sourceKind: 'part', fileName: 'part.pcad', path: '', contentHash: sourceHash, importedAt: '',
    });
    // A reopened .pcadd contains the embedded part and its own saved bytes; the old .pcad bytes are not required.
    const withDrawing = { part: { document: part }, drawing: {
      document: drawing, source, savedBytes: bytes('saved .pcadd'),
    } };
    expect((await saveTutorialCheckpoint({ stageHint: 'stepStl', owned: candidate.owned }, withDrawing, storage)).ok).toBe(true);
    expect(await readTutorialCheckpoint(withDrawing, storage)).toMatchObject({ ok: true, checkpoint: { stageHint: 'stepStl' } });
    expect(await readTutorialCheckpoint({ ...withDrawing, drawing: { ...withDrawing.drawing,
      document: { ...drawing, id: 'other-drawing' } } }, storage)).toMatchObject({ ok: false, reason: 'differentDocument' });
    expect(await readTutorialCheckpoint({ ...withDrawing, drawing: { ...withDrawing.drawing,
      savedBytes: bytes('changed .pcadd') } }, storage)).toMatchObject({ ok: false, reason: 'staleContent' });
  });

  it('refuses unavailable, quota, storage failures and unbounded draft without changing the existing input', async () => {
    expect(await readTutorialCheckpoint(evidence, null)).toMatchObject({ ok: false, reason: 'storageUnavailable' });
    const storage = memoryStorage();
    expect(await saveTutorialCheckpoint({ ...candidate, draft: { ...candidate.draft,
      fields: [{ key: 'x', source: 'x'.repeat(1025) }, ...candidate.draft.fields.slice(1)] } }, evidence, storage))
      .toMatchObject({ ok: false, reason: 'corrupt' });
    expect(await saveTutorialCheckpoint({ ...candidate, draft: { ...candidate.draft,
      fields: candidate.draft.fields.map(field => ({ ...field, source: 'x'.repeat(400) })) } }, evidence, storage))
      .toMatchObject({ ok: false, reason: 'corrupt' });
    expect(await saveTutorialCheckpoint({ ...candidate, draft: { ...candidate.draft,
      fields: candidate.draft.fields.slice(0, 2) } }, evidence, storage))
      .toMatchObject({ ok: false, reason: 'corrupt' });
    expect(await saveTutorialCheckpoint({ ...candidate, draft: { ...candidate.draft, focusedKey: 'missing' } }, evidence, storage))
      .toMatchObject({ ok: false, reason: 'corrupt' });
    expect(await saveTutorialCheckpoint({ ...candidate, draft: { ...candidate.draft,
      fields: [{ key: 'x', source: '1' }, { key: 'x', source: '2' }, { key: 'z', source: '3' }] } }, evidence, storage))
      .toMatchObject({ ok: false, reason: 'corrupt' });
    expect(await saveTutorialCheckpoint({ ...candidate, draft: { kind: 'parameter', parameterName: 'thickness',
      source: '6mm', focusedKey: 'source' } }, evidence, storage))
      .toMatchObject({ ok: false, reason: 'corrupt' });
    expect(storage.data.size).toBe(0);
    const quota: TutorialCheckpointStorage = {
      getItem: () => null,
      setItem: () => { throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }); },
    };
    expect(await saveTutorialCheckpoint(candidate, evidence, quota)).toMatchObject({ ok: false, reason: 'storageQuota' });
    const inaccessible: TutorialCheckpointStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => {} };
    expect(await readTutorialCheckpoint(evidence, inaccessible)).toMatchObject({ ok: false, reason: 'storageFailure' });
  });
});

describe('explicit checkpoint discard', () => {
  it('removes only the guide key after an explicit current-owner action', async () => {
    const storage = memoryStorage();
    await saveTutorialCheckpoint(candidate, evidence, storage);
    storage.data.set('unrelated-setting', 'keep');
    const beforeDocument = JSON.stringify(part);
    expect(discardTutorialCheckpoint(storage, () => true)).toEqual({ ok: true });
    expect(storage.data.get(TUTORIAL_CHECKPOINT_KEY)).toBeUndefined();
    expect(storage.data.get('unrelated-setting')).toBe('keep');
    expect(JSON.stringify(part)).toBe(beforeDocument);
    expect(await readTutorialCheckpoint(evidence, storage)).toMatchObject({ ok: false, reason: 'missing' });
  });

  it('keeps the original record when the owner is cancelled before the delete', async () => {
    const storage = memoryStorage();
    await saveTutorialCheckpoint(candidate, evidence, storage);
    const original = storage.data.get(TUTORIAL_CHECKPOINT_KEY);
    let checks = 0;
    expect(discardTutorialCheckpoint(storage, () => ++checks < 3))
      .toMatchObject({ ok: false, reason: 'staleRequest' });
    expect(storage.data.get(TUTORIAL_CHECKPOINT_KEY)).toBe(original);
    expect(discardTutorialCheckpoint(storage, () => false)).toMatchObject({ ok: false, reason: 'staleRequest' });
    expect(storage.data.get(TUTORIAL_CHECKPOINT_KEY)).toBe(original);
  });

  it('does not erase a new record written between snapshot and compare', async () => {
    const storage = memoryStorage();
    await saveTutorialCheckpoint(candidate, evidence, storage);
    const newer = 'a newer owner wrote this';
    let reads = 0, removals = 0;
    const racing: TutorialCheckpointStorage = {
      getItem: key => { reads += 1; if (reads === 2) storage.data.set(key, newer); return storage.data.get(key) ?? null; },
      setItem: storage.setItem,
      removeItem: () => { removals += 1; },
    };
    expect(discardTutorialCheckpoint(racing, () => true)).toMatchObject({ ok: false, reason: 'storageConflict' });
    expect(storage.data.get(TUTORIAL_CHECKPOINT_KEY)).toBe(newer);
    expect(removals).toBe(0);
  });

  it('refuses unsupported, missing, quota and throwing storage without claiming deletion', async () => {
    const storage = memoryStorage();
    await saveTutorialCheckpoint(candidate, evidence, storage);
    const original = storage.data.get(TUTORIAL_CHECKPOINT_KEY);
    expect(discardTutorialCheckpoint({ getItem: storage.getItem, setItem: storage.setItem }, () => true))
      .toMatchObject({ ok: false, reason: 'storageUnavailable' });
    expect(discardTutorialCheckpoint({ ...storage, removeItem: () => {
      throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    } }, () => true)).toMatchObject({ ok: false, reason: 'storageQuota' });
    expect(discardTutorialCheckpoint({ ...storage, removeItem: () => { throw new Error('denied'); } }, () => true))
      .toMatchObject({ ok: false, reason: 'storageFailure' });
    expect(storage.data.get(TUTORIAL_CHECKPOINT_KEY)).toBe(original);
    storage.data.delete(TUTORIAL_CHECKPOINT_KEY);
    expect(discardTutorialCheckpoint(storage, () => true)).toMatchObject({ ok: false, reason: 'missing' });
  });
});
