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
import {
  useAppStore,
} from './useAppStore.js';
import {
  resetTestStore,
} from './testing/createTestStore.js';

beforeEach(resetTestStore);

describe('下絵の画像(FR-332、P6 タスク39)', () => {
  /** 800×600 画素の下絵 1 枚と、その画像のバイト列(中身は見ない)。 */
  function sampleCanvas(): SketchCanvas {
    return newSketchCanvas([], 'xy', '間取り.png', { width: 800, height: 600 });
  }

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
    useAppStore.getState().addCanvas(sampleCanvas(), new Uint8Array([1]));
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

  it('不透明度は 0〜1 に収める(範囲の外を打っても壊れない)', () => {
    useAppStore.getState().addCanvas(sampleCanvas(), new Uint8Array([1]));
    useAppStore.getState().setCanvasOpacity('canvas-1', 5);
    expect(useAppStore.getState().document.canvases[0].opacity.value).toBe(1);
    useAppStore.getState().setCanvasOpacity('canvas-1', -2);
    expect(useAppStore.getState().document.canvases[0].opacity.value).toBe(0);
  });

  it('2 点が同じ位置なら断り、文言は model のものをそのまま出す(§2.14)', () => {
    useAppStore.getState().addCanvas(sampleCanvas(), new Uint8Array([1]));
    useAppStore.getState().startCanvasScale('canvas-1');
    useAppStore.getState().addCanvasScalePoint([0, 0]);
    useAppStore.getState().addCanvasScalePoint([0, 0]);

    expect(useAppStore.getState().applyCanvasScale(50, { width: 800, height: 600 })).toBe(false);
    expect(useAppStore.getState().canvasMessage).toBe(CANVAS_SAME_POINT_MESSAGE);
    // 断られても欄は開いたままで、指し直せる。
    expect(useAppStore.getState().canvasScale).not.toBeNull();
  });

  it('3 点目を指すと 1 点目を捨てて詰める(やり直しのために止めない)', () => {
    useAppStore.getState().startCanvasScale('canvas-1');
    useAppStore.getState().addCanvasScalePoint([1, 1]);
    useAppStore.getState().addCanvasScalePoint([2, 2]);
    useAppStore.getState().addCanvasScalePoint([3, 3]);
    expect(useAppStore.getState().canvasScale?.points).toEqual([
      [2, 2],
      [3, 3],
    ]);
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
    useAppStore.getState().addCanvas(sampleCanvas(), new Uint8Array([1]));
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
