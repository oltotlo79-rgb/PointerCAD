/** 文書・履歴・Undo。useAppStore.test.ts から責務単位で移した回帰テスト。 */

import {
  appearanceFromPreset,
  appearanceOf,
  appendSolid,
  createAssemblyDocument,
  createEmptyPartDocument,
  createEmptySketchDocument,
  EMPTY_PART_LIBRARY,
  removeSolid,
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
