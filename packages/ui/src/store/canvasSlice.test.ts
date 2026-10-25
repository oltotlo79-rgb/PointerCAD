/** 下絵画像。useAppStore.test.ts から責務単位で移した回帰テスト。 */

import {
  CANVAS_SAME_POINT_MESSAGE,
  createEmptyPartDocument,
  type PartDocument,
  type SketchCanvas,
} from '@pointercad/model';
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  newSketchCanvas,
} from '../file/canvasFile.js';
import { loadedCanvasImages } from '../file/loadedCanvasImages.js';
import { emptyPcadAttachments } from '@pointercad/io';
import type { CanvasImageLoad } from '../sketch/canvasActionState.js';
import {
  useAppStore,
} from './useAppStore.js';
import {
  resetTestStore,
} from './testing/createTestStore.js';

beforeEach(resetTestStore);

describe('異なる部品を開いた後の画像所有', () => {
  it('同じ旧画像番号を持つ別部品へ切り替えてUndoしても元の画像バイトへ戻る', () => {
    const canvas = newSketchCanvas([], 'xy', 'legacy.png', { width: 2, height: 1 }, 'canvas-1');
    const a = { ...createEmptyPartDocument(), name: 'A', canvases: [canvas] };
    const b = { ...createEmptyPartDocument(), name: 'B', canvases: [{ ...canvas, name: 'B.png' }] };
    const bytesA = Uint8Array.of(1, 2), bytesB = Uint8Array.of(3, 4);
    const store = useAppStore.getState();
    store.setCanvasImages(new Map([[canvas.imageId, bytesA]]));
    store.applyDocument(a, { replacesDocument: true });
    const original = useAppStore.getState().canvases;
    const loaded = loadedCanvasImages(b, { ...emptyPcadAttachments(), canvases: new Map([[canvas.imageId, bytesB]]) }, original,
      () => 'image-B');
    store.setCanvasImages(loaded.attachments.canvases);
    store.applyDocument(loaded.document, { replacesDocument: true });
    store.undo();
    const restored = useAppStore.getState();
    expect(restored.document.name).toBe('A');
    expect(restored.canvases.get(restored.document.canvases[0].imageId)).toBe(bytesA);
    expect(original.get(canvas.imageId)).toBe(bytesA);
  });
});

describe('下絵の画像(FR-332、P6 タスク39)', () => {
  it('存在しない下絵の寸法合わせを開始せず、履歴を変えない', () => {
    const before = useAppStore.getState();
    before.startCanvasScale('gone');
    expect(useAppStore.getState().canvasScale).toBeNull();
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
  });

  it('範囲外の濃さを確定せず、文書と履歴を保つ', () => {
    useAppStore.getState().addCanvas(sampleCanvas(), Uint8Array.of(1));
    const before = useAppStore.getState();
    before.setCanvasOpacity('canvas-1', 1.1);
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
  });
  /** 800×600 画素の下絵 1 枚と、その画像のバイト列(中身は見ない)。 */
  function sampleCanvas(): SketchCanvas {
    return newSketchCanvas([], 'xy', '間取り.png', { width: 800, height: 600 }, 'canvas-1');
  }
  function addReadyCanvas(): void {
    useAppStore.getState().addCanvas(sampleCanvas(), Uint8Array.of(1));
    useAppStore.getState().setCanvasPixelSize('canvas-1', { width: 800, height: 600 });
  }

  it('既に保持する画像番号を再追加しても元画像と履歴を上書きしない', () => {
    const canvas = sampleCanvas();
    const original = Uint8Array.of(1, 2, 3);
    useAppStore.getState().addCanvas(canvas, original);
    useAppStore.getState().removeCanvas(canvas.id);
    const before = useAppStore.getState();
    useAppStore.getState().addCanvas({ ...canvas, name: 'B.png' }, Uint8Array.of(9));
    const after = useAppStore.getState();
    expect(after.canvases.get(canvas.imageId)).toBe(original);
    expect(after.document).toBe(before.document);
    expect(after.undoStack).toBe(before.undoStack);
    expect(after.canvasMessage).not.toBeNull();
    after.undo(); expect(useAppStore.getState().document.canvases).toEqual([canvas]);
  });

  it('画像の差替えで古い画素寸法を消し、同じ寸法と削除の再通知は起こさない', () => {
    useAppStore.getState().setCanvasPixelSize('canvas-1', { width: 100, height: 50 });
    useAppStore.getState().setCanvasImages(new Map([['canvas-1', Uint8Array.of(1)]]));
    expect(useAppStore.getState().canvasPixelSizes.size).toBe(0);
    let notices = 0;
    const unsubscribe = useAppStore.subscribe(() => { notices += 1; });
    useAppStore.getState().setCanvasPixelSize('canvas-1', { width: 100, height: 50 });
    useAppStore.getState().setCanvasPixelSize('canvas-1', { width: 100, height: 50 });
    useAppStore.getState().removeCanvasPixelSize('canvas-1');
    useAppStore.getState().removeCanvasPixelSize('canvas-1');
    unsubscribe(); expect(notices).toBe(2);
  });

  it('起動直後は 1 枚も持たない(文書も画像の表も空)', () => {
    expect(useAppStore.getState().document.canvases).toEqual([]);
    expect(useAppStore.getState().canvases.size).toBe(0);
  });

  it('足すと文書に 1 枚入り、画像のバイト列は添付の表へ入る', () => {
    const canvas = sampleCanvas();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    useAppStore.getState().addCanvas(canvas, bytes);

    const state = useAppStore.getState();
    expect(state.document.canvases.map((item) => item.id)).toEqual(['canvas-1']);
    // 文書には id と寸法だけ(バイト列は入らない)。
    expect(state.canvases.get('canvas-1')).toBe(bytes);
    expect(state.document.canvases[0].width.value).toBe(100);
    expect(state.document.canvases[0].height.value).toBeCloseTo(75, 9);
  });

  it('下絵の入切で再計算が走らない(§2.14。`affectsShape` が偽)', () => {
    useAppStore.getState().addCanvas(sampleCanvas(), new Uint8Array([1]));
    // 足した直後の札を落としてから確かめる(立てたのは足した操作ではないことも含めて見る)。
    useAppStore.setState({ isComputing: false });

    useAppStore.getState().setCanvasVisible('canvas-1', false);
    expect(useAppStore.getState().document.canvases[0].visible).toBe(false);
    // **ここが本題**: 下絵は材料にならないので計算中の札が立たない。
    expect(useAppStore.getState().isComputing).toBe(false);

    useAppStore.getState().setCanvasVisible('canvas-1', true);
    expect(useAppStore.getState().isComputing).toBe(false);
  });

  it('不透明度・寸法合わせでも再計算は走らない', () => {
    addReadyCanvas();
    useAppStore.setState({ isComputing: false });

    useAppStore.getState().setCanvasOpacity('canvas-1', 0.25);
    expect(useAppStore.getState().document.canvases[0].opacity.value).toBe(0.25);
    expect(useAppStore.getState().isComputing).toBe(false);

    useAppStore.getState().startCanvasScale('canvas-1');
    // 画像の左上と右下(幅 100mm・高さ 75mm の下絵)。
    useAppStore.getState().addCanvasScalePoint([-50, 37.5]);
    useAppStore.getState().addCanvasScalePoint([50, 37.5]);
    expect(
      useAppStore.getState().applyCanvasScale(200, { width: 800, height: 600 }),
    ).toBe(true);
    // 800 画素を 200mm にしたので縮尺 0.25、幅は 200mm・高さは 150mm。
    expect(useAppStore.getState().document.canvases[0].width.value).toBeCloseTo(200, 9);
    expect(useAppStore.getState().document.canvases[0].height.value).toBeCloseTo(150, 9);
    expect(useAppStore.getState().isComputing).toBe(false);
    // 合わせ終わったら欄は畳む。
    expect(useAppStore.getState().canvasScale).toBeNull();
  });

  it('不透明度の範囲外は補正せず拒否し、0と1は確定できる', () => {
    useAppStore.getState().addCanvas(sampleCanvas(), new Uint8Array([1]));
    useAppStore.getState().setCanvasOpacity('canvas-1', 5);
    expect(useAppStore.getState().document.canvases[0].opacity.value).toBe(0.5);
    useAppStore.getState().setCanvasOpacity('canvas-1', -2);
    expect(useAppStore.getState().document.canvases[0].opacity.value).toBe(0.5);
    useAppStore.getState().setCanvasOpacity('canvas-1', 1);
    expect(useAppStore.getState().document.canvases[0].opacity.value).toBe(1);
    useAppStore.getState().setCanvasOpacity('canvas-1', 0);
    expect(useAppStore.getState().document.canvases[0].opacity.value).toBe(0);
  });

  it('2 点が同じ位置なら断り、文言は model のものをそのまま出す(§2.14)', () => {
    addReadyCanvas();
    useAppStore.getState().startCanvasScale('canvas-1');
    useAppStore.getState().addCanvasScalePoint([0, 0]);
    useAppStore.getState().addCanvasScalePoint([0, 0]);

    expect(useAppStore.getState().applyCanvasScale(50, { width: 800, height: 600 })).toBe(false);
    expect(useAppStore.getState().canvasMessage).toBe(CANVAS_SAME_POINT_MESSAGE);
    // 断られても欄は開いたままで、指し直せる。
    expect(useAppStore.getState().canvasScale).not.toBeNull();
  });

  it('3 点目を指すと 1 点目を捨てて詰める(やり直しのために止めない)', () => {
    addReadyCanvas();
    useAppStore.getState().startCanvasScale('canvas-1');
    useAppStore.getState().addCanvasScalePoint([1, 1]);
    useAppStore.getState().addCanvasScalePoint([2, 2]);
    useAppStore.getState().addCanvasScalePoint([3, 3]);
    expect(useAppStore.getState().canvasScale?.points).toEqual([
      [2, 2],
      [3, 3],
    ]);
  });

  it('四隅は確定まで文書/Undoを変えず、適用1段とUndo/Redoでも元画像byteを保つ', () => {
    addReadyCanvas();
    const original = useAppStore.getState();
    const bytes = original.canvases.get('canvas-1');
    original.startCanvasRectification('canvas-1');
    const corners = [[0.1, 0.1], [0.9, 0.12], [0.8, 0.8], [0.15, 0.9]] as const;
    for (const point of corners) useAppStore.getState().addCanvasRectificationPoint(point);
    expect(useAppStore.getState().document).toBe(original.document);
    expect(useAppStore.getState().undoStack).toBe(original.undoStack);
    expect(useAppStore.getState().applyCanvasRectification()).toBe(true);
    const applied = useAppStore.getState();
    expect(applied.document.canvases[0].rectification?.sourceQuad).toEqual(corners);
    expect(applied.undoStack.past).toHaveLength(original.undoStack.past.length + 1);
    expect(applied.canvases.get('canvas-1')).toBe(bytes);
    applied.undo();
    expect(useAppStore.getState().document.canvases[0].rectification).toBeUndefined();
    useAppStore.getState().redo();
    expect(useAppStore.getState().document.canvases[0].rectification?.sourceQuad).toEqual(corners);
    expect(useAppStore.getState().canvases.get('canvas-1')).toBe(bytes);
    expect(useAppStore.getState().clearCanvasRectification('canvas-1')).toBe(true);
    expect(useAppStore.getState().document.canvases[0].rectification).toBeUndefined();
    useAppStore.getState().undo();
    expect(useAppStore.getState().document.canvases[0].rectification?.sourceQuad).toEqual(corners);
    expect(useAppStore.getState().canvases.get('canvas-1')).toBe(bytes);
  });

  it('交差する四隅と取消は文書/Undoを変えず、2点寸法と同時には始めない', () => {
    addReadyCanvas();
    useAppStore.getState().startCanvasScale('canvas-1');
    useAppStore.getState().startCanvasRectification('canvas-1');
    expect(useAppStore.getState().canvasScale).toBeNull();
    const before = useAppStore.getState();
    for (const point of [[0.1, 0.1], [0.9, 0.9], [0.9, 0.1], [0.1, 0.9]] as const) {
      useAppStore.getState().addCanvasRectificationPoint(point);
    }
    expect(useAppStore.getState().applyCanvasRectification()).toBe(false);
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    useAppStore.getState().cancelCanvasRectification();
    expect(useAppStore.getState().canvasRectification).toBeNull();
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    useAppStore.getState().startCanvasRectification('canvas-1');
    useAppStore.getState().startCanvasScale('canvas-1');
    expect(useAppStore.getState().canvasRectification).toBeNull();
  });

  it('画像読込要求の差替えと文書の作り直しは古い四隅を確定させない', () => {
    addReadyCanvas();
    useAppStore.getState().startCanvasRectification('canvas-1');
    const before = useAppStore.getState();
    const bytes = before.canvases.get('canvas-1');
    if (bytes === undefined) throw new Error('fixture image missing');
    const loading: CanvasImageLoad = { documentId: before.activeDocumentId,
      bytes, request: {}, status: 'loading' };
    before.setCanvasImageLoad('canvas-1', loading, loading);
    expect(useAppStore.getState().canvasRectification).toBeNull();
    expect(useAppStore.getState().applyCanvasRectification()).toBe(false);
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().canvasRectification).toBeNull();
  });

  it('画像byteの差替え・同じcanvas番号の別画像・削除後の古い四隅を採用しない', () => {
    addReadyCanvas();
    const original = useAppStore.getState();
    original.startCanvasRectification('canvas-1');
    for (const point of [[0.1, 0.1], [0.9, 0.1], [0.8, 0.8], [0.1, 0.9]] as const) {
      useAppStore.getState().addCanvasRectificationPoint(point);
    }
    const stale = useAppStore.getState().canvasRectification;
    if (stale === null) throw new Error('fixture rectification missing');
    useAppStore.getState().setCanvasImages(new Map([['canvas-1', Uint8Array.of(9)]]));
    useAppStore.setState({ canvasRectification: stale });
    const changedBytes = useAppStore.getState();
    expect(changedBytes.applyCanvasRectification()).toBe(false);
    expect(useAppStore.getState().document).toBe(changedBytes.document);
    expect(useAppStore.getState().undoStack).toBe(changedBytes.undoStack);

    useAppStore.getState().removeCanvas('canvas-1');
    useAppStore.setState({ canvasRectification: stale });
    const removed = useAppStore.getState();
    expect(removed.applyCanvasRectification()).toBe(false);
    expect(useAppStore.getState().document).toBe(removed.document);
    expect(useAppStore.getState().undoStack).toBe(removed.undoStack);

    useAppStore.getState().addCanvas({ ...sampleCanvas(), imageId: 'replacement' }, Uint8Array.of(7));
    useAppStore.getState().setCanvasPixelSize('replacement', { width: 800, height: 600 });
    useAppStore.setState({ canvasRectification: stale });
    const replacement = useAppStore.getState();
    expect(replacement.applyCanvasRectification()).toBe(false);
    expect(useAppStore.getState().document).toBe(replacement.document);
    expect(useAppStore.getState().undoStack).toBe(replacement.undoStack);
  });

  it('消しても画像のバイト列は残す(取り消しで戻せるようにするため)', () => {
    useAppStore.getState().addCanvas(sampleCanvas(), new Uint8Array([1]));
    useAppStore.getState().removeCanvas('canvas-1');
    expect(useAppStore.getState().document.canvases).toEqual([]);
    expect(useAppStore.getState().canvases.get('canvas-1')).toBeDefined();

    useAppStore.getState().undo();
    expect(useAppStore.getState().document.canvases.map((item) => item.id)).toEqual(['canvas-1']);
  });

  it('新規(文書の作り直し)では画像も寸法合わせも持ち越さない', () => {
    addReadyCanvas();
    useAppStore.getState().startCanvasScale('canvas-1');
    useAppStore.getState().resetDocument(createEmptyPartDocument());

    expect(useAppStore.getState().document.canvases).toEqual([]);
    expect(useAppStore.getState().canvases.size).toBe(0);
    expect(useAppStore.getState().canvasScale).toBeNull();
  });

  it('開いた部品の画像は表ごと入れ直す(`packages/io` の添付から)', () => {
    useAppStore.getState().setCanvasImages(new Map([['canvas-7', new Uint8Array([9])]]));
    expect(useAppStore.getState().canvases.get('canvas-7')).toEqual(new Uint8Array([9]));
  });

  it('開くと下絵の画像が復活する(添付を入れてから文書を差し替える順序)', () => {
    // 開く前の部品にも下絵が 1 枚ある(前の部品の画像が残らないことも一緒に見る)。
    useAppStore.getState().addCanvas(sampleCanvas(), new Uint8Array([1]));

    /*
     * `file/partFile.ts` の「開く」と同じ順序: **添付を入れ直してから**文書を差し替える。
     * `applyDocument`(丸ごとの差し替え)は添付の表を空にしないので、この順序でも
     * 画像は残る。逆に `resetDocument`(新規・復元)は空にするので、あちらは後から
     * 入れ直す(下の検査。ストアの `resetDocument` の注釈と同じ約束、P6 タスク39)。
     */
    const opened: PartDocument = { ...createEmptyPartDocument(), canvases: [sampleCanvas()] };
    useAppStore.getState().setCanvasImages(new Map([['canvas-1', new Uint8Array([9])]]));
    useAppStore.getState().applyDocument(opened, { replacesDocument: true });

    const state = useAppStore.getState();
    expect(state.document.canvases.map((item) => item.id)).toEqual(['canvas-1']);
    expect(state.canvases.get('canvas-1')).toEqual(new Uint8Array([9]));
  });

  it('復元(作り直し)でも、後から入れ直せば下絵の画像が復活する', () => {
    // `file/attachAutoSave.ts` の順序: `resetDocument` の後に `setCanvasImages`。
    const restored: PartDocument = { ...createEmptyPartDocument(), canvases: [sampleCanvas()] };
    useAppStore.getState().resetDocument(restored);
    expect(useAppStore.getState().canvases.size).toBe(0);

    useAppStore.getState().setCanvasImages(new Map([['canvas-1', new Uint8Array([9])]]));
    expect(useAppStore.getState().canvases.get('canvas-1')).toEqual(new Uint8Array([9]));
  });

  it('画素の大きさは控えるが、同じ値を入れ直しても表を作り直さない(NFR-PF-1)', () => {
    useAppStore.getState().setCanvasPixelSize('canvas-1', { width: 800, height: 600 });
    const first = useAppStore.getState().canvasPixelSizes;
    expect(first.get('canvas-1')).toEqual({ width: 800, height: 600 });
    useAppStore.getState().setCanvasPixelSize('canvas-1', { width: 800, height: 600 });
    expect(useAppStore.getState().canvasPixelSizes).toBe(first);
  });
});

/* ===== P6 タスク32: 読み込んだ形の添付(FR-802、§0.a-0.9・0.24) ===== */

describe('下絵の追加・削除を100回繰り返した後の画像資産(R02)', () => {
  /** 履歴(過去・現在・未来)の文書が指す画像番号の集合。 */
  function referencedImageIds(): Set<string> {
    const { undoStack } = useAppStore.getState();
    return new Set([...undoStack.past, undoStack.present, ...undoStack.future]
      .flatMap((document) => document.canvases.map((canvas) => canvas.imageId)));
  }

  it('履歴の外の資産の保持が0、履歴の内の消失が0で、Undo/Redoでも元のバイトへ戻る', () => {
    const bytesById = new Map<string, Uint8Array>();
    for (let cycle = 0; cycle < 100; cycle += 1) {
      const imageId = `cycle-${cycle}`, bytes = Uint8Array.of(cycle, cycle + 1);
      const canvas = newSketchCanvas([], 'xy', `${imageId}.png`, { width: 2, height: 1 }, imageId);
      bytesById.set(imageId, bytes);
      useAppStore.getState().addCanvas(canvas, bytes);
      useAppStore.getState().removeCanvas(canvas.id);
      const held = new Set(useAppStore.getState().canvases.keys()), referenced = referencedImageIds();
      // 履歴の外の資産の保持は0。
      expect([...held].filter((id) => !referenced.has(id))).toEqual([]);
      // 履歴の内の消失は0。
      expect([...referenced].filter((id) => !held.has(id))).toEqual([]);
      for (const id of held) expect(useAppStore.getState().canvases.get(id)).toBe(bytesById.get(id));
    }
    // 履歴は上限で切られても、残る段の下絵は戻した時に元のバイトで読める。
    let undone = 0;
    while (useAppStore.getState().undoStack.past.length > 0) {
      useAppStore.getState().undo(); undone += 1;
      for (const canvas of useAppStore.getState().document.canvases) {
        expect(useAppStore.getState().canvases.get(canvas.imageId)).toBe(bytesById.get(canvas.imageId));
      }
    }
    expect(undone).toBeGreaterThan(0);
    // 新しい編集で未来を捨てると、戻せなくなった画像も同じ更新で手放す。
    const branch = newSketchCanvas([], 'xy', 'branch.png', { width: 2, height: 1 }, 'branch');
    useAppStore.getState().addCanvas(branch, Uint8Array.of(7));
    const held = new Set(useAppStore.getState().canvases.keys()), referenced = referencedImageIds();
    expect([...held].filter((id) => !referenced.has(id))).toEqual([]);
    expect(held.has('branch')).toBe(true);
  });
});
