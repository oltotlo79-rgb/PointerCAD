import {
  DEFAULT_WORK_PLANE_ID,
  WORK_PLANES,
  type ResolvedReferences,
  type AssemblyInterferenceResult,
  type ResolvedSketch,
  type SketchMesh,
  type SolidBody,
  type Vec3,
  type WorkPlane,
} from '@pointercad/model';
import * as THREE from 'three';

import { viewportPixelRatio } from './viewportRenderScale.js';

import { capturePrintPng } from '../file/printView.js';
import { captureThumbnailPng, THUMBNAIL_SIZE } from '../file/thumbnail.js';
import type { PointerRay, TrackCandidate } from '../sketch/trackMath.js';
import type { EditPreview } from '../sketch/trimPreview.js';
import { faceIndexOfTriangle } from '../solid/pickSubShape.js';
import type { DisplayStyle, ProjectionMode } from '../store/viewSlice.js';
import {
  buildSketchGeometry,
  EMPTY_RESOLVED_SKETCH,
  NO_HIGHLIGHT,
  type SketchHighlight,
} from './buildSketchGeometry.js';
import { anyNeedsEnvironment } from '../appearance/createAppearanceMaterial.js';
import {
  buildSolidGeometry,
  EMPTY_SOLID_GEOMETRY,
  type AppearanceInput,
} from './buildSolidGeometry.js';
import { createEnvironmentStore, createEnvironmentTarget } from './createEnvironment.js';
import { buildSubShapeGeometry, EMPTY_SUB_SHAPE_HIGHLIGHT } from './buildSubShapeGeometry.js';
import {
  buildSphereGridPositions,
  isValidSphereGridStep,
  type SphereGridSpec,
} from './buildSphereGrid.js';
import {
  cameraPosition,
  clamp,
  HOME_ORBIT,
  orthographicFrustumHeight,
  VERTICAL_FIELD_OF_VIEW,
  type OrbitState,
} from './cameraMath.js';
import type { ConstraintMark } from '../sketch/constraintPicking.js';
import { constraintKindSymbol } from '../sketch/constraintSummary.js';
import { createCanvasLayer, type CanvasDraw } from './canvasLayer.js';
import {
  assemblyAppearanceSpecs,
  createAssemblyLayer,
  EMPTY_ASSEMBLY_GEOMETRY,
  type AssemblyGeometryBundle,
} from './createAssemblyLayer.js';
import { createConstraintLayer } from './createConstraintLayer.js';
import { createInterferenceLayer } from './createInterferenceLayer.js';
import { createMeasureLayer, type MeasurementState } from './createMeasureLayer.js';
import { createReferenceLayer } from './createReferenceLayer.js';
import { createSketchLayer } from './createSketchLayer.js';
import { createTrackingLayer } from './createTrackingLayer.js';
import {
  createSolidLayer,
  type CutPreview,
  type PrintabilityHighlight,
  type SectionHandle,
  type ThreadMarkInfo,
} from './createSolidLayer.js';
import type { SectionPlaneNumbers } from './sectionView.js';
import { axisLength, gridExtent, gridFadeOpacity, gridSpacing, isMajorGridLine } from './gridMath.js';
import { DEFAULT_THEME_COLORS, type ThemeColors } from './themeColors.js';
import { quadLayout, type QuadRectangle, type QuadViewId } from './quadLayout.js';
import type { QuadCameraState } from './quadCamera.js';

/**
 * 1 枚描くときの見せ方。視点はここでも持たず、呼び出しごとに渡されたものを控えるだけ
 * (視点の正本は `attachCameraControls`)。サムネイル(§0.a-0.18)は最後の 1 枚と
 * 同じ見せ方で描き直すため、この控えを使う。
 */
interface RenderSettings {
  readonly orbit: OrbitState;
  readonly projection: ProjectionMode;
  readonly displayStyle: DisplayStyle;
  readonly showGrid: boolean;
  /**
   * UI の拡大率(`DisplaySettings.uiScale`、90〜150)。名前の札(基準軸・座標系)の
   * 画面上の大きさをそろえるのに使う(P4 仕上げ (f)、`createReferenceLayer.ts`)。
   */
  readonly uiScale: number;
}

/**
 * ビューの断面表示(FR-111、P6 タスク35、§2.12)を描くのに要るもの。
 *
 * 平面の**数**は `sectionView.ts` の `toThreePlane`(タスク34、three.js に触れない純関数)が
 * 作る。`THREE.Plane` に組み直すのはここだけで、つまみ(四角と矢印)の四角の大きさは
 * `createSolidLayer` がいま描いているボディから測る。
 */
export interface SectionViewRender {
  /** クリッピング平面の素の数(`normal · x + constant = 0`。残るのは正の側)。 */
  readonly plane: SectionPlaneNumbers;
  /** つまみ(オフセットを載せた後の平面と、残す側)。 */
  readonly handle: SectionHandle;
}

/** ビューポートの描画一式。視点は持たず、呼ばれるたびに渡された視点で描く。 */
export interface ViewportScene {
  /** 明示的な診断時だけ実メッシュ全頂点を投影する。描画ループでは呼ばない。 */
  fullyFramedBodyIds(): readonly string[];
  render(
    orbit: OrbitState,
    projection: ProjectionMode,
    displayStyle: DisplayStyle,
    showGrid: boolean,
    uiScale: number,
  ): void;
  renderQuad(state: QuadCameraState, projection: ProjectionMode, displayStyle: DisplayStyle, showGrid: boolean, uiScale: number): void;
  /** 入力の最初に切り替える。描画待ちの間も選択は対象の区画のカメラを使う。 */
  setActivePane(pane: QuadViewId): void;
  /** スケッチの表示を差し替える(FR-105、FR-310)。 */
  setSketch(sketch: ResolvedSketch, mesh: SketchMesh | null): void;
  /**
   * 構築線(FR-320)として破線で引く要素の id を差し替える(P4 タスク33)。
   * 解決済みの曲線は construction を持たないので、履歴から引いた集合を外から渡す。
   */
  setConstructionIds(ids: ReadonlySet<string>): void;
  /**
   * 完全に決まった要素(FR-313、利用者の決定②(2026-09-05)、P4b タスク22b)の
   * フィーチャー id を差し替える。判定は `constrainedElements.ts` が行い、ここは
   * 受け取った集合を組み立てへ渡すだけにする(判定を 2 か所に置かない)。
   */
  setConstrainedFeatureIds(ids: ReadonlySet<string>): void;
  /** ホバー・選択の強調を差し替える(FR-106)。 */
  setSketchHighlight(hoveredElementId: string | null, selection: readonly string[]): void;
  /** ソリッドの表示を差し替える(FR-105)。ボディの id はフィーチャーの id(§0.a-0.5)。 */
  setBodies(bodies: readonly SolidBody[]): void;
  /**
   * 配置した部品の表示を差し替える(FR-605、P7 タスク10)。
   *
   * 渡すのは `createAssemblyLayer.ts` の `buildAssemblyGeometry` が仕分けた一式で、
   * **形は部品の鍵ごとに 1 つ**・配置は置いた数だけ入っている(§0.a-0.4)。
   * `EMPTY_ASSEMBLY_GEOMETRY` を渡すと消える(アセンブリを開いていないあいだの値)。
   * **同じ一式(同一参照)を渡し直したときは並びを触らない**(NFR-PF-1)。
   */
  setAssembly(bundle: AssemblyGeometryBundle): void;
  /** 干渉解析の共通形状と、一覧で選んだ組を独立層へ渡す。 */
  setInterference(result: AssemblyInterferenceResult | null, selectedKey: string | null): void;
  /**
   * 外観の割り当てを差し替える(FR-1106〜1109、P5 タスク10)。文書の割り当てと、
   * カーネルが選び直した面の対応から `createSolidLayer.ts` の `buildAppearanceInput` が
   * 組み立てたものを渡す。`null` で「割り当て無し」(既定の外観 1 色)に戻る。
   *
   * **形は作り直さない。** 三角形の並びは前のまま(同一参照)で、まとまりと材質だけが
   * 変わる(要件§4.12「外観を変えても再計算は起きず、描画だけが変わる」)。
   */
  setAppearance(appearance: AppearanceInput | null): void;
  /**
   * ボディのホバー・選択の強調を差し替える(FR-106)。
   * ストアの `hoveredElementId` / `selection` をそのまま渡してよい
   * (スケッチの要素 id が混ざっていても、ボディの id と取り違えることはない)。
   */
  setBodyHighlight(hoveredBodyId: string | null, selectedBodyIds: readonly string[]): void;
  /**
   * 部分形状(面・辺・頂点)のホバー・選択の強調を差し替える(FR-106)。
   * `hoveredElementId` / `selection` はストアのものをそのまま渡してよい
   * (スケッチの要素 id・ボディの id が混ざっていても部分形状の id だけを拾う)。
   */
  setSubShapeHighlight(hoveredElementId: string | null, selection: readonly string[]): void;
  /**
   * 切断面の予告表示を差し替える(FR-432、P5 タスク27e、§0.a-0.61)。
   * `null` で消える。**同じ内容(同一参照)を渡し直すと並びを触らない**(NFR-PF-1)ので、
   * 呼び出し側は予告の値を毎回作り直さず、変わったときだけ新しい値を渡す。
   */
  setCutPreview(preview: CutPreview | null): void;
  /**
   * ビューの断面表示(FR-111、P6 タスク35)を差し替える。`null` で切る(元に戻る)。
   *
   * **形は変えない。** 材質のクリッピング平面を差し替えるだけなので、体積も三角形も
   * 1 つも変わらず、再計算(`isComputing`)も走らない。切っていないあいだは平面が
   * 1 枚も無く、費用はゼロ(NFR-PF-1)。
   */
  setSectionView(view: SectionViewRender | null): void;
  /**
   * 3D プリントの点検の色(FR-815、P6 §0.53、タスク46)を出す / 消す。`null` で閉じる。
   *
   * **形は 1 つも変わらない。** 材質の割り当てを一時的に差し替えるだけなので、体積も
   * 三角形も変わらず、再計算(`isComputing`)も走らない。閉じれば元の外観に戻る。
   */
  setPrintability(highlight: PrintabilityHighlight | null): void;
  /**
   * 下絵の画像(FR-332、P6 タスク39)を差し替える。空の並びで消える。
   *
   * **形は 1 つも変わらない。** 下絵は押し出しの材料にも当たり判定にもならないので、
   * 入切・移動・不透明度の変更で再計算(`isComputing`)は走らない(§2.14)。
   * 入切で外したもの・作図面を解けないもの・画像をまだ復号できていないものは、
   * 呼び出し側が並びから外して渡す(この層は渡された分だけを描く)。
   */
  setCanvases(draws: readonly CanvasDraw[]): void;
  /**
   * 球面の案内線(球面グリッド、FR-431、P5 タスク21)を差し替える。`null` で消える。
   *
   * **中身が同じなら組み立て直さない。** 呼び出し側(`ViewportCanvas.tsx`)は文書が
   * 変わるたびに新しい値を作るので、参照ではなく**中心・半径・間隔の値**で見比べる
   * (5 つの数の比較で、7,704 本の組み立てを丸ごと省ける。NFR-PF-1)。
   *
   * 間隔が 1 度未満・90 度超、半径が 0 以下のときは線を引かない(`buildSphereGrid.ts` の
   * 断りをここで受け止め、例外を描画へ持ち込まない。FR-504)。
   */
  setSphereGrid(spec: SphereGridSpec | null): void;
  /**
   * 画面座標(canvas の左上を原点とした画素)にあるボディの featureId。無ければ null
   * (FR-106)。透視投影でも平行投影でも、最後に描いたカメラで判定する。
   */
  pickBody(screenX: number, screenY: number): string | null;
  /**
   * 画面座標にある部品(アセンブリのインスタンス)の id。無ければ null(FR-106)。
   * **非表示にした部品には当たらない**(`createAssemblyLayer.ts` の `pickComponent`)。
   */
  pickComponent(screenX: number, screenY: number): string | null;
  pickAssemblyFace(screenX: number, screenY: number): import('./createAssemblyLayer.js').AssemblyMateFaceHit | null;
  /**
   * 画面座標のところにある面。当たった三角形の番号を、そのボディの面ごとの範囲表で
   * 面の通し番号へ直して返す(`pickSubShape.ts` の `faceIndexOfTriangle`)。当たらなければ
   * null(FR-106)。
   */
  pickFaceAt(
    screenX: number,
    screenY: number,
  ): { readonly featureId: string; readonly faceIndex: number } | null;
  /**
   * いまの絵をもう 1 回描いて、一辺 `size` の PNG のバイト列にする(§0.a-0.18)。
   * `preserveDrawingBuffer` を常時有効にすると描画が重くなる(NFR-PF-1)ので、
   * **描いた直後の同じ同期処理の中**で読む。まだ一度も描いていなければ null。
   */
  captureThumbnail(size?: number): Uint8Array | null;
  /**
   * いまの絵をもう 1 回描いて、**印刷用の 1 コマ**(PNG の data URL)にする
   * (FR-810、FR-908、P6 §2.11、タスク33)。読む時機は `captureThumbnail` と同じ理由で
   * 「描いた直後の同じ同期処理の中」。まだ一度も描いていなければ null。
   *
   * **サムネイルを流用しない。** サムネイルは 256 画素の正方形で下地も画面と同じ暗い色だが、
   * 紙は白く、縦横比も画面のままでなければならない(FR-908)。大きさと下地を決めるのは
   * `printView.ts` の `capturePrintPng`(長辺 `PRINT_IMAGE_MAX`・`PRINT_BACKGROUND`)で、
   * ここはそれを最後の見せ方で描き直してから呼ぶだけにしてある。
   */
  capturePrintFrame(): string | null;
  /**
   * 表示テーマの色を反映する(FR-908)。方眼と軸は色を頂点へ焼き込んでいるので作り直し、
   * 立体・スケッチの各層は材質の色を塗り替えるだけ。**テーマを変えたときにだけ呼ぶ。**
   */
  setThemeColors(colors: ThemeColors): void;
  /**
   * いま描いている作図面(§0.a-0.3)。薄い矩形で向きを示す。
   * 任意の作業平面(FR-328)も出せるよう、id ではなく**解いた面そのもの**を受け取る
   * (解くのはストア側の `workPlane`、P4 タスク13)。
   */
  setWorkPlane(plane: WorkPlane): void;
  /** 作図面の矩形を出すか(3D スケッチでは出さない。FR-330、P4 タスク33)。 */
  setWorkPlaneVisible(visible: boolean): void;
  /**
   * トリム・延長の予告(FR-322、P4 タスク22)。マウスを乗せた区間(消える区間)と、
   * 伸びる区間の折れ線を、もとの線の上へ重ねて描く。`null` で消す。
   */
  setEditPreview(preview: EditPreview | null): void;
  /**
   * 向きの吸着の案内線(FR-110、P4b タスク16)。細い破線を画面いっぱいに引く。
   * 同時に出すのは最大 2 本で、`null` か空で消す。
   */
  setTracking(lines: readonly TrackCandidate[] | null): void;
  /**
   * 拘束の印(FR-313、P4b タスク13)。要素の脇に記号の小さな札を常時出す(§0.a-0.7 の①)。
   * `null` か空で消す。当たり判定は `constraintPicking.ts` の `constraintMarkAt` が
   * 同じ並びを見て行う(描画・当たり判定・選択の 3 つをそろえる、P4 タスク12 の失敗)。
   */
  setConstraintMarks(marks: readonly ConstraintMark[] | null): void;
  /** 一覧・印で選んでいる拘束(FR-313)。その印だけ大きく出す。`null` で解除。 */
  setSelectedConstraint(constraintId: string | null): void;
  /**
   * 線を引いている最中に推定した拘束の**予告**の印(FR-333、P6 タスク41)。
   * 図柄は確定後の拘束の印とまったく同じ(§0.a-0.50)で、`null` か空で消す。
   * 実在の拘束ではないので当たり判定には出ない(押しても選ばれない)。
   */
  setInferredConstraintMarks(marks: readonly ConstraintMark[] | null): void;
  /** 基準ジオメトリ(基準軸・基準点・座標系、FR-329)を出す。 */
  setReferences(references: ResolvedReferences): void;
  /**
   * 測定の結果(FR-1102、P5 タスク31)。測った 2 点を結ぶ線と端の丸、角度の 2 本の線と弧、
   * 値の札を出す。`null` で消す。**同じものを渡し直したときは並びを触らない**(NFR-PF-1)。
   */
  setMeasurement(measurement: MeasurementState | null): void;
  /** ワールド座標を canvas 上の画素座標へ。まだ一度も描いていない・画面の外なら null。 */
  worldToScreen(point: Vec3): readonly [number, number] | null;
  /** canvas 上の画素座標から、作図面の上の点を求める。平面と視線が平行なら null。 */
  screenToPlanePoint(x: number, y: number, plane: WorkPlane): Vec3 | null;
  /**
   * canvas 上の画素座標にあるポインタの光線(カメラの視点からその画素を通る半直線)。
   * ワールド座標系の origin/direction(単位ベクトル)を返す。まだ一度も描いていなければ
   * null。案内線(向きの吸着)の候補位置を、画面上でポインタに最も近い点で決めるのに使う
   * (P4b 仕上げ (a)、`trackMath.ts` の `closestParameterToRay`)。
   */
  pointerRay(x: number, y: number): PointerRay | null;
  resize(widthPixels: number, heightPixels: number): void;
  /** 視点操作中は描画画素を減らし、離したら通常解像度へ戻す。 */
  setInteractiveRendering(active: boolean): void;
  dispose(): void;
}

/**
 * ねじの印(threadMarks)を持つボディ。`SolidBody` はタスク17(橋渡しの拡張)で
 * この欄を必須で持つようになったので、ここでは呼び出し側の型を示すために
 * 同じ欄をそのまま再宣言している(`buildSolidGeometry.ts` の `SolidBodyWithSubShapes` と
 * 同じ考え方、§7)。
 */
interface SolidBodyWithThreadMarks extends SolidBody {
  readonly threadMarks: readonly ThreadMarkInfo[];
}

/** ボディの一覧からねじの印だけを 1 本にまとめる(§0.a-0.15)。 */
function collectThreadMarks(
  bodies: readonly SolidBodyWithThreadMarks[],
): readonly ThreadMarkInfo[] {
  return bodies.flatMap((body) => body.threadMarks ?? []);
}

/**
 * 球面の案内線を球の面からどれだけ外へ持ち上げるか(半径に対する割合、FR-431)。
 *
 * 球の三角形は真球の**内側**に張られる(弦なので必ず内側へ入る)ので、案内線を真半径で
 * 引くと面と深度が競って縞になる。半径の 0.2% だけ外へ出せば、いちばん粗い分割でも面より
 * 確実に手前に来る(r=10 なら 0.02mm。画面では 1 画素に満たない)。吸着で決まる点そのものは
 * **真半径のまま**なので、作られる点の位置はこの持ち上げの影響を受けない。
 */
const SPHERE_GRID_LIFT = 0.002;

/** 本アプリは Z 軸が上(計画書 §0.a-0.9)。three.js の既定(Y 上)から変える。 */
const UP_AXIS = new THREE.Vector3(0, 0, 1);

const NEAR_PLANE = 0.05;
const FAR_PLANE = 200_000;

/*
 * 方眼の色(副線は地から浮きすぎない濃さ、主線はその一段上)と軸の色(X 赤・Y 緑・Z 青)は
 * テーマが決める(FR-104、FR-908)。明るいテーマでは、地が明るいぶん線を濃くする。
 * ビューポートの地そのものは canvas の下の CSS(.pcad-viewport の縦グラデーション)なので、
 * ここでは扱わない。
 */

/** 原点を通る 3 本の軸の向き。色はテーマから取る。 */
const AXIS_DIRECTIONS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** 軸 1 本ぶんの色を、向きの並びと同じ順で取り出す。 */
function axisColorsOf(colors: ThemeColors): readonly number[] {
  return [colors.axisX, colors.axisY, colors.axisZ];
}

/** 軸 1 本を何本の線分に割るか。頂点ごとの薄まりを線の途中でも効かせるために分ける。 */
const AXIS_SEGMENTS_PER_SIDE = 40;

/**
 * 空と地面の色で全体を起こす補助光。真上は白のまま、地面側は地の色に馴染ませるので
 * テーマが決める(--pcad-scene-ground)。明るいテーマでは下面が沈みすぎない明るさにする。
 */
const SKY_COLOR = 0xffffff;
const HEMISPHERE_INTENSITY = 0.9;

/** 面の明暗差を作る主光源。視点の右上前方に置き、カメラに追従させる。 */
const KEY_LIGHT_INTENSITY = 0.8;
const KEY_LIGHT_AZIMUTH_OFFSET = 0.55;
const KEY_LIGHT_ELEVATION_OFFSET = 0.5;
/** 真上・真下から照らすと上面と側面の差が消えるので、仰角に上限を設ける。 */
const KEY_LIGHT_MAX_ELEVATION = 1.2;

/** 位置(3 個)と色+不透明度(4 個)を並べて貯める、線分列の下書き。 */
interface LineBuffer {
  readonly positions: number[];
  readonly colors: number[];
}

function createLineBuffer(): LineBuffer {
  return { positions: [], colors: [] };
}

/**
 * 線分を 1 本足す。両端の不透明度は原点からの距離で決め、遠いほど薄くする。
 * 端点どうしの間は GPU が補間するので、長い線は呼び出し側で細かく割って渡す。
 */
function pushFadedSegment(
  buffer: LineBuffer,
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  color: THREE.Color,
  extent: number,
): void {
  for (const point of [from, to]) {
    buffer.positions.push(point[0], point[1], point[2]);
    buffer.colors.push(
      color.r,
      color.g,
      color.b,
      gridFadeOpacity(Math.hypot(point[0], point[1], point[2]), extent),
    );
  }
}

function toLineGeometry(buffer: LineBuffer): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(buffer.positions, 3));
  // 4 個組にすると three.js が頂点ごとの不透明度として扱う(USE_COLOR_ALPHA)。
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(buffer.colors, 4));
  return geometry;
}

/**
 * 方眼(主線と副線)の線分列を作る(FR-104)。
 *
 * 原点を通る 2 本は軸として別に描くのでここでは引かない。同じ位置に 2 本重ねると
 * 深度が競って縞模様になるため、重ねない作りにして縞模様そのものを起こさせない。
 */
function buildGridGeometry(spacing: number, colors: ThemeColors): THREE.BufferGeometry {
  const extent = gridExtent(spacing);
  const halfCount = Math.round(extent / spacing);
  const minorColor = new THREE.Color(colors.gridMinor);
  const majorColor = new THREE.Color(colors.gridMajor);
  const buffer = createLineBuffer();

  for (let line = -halfCount; line <= halfCount; line += 1) {
    if (line === 0) {
      continue;
    }
    const color = isMajorGridLine(line) ? majorColor : minorColor;
    const offset = line * spacing;
    for (let cell = -halfCount; cell < halfCount; cell += 1) {
      const from = cell * spacing;
      const to = (cell + 1) * spacing;
      pushFadedSegment(buffer, [from, offset, 0], [to, offset, 0], color, extent);
      pushFadedSegment(buffer, [offset, from, 0], [offset, to, 0], color, extent);
    }
  }

  return toLineGeometry(buffer);
}

/** 原点を通る XYZ 軸の線分列を作る(FR-104)。方眼と同じ薄まり方をさせる。 */
function buildAxisGeometry(length: number, colors: ThemeColors): THREE.BufferGeometry {
  const buffer = createLineBuffer();
  const axisColors = axisColorsOf(colors);

  for (let axis = 0; axis < AXIS_DIRECTIONS.length; axis += 1) {
    const direction = AXIS_DIRECTIONS[axis];
    const color = new THREE.Color(axisColors[axis]);
    for (let step = -AXIS_SEGMENTS_PER_SIDE; step < AXIS_SEGMENTS_PER_SIDE; step += 1) {
      const from = (step / AXIS_SEGMENTS_PER_SIDE) * length;
      const to = ((step + 1) / AXIS_SEGMENTS_PER_SIDE) * length;
      pushFadedSegment(
        buffer,
        [direction[0] * from, direction[1] * from, direction[2] * from],
        [direction[0] * to, direction[1] * to, direction[2] * to],
        color,
        length,
      );
    }
  }

  return toLineGeometry(buffer);
}

/** 球面の案内線の中身が同じか(中心・半径・間隔の 5 つの数だけで決まる)。 */
function sameSphereGridSpec(a: SphereGridSpec | null, b: SphereGridSpec | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.radius === b.radius &&
    a.stepDegrees === b.stepDegrees &&
    a.center[0] === b.center[0] &&
    a.center[1] === b.center[1] &&
    a.center[2] === b.center[2]
  );
}

export function createViewportScene(canvas: HTMLCanvasElement): ViewportScene {
  // 背景は CSS(.pcad-viewport の縦グラデーション)に任せ、描画結果だけを重ねる。
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  let interactiveRendering = false;
  renderer.setPixelRatio(viewportPixelRatio(globalThis.devicePixelRatio, interactiveRendering));
  renderer.setClearColor(0x000000, 0);
  /*
    ビューの断面表示(FR-111、P6 タスク35、§2.12)。**材質ごとの**クリッピング平面を
    使うので、レンダラ側でその機能を開けておく。開けるだけでは何も変わらない——
    three.js は `material.clippingPlanes` が空(または null)の材質を従来どおりに描く
    (`WebGLClipping.setState` の先頭で抜ける)ので、断面表示を使わない限り費用はゼロ
    (NFR-PF-1)。レンダラ全体の `renderer.clippingPlanes` は使わない(方眼・軸・
    スケッチ・つまみまで切れてしまうため)。
  */
  renderer.localClippingEnabled = true;

  const scene = new THREE.Scene();
  // シーンの原点は動かさない。毎コマ恒等行列を再設定すると、変更の無い全ての部品へも
  // world 行列の強制更新が伝わる。カメラや各層の動く要素は自身の更新設定で追従する。
  scene.matrixAutoUpdate = false;

  /** いま効いているテーマの色。`setThemeColors` が来るまでは既定(ダーク)。 */
  let colors: ThemeColors = DEFAULT_THEME_COLORS;

  const skyLight = new THREE.HemisphereLight(
    SKY_COLOR,
    DEFAULT_THEME_COLORS.sceneGround,
    HEMISPHERE_INTENSITY,
  );
  // 半球光の「空」の向きは position が決める。Z 上の座標系に合わせる。
  skyLight.position.set(0, 0, 1);
  scene.add(skyLight);

  const keyLight = new THREE.DirectionalLight(0xffffff, KEY_LIGHT_INTENSITY);
  scene.add(keyLight);

  /** 主光源を視点の右上前方へ置き直す。どの向きから見ても隣り合う面に明暗差が出る。 */
  function updateKeyLight(orbit: OrbitState): void {
    const azimuth = orbit.azimuth + KEY_LIGHT_AZIMUTH_OFFSET;
    const elevation = clamp(
      orbit.elevation + KEY_LIGHT_ELEVATION_OFFSET,
      -KEY_LIGHT_MAX_ELEVATION,
      KEY_LIGHT_MAX_ELEVATION,
    );
    const horizontal = Math.cos(elevation);
    // 平行光は向きだけを使うので、既定の目標(原点)から見た単位ベクトルを置けばよい。
    keyLight.position.set(
      horizontal * Math.cos(azimuth),
      horizontal * Math.sin(azimuth),
      Math.sin(elevation),
    );
  }

  const perspectiveCamera = new THREE.PerspectiveCamera(
    (VERTICAL_FIELD_OF_VIEW * 180) / Math.PI,
    1,
    NEAR_PLANE,
    FAR_PLANE,
  );
  perspectiveCamera.up.copy(UP_AXIS);

  // 平行投影は視点の後ろも写す(方眼が手前で切れないように near を負にする)。
  const orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -FAR_PLANE, FAR_PLANE);
  orthographicCamera.up.copy(UP_AXIS);

  /**
   * 方眼と軸で共有する線の材質。頂点ごとの色と不透明度をそのまま使うので材質色は白のまま。
   * 深度は書かないので、方眼と軸が互いを隠すことはない。下書き(スケッチ)は
   * createSketchLayer.ts の renderOrder でこの上に出る。
   */
  const lineMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
  });

  const gridGroup = new THREE.Group();
  scene.add(gridGroup);

  const grid = new THREE.LineSegments(new THREE.BufferGeometry(), lineMaterial);
  gridGroup.add(grid);

  const axisLines = new THREE.LineSegments(new THREE.BufferGeometry(), lineMaterial);
  // 軸は方眼より後に描いて前面に出す(重なりはないが、半透明どうしの順序を決めておく)。
  axisLines.renderOrder = 1;
  gridGroup.add(axisLines);

  const solidLayer = createSolidLayer();
  scene.add(solidLayer.group);

  /*
    配置した部品(FR-605、P7 タスク10)。**部品の立体とは別の層**にする——1 つの窓で開く
    文書は 1 つだけ(§0.a-0.10)なので同時には出ないが、形の持ち方が違う(立体は
    フィーチャーごとに 1 つ、アセンブリは**部品の鍵ごとに 1 つを全インスタンスで共有**)
    ため、同じ入れ物に混ぜると共有の判断が 2 通りに割れる。
    断面表示のクリッピング平面(FR-111)は、下の独立した干渉層と同時に配る。
  */
  const assemblyLayer = createAssemblyLayer();
  scene.add(assemblyLayer.group);
  // 干渉の赤は共有材質を変えず、共通形状だけを独立した層へ重ねる(P7 タスク26)。
  const interferenceLayer = createInterferenceLayer();
  scene.add(interferenceLayer.group);

  /*
    下絵の画像(FR-332、P6 タスク39)。**スケッチの線より必ず後ろ**に描く(§0.a-0.46)ので、
    読む順も層の前後にそろえてスケッチの層より前に足す(実際の前後は足した順ではなく
    `canvasLayer.ts` の `CANVAS_RENDER_ORDER`(-2)が決める)。
    **断面表示のクリッピング平面は配らない**(`solidLayer.setSectionPlanes` の相手にしない)。
    中を見るために断面表示を入れた瞬間に下絵まで切れて消えると、なぞるための紙として
    用を成さないため(タスク39 の判断)。下絵は形ではないので、切っても体積も三角形も変わらない。
  */
  const canvasLayer = createCanvasLayer();
  scene.add(canvasLayer.group);

  const sketchLayer = createSketchLayer();
  sketchLayer.setWorkPlane(WORK_PLANES[DEFAULT_WORK_PLANE_ID]);
  scene.add(sketchLayer.group);

  // 基準ジオメトリ(FR-329)。スケッチの層と同じ理由で、面より後に描く。
  const referenceLayer = createReferenceLayer();
  scene.add(referenceLayer.group);

  // 向きの吸着の案内線(FR-110、P4b タスク16)。下書きより後ろ・面より前に出す。
  const trackingLayer = createTrackingLayer();
  scene.add(trackingLayer.group);
  // 拘束の印(FR-313、タスク13)。「固定」の記号だけは色を分けるので、記号の表の正本
  // (`constraintSummary.ts`)から値として受け取る(同じ表を 2 か所に書かない)。
  const constraintLayer = createConstraintLayer(constraintKindSymbol('fix'));
  scene.add(constraintLayer.group);
  /*
    拘束の自動推定の予告(FR-333、P6 タスク41)。**印の層をもう 1 つ持つ**のは、確定した
    拘束の印(`constraintSummaries` から作る)と予告を別々に差し替えるため。1 つの層に
    混ぜると、再計算で拘束の印が入れ替わるたびに予告が消えてしまう。図柄・大きさ・色は
    同じ層の実装をそのまま使う(§0.a-0.50「P4b の図柄をそのまま出す」)。
  */
  const inferenceLayer = createConstraintLayer(constraintKindSymbol('fix'));
  scene.add(inferenceLayer.group);
  // 測定の結果(FR-1102、P5 タスク31)。線・弧・端の丸・値の札を、他の重ね描きより手前に出す。
  const measureLayer = createMeasureLayer();
  scene.add(measureLayer.group);

  let currentSpacing = 0;

  /**
   * 基準軸(FR-329)を出す長さの、方眼の広がりに対する割合(P4 タスク33)。
   * 方眼と同じ長さだと方眼の線に紛れるので、はっきり内側で終わるようにする。
   */
  const REFERENCE_AXIS_EXTENT_RATIO = 0.55;

  /**
   * 方眼と XYZ 軸を作り直す(FR-104)。間隔が変わったときと、テーマが変わったときだけ呼ぶ
   * (色は頂点ごとの並びへ焼き込むので、テーマの切替では作り直すしかない。
   * 描画のたびには呼ばれないので NFR-PF-1 に触らない)。
   */
  function rebuildGrid(spacing: number): void {
    grid.geometry.dispose();
    grid.geometry = buildGridGeometry(spacing, colors);
    axisLines.geometry.dispose();
    axisLines.geometry = buildAxisGeometry(axisLength(spacing), colors);
    // 作図面の矩形は方眼と同じ広がりにする。
    sketchLayer.setWorkPlaneExtent(gridExtent(spacing));
    // 基準軸は方眼より**短く**する(P4 タスク33、タスク9・13 の申し送り)。
    // 方眼と同じ長さだと方眼の線と見分けが付かず、どこまでが軸なのか分からなかった。
    referenceLayer.setAxisHalfLength(gridExtent(spacing) * REFERENCE_AXIS_EXTENT_RATIO);
    // 案内線は方眼と同じ広がりまで伸ばす(視野のおよそ 2 倍なので「画面いっぱい」になる)。
    trackingLayer.setHalfLength(gridExtent(spacing));
    currentSpacing = spacing;
  }
  rebuildGrid(gridSpacing(HOME_ORBIT.distance));

  let width = 1;
  let height = 1;
  let sizeInitialized = false;

  /** スケッチの現在値。組み立て直すのは変化したときだけ(NFR-PF-1)。 */
  let resolvedSketch: ResolvedSketch = EMPTY_RESOLVED_SKETCH;
  let sketchMesh: SketchMesh | null = null;
  let sketchHighlight: SketchHighlight = NO_HIGHLIGHT;
  /** 構築線(FR-320)として破線で引く要素の id。履歴から引いた集合を外から入れてもらう。 */
  let constructionIds: ReadonlySet<string> = new Set<string>();
  /** 完全に決まった要素(FR-313、タスク22b)の id。これも外から入れてもらう。 */
  let constrainedIds: ReadonlySet<string> = new Set<string>();
  let sketchBundle = buildSketchGeometry(resolvedSketch, sketchMesh, sketchHighlight);

  /** ボディの現在値。組み立て直すのは変化したときだけ(NFR-PF-1)。 */
  let bodies: readonly SolidBody[] = [];
  let hoveredBodyId: string | null = null;
  let selectedBodyIds: readonly string[] = [];
  /** 外観の割り当て(FR-1106)。無ければ既定の外観 1 色になる。 */
  let appearanceInput: AppearanceInput | null = null;
  let solidBundle = EMPTY_SOLID_GEOMETRY;

  /**
   * 配置した部品(FR-605、タスク10)。アセンブリを開いていないあいだは空のまま
   * (形も入れ物も 1 つも作らないので費用はゼロ)。
   */
  let assemblyBundle: AssemblyGeometryBundle = EMPTY_ASSEMBLY_GEOMETRY;

  /**
   * 映り込み用の環境マップ(FR-1107、§0.a-0.9)。**鏡・ガラスを 1 つでも使っているときだけ
   * 作り、使わなくなったら捨てる**(NFR-PF-5)。レンダラを持っているのはここだけなので、
   * 作る・捨てるの判断もここで行い、`createSolidLayer` へはできあがったものを渡す。
   */
  const environments = createEnvironmentStore(() => createEnvironmentTarget(renderer));

  /**
   * いまの外観で環境マップが要るかを見直す。**組み立て直したときにだけ呼ぶ**
   * (毎コマ呼ぶと、鏡を 1 つ足すたびに焼き直すことになる)。
   */
  function refreshEnvironment(): void {
    const used = [
      ...solidBundle.entries.flatMap((entry) => entry.appearances),
      ...assemblyAppearanceSpecs(assemblyBundle),
    ];
    if (anyNeedsEnvironment(used)) {
      environments.ensureEnvironment(scene);
      return;
    }
    environments.releaseEnvironment(scene);
  }

  /** ボディ・強調・外観のどれかが変わったときに、描画用の並びを作り直す。 */
  function rebuildSolidBundle(): void {
    solidBundle = buildSolidGeometry(
      bodies,
      hoveredBodyId,
      selectedBodyIds,
      appearanceInput ?? undefined,
    );
    refreshEnvironment();
  }

  /** 部分形状(面・辺・頂点)の強調の現在値(§0.a-0.7)。 */
  let subShapeHoveredElementId: string | null = null;
  let subShapeSelection: readonly string[] = [];
  let subShapeBundle = EMPTY_SUB_SHAPE_HIGHLIGHT;

  /** ねじの簡略表示の印(§0.a-0.15)。ボディの一覧から導くだけで、別の入力は持たない。 */
  let threadMarks: readonly ThreadMarkInfo[] = [];

  /** 切断面の予告(FR-432、タスク27e)。道具を使っている間だけ入り、確定・取消で null に戻る。 */
  let cutPreview: CutPreview | null = null;

  /**
   * ビューの断面表示(FR-111、タスク35)のクリッピング平面。**1 枚を使い回す**
   * (引いている最中は中身だけ書き換える)。切っているあいだは材質へ配らない。
   */
  const sectionPlane = new THREE.Plane();
  /** いま平面を配ってあるか。枚数(0 ↔ 1)が変わったときだけ材質へ配り直す。 */
  let sectionActive = false;

  /** 球面の案内線(FR-431、タスク21)。出していないときは null。 */
  let sphereGridSpec: SphereGridSpec | null = null;
  let sphereGridPositions: Float32Array | null = null;

  /** 最後に描いたときのカメラ。画面座標との行き来はこれが決まってからでないとできない。 */
  let lastCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera | null = null;
  /** 最後に描いたときの見せ方。サムネイルを撮るときに同じ絵を描き直すのに使う。 */
  let lastRender: RenderSettings | null = null;
  let lastQuad: QuadCameraState | null = null;
  let quadProjection: ProjectionMode = 'perspective';
  let activeRectangle: QuadRectangle = { x: 0, y: 0, width, height };
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  const scratch = new THREE.Vector3();
  const intersection = new THREE.Vector3();
  const pickPlane = new THREE.Plane();
  const planeNormal = new THREE.Vector3();
  const planeOrigin = new THREE.Vector3();

  /** 1 枚描く。表示スタイルの反映からカメラの置き直しまで、絵を作る手順はここだけ。 */
  function drawScene(settings: RenderSettings, rectangle: QuadRectangle, spacing: number): void {
    const { orbit, projection, displayStyle, showGrid, uiScale } = settings;
    if (spacing !== currentSpacing) {
      rebuildGrid(spacing);
    }
    gridGroup.visible = showGrid;

    // 立体とスケッチは組み立て直したときだけ並びを差し替える(同じ結果なら表示の入切だけ)。
    solidLayer.update(solidBundle, displayStyle, environments.texture);
    solidLayer.updateSubShapes(subShapeBundle);
    solidLayer.updateThreadMarks(threadMarks);
    solidLayer.updateCutPreview(cutPreview);
    solidLayer.updateSphereGrid(sphereGridPositions);
    // 配置した部品(FR-605)。同じ一式を渡し直したときは並びを触らない(NFR-PF-1)。
    assemblyLayer.update(assemblyBundle, displayStyle, environments.texture);
    sketchLayer.update(sketchBundle, displayStyle);
    // 名前の札(基準軸・座標系)の画面上の大きさをそろえ直す(P4 仕上げ (f))。
    // ズームでカメラ距離が変わるたびに効くよう、描画のたびに計算し直す。
    referenceLayer.updateScreenScale(orbit.distance / (orbit.zoom ?? 1), rectangle.height, uiScale);
    // 測定の値の札も同じ大きさ(約 13px)にそろえる(P5 タスク31)。
    measureLayer.updateScreenScale(orbit.distance / (orbit.zoom ?? 1), rectangle.height, uiScale);

    updateKeyLight(orbit);
    renderer.render(scene, configureCamera(orbit, projection, rectangle));
  }

  function configureCamera(orbit: OrbitState, projection: ProjectionMode, rectangle: QuadRectangle): THREE.Camera {
    const [x, y, z] = cameraPosition(orbit);
    const aspect = rectangle.width / rectangle.height;
    const camera = projection === 'perspective' ? perspectiveCamera : orthographicCamera;

    if (projection === 'perspective') {
      perspectiveCamera.aspect = aspect;
    } else {
      // 透視投影と見た目の大きさを揃える(FR-102)。
      const frustumHeight = orthographicFrustumHeight(orbit.distance);
      orthographicCamera.top = frustumHeight / 2;
      orthographicCamera.bottom = -frustumHeight / 2;
      orthographicCamera.left = (-frustumHeight * aspect) / 2;
      orthographicCamera.right = (frustumHeight * aspect) / 2;
    }
    camera.position.set(x, y, z);
    if (orbit.up === undefined) camera.up.copy(UP_AXIS);
    else camera.up.set(...orbit.up);
    camera.zoom = orbit.zoom ?? 1;
    camera.lookAt(orbit.target[0], orbit.target[1], orbit.target[2]);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    // 画面座標との行き来(worldToScreen / screenToPlanePoint / pickBody)はこのカメラで行う。
    lastCamera = camera;
    activeRectangle = rectangle;
    return camera;
  }

  function setPointer(screenX: number, screenY: number): void {
    pointerNdc.set(2 * (screenX - activeRectangle.x) / activeRectangle.width - 1,
      1 - 2 * (screenY - activeRectangle.y) / activeRectangle.height);
  }

  function quadPanes() {
    const ratio = renderer.getPixelRatio();
    const logical = (rectangle: QuadRectangle): QuadRectangle => ({
      x: rectangle.x / ratio, y: rectangle.y / ratio,
      width: rectangle.width / ratio, height: rectangle.height / ratio,
    });
    return quadLayout(canvas.width, canvas.height, quadProjection)
      .filter((pane) => pane.rectangle.width > 0 && pane.rectangle.height > 0)
      .map((pane) => ({ ...pane, rectangle: logical(pane.rectangle), scissor: logical(pane.scissor) }));
  }

  function activatePane(id: QuadViewId): void {
    if (lastQuad === null) return;
    const pane = quadPanes().find((entry) => entry.id === id);
    if (pane === undefined) return;
    lastQuad = { ...lastQuad, active: id };
    configureCamera(lastQuad.orbits[id], pane.projection, pane.rectangle);
  }

  /** サムネイル・印刷も4区画を同じ同期描画で再現する。 */
  function redraw(): void {
    if (lastRender === null) return;
    if (lastQuad === null) {
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, width, height);
      drawScene(lastRender, { x: 0, y: 0, width, height }, gridSpacing(lastRender.orbit.distance));
      return;
    }
    // 共通格子を区画ごとに作り直さない。最大距離で1回だけ間隔を決める。
    const spacing = gridSpacing(Math.max(...Object.values(lastQuad.orbits).map((entry) => entry.distance)));
    renderer.setScissorTest(true);
    try {
      for (const pane of quadPanes()) {
        const box = pane.scissor;
        renderer.setViewport(box.x, box.y, box.width, box.height);
        renderer.setScissor(box.x, box.y, box.width, box.height);
        drawScene({ ...lastRender, orbit: lastQuad.orbits[pane.id], projection: pane.projection }, pane.rectangle, spacing);
      }
    } finally {
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, width, height);
      activatePane(lastQuad.active);
    }
  }

  return {
    setSketch(nextSketch, nextMesh): void {
      resolvedSketch = nextSketch;
      sketchMesh = nextMesh;
      sketchBundle = buildSketchGeometry(
        resolvedSketch,
        sketchMesh,
        sketchHighlight,
        constructionIds,
        constrainedIds,
      );
    },

    setConstructionIds(ids): void {
      constructionIds = ids;
      sketchBundle = buildSketchGeometry(
        resolvedSketch,
        sketchMesh,
        sketchHighlight,
        constructionIds,
        constrainedIds,
      );
    },

    setConstrainedFeatureIds(ids): void {
      constrainedIds = ids;
      sketchBundle = buildSketchGeometry(
        resolvedSketch,
        sketchMesh,
        sketchHighlight,
        constructionIds,
        constrainedIds,
      );
    },

    setSketchHighlight(hoveredElementId, selection): void {
      sketchHighlight = { hoveredElementId, selection };
      sketchBundle = buildSketchGeometry(
        resolvedSketch,
        sketchMesh,
        sketchHighlight,
        constructionIds,
        constrainedIds,
      );
    },

    setBodies(nextBodies): void {
      bodies = nextBodies;
      rebuildSolidBundle();
      // ボディの形が変わると強調する三角形・線分の座標も変わるので組み立て直す。
      subShapeBundle = buildSubShapeGeometry(bodies, subShapeHoveredElementId, subShapeSelection);
      // ねじの印もボディの一覧から導く値なので、ここで一緒に組み立て直す(§0.a-0.15)。
      threadMarks = collectThreadMarks(bodies);
    },

    setAssembly(bundle): void {
      // 仕分け(どの形をいくつ置くか)は純関数が済ませてある。ここは覚えるだけで、
      // 入れ物への流し込みは次に描くとき(`drawScene`)に 1 回だけ行う。
      assemblyBundle = bundle;
      refreshEnvironment();
    },

    setInterference(result, selectedKey): void {
      interferenceLayer.update(result, selectedKey);
    },

    setBodyHighlight(nextHovered, nextSelected): void {
      hoveredBodyId = nextHovered;
      selectedBodyIds = nextSelected;
      rebuildSolidBundle();
    },

    setAppearance(appearance): void {
      appearanceInput = appearance;
      rebuildSolidBundle();
    },

    setSubShapeHighlight(hoveredElementId, selection): void {
      subShapeHoveredElementId = hoveredElementId;
      subShapeSelection = selection;
      subShapeBundle = buildSubShapeGeometry(bodies, subShapeHoveredElementId, subShapeSelection);
    },

    setCutPreview(preview): void {
      cutPreview = preview;
    },

    setSectionView(view): void {
      if (view === null) {
        if (sectionActive) {
          // 平面の枚数が 0 に戻ったことを材質へ知らせる(空なら three.js は素通りする)。
          solidLayer.setSectionPlanes([]);
          assemblyLayer.setSectionPlanes([]);
          interferenceLayer.setSectionPlanes([]);
          sectionActive = false;
        }
        solidLayer.updateSectionHandle(null);
        return;
      }
      /*
        引いている最中は**同じ `THREE.Plane` の中身だけ**を書き換える(タスク34 の申し送り)。
        材質が持っているのは入れ物への参照なので、枚数が変わらないかぎり配り直さなくてよく、
        three.js もシェーダを組み直さない(1 コマの中で終わる、NFR-PF-1)。
      */
      sectionPlane.normal.set(view.plane.normal[0], view.plane.normal[1], view.plane.normal[2]);
      sectionPlane.constant = view.plane.constant;
      if (!sectionActive) {
        solidLayer.setSectionPlanes([sectionPlane]);
        assemblyLayer.setSectionPlanes([sectionPlane]);
        interferenceLayer.setSectionPlanes([sectionPlane]);
        sectionActive = true;
      }
      solidLayer.updateSectionHandle(view.handle);
    },

    setPrintability(highlight): void {
      solidLayer.setPrintabilityHighlight(highlight);
    },

    setCanvases(draws): void {
      canvasLayer.update(draws);
    },

    setSphereGrid(spec): void {
      if (sameSphereGridSpec(sphereGridSpec, spec)) {
        return;
      }
      sphereGridSpec = spec;
      sphereGridPositions =
        spec === null || !isValidSphereGridStep(spec.stepDegrees) || !(spec.radius > 0)
          ? null
          : buildSphereGridPositions({ ...spec, radius: spec.radius * (1 + SPHERE_GRID_LIFT) });
    },

    pickBody(screenX, screenY): string | null {
      if (lastCamera === null) {
        return null;
      }
      setPointer(screenX, screenY);
      // 平行投影でも setFromCamera が視線の起点と向きを組み立て直す(three.js が
      // カメラの種類を見て分ける)ので、投影の切替でそのまま動く。
      raycaster.setFromCamera(pointerNdc, lastCamera);
      return solidLayer.pickBody(raycaster);
    },

    pickComponent(screenX, screenY): string | null {
      if (lastCamera === null) {
        return null;
      }
      setPointer(screenX, screenY);
      raycaster.setFromCamera(pointerNdc, lastCamera);
      return assemblyLayer.pickComponent(raycaster);
    },

    pickAssemblyFace(screenX, screenY) {
      if (lastCamera === null) return null;
      setPointer(screenX, screenY);
      raycaster.setFromCamera(pointerNdc, lastCamera);
      return assemblyLayer.pickMateFace(raycaster);
    },

    pickFaceAt(screenX, screenY): { readonly featureId: string; readonly faceIndex: number } | null {
      if (lastCamera === null) {
        return null;
      }
      setPointer(screenX, screenY);
      raycaster.setFromCamera(pointerNdc, lastCamera);
      const hit = solidLayer.pickFace(raycaster);
      if (hit === null) {
        return null;
      }
      // 当たった三角形の通し番号を、そのボディの面ごとの範囲表で面の通し番号へ直す。
      const entry = solidBundle.index.get(hit.featureId);
      if (entry === undefined) {
        return null;
      }
      const faceIndex = faceIndexOfTriangle(entry.faces, hit.triangleIndex);
      return faceIndex === null ? null : { featureId: hit.featureId, faceIndex };
    },

    captureThumbnail(size = THUMBNAIL_SIZE): Uint8Array | null {
      if (lastRender === null) {
        // まだ一度も描いていない(3D 表示部の読み込み中)。
        // サムネイルなしで保存する(§0.a-0.18)。
        return null;
      }
      // 画面へ出した時点で描画バッファは捨てられるので、最後と同じ見せ方で描き直し、
      // **同じ同期処理の中で**読む。間に非同期の待ちを挟んではいけない。
      redraw();
      return captureThumbnailPng(canvas, size);
    },

    capturePrintFrame(): string | null {
      if (lastRender === null) {
        // まだ一度も描いていない(3D 表示部の読み込み中)。印刷は断る(NFR-UX-5)。
        return null;
      }
      // サムネイルと同じ理由で、最後と同じ見せ方で描き直して**同じ同期処理の中で**読む。
      redraw();
      return capturePrintPng(canvas);
    },

    setThemeColors(next): void {
      colors = next;
      // 方眼と軸は頂点ごとの色を持つので、いまの間隔のまま組み立て直す。
      rebuildGrid(currentSpacing);
      skyLight.groundColor.setHex(colors.sceneGround);
      solidLayer.setThemeColors(colors);
      assemblyLayer.setThemeColors(colors);
      interferenceLayer.setThemeColors(colors);
      sketchLayer.setThemeColors(colors);
      referenceLayer.setThemeColors(colors);
      trackingLayer.setThemeColors(colors);
      constraintLayer.setThemeColors(colors);
      inferenceLayer.setThemeColors(colors);
      measureLayer.setThemeColors(colors);
    },

    setWorkPlaneVisible(visible): void {
      sketchLayer.setWorkPlaneVisible(visible);
    },

    setWorkPlane(plane): void {
      sketchLayer.setWorkPlane(plane);
    },

    setEditPreview(preview): void {
      sketchLayer.setEditPreview(preview);
    },

    setTracking(lines): void {
      trackingLayer.setLines(lines);
    },

    setConstraintMarks(marks): void {
      constraintLayer.setMarks(marks);
    },

    setSelectedConstraint(constraintId): void {
      constraintLayer.setSelected(constraintId);
    },

    setInferredConstraintMarks(marks): void {
      inferenceLayer.setMarks(marks);
    },

    setReferences(references): void {
      referenceLayer.update(references);
    },

    setMeasurement(measurement): void {
      measureLayer.update(measurement);
    },

    fullyFramedBodyIds(): readonly string[] {
      if (lastCamera === null) return [];
      const camera = lastCamera;
      return bodies.filter((body) => {
        const positions = body.mesh.positions;
        if (positions.length === 0) return false;
        for (let i = 0; i < positions.length; i += 3) {
          scratch.set(positions[i], positions[i + 1], positions[i + 2]).project(camera);
          if (![scratch.x, scratch.y, scratch.z].every((value) => Number.isFinite(value) && Math.abs(value) <= 1)) return false;
        }
        return true;
      }).map((body) => body.featureId);
    },

    worldToScreen(point): readonly [number, number] | null {
      if (lastCamera === null) {
        return null;
      }
      scratch.set(point[0], point[1], point[2]).project(lastCamera);
      // 視点の後ろ(z > 1)や手前の切り取り面より近い点は画面に無い。
      if (scratch.z < -1 || scratch.z > 1) {
        return null;
      }
      return [activeRectangle.x + ((scratch.x + 1) / 2) * activeRectangle.width,
        activeRectangle.y + ((1 - scratch.y) / 2) * activeRectangle.height];
    },

    screenToPlanePoint(x, y, plane): Vec3 | null {
      if (lastCamera === null) {
        return null;
      }
      setPointer(x, y);
      raycaster.setFromCamera(pointerNdc, lastCamera);
      planeNormal.set(plane.normal[0], plane.normal[1], plane.normal[2]);
      planeOrigin.set(plane.origin[0], plane.origin[1], plane.origin[2]);
      pickPlane.setFromNormalAndCoplanarPoint(planeNormal, planeOrigin);
      const hit = raycaster.ray.intersectPlane(pickPlane, intersection);
      return hit === null ? null : [hit.x, hit.y, hit.z];
    },

    pointerRay(x, y): PointerRay | null {
      if (lastCamera === null) {
        return null;
      }
      setPointer(x, y);
      // 平行投影でも setFromCamera が視線の起点と向きを組み立て直す(pickBody と同じ事情)。
      raycaster.setFromCamera(pointerNdc, lastCamera);
      const { origin, direction } = raycaster.ray;
      return {
        origin: [origin.x, origin.y, origin.z],
        direction: [direction.x, direction.y, direction.z],
      };
    },

    resize(widthPixels, heightPixels): void {
      const nextWidth = Math.max(widthPixels, 1);
      const nextHeight = Math.max(heightPixels, 1);
      if (sizeInitialized && width === nextWidth && height === nextHeight) return;
      width = nextWidth;
      height = nextHeight;
      sizeInitialized = true;
      // CSS の大きさは指定済みなので描画バッファだけを合わせる。
      renderer.setSize(width, height, false);
    },

    setInteractiveRendering(active): void {
      if (interactiveRendering === active) {
        return;
      }
      interactiveRendering = active;
      // setPixelRatio 自身が現在の論理サイズで setSize を呼ぶ。重ねて呼ぶと
      // canvas.width/height が再代入され、同じ寸法でも描画バッファを再確保してしまう。
      renderer.setPixelRatio(viewportPixelRatio(globalThis.devicePixelRatio, interactiveRendering));
    },

    render(orbit, projection, displayStyle, showGrid, uiScale): void {
      lastQuad = null;
      lastRender = { orbit, projection, displayStyle, showGrid, uiScale };
      redraw();
    },

    renderQuad(state, projection, displayStyle, showGrid, uiScale): void {
      lastQuad = state;
      quadProjection = projection;
      lastRender = { orbit: state.orbits[state.active], projection, displayStyle, showGrid, uiScale };
      redraw();
    },

    setActivePane: activatePane,

    dispose(): void {
      // 環境マップはレンダーターゲット 1 枚ぶんの資源なので、画面ごと閉じるときに捨てる。
      environments.dispose();
      solidLayer.dispose();
      // 配置した部品の共有の形と材質も、画面ごと閉じるときに必ず捨てる(P5 §7.3)。
      assemblyLayer.dispose();
      interferenceLayer.dispose();
      // 下絵はテクスチャを持つ(P5 §4)ので、画面ごと閉じるときに必ず捨てる。
      canvasLayer.dispose();
      sketchLayer.dispose();
      referenceLayer.dispose();
      trackingLayer.dispose();
      constraintLayer.dispose();
      inferenceLayer.dispose();
      measureLayer.dispose();
      grid.geometry.dispose();
      axisLines.geometry.dispose();
      lineMaterial.dispose();
      skyLight.dispose();
      keyLight.dispose();
      renderer.dispose();
    },
  };
}
