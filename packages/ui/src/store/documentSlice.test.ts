import { prepareDocumentSession, SecurePartIdentityError } from './fileSlice.js';
/** 文書・履歴・Undo。useAppStore.test.ts から責務単位で移した回帰テスト。 */

import {
  allocatePatternPointSlots,
  patternSlotHighWater,
  type PatternFeature,
  appearanceFromPreset,
  appearanceOf,
  appendSolid,
  createAssemblyDocument,
  createEmptyPartDocument,
  createEmptySketchDocument,
  createDrawingDocument,
  embedDrawingSource,
  embedPart,
  emptyDrawingSourceLibrary,
  emptyEmbeddedPartAttachments,
  EMPTY_PART_LIBRARY,
  removeSolid,
  UNDO_LIMIT,
} from '@pointercad/model';
import {
  expressionValueFromNumber,
} from '@pointercad/expression';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  setFeatureField,
} from '../sketch/featureSummary.js';
import {
  attachPartRecompute,
} from './attachKernel.js';
import {
  createInitialDocumentState,
} from './initialDocumentState.js';
import {
  useAppStore,
} from './useAppStore.js';
import { activeDocument } from './documentKind.js';
import { newSketchCanvas } from '../file/canvasFile.js';
import { captureSaveSnapshot, copySaveSnapshot } from '../file/pcadSaveSnapshot.js';
import { encodeSaveDocument, readPcadFile } from '@pointercad/io';
import { documentPatch } from './documentDerived.js';
import {
  resetTestStore,
  createFakeRecompute,
  resultFor,
  sketchResultFor,
  tick,
  documentWithPoint,
  partWithPoint,
  extrudeFeature,
  bodyFor,
} from './testing/createTestStore.js';

beforeEach(resetTestStore);

describe('下絵資産の実履歴による保持と回収', () => {
  function expectAssets(count: number): void {
    const state = useAppStore.getState();
    expect(state.canvases.size).toBe(count);
    expect([...state.canvases.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0)).toBe(count * 2);
    for (const document of [state.document, ...state.undoStack.past, state.undoStack.present, ...state.undoStack.future]) {
      for (const canvas of document.canvases) expect(state.canvases.has(canvas.imageId)).toBe(true);
    }
    expect(state.isComputing).toBe(false);
  }

  it('追加→削除→Undo→Redoを100回行い、実履歴の上限を越えた画像だけを順に回収する', async () => {
    const fake = createFakeRecompute(), detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle(resultFor(fake.calls[0].document)); await tick();
    expect(fake.calls).toHaveLength(1);
    const originals = new Map<string, Uint8Array>();
    for (let cycle = 1; cycle <= 100; cycle += 1) {
      const state = useAppStore.getState();
      const canvas = newSketchCanvas(state.document.canvases, 'xy', `${cycle}.png`, { width: 2, height: 1 }, `asset-${cycle}`);
      const bytes = Uint8Array.of(cycle, 255 - cycle); originals.set(canvas.imageId, bytes);
      state.addCanvas(canvas, bytes); expectAssets(cycle);
      expect(useAppStore.getState().undoStack.past).toHaveLength(cycle * 2 - 1);
      state.removeCanvas(canvas.id); expectAssets(cycle);
      expect(useAppStore.getState().undoStack.past).toHaveLength(cycle * 2);
      state.undo(); expectAssets(cycle);
      expect(useAppStore.getState().undoStack.past).toHaveLength(cycle * 2 - 1);
      expect(useAppStore.getState().undoStack.future).toHaveLength(1);
      expect(useAppStore.getState().document.canvases).toEqual([canvas]);
      expect(useAppStore.getState().canvases.get(canvas.imageId)).toBe(bytes);
      state.redo(); expectAssets(cycle);
      expect(useAppStore.getState().undoStack.past).toHaveLength(cycle * 2);
      expect(useAppStore.getState().undoStack.future).toHaveLength(0);
      expect(useAppStore.getState().document.canvases).toEqual([]);
    }
    expect(useAppStore.getState().undoStack.past).toHaveLength(UNDO_LIMIT);
    const captured = useAppStore.getState().canvases;
    for (let edit = 1; edit <= UNDO_LIMIT; edit += 1) {
      const state = useAppStore.getState();
      state.applyDocument({ ...state.document, name: `later-${edit}` });
      // 各画像を参照する過去の文書は、追加直後の1段だけ。2段ごとに1枚退去する。
      expectAssets(100 - Math.floor(edit / 2));
      expect(useAppStore.getState().undoStack.past).toHaveLength(UNDO_LIMIT);
    }
    expect(captured.size).toBe(100);
    for (const [id, bytes] of originals) expect(captured.get(id)).toBe(bytes);
    const final = useAppStore.getState();
    final.applyDocument({ ...final.document, name: 'after-empty' });
    expect(useAppStore.getState().canvases).toBe(final.canvases);
    expectAssets(0);
    expect(fake.calls).toHaveLength(1); detach();
  });

  it('futureだけが参照する画像をRedoまで保ち、新しい分岐を作った時だけ回収する', () => {
    useAppStore.setState({ isComputing: false });
    const store = useAppStore.getState();
    const a = newSketchCanvas([], 'xy', 'A.png', { width: 2, height: 1 }, 'A');
    const b = newSketchCanvas([], 'xy', 'B.png', { width: 2, height: 1 }, 'B');
    const bytesA = Uint8Array.of(1, 2), bytesB = Uint8Array.of(3, 4);
    store.addCanvas(a, bytesA); store.removeCanvas(a.id);
    store.addCanvas(b, bytesB); store.undo(); expectAssets(2);
    expect(useAppStore.getState().undoStack.future[0].canvases).toEqual([b]);
    store.redo(); expect(useAppStore.getState().canvases.get(b.imageId)).toBe(bytesB);
    store.undo();
    const captured = useAppStore.getState().canvases;
    const c = newSketchCanvas([], 'xy', 'C.png', { width: 2, height: 1 }, 'C');
    const bytesC = Uint8Array.of(5, 6);
    store.addCanvas(c, bytesC); expectAssets(2);
    expect([...useAppStore.getState().canvases.keys()]).toEqual(['A', 'C']);
    expect(useAppStore.getState().undoStack.future).toEqual([]);
    expect(captured.get('B')).toBe(bytesB);
    store.undo(); store.undo(); expectAssets(2);
    expect(useAppStore.getState().document.canvases).toEqual([a]);
    expect(useAppStore.getState().canvases.get('A')).toBe(bytesA);
    store.redo(); store.redo(); expectAssets(2);
    expect(useAppStore.getState().document.canvases).toEqual([c]);
    expect(useAppStore.getState().canvases.get('C')).toBe(bytesC);
  });

  it('回収中も保存が捕捉した旧Mapと原本を保ち、開始済みの保存コピーを実ZIPへ復元できる', async () => {
    const store = useAppStore.getState(), bytes = Uint8Array.of(1, 2);
    const canvas = newSketchCanvas([], 'xy', 'saved.png', { width: 2, height: 1 }, 'saved');
    store.addCanvas(canvas, bytes); store.setCanvasPixelSize(canvas.imageId, { width: 2, height: 1 });
    const before = useAppStore.getState();
    const captured = before.canvases;
    const snapshot = captureSaveSnapshot({ kind: 'part', document: before.document,
      options: { attachments: { ...emptyEmbeddedPartAttachments(), canvases: captured } } });
    const copying = copySaveSnapshot(snapshot);
    store.removeCanvas(canvas.id);
    for (let edit = 0; edit < UNDO_LIMIT; edit += 1) {
      store.applyDocument({ ...useAppStore.getState().document, name: `empty-${edit}` });
    }
    expect(useAppStore.getState().canvases.size).toBe(0);
    expect(useAppStore.getState().canvasImageLoads.size).toBe(0);
    expect(useAppStore.getState().canvasPixelSizes.size).toBe(0);
    expect(captured.get(canvas.imageId)).toBe(bytes);
    const owned = await copying;
    const saved = readPcadFile(await encodeSaveDocument(owned.input));
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error('Captured save was not readable');
    expect(saved.document.canvases).toEqual([canvas]);
    expect(saved.attachments.canvases.get(canvas.imageId)).toEqual(bytes);
    expect(captured.get(canvas.imageId)).toBe(bytes);
    expect(bytes).toEqual(Uint8Array.of(1, 2));
  });

  it.each(['assembly', 'drawing'] as const)('%sの埋込み所有者を仮部品で回収せず、先行添付後の部品差替えも保つ', async mode => {
    const store = useAppStore.getState();
    const canvas = newSketchCanvas([], 'xy', 'embedded.png', { width: 2, height: 1 }, 'canvas-1');
    const oldBytes = Uint8Array.of(1, 2), newBytes = Uint8Array.of(3, 4);
    const embeddedPart = { ...createEmptyPartDocument(), canvases: [canvas] };
    const attachments = { ...emptyEmbeddedPartAttachments(), canvases: new Map([[canvas.imageId, oldBytes]]) };
    const embedded = await embedPart(EMPTY_PART_LIBRARY, embeddedPart, 'embedded.pcad', '', { attachments });
    const source = await embedDrawingSource(emptyDrawingSourceLibrary(), {
      sourceKind: 'part', document: embeddedPart, attachments,
    }, 'embedded.pcad', '');
    if (mode === 'assembly') store.openAssembly(createAssemblyDocument('assembly'), embedded.library);
    else store.openDrawing(createDrawingDocument('drawing', source.source), { sources: source.library });
    store.setCanvasImages(new Map([[canvas.imageId, newBytes]]));
    const before = useAppStore.getState();
    const placeholder = createEmptyPartDocument();
    const patch = documentPatch(before, placeholder, before.undoStack);
    expect(patch.canvases).toBe(before.canvases);
    // 本番の読込順と同じく、添付を先に置き、後から新しいpartを適用する。
    store.applyDocument({ ...placeholder, canvases: [canvas] }, { replacesDocument: true });
    expect(useAppStore.getState().canvases.get(canvas.imageId)).toBe(newBytes);
    expect(embedded.library.attachments.get(embedded.partRef)?.canvases.get(canvas.imageId)).toBe(oldBytes);
    const ownedSource = source.library.sources[0];
    expect(ownedSource.attachments?.canvases.get(canvas.imageId)).toBe(oldBytes);
    expect(before.canvases.get(canvas.imageId)).toBe(newBytes);
  });
});

describe('文書種別による共通入口(P7 タスク11a)', () => {
  it('共通 Undo/Redo はアセンブリだけを戻し、裏の部品履歴と文書IDは保つ', () => {
    const store = useAppStore.getState();
    store.applyDocument(partWithPoint());
    const part = useAppStore.getState().document;
    const partHistory = useAppStore.getState().undoStack;
    const assembly = createAssemblyDocument('assembly');
    store.openAssembly(assembly);
    const before = useAppStore.getState();
    const changed = { ...assembly, name: 'changed' };
    store.applyAssembly(changed);
    expect(useAppStore.getState().canUndo).toBe(true);
    store.undo();
    expect(useAppStore.getState().assembly).toBe(assembly);
    expect(useAppStore.getState().canUndo).toBe(false);
    expect(useAppStore.getState().canRedo).toBe(true);
    store.redo();
    const after = useAppStore.getState();
    expect(after.assembly).toBe(changed);
    expect(after.canUndo).toBe(true);
    expect(after.canRedo).toBe(false);
    expect(after.document).toBe(part);
    expect(after.undoStack).toBe(partHistory);
    expect(after.activeDocumentId).toBe(before.activeDocumentId);
    expect(after.documentVersion).toBe(before.documentVersion + 2);
  });

  it('空のアセンブリの Undo/Redo で裏の部品履歴を動かさない', () => {
    const store = useAppStore.getState();
    store.applyDocument(partWithPoint());
    store.openAssembly(createAssemblyDocument('assembly'));
    const before = useAppStore.getState();
    store.undo();
    store.redo();
    expect(useAppStore.getState()).toBe(before);
  });

  it('アセンブリ中の通常 applyDocument は裏の部品を編集しない', () => {
    const store = useAppStore.getState();
    store.openAssembly(createAssemblyDocument('assembly'));
    const before = useAppStore.getState();
    store.applyDocument(partWithPoint());
    expect(useAppStore.getState()).toBe(before);
  });

  it('部品を開く差し替えは、文書・種別・ID・添付履歴を一度に切り替える', () => {
    const store = useAppStore.getState();
    const assembly = createAssemblyDocument('assembly');
    store.openAssembly(assembly);
    store.applyAssembly({ ...assembly, name: 'edited' });
    store.setAssemblyFileState('assembly.pcada', { document: assembly, library: EMPTY_PART_LIBRARY });
    const before = useAppStore.getState();
    const observed: ReturnType<typeof useAppStore.getState>[] = [];
    const unsubscribe = useAppStore.subscribe((state) => { observed.push(state); });
    const part = partWithPoint();
    try {
      store.applyDocument(part, { replacesDocument: true });
    } finally {
      unsubscribe();
    }
    expect(observed).toHaveLength(1);
    const after = observed[0];
    expect(activeDocument(after).kind).toBe('part');
    expect(after.document).toBe(part);
    expect(after.activeDocumentId).not.toBe(before.activeDocumentId);
    expect(after.documentVersion).toBe(before.documentVersion + 1);
    expect(after.assemblyLibrary).toBe(EMPTY_PART_LIBRARY);
    expect(after.assemblyUndoStack).toBeNull();
    expect(after.savedAssembly).toBeNull();
    expect(after.assemblyFileName).toBeNull();
    expect(after.assemblyView).toBeNull();
    expect(after.undoStack.past.at(-1)).toBe(before.document);
  });

  it('部品の新規はアセンブリの保存先・添付履歴を消し、一度の通知で新文書にする', () => {
    const store = useAppStore.getState();
    store.openAssembly(createAssemblyDocument('assembly'));
    const before = useAppStore.getState();
    const clearSaveTarget = vi.fn();
    useAppStore.setState({ fileGateway: { ...store.fileGateway, clearSaveTarget } });
    const observed: ReturnType<typeof useAppStore.getState>[] = [];
    const unsubscribe = useAppStore.subscribe((state) => { observed.push(state); });
    const part = createEmptyPartDocument();
    try {
      store.resetDocument(part);
    } finally {
      unsubscribe();
      useAppStore.setState({ fileGateway: store.fileGateway });
    }
    expect(clearSaveTarget).toHaveBeenCalledExactlyOnceWith();
    expect(observed).toHaveLength(1);
    const after = observed[0];
    expect(activeDocument(after).kind).toBe('part');
    expect(after.document).toBe(part);
    expect(after.activeDocumentId).not.toBe(before.activeDocumentId);
    expect(after.documentVersion).toBe(before.documentVersion + 1);
    expect(after.assemblyLibrary).toBe(EMPTY_PART_LIBRARY);
    expect(after.assemblyUndoStack).toBeNull();
    expect(after.undoStack.present).toBe(part);
    expect(after.undoStack.past).toEqual([]);
    expect(after.undoStack.future).toEqual([]);
    expect(after.canUndo).toBe(false);
    expect(after.canRedo).toBe(false);
  });

  it('部品の通常編集ではIDを保ち、開く・新規で新しいIDにする', () => {
    const store = useAppStore.getState();
    const first = store.activeDocumentId;
    store.applyDocument(partWithPoint());
    expect(useAppStore.getState().activeDocumentId).toBe(first);
    store.applyDocument(createEmptyPartDocument(), { replacesDocument: true });
    const opened = useAppStore.getState().activeDocumentId;
    expect(opened).not.toBe(first);
    store.resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().activeDocumentId).not.toBe(opened);
  });
});

describe('履歴の差し替えと取り除き(FR-311、FR-504)', () => {
  it('式を直すと履歴が入れ替わる(打つたびの点滅を避けるため計算中の印は立てない)', () => {
    const sketch = documentWithPoint();
    useAppStore.getState().setSketch(sketch);
    useAppStore.getState().applySketch(sketch, sketchResultFor(sketch));

    const target = sketch.features[0];
    useAppStore
      .getState()
      .replaceSketchFeature(
        target.id,
        setFeatureField(target, 'at.x', expressionValueFromNumber(7)),
      );

    const state = useAppStore.getState();
    expect(state.isComputing).toBe(false);
    expect(state.sketch.features).toHaveLength(1);
    const changed = state.sketch.features[0];
    if (changed.kind !== 'point' || changed.at.mode !== 'absolute') {
      throw new Error('絶対座標の点が残るはず');
    }
    expect(changed.at.x.value).toBe(7);
    expect(changed.at.y.value).toBe(2);
  });

  it('取り除くと選択とホバーからも外れる(点列の 1 点を指していても外れる)', () => {
    const sketch = documentWithPoint();
    const id = sketch.features[0].id;
    useAppStore.getState().setSketch(sketch);
    useAppStore.getState().setSelection([`${id}#0`]);
    useAppStore.getState().setHovered(`${id}#0`);

    useAppStore.getState().removeSketchFeature(id);

    const state = useAppStore.getState();
    expect(state.sketch.features).toEqual([]);
    expect(state.selection).toEqual([]);
    expect(state.hoveredElementId).toBeNull();
    expect(state.isComputing).toBe(true);
  });

  it('面を張れなかった理由を持ち、選び直すと消える(NFR-UX-5)', () => {
    useAppStore.getState().setFaceError('face.error.tooFewPoints');
    expect(useAppStore.getState().faceErrorKey).toBe('face.error.tooFewPoints');

    useAppStore.getState().setSelection(['point-1']);
    expect(useAppStore.getState().faceErrorKey).toBeNull();

    useAppStore.getState().setFaceError('face.error.mixedBoundary');
    useAppStore.getState().toggleSelection('line-1');
    expect(useAppStore.getState().faceErrorKey).toBeNull();
  });

  it('ビューポートへ焦点を戻す要求を数える(道具を選んだ直後の Enter に使う)', () => {
    expect(useAppStore.getState().focusViewportRequestCount).toBe(0);
    useAppStore.getState().requestViewportFocus();
    useAppStore.getState().requestViewportFocus();
    expect(useAppStore.getState().focusViewportRequestCount).toBe(2);
  });
});

describe('Undo / Redo(FR-505、§0.a-0.13)', () => {
  it('元に戻すと文書も控えも前の版へ戻り、やり直すと元へ進む', () => {
    const first = useAppStore.getState().document;
    const second = partWithPoint();
    useAppStore.getState().applyDocument(second);

    useAppStore.getState().undo();
    let state = useAppStore.getState();
    expect(state.document).toBe(first);
    expect(state.sketch).toBe(first.sketches[0]);
    expect(state.sketch.features).toEqual([]);
    expect(state.featureNames).toEqual([]);
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(true);

    useAppStore.getState().redo();
    state = useAppStore.getState();
    expect(state.document).toBe(second);
    expect(state.sketch).toBe(second.sketches[0]);
    expect(state.featureNames).toEqual(['点1']);
    expect(state.canUndo).toBe(true);
    expect(state.canRedo).toBe(false);
  });

  it('戻せる版が無ければ何も起きない(例外にしない)', () => {
    const before = useAppStore.getState().document;
    useAppStore.getState().undo();
    useAppStore.getState().redo();
    expect(useAppStore.getState().document).toBe(before);
    expect(useAppStore.getState().canUndo).toBe(false);
    expect(useAppStore.getState().canRedo).toBe(false);
  });

  it('同じ欄への連続した変更は 1 段にまとめる(プロパティ欄の 1 文字ごと)', () => {
    const sketch = documentWithPoint();
    useAppStore.getState().setSketch(sketch);
    expect(useAppStore.getState().undoStack.past).toHaveLength(1);

    const target = sketch.features[0];
    for (const value of [4, 5, 6]) {
      const current = useAppStore.getState().sketch.features[0];
      useAppStore
        .getState()
        .replaceSketchFeature(
          target.id,
          setFeatureField(current, 'at.x', expressionValueFromNumber(value)),
        );
    }

    // 3 回打っても段は 1 つしか増えない(束ねる、§0.a-0.13)。
    expect(useAppStore.getState().undoStack.past).toHaveLength(2);

    useAppStore.getState().undo();
    const undone = useAppStore.getState().sketch.features[0];
    if (undone.kind !== 'point' || undone.at.mode !== 'absolute') {
      throw new Error('絶対座標の点が残るはず');
    }
    // 束ねた 3 回ぶんがまとめて戻り、打ち始める前の値に戻る。
    expect(undone.at.x.value).toBe(1);
  });

  it('鍵の無い変更は必ず別の段になる', () => {
    useAppStore.getState().setSketch(documentWithPoint());
    useAppStore.getState().setSketch(createEmptySketchDocument());
    expect(useAppStore.getState().undoStack.past).toHaveLength(2);
  });
});

describe('documentVersion(プロパティ欄の下書きを捨てる判定、docs/報告記録.md 2026-09-04 14:05 の 9b)', () => {
  it('起動直後は 0', () => {
    expect(useAppStore.getState().documentVersion).toBe(0);
  });

  it('プロパティ欄の 1 文字ずつの反映(coalesceKey あり)では進まない', () => {
    useAppStore.getState().setSketch(documentWithPoint());
    const before = useAppStore.getState().documentVersion;

    const target = useAppStore.getState().sketch.features[0];
    for (const value of [4, 5, 6]) {
      const current = useAppStore.getState().sketch.features[0];
      useAppStore
        .getState()
        .replaceSketchFeature(
          target.id,
          setFeatureField(current, 'at.x', expressionValueFromNumber(value)),
        );
    }
    expect(useAppStore.getState().documentVersion).toBe(before);
  });

  it('普通の applyDocument(新しい要素の追加など)では進まない', () => {
    const before = useAppStore.getState().documentVersion;
    useAppStore.getState().applyDocument(partWithPoint());
    expect(useAppStore.getState().documentVersion).toBe(before);
  });

  it('replacesDocument: true を渡すと進む(開くファイルの読み込みと同じ扱い)', () => {
    const before = useAppStore.getState().documentVersion;
    useAppStore.getState().applyDocument(partWithPoint(), { replacesDocument: true });
    expect(useAppStore.getState().documentVersion).toBe(before + 1);
  });

  it('undo / redo で進む(時をまたぐ差し替えなので下書きを信用しない)', () => {
    useAppStore.getState().applyDocument(partWithPoint());
    const afterApply = useAppStore.getState().documentVersion;

    useAppStore.getState().undo();
    expect(useAppStore.getState().documentVersion).toBe(afterApply + 1);

    useAppStore.getState().redo();
    expect(useAppStore.getState().documentVersion).toBe(afterApply + 2);
  });

  it('戻せる段が無い undo / redo は何も起きないので進まない', () => {
    const before = useAppStore.getState().documentVersion;
    useAppStore.getState().undo();
    useAppStore.getState().redo();
    expect(useAppStore.getState().documentVersion).toBe(before);
  });

  it('resetDocument(新規・復元)で進む', () => {
    const before = useAppStore.getState().documentVersion;
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().documentVersion).toBe(before + 1);
  });

  it('同じ文書を入れ直しても(何も変わらないとき)進まない', () => {
    const before = useAppStore.getState().document;
    const beforeVersion = useAppStore.getState().documentVersion;
    useAppStore.getState().applyDocument(before, { replacesDocument: true });
    expect(useAppStore.getState().documentVersion).toBe(beforeVersion);
  });
});

describe('外観の口(FR-1106〜1110、P5 タスク11)', () => {
  const steel = appearanceFromPreset('steel');
  const glass = appearanceFromPreset('glass');

  /** 押し出し 1 段とそのボディが画面に出ている状態にする。 */
  function withSolidBody(): void {
    useAppStore.setState({
      ...createInitialDocumentState(),
      document: appendSolid(partWithPoint(), extrudeFeature('extrude-1')),
      bodies: [bodyFor('extrude-1')],
    });
  }

  it('立体を選んで割り当てると、割り当てが 1 件できる', () => {
    withSolidBody();
    useAppStore.getState().setSelection(['extrude-1']);
    useAppStore.getState().assignAppearance(steel);

    const entries = appearanceOf(useAppStore.getState().document).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].target).toEqual({ kind: 'body', bodyFeatureId: 'extrude-1' });
    expect(useAppStore.getState().appearanceErrorKey).toBeNull();
  });

  it('外観の割り当ては再計算も計算中の札も起こさない(§2.3 の要)', async () => {
    withSolidBody();
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();
    expect(fake.calls).toHaveLength(1);

    useAppStore.getState().setSelection(['extrude-1']);
    useAppStore.getState().assignAppearance(steel);

    expect(fake.calls).toHaveLength(1);
    expect(useAppStore.getState().isComputing).toBe(false);
    detach();
  });

  it('取り消し 1 回で外観が消える(FR-505)', () => {
    withSolidBody();
    useAppStore.getState().setSelection(['extrude-1']);
    useAppStore.getState().assignAppearance(steel);
    useAppStore.getState().undo();

    expect(appearanceOf(useAppStore.getState().document).entries).toEqual([]);
  });

  it('何も選ばずに割り当てると断り、文書は 1 バイトも変わらない(NFR-UX-5)', () => {
    withSolidBody();
    const before = useAppStore.getState().document;
    useAppStore.getState().assignAppearance(steel);

    expect(useAppStore.getState().appearanceErrorKey).toBe('appearanceError.noTarget');
    expect(useAppStore.getState().document).toBe(before);
  });

  it('選び直すと外観の断りは消える', () => {
    withSolidBody();
    useAppStore.getState().assignAppearance(steel);
    expect(useAppStore.getState().appearanceErrorKey).not.toBeNull();

    useAppStore.getState().setSelection(['extrude-1']);
    expect(useAppStore.getState().appearanceErrorKey).toBeNull();
  });

  it('割り当てを 1 つ外す(FR-1110)', () => {
    withSolidBody();
    useAppStore.getState().setSelection(['extrude-1']);
    useAppStore.getState().assignAppearance(steel);
    const id = appearanceOf(useAppStore.getState().document).entries[0].id;

    useAppStore.getState().removeAppearance(id);
    expect(appearanceOf(useAppStore.getState().document).entries).toEqual([]);
  });

  it('すべて既定に戻す(FR-1110)', () => {
    withSolidBody();
    useAppStore.getState().setSelection(['extrude-1']);
    useAppStore.getState().assignAppearance(steel);
    useAppStore.getState().setSelection([]);
    useAppStore.getState().clearAppearance();

    expect(appearanceOf(useAppStore.getState().document).entries).toEqual([]);
  });

  it('上流のフィーチャーを消すと、その立体を指す割り当ても消える', () => {
    withSolidBody();
    useAppStore.getState().setSelection(['extrude-1']);
    useAppStore.getState().assignAppearance(glass);
    expect(appearanceOf(useAppStore.getState().document).entries).toHaveLength(1);

    useAppStore
      .getState()
      .applyDocument(removeSolid(useAppStore.getState().document, 'extrude-1'));

    expect(appearanceOf(useAppStore.getState().document).entries).toEqual([]);
  });

  it('抑制(一時的に外す)では割り当てを消さない(戻したときに色が失われないため)', () => {
    withSolidBody();
    useAppStore.getState().setSelection(['extrude-1']);
    useAppStore.getState().assignAppearance(glass);

    const document = useAppStore.getState().document;
    const suppressed = {
      ...document,
      solids: document.solids.map((solid) =>
        solid.id === 'extrude-1' ? { ...solid, suppressed: true } : solid,
      ),
    };
    useAppStore.getState().applyDocument(suppressed);

    expect(appearanceOf(useAppStore.getState().document).entries).toHaveLength(1);
  });
});

describe('point-pattern issuance survives actual store Undo and branch changes', () => {
  it('restores history without reissuing deleted slots on the new branch', () => {
    const initial = useAppStore.getState().document;
    useAppStore.getState().applyDocument({ ...initial, name: 'issued', patternSlotHighWater: { pattern: 5 } });
    useAppStore.getState().undo();
    const undone = useAppStore.getState();
    expect(undone.document.name).toBe(initial.name);
    expect(undone.document.patternSlotHighWater?.pattern).toBe(5);
    expect(undone.undoStack.present).toBe(undone.document);
    useAppStore.getState().redo();
    expect(useAppStore.getState().document.name).toBe('issued');
    useAppStore.getState().undo();
    const restored = useAppStore.getState().document;
    const feature: PatternFeature = { id: 'pattern', name: 'branch pattern', kind: 'pattern', suppressed: false,
      sourceFeatureId: 'source-hole', placement: allocatePatternPointSlots([{ kind: 'origin' }],
        undefined, undefined, patternSlotHighWater(restored, 'pattern')) };
    useAppStore.getState().applyDocument(appendSolid(restored, feature));
    const branch = useAppStore.getState();
    const pattern = branch.document.solids.find((solid) => solid.id === 'pattern');
    if (pattern?.kind !== 'pattern' || pattern.placement.kind !== 'points') throw new Error('Missing branch pattern');
    expect(pattern.placement.points.map((slot) => slot.slotId)).toEqual(['slot-5']);
    expect(branch.document.patternSlotHighWater?.pattern).toBe(6);
    expect(branch.undoStack.present).toBe(branch.document);
    expect(branch.canRedo).toBe(false);
  });

  it('does not transfer a ledger through the explicit new/open document boundary', () => {
    const document = useAppStore.getState().document;
    useAppStore.getState().applyDocument({ ...document, patternSlotHighWater: { removed: 12 } });
    const fresh = createEmptyPartDocument();
    useAppStore.getState().applyDocument(fresh, { replacesDocument: true });
    expect(useAppStore.getState().document.patternSlotHighWater).toBeUndefined();
    expect(useAppStore.getState().undoStack.present).toBe(useAppStore.getState().document);
  });
});

describe('persisted lineage identity at actual startup', () => {
  it('independent startup documents have unique tagged IDs and unchanged empty content', () => {
    const first = createInitialDocumentState().document;
    const second = createInitialDocumentState().document;
    const format = /^part-uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(first.id).toMatch(format);
    expect(second.id).toMatch(format);
    expect(second.id).not.toBe(first.id);
    expect(first).toEqual({ ...createEmptyPartDocument(), id: first.id });
    expect(second).toEqual({ ...createEmptyPartDocument(), id: second.id });
  });

  it('actual load/reset and edit Undo/Redo retain both legacy and tagged IDs', () => {
    for (const id of ['part-1', 'part-uuid:086963bc-1dbd-4a51-a603-ae34317c05c3']) {
      const source = { ...createEmptyPartDocument(), id, name: 'Opened source' };
      useAppStore.getState().resetDocument(source);
      expect(useAppStore.getState().document).toBe(source);
      useAppStore.getState().applyDocument({ ...source, name: 'Edited source' });
      expect(useAppStore.getState().document.id).toBe(id);
      useAppStore.getState().undo();
      expect(useAppStore.getState().document).toEqual(source);
      useAppStore.getState().redo();
      expect(useAppStore.getState().document).toEqual({ ...source, name: 'Edited source' });
    }
  });
});

describe('secure entropy fallback at actual startup', () => {
  it('missing randomUUID uses real getRandomValues and preserves full empty documents', () => {
    const entropy = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: entropy.getRandomValues.bind(entropy) });
    try {
      const first = createInitialDocumentState().document;
      const second = createInitialDocumentState().document;
      const format = /^part-uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(first.id).toMatch(format);
      expect(second.id).toMatch(format);
      expect(second.id).not.toBe(first.id);
      expect(first).toEqual({ ...createEmptyPartDocument(), id: first.id });
      expect(second).toEqual({ ...createEmptyPartDocument(), id: second.id });
    } finally { vi.unstubAllGlobals(); }
  });
  it('missing secure entropy fails explicitly and cannot replace the current document', () => {
    const before = useAppStore.getState().document;
    vi.stubGlobal('crypto', {});
    try {
      expect(() => createInitialDocumentState()).toThrow('Secure document identity is unavailable');
      expect(useAppStore.getState().document).toBe(before);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('atomic part session before real reset', () => {
  it('missing entropy leaves the complete old assembly owner, history, target and runtime untouched', () => {
    useAppStore.getState().openAssembly(createAssemblyDocument('Old assembly'));
    const next = createEmptyPartDocument();
    const clearSaveTarget = vi.fn();
    useAppStore.setState({ fileGateway: { ...useAppStore.getState().fileGateway,
      hasSaveTarget: () => true, clearSaveTarget } });
    const before = useAppStore.getState();
    vi.stubGlobal('crypto', {});
    try {
      expect(() => before.resetDocument(next)).toThrow(SecurePartIdentityError);
      expect(clearSaveTarget).not.toHaveBeenCalled();
      expect(useAppStore.getState()).toBe(before);
      expect(useAppStore.getState()).toEqual(before);
      expect(useAppStore.getState().fileGateway.hasSaveTarget()).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  it('prepared reset keeps loaded legacy lineage and commits the exact prepared session without entropy', () => {
    const next = { ...createEmptyPartDocument(), id: 'part-1', name: 'Actual loaded lineage' };
    const session = prepareDocumentSession();
    vi.stubGlobal('crypto', {});
    try {
      useAppStore.getState().resetDocument(next, session);
      expect(useAppStore.getState().document).toBe(next);
      expect(useAppStore.getState().document).toEqual(next);
      expect(useAppStore.getState().activeDocumentId).toBe(session.id);
      expect(useAppStore.getState().undoStack.present).toBe(next);
    } finally { vi.unstubAllGlobals(); }
  });
});
