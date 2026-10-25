/**
 * 別の文書を開いた後の「元に戻す」と選択の検査(2026-10-05 の不具合調査、R29 の画面検査で発見)。
 *
 * 開く・最近使ったファイル・新規・ひな形・自動保存からの復元・図面から元の部品へ戻る冷再開は、
 * どれも「別の文書へ切り替える」操作である。切り替えた文書は**新しい履歴から始まり**、
 * 前の文書の選択・取りかけを持ち越さない(組立・図面を開く `openAssembly`・`openDrawing`、
 * 新規・復元の `resetDocument` と同じ約束。NFR-UX-3 の確認窓は「変更を捨てて続ける」)。
 *
 * 開いた直後の Undo で前の文書へ戻ると、帯の名前と上書き先は開いたファイルのまま中身だけが
 * 前の文書になり、上書き保存で開いたファイルを前の文書の中身で壊す。ここではその経路を
 * 偽の口(記憶上のバイト列)で再現し、全ての開き方で同じ約束が守られることを確かめる。
 */

import {
  createAutoSaver,
  createMemoryAutoSaveStorage,
  encodeSaveDocument,
  readDocumentBundle,
  readDrawingBundle,
  readPcadFile,
  writeDocumentBundle,
  writeDrawingBundle,
  writePcadFile,
} from '@pointercad/io';
import {
  absoluteCoordinate,
  appendFeature,
  createAssemblyDocument,
  createAssemblyDocumentBundle,
  createDrawingDocument,
  createEmptyPartDocument,
  createEmptySketchDocument,
  createPointFeature,
  embedDrawingSource,
  EMPTY_PART_LIBRARY,
  emptyDrawingSourceLibrary,
  replaceSketch,
  type PartDocument,
} from '@pointercad/model';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDrawingWithConfirmation } from '../drawing/closeDrawing.js';
import { activeDocumentKind } from '../store/documentKind.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { createParameterTutorialSession } from '../tutorial/tutorialProgress.js';
import { restoreAutoSave } from './attachAutoSave.js';
import type { FileGateway, PickedFile } from './fileGateway.js';
import { newPart, openPart, savePart, type PartFileDeps } from './partFile.js';

const deps: PartFileDeps = {
  captureThumbnail: () => null,
  confirmDiscard: () => Promise.resolve(true),
  recentFilesStorage: null,
};

interface Gateway {
  /** 次の「開く」で選ばれるファイル。 */
  next: PickedFile | null;
  /** 上書き先を覚えているファイルの名前(開いて確定したもの)。 */
  target: string | null;
  /** 書き込んだ先の名前と中身。 */
  readonly writes: { readonly name: string; readonly bytes: Uint8Array; readonly saveAs: boolean }[];
}

/** 開いたファイルを上書き先として覚え、上書き保存ではそこへ書く偽の口。 */
function installGateway(): Gateway {
  const state: Gateway = { next: null, target: null, writes: [] };
  let pending: string | null = null;
  const gateway: FileGateway = {
    openPcad: () => {
      pending = state.next?.name ?? null;
      return Promise.resolve(state.next);
    },
    savePcad: (suggestedName, bytes, saveAs) => {
      const name = saveAs || state.target === null ? suggestedName : state.target;
      state.writes.push({ name, bytes, saveAs });
      state.target = name;
      return Promise.resolve(name);
    },
    hasSaveTarget: () => state.target !== null,
    confirmSaveTarget: () => {
      state.target = pending;
      return Promise.resolve();
    },
    clearSaveTarget: () => {
      state.target = null;
      pending = null;
    },
  };
  useAppStore.setState({ fileGateway: gateway });
  return state;
}

/** 名前と点 1 つの部品。点の id はどちらも同じ(別の文書の同名 id)。 */
function partNamed(name: string, x: number): PartDocument {
  const sketch = createEmptySketchDocument();
  const drawn = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(x, 2, 3)));
  return { ...replaceSketch(createEmptyPartDocument(), drawn), name };
}

function pointIdOf(document: PartDocument): string {
  const feature = document.sketches.flatMap((sketch) => sketch.features).find((item) => item.kind === 'point');
  if (feature === undefined) throw new Error('point missing');
  return feature.id;
}

/** 部品 A を編集して保存し、履歴と選択と取りかけを持った状態にする。 */
async function editAndSelectPartA(gateway: Gateway): Promise<PartDocument> {
  const store = useAppStore.getState();
  store.applyDocument(partNamed('A', 1));
  store.applyDocument(partNamed('A', 5));
  await savePart(deps, false);
  expect(gateway.writes).toHaveLength(1);
  expect(useAppStore.getState().fileName).toBe(gateway.writes[0].name);
  const a = useAppStore.getState().document;
  useAppStore.getState().setSelection([pointIdOf(a)]);
  useAppStore.getState().setHovered(pointIdOf(a));
  expect(useAppStore.getState().canUndo).toBe(true);
  expect(useAppStore.getState().selection).toEqual([pointIdOf(a)]);
  return a;
}

/** 開いた直後の約束: 戻れる段が無く、選択・ホバーが空。 */
function expectFreshAfterOpen(stage: string): void {
  const state = useAppStore.getState();
  expect.soft(state.canUndo, `${stage}: canUndo`).toBe(false);
  expect.soft(state.canRedo, `${stage}: canRedo`).toBe(false);
  expect.soft(state.selection, `${stage}: selection`).toEqual([]);
  expect.soft(state.connectionSelection, `${stage}: connectionSelection`).toBeNull();
  expect.soft(state.hoveredElementId, `${stage}: hover`).toBeNull();
}

beforeEach(() => {
  resetTestStore();
  useAppStore.setState({ saveDocumentEncoder: encodeSaveDocument, documentSaveOperation: null });
});

describe('部品を開いた後の元に戻すと選択', () => {
  it('開いた直後は戻れず、押しても開いた文書のまま。上書き保存は開いたファイルへ開いた中身を書く', async () => {
    const gateway = installGateway();
    const a = await editAndSelectPartA(gateway);
    const b = partNamed('B', 9);
    gateway.next = { name: 'B.pcad', bytes: writePcadFile(b), saveTargetToken: 'B.pcad' };

    await openPart(deps);

    const opened = useAppStore.getState();
    expect(opened.document.name).toBe('B');
    expect(opened.fileName).toBe('B.pcad');
    expect(gateway.target).toBe('B.pcad');
    expectFreshAfterOpen('open B');
    opened.undo();
    const afterUndo = useAppStore.getState();
    expect(afterUndo.document).toBe(opened.document);
    expect(afterUndo.document.name).toBe('B');
    expect(afterUndo.documentVersion).toBe(opened.documentVersion);

    await savePart(deps, false);
    const written = gateway.writes.at(-1);
    expect(written?.name).toBe('B.pcad');
    const read = readPcadFile(written?.bytes ?? new Uint8Array());
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.document.name).toBe('B');
    // A の文書そのものは別のファイル(A.pcad)にだけ残る。
    expect(a.name).toBe('A');
  });

  it('同じ id の点を選んでいても、開いた文書へ選択を持ち越さない', async () => {
    const gateway = installGateway();
    const a = await editAndSelectPartA(gateway);
    const b = partNamed('B', 9);
    expect(pointIdOf(b)).toBe(pointIdOf(a));
    useAppStore.getState().setActiveTool('point');
    gateway.next = { name: 'B.pcad', bytes: writePcadFile(b), saveTargetToken: 'B.pcad' };

    await openPart(deps);

    expectFreshAfterOpen('same id');
    expect(useAppStore.getState().activeTool).toBe('select');
  });

  it('組立を開いている間に部品を開いても、裏の古い部品の履歴へ戻らない', async () => {
    const gateway = installGateway();
    await editAndSelectPartA(gateway);
    useAppStore.getState().openAssembly(createAssemblyDocument('組立'));
    gateway.next = { name: 'B.pcad', bytes: writePcadFile(partNamed('B', 9)), saveTargetToken: 'B.pcad' };

    await openPart(deps);

    expect(activeDocumentKind(useAppStore.getState())).toBe('part');
    expect(useAppStore.getState().document.name).toBe('B');
    expectFreshAfterOpen('assembly -> part');
    useAppStore.getState().undo();
    expect(useAppStore.getState().document.name).toBe('B');
  });

  it('図面を開いている間に部品を開くと図面を閉じ、開いた部品を新しい履歴で出す', async () => {
    const gateway = installGateway();
    await editAndSelectPartA(gateway);
    const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(),
      { sourceKind: 'part', document: createEmptyPartDocument() }, 'src.pcad', '');
    useAppStore.getState().openDrawing(createDrawingDocument('図面', embedded.source), { sources: embedded.library });
    gateway.next = { name: 'B.pcad', bytes: writePcadFile(partNamed('B', 9)), saveTargetToken: 'B.pcad' };

    await openPart(deps);

    const state = useAppStore.getState();
    expect(activeDocumentKind(state)).toBe('part');
    expect(state.drawing).toBeNull();
    expect(state.document.name).toBe('B');
    expectFreshAfterOpen('drawing -> part');
  });
});

describe('組立・図面を開く、新規、復元、冷再開も新しい履歴から始まる', () => {
  it('組立(.pcada)を開くと戻れず、選択も空', async () => {
    const gateway = installGateway();
    await editAndSelectPartA(gateway);
    const bundle = createAssemblyDocumentBundle(createAssemblyDocument('組立B'), EMPTY_PART_LIBRARY);
    const bytes = await writeDocumentBundle(bundle);
    expect((await readDocumentBundle(bytes, 'assembly')).ok).toBe(true);
    gateway.next = { name: 'B.pcada', bytes, saveTargetToken: 'B.pcada' };

    await openPart(deps);

    expect(activeDocumentKind(useAppStore.getState())).toBe('assembly');
    expectFreshAfterOpen('open assembly');
  });

  it('図面(.pcadd)を開くと戻れず、選択も空', async () => {
    const gateway = installGateway();
    await editAndSelectPartA(gateway);
    const source = { sourceKind: 'part' as const, document: createEmptyPartDocument() };
    const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(), source, 'src.pcad', '');
    const bytes = await writeDrawingBundle(createDrawingDocument('図面B', embedded.source), { source });
    expect((await readDrawingBundle(bytes)).ok).toBe(true);
    gateway.next = { name: 'B.pcadd', bytes, saveTargetToken: 'B.pcadd' };

    await openPart(deps);

    expect(activeDocumentKind(useAppStore.getState())).toBe('drawing');
    expectFreshAfterOpen('open drawing');
  });

  it('新規は戻れず、選択も空', async () => {
    const gateway = installGateway();
    await editAndSelectPartA(gateway);

    await newPart(deps);

    expectFreshAfterOpen('new');
    expect(gateway.target).toBeNull();
  });

  it('自動保存の控えから復元すると戻れず、選択も空', async () => {
    const gateway = installGateway();
    await editAndSelectPartA(gateway);
    const storage = createMemoryAutoSaveStorage();
    const saver = createAutoSaver({ storage, setTimeout: () => 1, clearTimeout: () => undefined });
    const recovered = partNamed('控え', 7);
    await storage.write({ bytes: writePcadFile(recovered), savedAt: '2026-10-05T00:00:00.000Z',
      documentName: recovered.name });
    useAppStore.getState().setSelection([pointIdOf(recovered)]);

    await restoreAutoSave(saver);

    expect(useAppStore.getState().document.name).toBe('控え');
    expectFreshAfterOpen('restore');
  });

  it('図面だけの冷再開で元の部品へ戻るときも、前の部品の履歴へ戻らない', async () => {
    installGateway();
    useAppStore.getState().applyDocument(partNamed('前の部品', 1));
    useAppStore.getState().applyDocument(partNamed('前の部品', 4));
    expect(useAppStore.getState().canUndo).toBe(true);
    const part = createEmptyPartDocument();
    const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(),
      { sourceKind: 'part', document: part }, 'guide.pcad', '');
    const drawing = createDrawingDocument('保存した図面', embedded.source);
    useAppStore.getState().openDrawing(drawing, { saved: true, sources: embedded.library });
    const opened = useAppStore.getState();
    const session = createParameterTutorialSession(part, opened.documentVersion);
    if (session === null) throw new Error('session missing');
    opened.setTutorialSession(session);
    opened.setTutorialDrawingProof({ document: drawing, sourcePart: part,
      sourceRef: drawing.source.sourceRef, sourceHash: drawing.source.contentHash });

    expect(await closeDrawingWithConfirmation({ confirmDiscard: vi.fn(() => Promise.resolve(true)) },
      { resumeGuidePart: true })).toBe(true);

    const returned = useAppStore.getState();
    expect(returned.drawing).toBeNull();
    expect(returned.document).toBe(part);
    expectFreshAfterOpen('cold resume');
    returned.undo();
    expect(useAppStore.getState().document).toBe(part);
  });
});
