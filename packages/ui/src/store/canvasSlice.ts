/**
 * 下絵のスライス(FR-332。画像・寸法合わせ・画素の大きさ)。
 * 分け方の約束は `viewSlice.ts` の冒頭にある(P6 タスク52)。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import {
  removeCanvas as removeCanvasFrom,
  setCanvasVisible as setCanvasVisibleIn,
  solveCanvasHomography,
  type CanvasNormalizedPoint,
  type CanvasSourceQuad,
  type SketchCanvas,
} from '@pointercad/model';
import type { StateCreator } from 'zustand';
import { t } from '../i18n/t.js';
import { canvasActionState, type CanvasImageLoad, type CanvasImageOwner } from '../sketch/canvasActionState.js';
import {
  type CanvasPixelSize,
  canvasPlacementOf,
  canvasSizeForTwoPoints,
} from '../viewport/canvasLayer.js';
import type { AppState } from './appState.js';

/**
 * 下絵の 2 点の寸法合わせ(FR-332。P6 タスク39、計画書 §0.a-0.46、§2.14)の途中の状態。
 *
 * **形は変わらない。** 画像の上で 2 点を指し、その実寸(mm、式)を打つと、下絵の幅・高さ
 * だけが変わる(§2.14 の式)。**縮尺は保存しない**(幅 ÷ 画素の幅でいつでも出せる、rules/04)。
 */
export interface CanvasScaleState {
  /** 合わせる下絵の id(`SketchCanvas.id`)。 */
  readonly canvasId: string;
  readonly documentId: string;
  readonly imageId: string;
  readonly bytes: Uint8Array;
  /**
   * 指した点(作図面の上の (u, v))。0 個・1 個・2 個のいずれか。3 点目を指したら
   * 1 点目を捨てて詰める(打ち直しのために毎回やめさせない、NFR-UX-3)。
   */
  readonly points: readonly (readonly [number, number])[];
}

/** 元画像の四隅を選んでいる間だけ持つ。文書/Undoと原画像にはまだ触れない。 */
export interface CanvasRectificationState {
  readonly canvasId: string;
  readonly documentId: string;
  readonly imageId: string;
  readonly bytes: Uint8Array;
  readonly request: object;
  readonly size: CanvasPixelSize;
  readonly points: readonly CanvasNormalizedPoint[];
}

/** 下絵のスライスが持つ欄と操作。 */
export interface CanvasSlice {
  /**
   * 下絵の画像そのもののバイト列(FR-332、P6 §0.a-0.45、タスク39)。鍵は
   * `SketchCanvas.imageId` で、`.pcad` の ZIP のエントリ `canvases/<imageId>.png` と 1 対 1。
   *
   * **文書(`document.canvases`)には id と寸法しか入らない**ので、数 MB のバイト列は
   * ここで持つ(§0.9 と同じ流儀。JSON へ入れると読み書きが桁違いに遅くなる)。
   * 保存するときは現在文書が参照する画像を `packages/io` の添付として書き出す。
   * 開くときは衝突する画像IDを正規化し、履歴の画像も含む表を `setCanvasImages` へ渡す。
   * **不変**にしてあるので、足す・消すたびに新しい `Map` を作る(rules/04)。
   *
   * 文書を作り直したら消える(古い文書の画像を新しい文書が指すことは無い)ので、
   * `createInitialDocumentState` の側に置いてある(rules/06 10.17 と同じ理屈)。
   */
  readonly canvases: ReadonlyMap<string, Uint8Array>;
  /**
   * 2 点の寸法合わせ(FR-332、§2.14)の途中の状態。`null` のあいだは浮かぶ欄も出ない。
   *
   * 点は**作図面の上の (u, v)**(押した場所を作図面へ落としたもの)で持ち、2 つそろったら
   * 実寸を打つ欄が出る。**再計算を起こさない**(文書に触らないので `affectsShape` の
   * 経路を通らない)。
   */
  readonly canvasScale: CanvasScaleState | null;
  /** 原画像上の四隅。確定まで文書には保存しない。 */
  readonly canvasRectification: CanvasRectificationState | null;
  /**
   * 下絵についての断り(FR-504、NFR-UX-5)。受け付けられない画像(PNG / JPEG でない、
   * 8MB 超)と、寸法合わせの断り(2 点が同じ・実寸が 0 以下)の日本語をそのまま持つ。
   *
   * **文言の正本は `@pointercad/model` の `sketch/canvas.ts`**(上限の数を知っているのが
   * あの層だけなので、`ja.json` へ写すと数字が 2 か所で食い違う)。**出す場所は下絵の
   * 浮かぶ欄**で、ステータスバーの言い回し(「図形を作れませんでした:」等)には乗せない。
   */
  readonly canvasMessage: string | null;
  /**
   * 下絵の画像の**画素の大きさ**(鍵は `SketchCanvas.imageId`)。復号できた画像だけが載る。
   *
   * 文書には保存しない(`rules/04`。復号した画像がいつでも答える)が、2 点の寸法合わせ
   * (§2.14 の `幅 = 縮尺 × 画素の幅`)とプロパティの表示に要るので、復号したときに
   * ビューポートがここへ控える。**画像 1 枚につき数 2 つだけ**なので記憶は増えない。
   */
  readonly canvasPixelSizes: ReadonlyMap<string, CanvasPixelSize>;
  readonly canvasImageLoads: ReadonlyMap<string, CanvasImageLoad>;
  readonly canvasImageRetries: ReadonlyMap<string, number>;
  readonly setCanvasImageLoad: (imageId: string, owner: CanvasImageOwner, load: CanvasImageLoad | null) => void;
  readonly retryCanvasImage: (canvasId: string, documentId?: string, imageId?: string) => void;
  /**
   * 下絵を 1 枚足す(FR-332、タスク39)。id は `nextCanvasId`、画像の鍵は `imageId` で、
   * バイト列は添付の表(`canvases`)へ入れる。**再計算は走らない**(`affectsShape` が偽)。
   */
  readonly addCanvas: (canvas: SketchCanvas, bytes: Uint8Array) => void;
  /** 下絵の入切(FR-332)。**再計算は走らない**(§2.14 の表)。 */
  readonly setCanvasVisible: (id: string, visible: boolean) => void;
  /** 下絵の不透明度(0〜1)。同じく再計算は走らない。 */
  readonly setCanvasOpacity: (id: string, opacity: number) => void;
  /** 下絵を 1 枚消す。画像は文書またはUndo/Redoの履歴から参照される間だけ残す。 */
  readonly removeCanvas: (id: string) => void;
  /** 正規化済みの画像表で入れ直す。呼出側が既存履歴の画像も保持する。 */
  readonly setCanvasImages: (images: ReadonlyMap<string, Uint8Array>) => void;
  /**
   * 開いた `.pcad` の添付から、読み込んだ形と三角形を入れ直す(FR-802、タスク32)。
   * **丸ごと差し替える**(開くのは文書ごとの操作なので、前の文書の添付は残さない)。
   */
  /** 2 点の寸法合わせを始める(§2.14)。もう一度呼ぶと点を捨ててやり直す。 */
  readonly startCanvasScale: (canvasId: string, documentId?: string, imageId?: string) => void;
  /** 寸法合わせの点を 1 つ足す(作図面の上の (u, v))。3 点目は 1 点目を捨てて詰める。 */
  readonly addCanvasScalePoint: (point: readonly [number, number]) => void;
  /** 寸法合わせをやめる。 */
  readonly cancelCanvasScale: () => void;
  readonly startCanvasRectification: (canvasId: string, documentId?: string, imageId?: string) => void;
  readonly addCanvasRectificationPoint: (point: CanvasNormalizedPoint) => void;
  readonly cancelCanvasRectification: () => void;
  readonly applyCanvasRectification: () => boolean;
  readonly clearCanvasRectification: (canvasId: string, documentId?: string, imageId?: string) => boolean;
  /** 下絵についての断り(model が組み立てた日本語)を出す・消す。 */
  readonly setCanvasMessage: (message: string | null) => void;
  /** 復号できた下絵の画素の大きさを控える(ビューポートが復号したときに呼ぶ)。 */
  readonly setCanvasPixelSize: (imageId: string, size: CanvasPixelSize) => void;
  /** 不要・差替え・復号待ちの画像の寸法を取り下げる。 */
  readonly removeCanvasPixelSize: (imageId: string) => void;
  /**
   * 指した 2 点が `realLengthMm` になるよう下絵の幅・高さを合わせる(§2.14)。
   * 合わせられたら `true`。断ったときは `false` を返し、理由の日本語を帯へ出す
   * (文言の正本は `@pointercad/model` の `sketch/canvas.ts`)。
   */
  readonly applyCanvasScale: (
    realLengthMm: number,
    pixelSize: { readonly width: number; readonly height: number },
  ) => boolean;
}

/**
 * 部品を作り直すたびに初期値へ戻す欄(下絵)。
 * 実体は `initialDocumentState.ts` の `createInitialDocumentState` が 1 か所で作る。
 */
export type CanvasInitialState = Pick<
  CanvasSlice,
  | 'canvases'
  | 'canvasScale'
  | 'canvasRectification'
  | 'canvasMessage'
  | 'canvasPixelSizes'
  | 'canvasImageLoads'
  | 'canvasImageRetries'
>;

export const createCanvasSlice: StateCreator<
  AppState,
  [],
  [],
  Omit<CanvasSlice, keyof CanvasInitialState>
> = (set, get) => ({
  addCanvas: (canvas, bytes) => {
    const state = get();
    if (state.canvases.has(canvas.imageId)) {
      // 既存ファイルの連番画像も含め、Undo が参照する画像を上書きしない。
      set({ canvasMessage: t('canvas.duplicateImage') });
      return;
    }
    set({ canvases: new Map([...state.canvases, [canvas.imageId, bytes]]), canvasMessage: null });
    // 文書へは id と寸法だけを入れる(バイト列は上の表。§0.a-0.45)。
    state.applyDocument({ ...state.document, canvases: [...state.document.canvases, canvas] });
  },
  setCanvasVisible: (id, visible) => {
    const state = get();
    const canvases = setCanvasVisibleIn(state.document.canvases, id, visible);
    if (canvases === state.document.canvases) {
      // 値が変わらないときは文書を作り直さない(NFR-PF-1。描き直しも呼ばない)。
      return;
    }
    state.applyDocument({ ...state.document, canvases });
  },
  setCanvasOpacity: (id, opacity) => {
    const state = get();
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
      // 数にならない値は据え置く(断りは打ち込んだ欄が出す。NFR-RE-1)。
      return;
    }
    const current = state.document.canvases.find(canvas => canvas.id === id);
    if (current === undefined || current.opacity.value === opacity) return;
    const canvases = state.document.canvases.map((canvas) =>
      canvas.id === id ? { ...canvas, opacity: expressionValueFromNumber(opacity) } : canvas,
    );
    // 確定1回を履歴1段にする。Enter後のblurによる同値の再確定は上で除く。
    state.applyDocument({ ...state.document, canvases });
  },
  removeCanvas: (id) => {
    const state = get();
    const canvases = removeCanvasFrom(state.document.canvases, id);
    if (canvases === state.document.canvases) {
      return;
    }
    /*
      **画像のバイト列は落とさない。** 消した下絵は取り消し(Ctrl+Z)で戻せる(FR-505)ので、
      ここで捨てると戻した下絵が二度と映らなくなる。`documentPatch` が確定後の文書と
      Undo/Redo全体から必要な画像を選び、履歴上限・分岐の破棄で不要になった画像を回収する。
      保存のときに書き出すのは保存する文書が指している画像だけ。
    */
    set({ canvasScale: null, canvasRectification: null, canvasMessage: null });
    state.applyDocument({ ...state.document, canvases });
  },
  setCanvasImages: (images) => {
    set(state => {
      // 同じ文書・不変バイト列なら、表示キャッシュと同じ寿命の控えを保つ。
      const canvasImageLoads = new Map([...state.canvasImageLoads].filter(([id, load]) =>
        load.documentId === state.activeDocumentId && images.get(id) === load.bytes));
      const canvasPixelSizes = new Map([...canvasImageLoads].flatMap(([id, load]) => load.status === 'ready' ? [[id, load.size] as const] : []));
      const canvasImageRetries = new Map([...state.canvasImageRetries].filter(([id]) => images.get(id) === state.canvases.get(id)));
      return { canvases: new Map(images), canvasPixelSizes, canvasImageLoads, canvasImageRetries,
        canvasScale: null, canvasRectification: null };
    });
  },
  startCanvasScale: (canvasId, documentId, imageId) => {
    const state = get();
    const action = canvasActionState(state, canvasId, documentId, imageId);
    const canvas = state.document.canvases.find(item => item.id === canvasId);
    const bytes = canvas === undefined ? undefined : state.canvases.get(canvas.imageId);
    if (action.status !== 'ready') {
      set({ canvasMessage: t(action.reason), canvasScale: null, canvasRectification: null });
      return;
    }
    if (canvas === undefined || bytes === undefined) return;
    set({ canvasScale: { canvasId, documentId: state.activeDocumentId, imageId: canvas.imageId,
      bytes, points: [] }, canvasRectification: null, canvasMessage: null });
  },
  addCanvasScalePoint: (point) => {
    set((state) => {
      if (state.canvasScale === null) {
        return {};
      }
      // 3 点目は 1 点目を捨てて詰める(打ち直しのために毎回やめさせない、NFR-UX-3)。
      const previous = state.canvasScale.points;
      const points = [...(previous.length >= 2 ? previous.slice(1) : previous), point];
      return { canvasScale: { ...state.canvasScale, points }, canvasMessage: null };
    });
  },
  cancelCanvasScale: () => {
    set({ canvasScale: null, canvasMessage: null });
  },
  startCanvasRectification: (canvasId, documentId, imageId) => {
    const state = get();
    const action = canvasActionState(state, canvasId, documentId, imageId);
    const canvas = state.document.canvases.find(item => item.id === canvasId);
    const bytes = canvas === undefined ? undefined : state.canvases.get(canvas.imageId);
    const load = canvas === undefined ? undefined : state.canvasImageLoads.get(canvas.imageId);
    if (action.status !== 'ready' || canvas === undefined || bytes === undefined || load?.status !== 'ready') {
      set({ canvasRectification: null, canvasScale: null,
        canvasMessage: action.status === 'ready' ? t('canvas.rectifyChanged') : t(action.reason) });
      return;
    }
    set({ canvasRectification: { canvasId, documentId: state.activeDocumentId,
      imageId: canvas.imageId, bytes, request: load.request, size: action.size, points: [] },
    canvasScale: null, canvasMessage: null });
  },
  addCanvasRectificationPoint: (point) => {
    set(state => {
      const picking = state.canvasRectification;
      if (picking === null) return state;
      const action = canvasActionState(state, picking.canvasId, picking.documentId, picking.imageId);
      const load = state.canvasImageLoads.get(picking.imageId);
      if (action.status !== 'ready' || load?.status !== 'ready' || load.request !== picking.request
        || load.bytes !== picking.bytes || state.canvases.get(picking.imageId) !== picking.bytes
        || action.size.width !== picking.size.width || action.size.height !== picking.size.height) {
        return { canvasRectification: null, canvasMessage: t('canvas.rectifyChanged') };
      }
      if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])
        || point[0] < 0 || point[0] > 1 || point[1] < 0 || point[1] > 1) {
        return { canvasMessage: t('canvas.rectifyInvalid') };
      }
      const points = picking.points.length >= 4 ? [point] : [...picking.points, point];
      return { canvasRectification: { ...picking, points }, canvasMessage: null };
    });
  },
  cancelCanvasRectification: () => {
    set({ canvasRectification: null, canvasMessage: null });
  },
  applyCanvasRectification: () => {
    const state = get();
    const picking = state.canvasRectification;
    if (picking === null) return false;
    const [topLeft, topRight, bottomRight, bottomLeft] = picking.points;
    if (topLeft === undefined || topRight === undefined || bottomRight === undefined || bottomLeft === undefined) {
      return false;
    }
    const canvas = state.document.canvases.find(item => item.id === picking.canvasId);
    const action = canvasActionState(state, picking.canvasId, picking.documentId, picking.imageId);
    const load = state.canvasImageLoads.get(picking.imageId);
    if (canvas === undefined || canvas.imageId !== picking.imageId || action.status !== 'ready'
      || load?.status !== 'ready' || load.request !== picking.request || load.bytes !== picking.bytes
      || state.canvases.get(picking.imageId) !== picking.bytes
      || action.size.width !== picking.size.width || action.size.height !== picking.size.height) {
      set({ canvasRectification: null, canvasMessage: t('canvas.rectifyChanged') });
      return false;
    }
    const sourceQuad: CanvasSourceQuad = [topLeft, topRight, bottomRight, bottomLeft];
    const solved = solveCanvasHomography(sourceQuad);
    if (!solved.ok) {
      set({ canvasMessage: t('canvas.rectifyInvalid') });
      return false;
    }
    const canvases = state.document.canvases.map(item => item.id === picking.canvasId
      ? { ...item, rectification: { sourceQuad } } : item);
    set({ canvasRectification: null, canvasMessage: null });
    state.applyDocument({ ...state.document, canvases });
    return true;
  },
  clearCanvasRectification: (canvasId, documentId, imageId) => {
    const state = get();
    const action = canvasActionState(state, canvasId, documentId, imageId);
    const canvas = state.document.canvases.find(item => item.id === canvasId);
    if (action.status !== 'ready' || canvas === undefined || canvas.rectification === undefined) return false;
    const canvases = state.document.canvases.map(item => item.id === canvasId
      ? { ...item, rectification: undefined } : item);
    set({ canvasRectification: null, canvasMessage: null });
    state.applyDocument({ ...state.document, canvases });
    return true;
  },
  setCanvasMessage: (canvasMessage) => {
    set({ canvasMessage });
  },
  setCanvasImageLoad: (imageId, owner, load) => {
    set(state => {
      const known = state.canvasImageLoads.get(imageId);
      if (load === null) {
        if (known?.documentId !== owner.documentId || known.bytes !== owner.bytes || known.request !== owner.request) return state;
      } else if (owner.request !== load.request || owner.documentId !== load.documentId || owner.bytes !== load.bytes
        || owner.documentId !== state.activeDocumentId
        || state.canvases.get(imageId) !== owner.bytes || state.assembly !== null || state.drawing !== null
        || !state.document.canvases.some(canvas => canvas.imageId === imageId)) return state;
      if (load !== null && load.status !== 'loading' && known !== undefined && known.request !== owner.request) return state;
      const canvasImageLoads = new Map(state.canvasImageLoads);
      const canvasPixelSizes = new Map(state.canvasPixelSizes);
      if (load === null) canvasImageLoads.delete(imageId); else canvasImageLoads.set(imageId, load);
      if (load?.status === 'ready') canvasPixelSizes.set(imageId, load.size); else canvasPixelSizes.delete(imageId);
      const cancelled = state.canvasScale?.imageId === imageId && load?.status !== 'ready';
      const picking = state.canvasRectification;
      const cancelledRectification = picking?.imageId === imageId
        && (load?.status !== 'ready' || load.request !== picking.request || load.bytes !== picking.bytes
          || load.size.width !== picking.size.width || load.size.height !== picking.size.height);
      return { canvasImageLoads, canvasPixelSizes,
        ...(cancelled ? { canvasScale: null, canvasMessage: load?.status === 'failed'
          ? t('propertyPanel.canvasReasonFailed') : state.canvasMessage } : {}),
        ...(cancelledRectification ? { canvasRectification: null,
          canvasMessage: t('canvas.rectifyChanged') } : {}) };
    });
  },
  retryCanvasImage: (canvasId, documentId, imageId) => {
    const state = get();
    if (canvasActionState(state, canvasId, documentId, imageId).status !== 'failed') return;
    const canvas = state.document.canvases.find(item => item.id === canvasId);
    if (canvas === undefined) return;
    const canvasImageRetries = new Map(state.canvasImageRetries);
    canvasImageRetries.set(canvas.imageId, (canvasImageRetries.get(canvas.imageId) ?? 0) + 1);
    set({ canvasImageRetries, canvasMessage: null });
  },
  setCanvasPixelSize: (imageId, size) => {
    if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) return;
    set((state) => {
      const known = state.canvasPixelSizes.get(imageId);
      if (known !== undefined && known.width === size.width && known.height === size.height) {
        // 同じ大きさを入れ直さない(新しい `Map` を作ると購読側が無駄に反応する。NFR-PF-1)。
        return state;
      }
      const bytes = state.canvases.get(imageId);
      const hasCanvas = state.document.canvases.some(canvas => canvas.imageId === imageId);
      const load = state.canvasImageLoads.get(imageId);
      const request = load?.documentId === state.activeDocumentId && load.bytes === bytes ? load.request : {};
      const picking = state.canvasRectification;
      const cancelledRectification = picking?.imageId === imageId
        && (picking.size.width !== size.width || picking.size.height !== size.height || picking.request !== request);
      return { canvasPixelSizes: new Map([...state.canvasPixelSizes, [imageId, size]]),
        ...(bytes === undefined || !hasCanvas ? {} : { canvasImageLoads: new Map([...state.canvasImageLoads,
          [imageId, { documentId: state.activeDocumentId, bytes, request, status: 'ready' as const, size }]]) }),
        ...(cancelledRectification ? { canvasRectification: null, canvasMessage: t('canvas.rectifyChanged') } : {}) };
    });
  },
  removeCanvasPixelSize: (imageId) => {
    set((state) => {
      if (!state.canvasPixelSizes.has(imageId)) return state;
      const canvasPixelSizes = new Map(state.canvasPixelSizes);
      canvasPixelSizes.delete(imageId);
      return { canvasPixelSizes,
        ...(state.canvasRectification?.imageId === imageId
          ? { canvasRectification: null, canvasMessage: t('canvas.rectifyChanged') } : {}) };
    });
  },
  applyCanvasScale: (realLengthMm, pixelSize) => {
    const state = get();
    const scale = state.canvasScale;
    if (scale === null || scale.points.length < 2) {
      return false;
    }
    const canvas = state.document.canvases.find((item) => item.id === scale.canvasId);
    const action = canvasActionState(state, scale.canvasId, scale.documentId);
    if (action.status !== 'ready') {
      set({ canvasMessage: t(action.reason) });
      return false;
    }
    if (canvas === undefined || canvas.imageId !== scale.imageId || state.canvases.get(canvas.imageId) !== scale.bytes
      || action.size.width !== pixelSize.width || action.size.height !== pixelSize.height) {
      set({ canvasMessage: t('propertyPanel.canvasReasonChanged') });
      return false;
    }
    const outcome = canvasSizeForTwoPoints(
      canvasPlacementOf(canvas),
      pixelSize,
      scale.points[0],
      scale.points[1],
      realLengthMm,
    );
    if (!outcome.ok) {
      // 断りの日本語は model が組み立てたものをそのまま出す(文言を写さない)。
      set({ canvasMessage: outcome.message });
      return false;
    }
    const canvases = state.document.canvases.map((item) =>
      item.id === scale.canvasId
        ? {
            ...item,
            width: expressionValueFromNumber(outcome.widthMm),
            height: expressionValueFromNumber(outcome.heightMm),
          }
        : item,
    );
    // 合わせ終わったら欄を畳む。取り消し 1 回で元の大きさへ戻る(NFR-UX-3)。
    set({ canvasScale: null, canvasMessage: null });
    state.applyDocument({ ...state.document, canvases });
    return true;
  },
});
