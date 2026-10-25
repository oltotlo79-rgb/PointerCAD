import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { writePcadFile } from '@pointercad/io';
import { applyParameters, createEmptyPartDocument, type PartDocument } from '@pointercad/model';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../i18n/t.js';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import type { AppState } from '../store/appState.js';
import { saveTutorialCheckpoint, TUTORIAL_CHECKPOINT_KEY } from '../tutorial/tutorialCheckpoint.js';
import { createParameterTutorialSession, parameterCheckpointIdentity } from '../tutorial/tutorialProgress.js';
import { ParameterPanel, persistParameterPanelGuideDraft } from './ParameterPanel.js';

// Resolve the real store with the static imports, outside the per-test hook.
// The fixture uses ordinary state writes; no mocked store imports its real copy.
const fixture = {
  base: useAppStore.getInitialState(),
  get current(): AppState { return useAppStore.getState(); },
  set current(state: AppState) { useAppStore.setState(state, true); },
};

beforeEach(() => {
  resetTestStore();
  fixture.base = useAppStore.getState();
  fixture.current = { ...fixture.base, ...createInitialDocumentState() };
});

function markup(): string {
  // Server rendering normally reads the initial snapshot, not the current fixture.
  const snapshot = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  try { return renderToStaticMarkup(createElement(ParameterPanel)); } finally { snapshot.mockRestore(); }
}

describe('parameter panel headless markup', () => {
  it('shows all 100 existing rows with search, usage and CSV controls', () => {
    const base = createEmptyPartDocument();
    // 日本語の名前と説明を持つ100行のまま検査する。
    const name = String.fromCharCode(0x4fc2, 0x6570);
    const description = String.fromCharCode(0x8aac, 0x660e);
    const document: PartDocument = { ...base, parameters: Array.from({ length: 100 }, (_, index) => ({
      name: `${name}${index}`, value: { source: String(index + 1), value: index + 1,
        display: String(index + 1) }, unit: 'mm' as const, description: `${description}${index}`,
    })) };
    const evaluated = applyParameters(document);
    fixture.current = { ...fixture.base, ...createInitialDocumentState(), document: evaluated.document,
      parameterAnalysis: evaluated.analysis };
    const html = markup();
    expect(html).toContain(t('parameterPanel.searchLabel'));
    expect(html).toContain(t('parameter.csv.import'));
    expect(html).toContain(t('parameter.csv.export'));
    expect(html).toContain(`${name}0`);
    expect(html).toContain(`${name}99`);
    expect(html).toContain('100 / 100');
  });
});

describe('parameter panel guide draft ownership', () => {
  it('旧パネルの後着入力は同IDの新guide草稿を変えず、新guideの通常入力は保存できる', async () => {
    const oldDocument: PartDocument = { ...createEmptyPartDocument(), parameters: [{ name: '板厚', unit: 'mm',
      description: '', value: { source: '3mm', value: 3, display: '3' } }] };
    const currentDocument = { ...oldDocument };
    expect(currentDocument.id).toBe(oldDocument.id);
    expect(currentDocument).not.toBe(oldDocument);
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); } };
    const savedBytes = writePcadFile(currentDocument, { savedAt: '2026-10-04T00:00:02.000Z' });
    const written = await saveTutorialCheckpoint({ stageHint: 'thicknessParameter',
      owned: { sketchId: currentDocument.activeSketchId, parameterName: '板厚' } },
      { part: { document: currentDocument, savedBytes } }, storage);
    if (!written.ok) throw new Error('checkpoint missing');
    const state = fixture.current;
    const session = createParameterTutorialSession(currentDocument, state.documentVersion);
    if (session === null) throw new Error('session missing');
    const retainedDraft = { kind: 'parameter' as const, parameterName: '板厚', source: '6mm',
      focusedKey: 'source' as const };
    const setTutorialDraft = vi.fn((draft: AppState['tutorialDraft']) => {
      fixture.current = { ...fixture.current, tutorialDraft: draft };
    });
    fixture.current = { ...state, document: currentDocument, savedDocument: currentDocument,
      tutorialSession: { ...session, checkpointIdentity: parameterCheckpointIdentity(written.checkpoint) },
      tutorialCheckpointStorage: storage, tutorialDraft: retainedDraft, setTutorialDraft };
    const before = fixture.current;
    const raw = values.get(TUTORIAL_CHECKPOINT_KEY);
    persistParameterPanelGuideDraft({ name: '板厚', field: 'source', text: '9mm', message: null }, oldDocument);
    const rejected = fixture.current;
    expect(setTutorialDraft).not.toHaveBeenCalled();
    expect(rejected.tutorialDraft).toBe(retainedDraft);
    expect(rejected.document).toBe(before.document);
    expect(rejected.undoStack).toBe(before.undoStack);
    expect(values.get(TUTORIAL_CHECKPOINT_KEY)).toBe(raw);
    persistParameterPanelGuideDraft({ name: '板厚', field: 'source', text: '8mm', message: null }, currentDocument);
    await vi.waitFor(() => expect(values.get(TUTORIAL_CHECKPOINT_KEY)).not.toBe(raw));
    expect(setTutorialDraft).toHaveBeenCalledTimes(1);
    expect(fixture.current.tutorialDraft).toMatchObject({ source: '8mm' });
    const stored = JSON.parse(values.get(TUTORIAL_CHECKPOINT_KEY) ?? '') as { draft?: { source?: string } };
    expect(stored.draft?.source).toBe('8mm');
    expect(fixture.current.document).toBe(currentDocument);
    expect(fixture.current.undoStack).toBe(before.undoStack);
  });

  it('別保存実体の同ID・同内容を旧checkpointへ草稿保存せず、受入済みownerだけ更新する', async () => {
    const part: PartDocument = { ...createEmptyPartDocument(), parameters: [{ name: '板厚', unit: 'mm',
      description: '', value: { source: '3mm', value: 3, display: '3' } }] };
    const other = { ...part };
    const firstBytes = writePcadFile(part, { savedAt: '2026-10-04T00:00:00.000Z' });
    const otherBytes = writePcadFile(other, { savedAt: '2026-10-04T00:00:01.000Z' });
    expect(other.id).toBe(part.id);
    expect(otherBytes).not.toEqual(firstBytes);
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); } };
    const written = await saveTutorialCheckpoint({ stageHint: 'thicknessParameter',
      owned: { sketchId: part.activeSketchId, parameterName: '板厚' } },
      { part: { document: part, savedBytes: firstBytes } }, storage);
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error('checkpoint missing');
    const originalRaw = values.get(TUTORIAL_CHECKPOINT_KEY);
    const state = fixture.current;
    const newSession = createParameterTutorialSession(other, state.documentVersion);
    const accepted = createParameterTutorialSession(part, state.documentVersion);
    if (newSession === null || accepted === null) throw new Error('session missing');
    function install(document: PartDocument, session: typeof newSession): void {
      fixture.current = { ...state, document, savedDocument: document, tutorialSession: session,
        tutorialCheckpointStorage: storage, tutorialDraft: null,
        setTutorialDraft: (draft: AppState['tutorialDraft']) => {
          fixture.current = { ...fixture.current, tutorialDraft: draft };
        },
        setTutorialCheckpointFailure: (reason: AppState['tutorialCheckpointFailure']) => {
          fixture.current = { ...fixture.current, tutorialCheckpointFailure: reason };
        } };
    }
    install(other, newSession);
    persistParameterPanelGuideDraft({ name: '板厚', field: 'source', text: '6mm', message: null }, other);
    expect(values.get(TUTORIAL_CHECKPOINT_KEY)).toBe(originalRaw);
    expect(fixture.current.tutorialCheckpointFailure).toBe('storageConflict');
    install(part, { ...accepted, checkpointIdentity: parameterCheckpointIdentity(written.checkpoint) });
    persistParameterPanelGuideDraft({ name: '板厚', field: 'source', text: '6mm', message: null }, part);
    await vi.waitFor(() => expect(values.get(TUTORIAL_CHECKPOINT_KEY)).not.toBe(originalRaw));
    const changed = JSON.parse(values.get(TUTORIAL_CHECKPOINT_KEY) ?? '') as { draft?: { source?: string } };
    expect(changed.draft?.source).toBe('6mm');
    let reads = 0;
    const outsider = '{"newer":"external checkpoint"}';
    const setItem = vi.fn((key: string, value: string) => { values.set(key, value); });
    const competingStorage = { getItem: (key: string) => {
      reads += 1;
      if (reads === 2) values.set(key, outsider);
      return values.get(key) ?? null;
    }, setItem };
    fixture.current = { ...fixture.current, tutorialCheckpointStorage: competingStorage };
    persistParameterPanelGuideDraft({ name: '板厚', field: 'source', text: '9mm', message: null }, part);
    await vi.waitFor(() => expect(fixture.current.tutorialCheckpointFailure).toBe('staleRequest'));
    expect(values.get(TUTORIAL_CHECKPOINT_KEY)).toBe(outsider);
    expect(setItem).not.toHaveBeenCalled();
  });
});
