import {
  canRedo as stackCanRedo,
  canUndo as stackCanUndo,
  createEmptyPartDocument,
  createUndoStack,
  DEFAULT_WORK_PLANE_ID,
  dotVec3,
  findSketch,
  pushUndo,
  redo as redoStep,
  removeFeature,
  replaceFeature,
  replaceSketch,
  resolveSketch,
  setActiveSketch as activateSketch,
  undo as undoStep,
  WORK_PLANE_IDS,
  WORK_PLANES,
  type CoordinateInput,
  type PartDocument,
  type PartProgress,
  type PartRecomputeError,
  type PartRecomputeOptions,
  type PartRecomputeResult,
  type PartSketchResult,
  type ResolvedSketch,
  type SketchDocument,
  type SketchError,
  type SketchFeature,
  type SketchMesh,
  type SketchRecomputeResult,
  type SolidBody,
  type UndoStack,
  type Vec3,
  type WorkPlaneId,
} from '@pointercad/model';
import { create } from 'zustand';

import type { MessageKey } from '../i18n/t.js';
import { featureIdOf } from '../sketch/featureSummary.js';
import type { NumericInputState, NumericInputToolId } from '../sketch/numericInput.js';
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

/** 文書を差し替えるときの添え物(§0.a-0.4、§0.a-0.13)。 */
export interface ApplyDocumentOptions {
  /**
   * 同じ鍵の変更が続いたら Undo の 1 段にまとめる(§0.a-0.13)。
   * 鍵があるときは「打っている途中」とみなし、計算中の札も立てない
   * (立てるとプロパティ欄で 1 文字打つたびに札が点滅する)。
   */
  readonly coalesceKey?: string;
  /**
   * Undo に段を積むか。既定は積む(true)。計算結果の反映のように
   * 利用者の操作ではない差し替えでは false にする。
   */
  readonly undoable?: boolean;
}

export interface AppState {
  readonly documentName: string;
  readonly featureNames: readonly string[];
  /** 再計算(解決とカーネル)の最中か。計算中の札を出すのに使う。 */
  readonly isComputing: boolean;
  /** 再計算そのものが投げた失敗。ステータスバーがそのまま見せる(FR-504)。 */
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
  /**
   * ビューポートへ焦点を戻す要求を数える。canvas を持っているのは
   * `attachSketchInteraction` だけなので、増加に気づいた向こう側が焦点を移す。
   * 道具を選んだ直後に Enter が効くようにするため(NFR-UX-1、NFR-UX-4)。
   */
  readonly focusViewportRequestCount: number;
  /** ビューポート区画の大きさ(画素)。その場入力を端で折り返すのに使う。 */
  readonly viewportSize: readonly [number, number];

  /**
   * 選んでいる道具(FR-301〜309、FR-401〜403)。スケッチの道具に加えて、数値を聞く
   * ソリッドの道具(押し出し・回転・縫合)も入る。和・差・積は押した瞬間に作って
   * 終わるので、道具として選ばれた状態にはならない(§0.a-0.6)。
   */
  readonly activeTool: NumericInputToolId;
  /** 作図面(要件§4.3、§0.a-0.3)。既定は XY。 */
  readonly workPlaneId: WorkPlaneId;

  /**
   * 部品文書。**これが唯一の正本**で、`.pcad` に保存されるのもこれだけ(要件§8、§0.a-0.4)。
   * 差し替える口は `applyDocument` の 1 つだけにし、下の控えはそこで作り直す。
   */
  readonly document: PartDocument;
  /** Undo / Redo の履歴(FR-505)。`present` は常に `document` と同じものを指す。 */
  readonly undoStack: UndoStack<PartDocument>;
  /** 戻せる段・進める段があるか。ツールバーのボタンの入り切りに使う(FR-505)。 */
  readonly canUndo: boolean;
  readonly canRedo: boolean;

  /**
   * 派生の控え(§0.a-0.4)。`document.sketches` のうち `activeSketchId` のもの。
   * 正本は `document` の 1 つだけで、ここは `applyDocument` が同期する。**直接 set しない。**
   * P1 からの読み手(`shell` / `viewport` / `sketch` の 13 ファイル)をそのまま生かすために残す。
   */
  readonly sketch: SketchDocument;
  /** 解決済みの幾何。履歴から導ける実行時の控え(保存しない)。 */
  readonly resolvedSketch: ResolvedSketch;
  /** 面の三角形。カーネルが返したもの。面が無ければ null。 */
  readonly sketchMesh: SketchMesh | null;
  /** いま編集しているスケッチの失敗(FR-504)。部品全体の失敗は `partErrors`。 */
  readonly sketchErrors: readonly SketchError[];

  /** ソリッドのボディ(§0.a-0.5)。カーネルが返した三角形と稜線。 */
  readonly bodies: readonly SolidBody[];
  /** 部品の再計算で集めた失敗。スケッチ側もソリッド側も並ぶ(FR-504)。 */
  readonly partErrors: readonly PartRecomputeError[];
  /** 作り直さずに済んだ段の数(NFR-PF-3 の効き目)。 */
  readonly cacheHits: number;
  /** 計算の進み具合(NFR-PF-4)。計算していなければ null。 */
  readonly recomputeProgress: PartProgress | null;
  /**
   * 中止を頼んだ回数(NFR-PF-4)。`attachPartRecompute` は計算を始めるときの値を覚え、
   * それより増えていたら段と段の間で打ち切る。数で持つのは、止めたい計算が
   * 走っていないときに押されても次の計算へ引きずらないため(§0.a-0.22)。
   */
  readonly cancelRequestCount: number;

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
  /**
   * 面を張れなかった理由の文言キー(FR-309、NFR-UX-5)。履歴には何も積まれていないので
   * `sketchErrors` には出てこない。計算そのものの失敗(`errorMessage`)とは別に持ち、
   * ステータスバーが「面を作れませんでした:」の言い回しで出す。
   */
  readonly faceErrorKey: MessageKey | null;
  /**
   * 立体を作れなかった理由の文言キー(FR-401〜404、NFR-UX-5)。`faceErrorKey` と同じ扱いで、
   * 履歴には何も積まれていないので `partErrors` には出てこない。ステータスバーが
   * 「立体を作れませんでした:」の言い回しで出す。
   */
  readonly solidErrorKey: MessageKey | null;
  /**
   * 最後にビューポートで何かを選んだ場所(canvas の左上を原点とした画素)。
   * ソリッドの道具のその場入力を、選んだものの近くへ出すのに使う(NFR-UX-2)。
   * まだ何も選んでいなければ null で、そのときはビューポートの中央に出す。
   */
  readonly pickAnchor: readonly [number, number] | null;

  // 動作を変える口はメソッド宣言ではなくプロパティ関数型で書く。メソッド宣言だと
  // useAppStore((state) => state.setX) のように取り出したとき @typescript-eslint/unbound-method
  // に触れるため(計画書 P1 §0.a-0.12、docs/報告記録.md 2026-09-02 15:28 の残件②)。
  /** 再計算が投げた失敗を出す・消す。計算中の印はここで下ろす。 */
  readonly setError: (message: string | null) => void;
  readonly setProjection: (projection: ProjectionMode) => void;
  readonly setDisplayStyle: (displayStyle: DisplayStyle) => void;
  readonly setShowGrid: (showGrid: boolean) => void;
  readonly requestHomeView: () => void;
  /** ビューポート(canvas)へ焦点を戻してほしい、と頼む。 */
  readonly requestViewportFocus: () => void;
  readonly setViewportSize: (size: readonly [number, number]) => void;

  readonly setActiveTool: (tool: NumericInputToolId) => void;
  readonly setWorkPlane: (id: WorkPlaneId) => void;
  /** 今の視点に最も近い作図面へ移してほしい、とビューポートへ頼む(§0.a-0.3)。 */
  readonly requestMatchWorkPlaneToView: () => void;
  /** 今の視点に最も近い作図面へ移る(§0.a-0.3 の「視点に合わせる」)。 */
  readonly matchWorkPlaneToView: (orbit: OrbitState) => void;

  /**
   * 部品文書を差し替える(§0.a-0.4)。**文書を差し替えるのはこの口だけ**で、
   * 派生の控えの同期と Undo の積み方をここ 1 箇所で決める。
   */
  readonly applyDocument: (next: PartDocument, options?: ApplyDocumentOptions) => void;
  /** 編集中のスケッチを切り替える。形は変わらないので Undo の段は作らない。 */
  readonly setActiveSketch: (sketchId: string) => void;
  /** 履歴を差し替える。計算中の印を立てるだけで、解決はしない。 */
  readonly setSketch: (sketch: SketchDocument) => void;
  /** スケッチ 1 本ぶんの再計算の結果を反映する(P1 からの口。呼び出し側は変えない)。 */
  readonly applySketch: (sketch: SketchDocument, result: SketchRecomputeResult) => void;
  /** 部品まるごとの再計算の結果を反映する(要件§6.3)。 */
  readonly applyRecompute: (document: PartDocument, result: PartRecomputeResult) => void;
  /** 1 段戻す・1 段進める(FR-505)。戻せる段が無ければ何も起きない。 */
  readonly undo: () => void;
  readonly redo: () => void;
  /** 計算の進み具合を出す・消す(NFR-PF-4)。 */
  readonly setRecomputeProgress: (progress: PartProgress | null) => void;
  /** 計算を止めるよう頼む(NFR-PF-4)。段と段の間でしか止まらない(§2.6 の限界)。 */
  readonly cancelRecompute: () => void;
  /**
   * 履歴の 1 つを差し替える(FR-311)。式を直したときに 1 文字ごとに呼ばれる。
   * 下流は再計算で追従し、壊れたものは `sketchErrors` に出る(FR-504)。
   */
  readonly replaceSketchFeature: (featureId: string, feature: SketchFeature) => void;
  /**
   * 履歴の 1 つを取り除く。参照していた要素が壊れても止めず、理由を出すだけにする
   * (FR-504、NFR-RE-1)。消えたものは選択とホバーからも外れる。
   */
  readonly removeSketchFeature: (featureId: string) => void;
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
  /** 面を張れなかった理由を出す・消す。 */
  readonly setFaceError: (key: MessageKey | null) => void;
  /** 立体を作れなかった理由を出す・消す(FR-401〜404)。 */
  readonly setSolidError: (key: MessageKey | null) => void;
  /** ビューポートで選んだ場所を覚える・忘れる。 */
  readonly setPickAnchor: (anchor: readonly [number, number] | null) => void;
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

/** いま編集しているスケッチ(§0.a-0.4)。指し先が消えていたら先頭を使う。 */
function activeSketchOf(document: PartDocument): SketchDocument {
  return findSketch(document, document.activeSketchId) ?? document.sketches[0];
}

/** 文書を差し替えたときに一緒に作り直す控え(§0.a-0.4)。 */
type DocumentPatch = Pick<
  AppState,
  | 'document'
  | 'undoStack'
  | 'canUndo'
  | 'canRedo'
  | 'sketch'
  | 'documentName'
  | 'featureNames'
  | 'selection'
  | 'hoveredElementId'
>;

/**
 * 文書を差し替え、派生の控えを作り直す。**`document` を書き換えるのはここだけ。**
 *
 * 文書から消えたフィーチャーは選択とホバーからも外す(消えたものを指したままだと、
 * プロパティ欄が空を出し、次に同じ id が採番されたとき別物を選んで見える)。
 */
function documentPatch(
  state: AppState,
  next: PartDocument,
  stack: UndoStack<PartDocument>,
): DocumentPatch {
  const sketch = activeSketchOf(next);
  const liveIds = new Set<string>(sketch.features.map((feature) => feature.id));
  for (const solid of next.solids) {
    liveIds.add(solid.id);
  }
  const hovered = state.hoveredElementId;
  return {
    document: next,
    undoStack: stack,
    canUndo: stackCanUndo(stack),
    canRedo: stackCanRedo(stack),
    sketch,
    documentName: sketch.name,
    featureNames: sketch.features.map((feature) => feature.name),
    selection: state.selection.filter((id) => liveIds.has(featureIdOf(id))),
    hoveredElementId: hovered !== null && !liveIds.has(featureIdOf(hovered)) ? null : hovered,
  };
}

/**
 * いま編集しているスケッチの失敗だけを控えへ写す(§0.a-0.4、FR-504)。
 *
 * 解決の失敗はスケッチごとの結果にそのまま入っている。カーネルが面を作れなかった失敗は
 * 部品全体の `errors` に混ざって届き、型の上では PartError と見分けが付かないので、
 * そのスケッチの要素 id を持ち、かつ解決の失敗として出ていないものを拾い直す。
 * 付け直す code は `recomputePart` が付けるものと同じ `kernelFailed`(強制変換を使わずに
 * 型を狭めるため、拾ったものをそのまま入れずに作り直している)。
 */
function activeSketchErrors(
  sketch: SketchDocument,
  result: PartSketchResult,
  errors: readonly PartRecomputeError[],
): readonly SketchError[] {
  const resolveErrors = result.resolved.errors;
  const reported = new Set(resolveErrors.map((error) => error.featureId));
  const featureIds = new Set(sketch.features.map((feature) => feature.id));
  const kernelErrors: SketchError[] = [];
  for (const error of errors) {
    if (featureIds.has(error.featureId) && !reported.has(error.featureId)) {
      kernelErrors.push({
        featureId: error.featureId,
        code: 'kernelFailed',
        message: error.message,
      });
    }
  }
  return kernelErrors.length === 0 ? resolveErrors : [...resolveErrors, ...kernelErrors];
}

/** テストで元へ戻せるよう、文書まわりの初期値を1箇所にまとめる。 */
export function createInitialDocumentState(): Pick<
  AppState,
  | 'activeTool'
  | 'workPlaneId'
  | 'document'
  | 'undoStack'
  | 'canUndo'
  | 'canRedo'
  | 'sketch'
  | 'resolvedSketch'
  | 'sketchMesh'
  | 'sketchErrors'
  | 'bodies'
  | 'partErrors'
  | 'cacheHits'
  | 'recomputeProgress'
  | 'cancelRequestCount'
  | 'documentName'
  | 'featureNames'
  | 'isComputing'
  | 'errorMessage'
  | 'selection'
  | 'hoveredElementId'
  | 'snapEnabled'
  | 'snapKinds'
  | 'chaining'
  | 'numericInput'
  | 'numericInputAnchor'
  | 'pendingStart'
  | 'snapIndicator'
  | 'faceErrorKey'
  | 'solidErrorKey'
  | 'pickAnchor'
> {
  // 起動時は空のスケッチ 1 本だけを持つ部品から始める(§0.a-0.2、NFR-UX-6 の空状態ガイド)。
  const document = createEmptyPartDocument();
  const sketch = activeSketchOf(document);
  return {
    activeTool: 'select',
    workPlaneId: DEFAULT_WORK_PLANE_ID,
    document,
    undoStack: createUndoStack(document),
    canUndo: false,
    canRedo: false,
    sketch,
    resolvedSketch: resolveSketch(sketch),
    sketchMesh: null,
    sketchErrors: [],
    bodies: [],
    partErrors: [],
    cacheHits: 0,
    recomputeProgress: null,
    cancelRequestCount: 0,
    documentName: sketch.name,
    featureNames: [],
    isComputing: false,
    errorMessage: null,
    selection: [],
    hoveredElementId: null,
    snapEnabled: true,
    snapKinds: DEFAULT_SNAP_KINDS,
    chaining: true,
    numericInput: null,
    numericInputAnchor: null,
    pendingStart: null,
    snapIndicator: null,
    faceErrorKey: null,
    solidErrorKey: null,
    pickAnchor: null,
  };
}

export const useAppStore = create<AppState>()((set, get) => ({
  projection: 'perspective',
  displayStyle: 'shadedWithEdges',
  showGrid: true,
  homeViewRequestCount: 0,
  matchWorkPlaneRequestCount: 0,
  focusViewportRequestCount: 0,
  viewportSize: [0, 0],
  ...createInitialDocumentState(),

  setError: (errorMessage) => {
    set({ errorMessage, isComputing: false, recomputeProgress: null });
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
  requestViewportFocus: () => {
    set((state) => ({ focusViewportRequestCount: state.focusViewportRequestCount + 1 }));
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
      faceErrorKey: null,
      solidErrorKey: null,
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

  applyDocument: (next, options) => {
    set((state) => {
      if (next === state.document) {
        return {};
      }
      const coalesceKey = options?.coalesceKey;
      const stack =
        options?.undoable === false
          ? // 段は増やさないが、present は常に document と同じものにしておく。
            { ...state.undoStack, present: next }
          : pushUndo(state.undoStack, next, { coalesceKey });
      return {
        ...documentPatch(state, next, stack),
        // 束ねる変更(プロパティ欄の 1 文字ごと)では計算中の札を立てない。立てると
        // 打つたびに札が点滅する。再計算は attachPartRecompute が拾い、終わり次第
        // そのまま形が動く(NFR-PF-1)。
        isComputing: coalesceKey === undefined ? true : state.isComputing,
      };
    });
  },
  setActiveSketch: (sketchId) => {
    const state = get();
    if (state.document.activeSketchId === sketchId) {
      // すでにそれを編集している。文書を作り直すと再計算まで走ってしまう(NFR-PF-1)。
      return;
    }
    // 編集する対象を変えるだけで形は変わらないので、Undo の段は作らない(§0.a-0.13)。
    state.applyDocument(activateSketch(state.document, sketchId), { undoable: false });
  },
  setSketch: (sketch) => {
    // 解決はここではしない。attachPartRecompute が非同期に行い applyRecompute で戻す。
    const state = get();
    state.applyDocument(replaceSketch(state.document, sketch));
  },
  applySketch: (sketch, result) => {
    set((state) => {
      const next = replaceSketch(state.document, sketch);
      return {
        // 計算結果の反映は利用者の操作ではないので Undo の段を作らない。
        ...documentPatch(state, next, { ...state.undoStack, present: next }),
        resolvedSketch: result.resolved,
        sketchMesh: result.mesh,
        sketchErrors: result.errors,
        isComputing: false,
        recomputeProgress: null,
      };
    });
  },
  applyRecompute: (document, result) => {
    set((state) => {
      const sketch = activeSketchOf(document);
      const active = result.sketches.find((entry) => entry.sketchId === sketch.id);
      return {
        resolvedSketch: active === undefined ? state.resolvedSketch : active.resolved,
        sketchMesh: active === undefined ? state.sketchMesh : active.mesh,
        sketchErrors:
          active === undefined
            ? state.sketchErrors
            : activeSketchErrors(sketch, active, result.errors),
        // 途中で打ち切られた結果は「作れたところまで」でしかないので、前のボディを
        // 半分だけの形へ置き換えない(NFR-PF-4、§2.6 の限界)。
        bodies: result.cancelled ? state.bodies : result.bodies,
        partErrors: result.errors,
        cacheHits: result.cacheHits,
        documentName: sketch.name,
        featureNames: sketch.features.map((feature) => feature.name),
        isComputing: false,
        recomputeProgress: null,
      };
    });
  },
  undo: () => {
    set((state) => {
      const stack = undoStep(state.undoStack);
      if (stack === state.undoStack) {
        return {};
      }
      return { ...documentPatch(state, stack.present, stack), isComputing: true };
    });
  },
  redo: () => {
    set((state) => {
      const stack = redoStep(state.undoStack);
      if (stack === state.undoStack) {
        return {};
      }
      return { ...documentPatch(state, stack.present, stack), isComputing: true };
    });
  },
  setRecomputeProgress: (recomputeProgress) => {
    set({ recomputeProgress });
  },
  cancelRecompute: () => {
    set((state) => ({ cancelRequestCount: state.cancelRequestCount + 1 }));
  },
  replaceSketchFeature: (featureId, feature) => {
    const state = get();
    // 同じ要素への続けざまの書き換え(プロパティ欄の 1 文字ごと)は Undo の 1 段に
    // まとめる(§0.a-0.13)。まとめないと Ctrl+Z が 1 文字ずつ戻る。
    state.applyDocument(
      replaceSketch(state.document, replaceFeature(state.sketch, featureId, feature)),
      { coalesceKey: `sketchFeature:${featureId}` },
    );
  },
  removeSketchFeature: (featureId) => {
    const state = get();
    state.applyDocument(
      replaceSketch(state.document, removeFeature(state.sketch, featureId)),
    );
  },
  setSelection: (selection) => {
    // 選び直したら、直前に断られた面・立体の理由は用済みなので消す(NFR-UX-5)。
    set({ selection, faceErrorKey: null, solidErrorKey: null });
  },
  toggleSelection: (id) => {
    set((state) => ({
      selection: state.selection.includes(id)
        ? state.selection.filter((selected) => selected !== id)
        : [...state.selection, id],
      faceErrorKey: null,
      solidErrorKey: null,
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
  setFaceError: (faceErrorKey) => {
    set({ faceErrorKey });
  },
  setSolidError: (solidErrorKey) => {
    set({ solidErrorKey });
  },
  setPickAnchor: (pickAnchor) => {
    set({ pickAnchor });
  },
}));

/**
 * 部品を 1 回計算するもの。実物は `recomputePart(document, bridge, options)`。
 * カーネル(Worker)を持たない検査では偽物を差し込めるよう、関数の型で受ける。
 */
export type PartRecomputer = (
  document: PartDocument,
  options: PartRecomputeOptions,
) => Promise<PartRecomputeResult>;

/**
 * 文書の変化を見張り、変わるたびに再計算を予約する(要件§6.3)。
 *
 * 1 本ずつしか走らせない。計算中に文書が何度変わっても覚えるのは**最新の 1 つだけ**で、
 * 間に挟まった版は捨てる。連続入力のたびに Worker を往復させて詰まらせないため
 * (NFR-PF-1)。古い版の結果は捨てるので、`isComputing` が下りるのは最新の計算が
 * 終わったときだけになる。失敗しても例外を投げず、理由を画面に出す(FR-504、NFR-RE-1)。
 *
 * 依頼のたびに世代番号を 1 つ増やして渡す(NFR-PF-4)。番号はここに閉じて持ち、
 * ストアへは出さない。計算を始めるたびにストアを書き換えると、購読の通知の中で
 * さらに書き換えることになるため。中止は `cancelRecompute` が数える回数で拾う。
 *
 * 戻り値を呼ぶと見張りをやめる。
 */
export function attachPartRecompute(recompute: PartRecomputer): () => void {
  let detached = false;
  let running = false;
  /** 実行中に届いた最新の文書。1 つだけ持つ。 */
  let queued: PartDocument | null = null;
  /** 依頼ごとに 1 つ増える世代番号。1 から始まる。 */
  let generation = 0;

  /** 1 本分が終わったときの後始末。次に回す文書があれば返す。 */
  function takeQueued(): PartDocument | null {
    running = false;
    const next = queued;
    queued = null;
    return next;
  }

  function start(document: PartDocument): void {
    running = true;
    generation += 1;
    const current = generation;
    // 中止は「この計算を始めた後に頼まれたか」で判る。始まっていない計算は止められない。
    const cancelBaseline = useAppStore.getState().cancelRequestCount;
    // 前の計算の進み具合は用済み。計算中の札は applyDocument が立てるのでここでは触らない。
    useAppStore.getState().setRecomputeProgress(null);

    void recompute(document, {
      generation: current,
      onProgress: (progress) => {
        // 古い世代の通知は捨てる。画面の進み具合を決めるのは最新の計算だけ。
        if (detached || current !== generation) {
          return;
        }
        useAppStore.getState().setRecomputeProgress(progress);
      },
      shouldCancel: () => useAppStore.getState().cancelRequestCount > cancelBaseline,
    }).then(
      (result) => {
        if (detached) {
          return;
        }
        const next = takeQueued();
        if (next !== null) {
          // もっと新しい文書が来ている。この結果は使わずに次を計算する。
          start(next);
          return;
        }
        useAppStore.getState().applyRecompute(document, result);
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

  function request(document: PartDocument): void {
    if (running) {
      queued = document;
      return;
    }
    start(document);
  }

  request(useAppStore.getState().document);

  const unsubscribe = useAppStore.subscribe((next, previous) => {
    if (next.document !== previous.document) {
      request(next.document);
    }
  });

  return () => {
    detached = true;
    queued = null;
    unsubscribe();
  };
}
