import { ASSEMBLY_EXAMPLES, DRAWING_EXAMPLES, resolveDrawingDimensions } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartFileDeps } from '../file/partFile.js';
import { t } from '../i18n/t.js';
import { partWithPoint, resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { ASSEMBLY_EXAMPLE_ENTRIES, DRAWING_EXAMPLE_ENTRIES } from './documentExampleEntries.js';
import { openAssemblyExample, openDrawingExample } from './openDocumentExample.js';

beforeEach(resetTestStore);
afterEach(resetTestStore);

/** A previously saved part with one unsaved edit and an existing overwrite target. */
function editSavedPart(): void {
  const state = useAppStore.getState();
  let hasTarget = true;
  useAppStore.setState({ fileGateway: { ...state.fileGateway,
    hasSaveTarget: () => hasTarget, clearSaveTarget: () => { hasTarget = false; } } });
  state.setFileState('previous.pcad', state.document);
  state.applyDocument(partWithPoint());
}

function prompt(answer: boolean) {
  return { confirmDiscard: vi.fn<PartFileDeps['confirmDiscard']>().mockResolvedValue(answer) };
}

describe('アセンブリ・図面の作例を新しい文書として開く', () => {
  it.each(ASSEMBLY_EXAMPLES)('$id の名前・配置数・埋め込んだ部品・新しい保存先', async example => {
    editSavedPart();
    const before = useAppStore.getState(), deps = prompt(true);
    await openAssemblyExample(example, deps);
    expect(deps.confirmDiscard.mock.calls).toEqual([['file.discardConfirm']]);
    const state = useAppStore.getState();
    expect(state.assembly?.name).toBe(t(ASSEMBLY_EXAMPLE_ENTRIES[example.id].nameKey));
    expect(state.assembly?.components).toHaveLength(example.id === 'boltedPlates' ? 6 : 8);
    expect(state.assemblyLibrary.parts.size).toBe(example.id === 'boltedPlates' ? 1 : 0);
    expect(state.activeDocumentId).not.toBe(before.activeDocumentId);
    expect(state.drawing).toBeNull();
    expect(state.savedAssembly).toBeNull();
    expect(state.assemblyFileName).toBeNull();
    expect(state.fileGateway.hasSaveTarget()).toBe(false);
    expect(state.assemblyUndoStack?.past).toEqual([]);
  });

  it('図面と元のフランジを一緒に開き、三面図の外径と厚さが両方とも解ける', async () => {
    editSavedPart();
    const before = useAppStore.getState(), deps = prompt(true);
    const [example] = DRAWING_EXAMPLES;
    await openDrawingExample(example, deps);
    expect(deps.confirmDiscard.mock.calls).toEqual([['file.discardConfirm']]);
    const state = useAppStore.getState(), drawing = state.drawing;
    if (drawing === null) throw new Error('図面が開いていません');
    expect(drawing.name).toBe(t(DRAWING_EXAMPLE_ENTRIES[example.id].nameKey));
    expect(state.drawingSources.sources.map(entry => entry.metadata)).toEqual([drawing.source]);
    expect(drawing.views.map(view => view.kind)).toEqual(['front', 'top', 'right']);
    // Both dimensions reference model points. The centre of the 20 mm thick flange is at Z = 10.
    const dimensions = resolveDrawingDimensions(drawing, { modelCenter: [0, 0, 10], instances: [] });
    expect(dimensions.map(item => [item.status, item.value])).toEqual([['resolved', 80], ['resolved', 20]]);
    expect(state.activeDocumentId).not.toBe(before.activeDocumentId);
    expect(state.assembly).toBeNull();
    expect(state.savedDrawing).toBeNull();
    expect(state.drawingFileName).toBeNull();
    expect(state.fileGateway.hasSaveTarget()).toBe(false);
    expect(state.drawingUndoStack?.past).toEqual([]);
  });

  it.each(['assembly', 'drawing'] as const)('%s の破棄を取り消すと、作例を作らず文書・履歴・保存先を保つ', async kind => {
    editSavedPart();
    const before = useAppStore.getState(), deps = prompt(false);
    const create = vi.fn(() => Promise.reject(new Error('取り消した作例を作ろうとしました')));
    if (kind === 'assembly') await openAssemblyExample({ ...ASSEMBLY_EXAMPLES[0], create }, deps);
    else await openDrawingExample({ ...DRAWING_EXAMPLES[0], create }, deps);
    expect(deps.confirmDiscard.mock.calls).toEqual([['file.discardConfirm']]);
    expect(create).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toBe(before);
    expect(before.fileGateway.hasSaveTarget()).toBe(true);
  });

  it('最初に了承しても、図面の作成中に加えた変更の破棄を断れば編集を保つ', async () => {
    editSavedPart();
    const before = useAppStore.getState(), deps = prompt(false);
    deps.confirmDiscard.mockResolvedValueOnce(true);
    const edited = { ...before.document, name: '図面の作成中の編集' };
    const [example] = DRAWING_EXAMPLES;
    await openDrawingExample({ ...example, create: async () => {
      const result = await example.create();
      before.applyDocument(edited);
      return result;
    } }, deps);
    const state = useAppStore.getState();
    expect(deps.confirmDiscard.mock.calls).toEqual([['file.discardConfirm'], ['file.openChangedWhileReading']]);
    expect(state.activeDocumentId).toBe(before.activeDocumentId);
    expect(state.document).toBe(edited);
    expect(state.drawing).toBeNull();
    expect(state.fileName).toBe(before.fileName);
    expect(state.fileGateway.hasSaveTarget()).toBe(true);
  });

  it('続けて別の作例を開くと、先に選んだ作例は採用しない', async () => {
    const deps = prompt(false);
    const first = openDrawingExample(DRAWING_EXAMPLES[0], deps);
    const second = openAssemblyExample(ASSEMBLY_EXAMPLES[0], deps);
    await Promise.all([first, second]);
    const state = useAppStore.getState();
    expect(deps.confirmDiscard).not.toHaveBeenCalled();
    expect(state.assembly?.name).toBe(t(ASSEMBLY_EXAMPLE_ENTRIES[ASSEMBLY_EXAMPLES[0].id].nameKey));
    expect(state.drawing).toBeNull();
  });

  it('作例を作れなかったときは、元の文書と上書き先を保って理由を表示する', async () => {
    editSavedPart();
    const before = useAppStore.getState();
    await openAssemblyExample({ ...ASSEMBLY_EXAMPLES[0], create: () => Promise.reject(new Error('assembly')) }, prompt(true));
    const state = useAppStore.getState();
    expect(state.document).toBe(before.document);
    expect(state.undoStack).toBe(before.undoStack);
    expect(state.activeDocumentId).toBe(before.activeDocumentId);
    expect(state.fileGateway.hasSaveTarget()).toBe(true);
    expect(state.fileMessage).toMatchObject({ key: 'file.openFailed', failed: true });
  });
});
