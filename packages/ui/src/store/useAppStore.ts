import {
  createEmptySketchDocument,
  DEFAULT_WORK_PLANE_ID,
  dotVec3,
  resolveSketch,
  WORK_PLANE_IDS,
  WORK_PLANES,
  type CoordinateInput,
  type PartMesh,
  type ResolvedSketch,
  type SketchDocument,
  type SketchError,
  type SketchMesh,
  type SketchRecomputeResult,
  type Vec3,
  type WorkPlaneId,
} from '@pointercad/model';
import { create } from 'zustand';

import type { NumericInputState, SketchToolId } from '../sketch/numericInput.js';
import { DEFAULT_SNAP_KINDS, type SnapKind } from '../sketch/snapMath.js';
import type { OrbitState } from '../viewport/cameraMath.js';

/** 透視投影 / 平行投影(FR-102)。 */
export type ProjectionMode = 'perspective' | 'orthographic';

/** 表示スタイル 3 種(FR-105)。 */
export type DisplayStyle = 'shaded' | 'shadedWithEdges' | 'wireframe';

/** いま吸い付いている場所。印を出すのに使う(FR-107)。 */
export interface SnapIndicator {
  /** ビューポートの左上を原点とした画面座標(画素)。 */
  readonly screen: readonly [number, number];
  readonly kind: SnapKind;
  /** 吸い付いた先の要素。方眼の交点は要素を持たないので null。 */
  readonly elementId: string | null;
}

export interface AppState {
  readonly documentName: string;
  readonly featureNames: readonly string[];
  readonly mesh: PartMesh | null;
  readonly isComputing: boolean;
  readonly errorMessage: string | null;
  readonly projection: ProjectionMode;
  readonly displayStyle: DisplayStyle;
  readonly showGrid: boolean;
  /** ホーム視点への復帰要求を数える(FR-108)。増えるたびにビューポートが反応する。 */
  readonly homeViewRequestCount: number;
  /**
   * 「視点に合わせる」の要求を数える(§0.a-0.3)。視点の正本は `attachCameraControls` に
   * あってストアからは読めないので、ビューポートが増加に気づいて今の視点を渡し返す。
   */
  readonly matchWorkPlaneRequestCount: number;
  /** ビューポート区画の大きさ(画素)。その場入力を端で折り返すのに使う。 */
  readonly viewportSize: readonly [number, number];

  /** 選んでいる道具(FR-301〜309)。 */
  readonly activeTool: SketchToolId;
  /** 作図面(要件§4.3、§0.a-0.3)。既定は XY。 */
  readonly workPlaneId: WorkPlaneId;
  /** スケッチの履歴。保存されるのはこれだけ(要件§8)。 */
  readonly sketch: SketchDocument;
  /** 解決済みの幾何。履歴から導ける実行時の控え(保存しない)。 */
  readonly resolvedSketch: ResolvedSketch;
  /** 面の三角形。カーネルが返したもの。面が無ければ null。 */
  readonly sketchMesh: SketchMesh | null;
  /** 解決とカーネルの失敗(FR-504)。ツリーとステータスバーがそのまま見せられる形で持つ。 */
  readonly sketchErrors: readonly SketchError[];
  /** 選択中の要素 id(FR-106)。面を張るときは選んだ順に意味がある(FR-309)。 */
  readonly selection: readonly string[];
  /** ホバー中の要素 id(FR-106)。 */
  readonly hoveredElementId: string | null;
  /** スナップの入り切りと、有効な種別(FR-107、§0.a-0.10)。 */
  readonly snapEnabled: boolean;
  readonly snapKinds: readonly SnapKind[];
  /** 連続描画(FR-307)。 */
  readonly chaining: boolean;
  /** その場数値入力の状態。開いていなければ null(NFR-UX-2)。 */
  readonly numericInput: NumericInputState | null;
  /** ポップアップを出す画面座標。 */
  readonly numericInputAnchor: readonly [number, number] | null;
  /** 線分の始点・円弧の中心・点列の基準として先に決めた座標。まだ無ければ null。 */
  readonly pendingStart: CoordinateInput | null;
  /** いま吸い付いている場所。無ければ null(FR-107)。 */
  readonly snapIndicator: SnapIndicator | null;

  // 動作を変える口はメソッド宣言ではなくプロパティ関数型で書く。メソッド宣言だと
  // useAppStore((state) => state.setX) のように取り出したとき @typescript-eslint/unbound-method
  // に触れるため(計画書 P1 §0.a-0.12、docs/報告記録.md 2026-09-02 15:28 の残件②)。
  readonly setDocument: (name: string, featureNames: readonly string[]) => void;
  readonly setMesh: (mesh: PartMesh) => void;
  readonly setComputing: (isComputing: boolean) => void;
  readonly setError: (message: string | null) => void;
  readonly setProjection: (projection: ProjectionMode) => void;
  readonly setDisplayStyle: (displayStyle: DisplayStyle) => void;
  readonly setShowGrid: (showGrid: boolean) => void;
  readonly requestHomeView: () => void;
  readonly setViewportSize: (size: readonly [number, number]) => void;

  readonly setActiveTool: (tool: SketchToolId) => void;
  readonly setWorkPlane: (id: WorkPlaneId) => void;
  /** 今の視点に最も近い作図面へ移してほしい、とビューポートへ頼む(§0.a-0.3)。 */
  readonly requestMatchWorkPlaneToView: () => void;
  /** 今の視点に最も近い作図面へ移る(§0.a-0.3 の「視点に合わせる」)。 */
  readonly matchWorkPlaneToView: (orbit: OrbitState) => void;
  /** 履歴を差し替える。計算中の印を立てるだけで、解決はしない。 */
  readonly setSketch: (sketch: SketchDocument) => void;
  /** 再計算の結果を反映する。 */
  readonly applySketch: (sketch: SketchDocument, result: SketchRecomputeResult) => void;
  readonly setSelection: (ids: readonly string[]) => void;
  readonly toggleSelection: (id: string) => void;
  readonly setHovered: (id: string | null) => void;
  readonly setSnapEnabled: (enabled: boolean) => void;
  readonly toggleSnapKind: (kind: SnapKind) => void;
  readonly setChaining: (chaining: boolean) => void;
  readonly openNumericInput: (
    state: NumericInputState,
    anchor: readonly [number, number],
  ) => void;
  readonly updateNumericInput: (state: NumericInputState) => void;
  readonly closeNumericInput: () => void;
  readonly setPendingStart: (start: CoordinateInput | null) => void;
  readonly setSnapIndicator: (indicator: SnapIndicator | null) => void;
}

/** カメラから注視点へ向かう単位ベクトル。Z 軸が上の球面座標から作る。 */
function viewDirection(orbit: OrbitState): Vec3 {
  const horizontal = Math.cos(orbit.elevation);
  return [
    -horizontal * Math.cos(orbit.azimuth),
    -horizontal * Math.sin(orbit.azimuth),
    -Math.sin(orbit.elevation),
  ];
}

/**
 * 同点とみなす傾きの差。等角のホーム視点では 3 面が等しく傾くが、三角関数の丸めで
 * 最下位桁だけが違う値になる。その 1 桁で選ばれる面が変わると、同じ見え方から
 * 違う結果が出て説明できない(NFR-UX-1)。差がこれ以下なら同点として先頭を採る。
 */
const ALIGNMENT_EPSILON = 1e-9;

/**
 * 今の視点に最も近い作図面を選ぶ(§0.a-0.3)。
 *
 * 画面に正対して見えている面ほど、その法線が視線と平行になる。だから法線と視線の
 * 内積の絶対値が最大の面を採る(手前から見ているか奥から見ているかは問わない)。
 * 等角のように 3 面が並ぶときは XY → XZ → YZ の先頭、つまり既定の XY を採る。
 * ビューキューブは視点だけを変え、作図面は変えない。作図面が変わるのはこの関数を
 * 呼ぶ「視点に合わせる」を押したときだけ(NFR-UX-1 操作文法の一貫性)。
 */
export function workPlaneForOrbit(orbit: OrbitState): WorkPlaneId {
  const direction = viewDirection(orbit);
  let best: WorkPlaneId = DEFAULT_WORK_PLANE_ID;
  let bestAlignment = -1;
  for (const id of WORK_PLANE_IDS) {
    const alignment = Math.abs(dotVec3(direction, WORK_PLANES[id].normal));
    if (alignment > bestAlignment + ALIGNMENT_EPSILON) {
      bestAlignment = alignment;
      best = id;
    }
  }
  return best;
}

/** テストで元へ戻せるよう、スケッチまわりの初期値を1箇所にまとめる。 */
export function createInitialSketchState(): Pick<
  AppState,
  | 'activeTool'
  | 'workPlaneId'
  | 'sketch'
  | 'resolvedSketch'
  | 'sketchMesh'
  | 'sketchErrors'
  | 'selection'
  | 'hoveredElementId'
  | 'snapEnabled'
  | 'snapKinds'
  | 'chaining'
  | 'numericInput'
  | 'numericInputAnchor'
  | 'pendingStart'
  | 'snapIndicator'
> {
  // 起動時は空のスケッチから始める(§0.a-0.2、NFR-UX-6 の空状態ガイドと揃える)。
  const sketch = createEmptySketchDocument();
  return {
    activeTool: 'select',
    workPlaneId: DEFAULT_WORK_PLANE_ID,
    sketch,
    resolvedSketch: resolveSketch(sketch),
    sketchMesh: null,
    sketchErrors: [],
    selection: [],
    hoveredElementId: null,
    snapEnabled: true,
    snapKinds: DEFAULT_SNAP_KINDS,
    chaining: true,
    numericInput: null,
    numericInputAnchor: null,
    pendingStart: null,
    snapIndicator: null,
  };
}

export const useAppStore = create<AppState>()((set) => ({
  documentName: '',
  featureNames: [],
  mesh: null,
  isComputing: false,
  errorMessage: null,
  projection: 'perspective',
  displayStyle: 'shadedWithEdges',
  showGrid: true,
  homeViewRequestCount: 0,
  matchWorkPlaneRequestCount: 0,
  viewportSize: [0, 0],
  ...createInitialSketchState(),

  setDocument: (documentName, featureNames) => {
    set({ documentName, featureNames });
  },
  setMesh: (mesh) => {
    set({ mesh, errorMessage: null, isComputing: false });
  },
  setComputing: (isComputing) => {
    set({ isComputing });
  },
  setError: (errorMessage) => {
    set({ errorMessage, isComputing: false });
  },
  setProjection: (projection) => {
    set({ projection });
  },
  setDisplayStyle: (displayStyle) => {
    set({ displayStyle });
  },
  setShowGrid: (showGrid) => {
    set({ showGrid });
  },
  requestHomeView: () => {
    set((state) => ({ homeViewRequestCount: state.homeViewRequestCount + 1 }));
  },
  setViewportSize: (viewportSize) => {
    set({ viewportSize });
  },

  setActiveTool: (activeTool) => {
    // 道具を変えたら入力中のポップアップを閉じ、取りかけの始点と吸着の印も落とす
    // (取りかけの操作を持ち越さない、NFR-UX-3)。
    set({
      activeTool,
      numericInput: null,
      numericInputAnchor: null,
      pendingStart: null,
      snapIndicator: null,
    });
  },
  setWorkPlane: (workPlaneId) => {
    set({ workPlaneId });
  },
  requestMatchWorkPlaneToView: () => {
    set((state) => ({ matchWorkPlaneRequestCount: state.matchWorkPlaneRequestCount + 1 }));
  },
  matchWorkPlaneToView: (orbit) => {
    set({ workPlaneId: workPlaneForOrbit(orbit) });
  },
  setSketch: (sketch) => {
    // 解決はここではしない。attachSketchRecompute が非同期に行い applySketch で戻す。
    set({ sketch, isComputing: true });
  },
  applySketch: (sketch, result) => {
    set({
      sketch,
      resolvedSketch: result.resolved,
      sketchMesh: result.mesh,
      sketchErrors: result.errors,
      isComputing: false,
      featureNames: sketch.features.map((feature) => feature.name),
      documentName: sketch.name,
    });
  },
  setSelection: (selection) => {
    set({ selection });
  },
  toggleSelection: (id) => {
    set((state) => ({
      selection: state.selection.includes(id)
        ? state.selection.filter((selected) => selected !== id)
        : [...state.selection, id],
    }));
  },
  setHovered: (hoveredElementId) => {
    set({ hoveredElementId });
  },
  setSnapEnabled: (snapEnabled) => {
    set({ snapEnabled });
  },
  toggleSnapKind: (kind) => {
    set((state) => ({
      snapKinds: state.snapKinds.includes(kind)
        ? state.snapKinds.filter((enabled) => enabled !== kind)
        : [...state.snapKinds, kind],
    }));
  },
  setChaining: (chaining) => {
    set({ chaining });
  },
  openNumericInput: (numericInput, numericInputAnchor) => {
    set({ numericInput, numericInputAnchor });
  },
  updateNumericInput: (numericInput) => {
    set({ numericInput });
  },
  closeNumericInput: () => {
    set({ numericInput: null, numericInputAnchor: null });
  },
  setPendingStart: (pendingStart) => {
    set({ pendingStart });
  },
  setSnapIndicator: (snapIndicator) => {
    set({ snapIndicator });
  },
}));

/**
 * 履歴 1 つを解決して結果を返すもの。実物は `recomputeSketch(document, bridge)`。
 * カーネル(Worker)を持たない検査では偽物を差し込めるよう、関数の型で受ける。
 */
export type SketchRecomputer = (document: SketchDocument) => Promise<SketchRecomputeResult>;

/**
 * 履歴の変化を見張り、変わるたびに再計算を予約する(要件§6.3)。
 *
 * 1 本ずつしか走らせない。計算中に履歴が何度変わっても覚えるのは**最新の 1 つだけ**で、
 * 間に挟まった版は捨てる。連続入力のたびに Worker を往復させて詰まらせないため
 * (NFR-PF-1)。古い結果は捨てるので、`isComputing` が下りるのは最新の計算が
 * 終わったときだけになる。失敗しても例外を投げず、理由を画面に出す(FR-504、NFR-RE-1)。
 *
 * 戻り値を呼ぶと見張りをやめる。
 */
export function attachSketchRecompute(recompute: SketchRecomputer): () => void {
  let detached = false;
  let running = false;
  /** 実行中に届いた最新の履歴。1 つだけ持つ。 */
  let queued: SketchDocument | null = null;

  /** 1 本分が終わったときの後始末。次に回す履歴があれば返す。 */
  function takeQueued(): SketchDocument | null {
    running = false;
    const next = queued;
    queued = null;
    return next;
  }

  function start(document: SketchDocument): void {
    running = true;
    void recompute(document).then(
      (result) => {
        if (detached) {
          return;
        }
        const next = takeQueued();
        if (next !== null) {
          // もっと新しい履歴が来ている。この結果は使わずに次を計算する。
          start(next);
          return;
        }
        useAppStore.getState().applySketch(document, result);
      },
      (error: unknown) => {
        if (detached) {
          return;
        }
        const next = takeQueued();
        if (next !== null) {
          start(next);
          return;
        }
        useAppStore.getState().setError(error instanceof Error ? error.message : String(error));
      },
    );
  }

  function request(document: SketchDocument): void {
    if (running) {
      queued = document;
      return;
    }
    start(document);
  }

  request(useAppStore.getState().sketch);

  const unsubscribe = useAppStore.subscribe((next, previous) => {
    if (next.sketch !== previous.sketch) {
      request(next.sketch);
    }
  });

  return () => {
    detached = true;
    queued = null;
    unsubscribe();
  };
}
