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
import { recordReferenceRepairRejection, readReferenceRepairRejections, borrowReferenceRepairPreview, type ReferenceRepairPreview, type ReferenceRepairPreviewBorrow,
  type RepairPreviewReceipt, type RepairPreviewInspection } from '../solid/referenceRepairPreview.js';

import { viewportPixelRatio } from './viewportRenderScale.js';

import { capturePrintPng } from '../file/printView.js';
import { captureThumbnailPng, THUMBNAIL_SIZE, reportThumbnailCaptureReason, type ThumbnailCaptureReasonSink } from '../file/thumbnail.js';
import type { PointerRay, TrackCandidate } from '../sketch/trackMath.js';
import type { EditPreview } from '../sketch/trimPreview.js';
import { faceIndexOfTriangle } from '../solid/pickSubShape.js';
import { subShapeFrameOrigin } from '../solid/subShapeSelection.js';
import type { DisplayStyle, ProjectionMode } from '../store/viewSlice.js';
import { activeAssemblyDocument } from '../store/documentKind.js';
import { assemblyUiBackings, assemblyMeshBudget, captureAssemblyMeshAdmission, currentAssemblyMeshAdmission,
  type AssemblyUiBackingLedger, type AssemblyMeshAdmission } from './assemblyMeshAdmission.js';
import {
  buildSketchGeometry,
  EMPTY_RESOLVED_SKETCH,
  NO_HIGHLIGHT,
  type SketchHighlight,
} from './buildSketchGeometry.js';
import { anyNeedsEnvironment } from '../appearance/createAppearanceMaterial.js';
import {
  buildSolidGeometry,
  AllocatedBackingRegistrationError,
  DisplayCopyCache,
  distinctBackingBytes,
  EMPTY_SOLID_GEOMETRY,
  type AppearanceInput,
  type SolidGeometryBundle,
} from './buildSolidGeometry.js';
import { createEnvironmentStore, createEnvironmentTarget } from './createEnvironment.js';
import {
  buildSubShapeGeometry, EMPTY_SUB_SHAPE_HIGHLIGHT, subShapeOverlayBytes, type SubShapeHighlightBundle,
} from './buildSubShapeGeometry.js';
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
import { createSolidFieldLayer } from '../solidAnalysis/solidFieldLayer.js';
import type { SolidFieldMesh } from '../solidAnalysis/solidFieldView.js';
import { createSolidModeLayer, type SolidModeDrawing } from '../solidAnalysis/solidModeLayer.js';
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
import { createViewportLifetime, ViewportResourceInitializationFailure, type ViewportLifetime } from './viewportLifetime.js';
import type { createViewportMeshObservation, ViewportMeshOwner } from './viewportMeshObservation.js';
import { quadLayout, type QuadRectangle, type QuadViewId } from './quadLayout.js';
import type { QuadCameraState } from './quadCamera.js';
import {
  captureSolidMeshAdmission, captureWorldMeshAdmission, displayCopyBaseline, isSolidMeshAdmissionCurrent,
  meshLayoutsUnchanged, type GpuMeshBudget, type SolidMeshAdmission, type SolidMeshAdmissionState,
} from './solidMeshAdmission.js';

/** Host acquisitions remain retryable; constructor-internal native resources are unobserved. */
export class ViewportSceneInitializationFailure extends Error {
  constructor(readonly initializationCause: unknown, readonly cleanup: ViewportLifetime) {
    super('Viewport scene initialization failed');
    this.name = 'ViewportSceneInitializationFailure';
  }
}

export interface ViewportSceneOptions {
  /** Defaults to the shared application lifetime; every Scene of that lifetime uses one identity union. */
  readonly uiBackings?: AssemblyUiBackingLedger;
  readonly observation?: ReturnType<typeof createViewportMeshObservation>;
  readonly viewportOwnerId?: string;
  readonly readSolidMeshState?: () => SolidMeshAdmissionState;
  /** Shared finite GPU mesh-buffer reservations for local displays; this scene is one owner. */
  readonly gpuMeshBudget?: GpuMeshBudget;
}

/**
 * Known finite mesh reservations of one scene. CPU display copies are the UI-created UVs,
 * patterned drawing copies and overlays (each typed backing once); GPU mesh bytes are the
 * layer's mesh attributes (per attribute, never merged by CPU aliasing). `uncovered` lists the
 * resources neither number includes, which therefore stay unknown rather than zero.
 */
export interface ViewportMeshReservation {
  /** Registered application UI union, including live borrowers after owner retirement; native/GPU remain uncovered. */
  readonly repairPreviewRejections?: ReturnType<typeof readReferenceRepairRejections>;
  readonly registeredUiBackingBytes?: number | null;
  readonly registeredUiPendingBytes?: number;
  readonly displayCopyBytes: number;
  readonly gpuMeshBytes: number;
  readonly assemblySourceBackingBytes: number;
  readonly assemblyInstanceBytes: number;
  readonly assemblyCleanupReservedCpuBytes: number;
  readonly assemblyCleanupStatus: 'complete' | 'pending';
  readonly viewportCleanupStatus: 'complete' | 'pending';
  readonly viewportCleanupErrors: readonly string[];
  readonly uncovered: readonly string[];
}

const UNCOVERED_MESH_RESOURCES: readonly string[] = Object.freeze(['textures', 'pmrem', 'materials',
  'threadMarks', 'sphereGrid', 'cutPreview', 'sectionHandle', 'printOpenEdges', 'jsObjectOverhead']);
const GPU_MESH_BUDGET_MESSAGE = 'Local display mesh buffers exceed the GPU budget';
const LOCAL_ENVIRONMENT_MESSAGE = 'Local display needs an environment map whose GPU reservation is unknown';

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

/** Results of this pick's existing gates; writing here never evaluates a gate again. */
export interface AssemblyFacePickObservation {
  ownerPresent?: boolean;
  displayInvalidated?: boolean;
  partCount?: number;
  ownerAccepted?: boolean;
  cameraReady?: boolean;
}

/** ビューポートの描画一式。視点は持たず、呼ばれるたびに渡された視点で描く。 */
export interface ViewportScene {
  /** 明示的な診断時だけ実メッシュ全頂点を投影する。描画ループでは呼ばない。 */
  fullyFramedBodyIds(): readonly string[];
  /** The published bundle's known CPU display-copy and GPU mesh-attribute reservations. */
  meshReservation(): ViewportMeshReservation;
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
  setReferenceRepairPreview(preview: ReferenceRepairPreview | null): Promise<void>;
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
   * The solid-analysis field overlay (display only). `null` removes it. Only the overlay's own geometry and material
   * are created and disposed here; bodies, picking and resource reservations are not involved.
   */
  setAnalysisField(field: SolidFieldMesh | null): void;
  /** Mode-shape overlay (display only); the caller keeps it exclusive with the analysis field. */
  setAnalysisMode(preview: SolidModeDrawing | null): void;
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
  pickAssemblyFace(screenX: number, screenY: number, observation?: AssemblyFacePickObservation): import('./createAssemblyLayer.js').AssemblyMateFaceHit | null;
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
  captureThumbnail(size?: number, reasonSink?: ThumbnailCaptureReasonSink): Uint8Array | null;
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

function toLineGeometry(buffer: LineBuffer, acquire?: (geometry: THREE.BufferGeometry) => void): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  acquire?.(geometry);
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
function buildGridGeometry(spacing: number, colors: ThemeColors, acquire?: (geometry: THREE.BufferGeometry) => void): THREE.BufferGeometry {
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

  return toLineGeometry(buffer, acquire);
}

/** 原点を通る XYZ 軸の線分列を作る(FR-104)。方眼と同じ薄まり方をさせる。 */
function buildAxisGeometry(length: number, colors: ThemeColors, acquire?: (geometry: THREE.BufferGeometry) => void): THREE.BufferGeometry {
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

  return toLineGeometry(buffer, acquire);
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

export function createViewportScene(canvas: HTMLCanvasElement, options: ViewportSceneOptions = {}): ViewportScene {
  const uiBackings = options.uiBackings ?? assemblyUiBackings;
  // Construction owns each actual acquisition until successful return or handoff.
  // Null means the completed Scene owns resources through disposeOwnedLayers.
  let construction: Map<{ dispose(): void }, { label: string; release: () => void }> | null = new Map();
  function acquired<T extends { dispose(): void }>(label: string, resource: T, dispose = () => resource.dispose()): T {
    if (construction !== null) construction.set(resource, { label, release: () => {
      dispose();
      construction?.delete(resource);
    } });
    return resource;
  }
  function returnAcquired(resource: { dispose(): void }): void {
    const pending = construction?.get(resource);
    if (pending === undefined) resource.dispose();
    else pending.release();
  }
  function acquireLineGeometry(geometry: THREE.BufferGeometry): void { acquired('line geometry', geometry); }
  try {
  // 背景は CSS(.pcad-viewport の縦グラデーション)に任せ、描画結果だけを重ねる。
  const renderer = acquired('renderer', new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }));
  let disposed = false;
  let ownedCleanup: ViewportLifetime | null = null;
  let disposalDisplayCopyBytes = 0;
  let disposalReservationsReleased = false;
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

  const skyLight = acquired('sky light', new THREE.HemisphereLight(
    SKY_COLOR,
    DEFAULT_THEME_COLORS.sceneGround,
    HEMISPHERE_INTENSITY,
  ));
  // 半球光の「空」の向きは position が決める。Z 上の座標系に合わせる。
  skyLight.position.set(0, 0, 1);
  scene.add(skyLight);

  const keyLight = acquired('key light', new THREE.DirectionalLight(0xffffff, KEY_LIGHT_INTENSITY));
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
  const lineMaterial = acquired('grid material', new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
  }));

  const gridGroup = new THREE.Group();
  scene.add(gridGroup);

  const grid = new THREE.LineSegments(acquired('grid geometry', new THREE.BufferGeometry()), lineMaterial);
  gridGroup.add(grid);

  const axisLines = new THREE.LineSegments(acquired('axis geometry', new THREE.BufferGeometry()), lineMaterial);
  // 軸は方眼より後に描いて前面に出す(重なりはないが、半透明どうしの順序を決めておく)。
  axisLines.renderOrder = 1;
  gridGroup.add(axisLines);

  const solidLayer = acquired('solidLayer', createSolidLayer());
  scene.add(solidLayer.group);

  /*
    配置した部品(FR-605、P7 タスク10)。**部品の立体とは別の層**にする——1 つの窓で開く
    文書は 1 つだけ(§0.a-0.10)なので同時には出ないが、形の持ち方が違う(立体は
    フィーチャーごとに 1 つ、アセンブリは**部品の鍵ごとに 1 つを全インスタンスで共有**)
    ため、同じ入れ物に混ぜると共有の判断が 2 通りに割れる。
    断面表示のクリッピング平面(FR-111)は、下の独立した干渉層と同時に配る。
  */
  const assemblyLayer = createAssemblyLayer(undefined, { gpuMeshBudget: options.gpuMeshBudget, uiBackings,
    isCurrent: () => assemblyCandidateOwner === null || assemblyOwnerCurrent(assemblyCandidateOwner),
    readBudget: () => {
      const owner = assemblyCandidateOwner ?? assemblyOwner;
      if (owner?.admission === null || owner === null) return undefined;
      const state = options.readSolidMeshState?.();
      if (state === undefined) return null;
      const budget = assemblyMeshBudget(owner.admission, state);
      if (budget === null) return null;
      return { limitBytes: budget.limitBytes, baselineBytes: budget.baselineBytes, sourceUiBackings: budget.sourceUiBackings,
        isCurrent: () => assemblyOwnerCurrent(owner) };
    } });
  acquired('assembly layer', assemblyLayer, () => {
    assemblyLayer.dispose();
    if (assemblyLayer.meshReservation().cleanupStatus === 'pending') throw new Error('Assembly resources remain pending');
  });
  scene.add(assemblyLayer.group);
  // 干渉の赤は共有材質を変えず、共通形状だけを独立した層へ重ねる(P7 タスク26)。
  const interferenceLayer = acquired('interferenceLayer', createInterferenceLayer());
  scene.add(interferenceLayer.group);
  const analysisFieldLayer = acquired('analysisFieldLayer', createSolidFieldLayer());
  scene.add(analysisFieldLayer.group);
  const analysisModeLayer = acquired('analysisModeLayer', createSolidModeLayer());
  scene.add(analysisModeLayer.group);

  /*
    下絵の画像(FR-332、P6 タスク39)。**スケッチの線より必ず後ろ**に描く(§0.a-0.46)ので、
    読む順も層の前後にそろえてスケッチの層より前に足す(実際の前後は足した順ではなく
    `canvasLayer.ts` の `CANVAS_RENDER_ORDER`(-2)が決める)。
    **断面表示のクリッピング平面は配らない**(`solidLayer.setSectionPlanes` の相手にしない)。
    中を見るために断面表示を入れた瞬間に下絵まで切れて消えると、なぞるための紙として
    用を成さないため(タスク39 の判断)。下絵は形ではないので、切っても体積も三角形も変わらない。
  */
  const canvasLayer = acquired('canvasLayer', createCanvasLayer());
  scene.add(canvasLayer.group);

  const sketchLayer = acquired('sketchLayer', createSketchLayer());
  sketchLayer.setWorkPlane(WORK_PLANES[DEFAULT_WORK_PLANE_ID]);
  scene.add(sketchLayer.group);

  // 基準ジオメトリ(FR-329)。スケッチの層と同じ理由で、面より後に描く。
  const referenceLayer = acquired('referenceLayer', createReferenceLayer());
  scene.add(referenceLayer.group);

  // 向きの吸着の案内線(FR-110、P4b タスク16)。下書きより後ろ・面より前に出す。
  const trackingLayer = acquired('trackingLayer', createTrackingLayer());
  scene.add(trackingLayer.group);
  // 拘束の印(FR-313、タスク13)。「固定」の記号だけは色を分けるので、記号の表の正本
  // (`constraintSummary.ts`)から値として受け取る(同じ表を 2 か所に書かない)。
  const constraintLayer = acquired('constraintLayer', createConstraintLayer(constraintKindSymbol('fix')));
  scene.add(constraintLayer.group);
  /*
    拘束の自動推定の予告(FR-333、P6 タスク41)。**印の層をもう 1 つ持つ**のは、確定した
    拘束の印(`constraintSummaries` から作る)と予告を別々に差し替えるため。1 つの層に
    混ぜると、再計算で拘束の印が入れ替わるたびに予告が消えてしまう。図柄・大きさ・色は
    同じ層の実装をそのまま使う(§0.a-0.50「P4b の図柄をそのまま出す」)。
  */
  const inferenceLayer = acquired('inferenceLayer', createConstraintLayer(constraintKindSymbol('fix')));
  scene.add(inferenceLayer.group);
  // 測定の結果(FR-1102、P5 タスク31)。線・弧・端の丸・値の札を、他の重ね描きより手前に出す。
  const measureLayer = acquired('measureLayer', createMeasureLayer());
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
    returnAcquired(grid.geometry);
    grid.geometry = buildGridGeometry(spacing, colors, acquireLineGeometry);
    returnAcquired(axisLines.geometry);
    axisLines.geometry = buildAxisGeometry(axisLength(spacing), colors, acquireLineGeometry);
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
  let solidOwner: SolidMeshAdmission | null = null;
  /** One GPU reservation per renderer: this scene and every quad pane it draws. */
  const gpuOwner = Symbol('viewport-renderer');
  /** Scene-owned UV and patterned copies; pruned to the published bodies after each adoption. */
  const displayCopies = new DisplayCopyCache();
  const solidCpuOwner = {};
  /** Mesh attribute arrays and bytes the layer holds for the published bundle and overlays. */
  let publishedAttributeArrays: ReadonlySet<ArrayBufferView> = new Set();
  let publishedGpuBytes = 0;
  let solidDisplayInvalidated = false;

  /**
   * 配置した部品(FR-605、タスク10)。アセンブリを開いていないあいだは空のまま
   * (形も入れ物も 1 つも作らないので費用はゼロ)。
   */
  let assemblyBundle: AssemblyGeometryBundle = EMPTY_ASSEMBLY_GEOMETRY;
  interface AssemblyOwner {
    readonly bundle: AssemblyGeometryBundle;
    readonly state: SolidMeshAdmissionState | null;
    readonly meshes: readonly SolidMeshAdmission[];
    readonly admission: AssemblyMeshAdmission | null;
  }
  let assemblyOwner: AssemblyOwner | null = null;
  let assemblyCandidateOwner: AssemblyOwner | null = null;
  const offeredAssemblyOwners = new WeakMap<AssemblyGeometryBundle, AssemblyOwner>();

  function captureAssemblyOwner(bundle: AssemblyGeometryBundle): AssemblyOwner | null {
    const offered = offeredAssemblyOwners.get(bundle);
    if (offered !== undefined) return assemblyOwnerCurrent(offered) ? offered : null;
    const state = options.readSolidMeshState?.() ?? null;
    if (state !== null && bundle.parts.length > 0) {
      const assembly = activeAssemblyDocument(state), view = state.assemblyView;
      if (assembly === null || view === null || view.sourceDocument !== assembly
        || bundle.sourceDocument !== assembly || bundle.sourceBodies !== view.bodies
        || bundle.parts.some(part => view.bodies.get(part.partKey) !== part.bodies)) return null;
    }
    const meshes: SolidMeshAdmission[] = [];
    const local = bundle.parts.some(part => part.bodies.some(body => body.coordinateFrame !== undefined));
    // An empty display retires its own assets; it does not borrow the old view's source meshes.
    const needsAdmission = local || (bundle.parts.length > 0 && state?.assemblyView?.meshOwnership !== undefined);
    const admission = !needsAdmission || state === null
      ? null : captureAssemblyMeshAdmission(bundle, state);
    if (needsAdmission && admission === null) return null;
    for (const part of bundle.parts) {
      if (part.bodies.some(body => body.coordinateFrame !== undefined)) continue;
      // Historical standalone world inputs retain their actual source union path.
      const admission = captureWorldMeshAdmission(part.bodies);
      if (admission === null) return null;
      meshes.push(admission);
    }
    const owner = { bundle, state, meshes, admission };
    if (bundle.parts.length > 0) offeredAssemblyOwners.set(bundle, owner);
    return owner;
  }

  function assemblyOwnerCurrent(owner: AssemblyOwner): boolean {
    if (disposed || owner.meshes.some(mesh => !meshLayoutsUnchanged(mesh, mesh.bodies))) return false;
    const before = owner.state;
    if (before === null) return options.readSolidMeshState === undefined;
    const now = options.readSolidMeshState?.();
    if (owner.admission !== null && (now === undefined || !currentAssemblyMeshAdmission(owner.admission, now))) return false;
    if (now === undefined || now.activeDocumentId !== before.activeDocumentId || now.assembly !== before.assembly
      || now.assemblyView !== before.assemblyView || now.drawing !== before.drawing
      || now.cancelRequestCount !== before.cancelRequestCount || now.recomputeCancelled !== before.recomputeCancelled) return false;
    // attachAssembly owns these shared counters only while the active document is an assembly.
    if (before.assembly !== null && (now.requestedGeneration !== before.requestedGeneration
      || now.completedGeneration !== before.completedGeneration || now.lastOutcome !== before.lastOutcome
      || now.documentVersion !== before.documentVersion || now.assemblyLibrary !== before.assemblyLibrary)) return false;
    return owner.bundle.parts.length === 0 || (now.assemblyView?.sourceDocument === now.assembly
      && owner.bundle.parts.every(part => now.assemblyView?.bodies.get(part.partKey) === part.bodies));
  }

  let assemblyDisplayInvalidated = false;

  function clearAssemblyDisplay(): void {
    assemblyDisplayInvalidated = true;
    assemblyLayer.group.visible = false;
    assemblyOwner = null; assemblyCandidateOwner = null;
    assemblyBundle = EMPTY_ASSEMBLY_GEOMETRY;
    assemblyLayer.update(EMPTY_ASSEMBLY_GEOMETRY, lastRender?.displayStyle ?? 'shadedWithEdges', environments.texture);
  }

  function ensureCurrentAssemblyOwner(): boolean {
    if (disposed) return false;
    if (assemblyOwner === null) return assemblyBundle.parts.length === 0;
    if (assemblyOwnerCurrent(assemblyOwner)) return true;
    clearAssemblyDisplay();
    return false;
  }

  function rebuildAssembly(bundle: AssemblyGeometryBundle): void {
    if (disposed) return;
    const owner = captureAssemblyOwner(bundle);
    if (owner === null) {
      ensureCurrentAssemblyOwner();
      throw new RangeError('Assembly mesh owner or final accounting is unknown');
    }
    assemblyCandidateOwner = owner;
    const previousBundle = assemblyBundle;
    try {
      if (!assemblyOwnerCurrent(owner)) return;
      // Environment preparation sees candidate appearances without exposing candidate mesh geometry.
      const environmentSpecs = [...solidBundle.entries.flatMap(entry => entry.appearances),
        ...assemblyAppearanceSpecs(bundle)];
      if (anyNeedsEnvironment(environmentSpecs)) environments.ensureEnvironment(scene);
      if (!assemblyOwnerCurrent(owner)) { refreshEnvironment(); ensureCurrentAssemblyOwner(); return; }
      assemblyLayer.update(bundle, lastRender?.displayStyle ?? 'shadedWithEdges', environments.texture);
      if (!assemblyOwnerCurrent(owner)) { clearAssemblyDisplay(); return; }
      assemblyBundle = bundle; assemblyOwner = owner; assemblyLayer.group.visible = true;
      assemblyDisplayInvalidated = false;
    } catch (error) {
      assemblyBundle = previousBundle;
      refreshEnvironment(); ensureCurrentAssemblyOwner();
      throw error;
    } finally { assemblyCandidateOwner = null; }
    refreshEnvironment();
  }

  /**
   * 映り込み用の環境マップ(FR-1107、§0.a-0.9)。**鏡・ガラスを 1 つでも使っているときだけ
   * 作り、使わなくなったら捨てる**(NFR-PF-5)。レンダラを持っているのはここだけなので、
   * 作る・捨てるの判断もここで行い、`createSolidLayer` へはできあがったものを渡す。
   */
  const environments = acquired('environments', createEnvironmentStore(() => createEnvironmentTarget(renderer)));

  /**
   * いまの外観で環境マップが要るかを見直す。**組み立て直したときにだけ呼ぶ**
   * (毎コマ呼ぶと、鏡を 1 つ足すたびに焼き直すことになる)。
   */
  function refreshEnvironment(bundle = solidBundle, assembly = assemblyBundle): void {
    const used = [
      ...bundle.entries.flatMap((entry) => entry.appearances),
      ...assemblyAppearanceSpecs(assembly),
    ];
    if (anyNeedsEnvironment(used)) {
      environments.ensureEnvironment(scene);
      return;
    }
    environments.releaseEnvironment(scene);
  }

  /** ボディ・強調・外観のどれかが変わったときに、描画用の並びを作り直す。 */
  interface SolidInputs {
    readonly bodies: readonly SolidBody[];
    readonly hovered: string | null;
    readonly selected: readonly string[];
    readonly appearance: AppearanceInput | null;
    readonly subHovered: string | null;
    readonly subSelection: readonly string[];
  }

  function solidInputs(): SolidInputs {
    return { bodies, hovered: hoveredBodyId, selected: selectedBodyIds, appearance: appearanceInput,
      subHovered: subShapeHoveredElementId, subSelection: subShapeSelection };
  }

  function ownerIsCurrent(owner: SolidMeshAdmission): boolean {
    return isSolidMeshAdmissionCurrent(owner, options.readSolidMeshState?.());
  }

  /**
   * 押し出しの仮の形(段階計算の受け入れ。EX-14)を描いている間は、立体・面の当たり判定を返さない。
   * 仮の形のボディは文書のフィーチャーではないので、その id を選択・ホバーへ渡さない(表示だけ)。
   */
  function stagedPreviewDisplayed(): boolean {
    return solidOwner !== null && solidOwner.state !== null && solidOwner.state.stagedSolid !== null;
  }

  /** Every mesh attribute array the layer uploads for a bundle and its overlays. */
  function attributeArrays(bundle: SolidGeometryBundle, overlay: SubShapeHighlightBundle): ArrayBufferView[] {
    return [...bundle.entries.flatMap((entry) => [entry.positions, entry.normals, entry.uv, entry.indices,
      entry.edgePositions]),
    ...[...overlay.hovered.batches, ...overlay.selected.batches].flatMap((batch) => [batch.facePositions,
      batch.faceNormals, batch.faceIndices, batch.edgePositions, batch.vertexPositions])];
  }

  /** GPU buffers are per attribute: CPU aliasing never merges two attributes into one buffer. */
  function attributeBytes(bundle: SolidGeometryBundle, overlay: SubShapeHighlightBundle): number {
    let bytes = subShapeOverlayBytes(overlay);
    for (const entry of bundle.entries) {
      bytes += entry.positions.byteLength + entry.normals.byteLength + entry.uv.byteLength
        + entry.indices.byteLength + entry.edgePositions.byteLength;
    }
    return bytes;
  }

  /** UI-created typed copies alive for a bundle and overlay (each backing once). */
  function liveDisplayCopies(bundle: SolidGeometryBundle, overlay: SubShapeHighlightBundle): ArrayBufferLike[] {
    return [...(bundle.displayCopies ?? []), ...[...overlay.hovered.batches, ...overlay.selected.batches]
      .flatMap((batch) => [batch.facePositions.buffer, batch.faceNormals.buffer, batch.faceIndices.buffer,
        batch.edgePositions.buffer, batch.vertexPositions.buffer])];
  }

  function releaseMeshReservations(): void {
    options.gpuMeshBudget?.release(gpuOwner);
    publishedAttributeArrays = new Set();
    publishedGpuBytes = 0;
    displayCopies.clear();
  }

  function clearSolidDisplay(): void {
    // Hide first so a failed resource cleanup cannot leave a pickable old document.
    solidLayer.group.visible = false;
    solidDisplayInvalidated = true;
    bodies = [];
    solidBundle = EMPTY_SOLID_GEOMETRY;
    subShapeBundle = EMPTY_SUB_SHAPE_HIGHLIGHT;
    threadMarks = [];
    solidOwner = null;
    releaseMeshReservations();
    solidLayer.update(solidBundle, lastRender?.displayStyle ?? 'shadedWithEdges', environments.texture);
    solidLayer.updateSubShapes(subShapeBundle);
    solidLayer.updateThreadMarks(threadMarks);
    solidLayer.setPrintabilityHighlight(null);
    solidLayer.updateCutPreview(null);
    solidLayer.updateSphereGrid(null);
    solidLayer.updateSectionHandle(null);
  }

  function ensureCurrentSolidOwner(): boolean {
    if (disposed) return false;
    if (solidOwner !== null && ownerIsCurrent(solidOwner)) return true;
    if (bodies.length === 0 && solidOwner === null) {
      const emptyOwner = options.readSolidMeshState === undefined ? captureWorldMeshAdmission(bodies)
        : captureSolidMeshAdmission(options.readSolidMeshState());
      if (emptyOwner !== null && emptyOwner.bodies.length === 0) {
        bodies = emptyOwner.bodies;
        solidOwner = emptyOwner;
        return true;
      }
    }
    clearSolidDisplay();
    return false;
  }

  function restorePublishedSolidLayers(): void {
    try {
      if (solidOwner !== null && ownerIsCurrent(solidOwner) && lastRender !== null) {
        solidLayer.update(solidBundle, lastRender.displayStyle, environments.texture);
        solidLayer.updateSubShapes(subShapeBundle);
        solidLayer.updateThreadMarks(threadMarks);
        refreshEnvironment();
      } else clearSolidDisplay();
    } catch {
      // A failed restoration must not expose a partially updated pick target.
      clearSolidDisplay();
    }
  }

  let observedCandidateSequence = 0;
  let observedPublishedOwner: ViewportMeshOwner | null = null;

  function observeMesh(owner: ViewportMeshOwner, kind: Parameters<NonNullable<ViewportSceneOptions['observation']>['record']>[1],
    reason: Parameters<NonNullable<ViewportSceneOptions['observation']>['record']>[2] = null): void {
    if (options.observation === undefined) return;
    options.observation?.record(owner, kind, reason, {
      hostDisplayCopyBytes: Math.max(disposalDisplayCopyBytes,
        distinctBackingBytes([...liveDisplayCopies(solidBundle, subShapeBundle), ...displayCopies.buffers()])),
      hostGpuAttributeBytes: publishedGpuBytes,
      hostGpuReservedBytes: disposalReservationsReleased ? 0 : null,
    });
  }

  function rebuildSolidBundle(next: SolidInputs): void {
    if (disposed) return;
    const owner = options.readSolidMeshState === undefined ? captureWorldMeshAdmission(next.bodies)
      : captureSolidMeshAdmission(options.readSolidMeshState());
    if (owner === null || owner.bodies !== next.bodies) {
      ensureCurrentSolidOwner();
      return;
    }
    // A candidate that is not published returns its copies and its added GPU reservation.
    const observedOwner: ViewportMeshOwner = {
      documentId: owner.state?.activeDocumentId ?? null,
      viewportOwnerId: options.viewportOwnerId ?? 'unobserved',
      resourceOwnerId: `${options.viewportOwnerId ?? 'unobserved'}:solid-host`,
      operationId: `solid-operation-${++observedCandidateSequence}`,
      publicationId: `solid-publication-${observedCandidateSequence}`,
      generation: owner.state?.requestedGeneration ?? null, preview: false,
    };
    observeMesh(observedOwner, 'build-start');
    const restoreCopies = displayCopies.checkpoint();
    let published = false;
    try {
      // No published input, bundle or layer changes until every CPU candidate exists.
      // The published bundle is a pure function of the published bodies and highlights, so an
      // ownership-only change (a new generation or a name-only edit) re-admits it without a
      // rebuild or GPU re-upload, provided the same body array still has its captured layout.
      const reusable = solidOwner !== null && meshLayoutsUnchanged(solidOwner, next.bodies);
      // A local display's UI copies are bounded on top of the kernel's post-token baseline.
      const issuedBaseline = owner.accounting === null ? null : displayCopyBaseline(owner.accounting);
      const ownedCopies = new Set([...liveDisplayCopies(solidBundle, subShapeBundle), ...displayCopies.buffers()]);
      uiBackings.adopt(ownedCopies);
      const baseline = issuedBaseline === null ? null : { limitBytes: issuedBaseline.limitBytes,
        baselineBytes: issuedBaseline.baselineBytes
          + distinctBackingBytes(uiBackings.buffers().filter(buffer => !ownedCopies.has(buffer)))
          + uiBackings.pending(solidCpuOwner) };
      if (owner.accounting !== null && baseline === null) {
        ensureCurrentSolidOwner();
        return;
      }
      if (issuedBaseline !== null) uiBackings.reserve(solidCpuOwner,
        issuedBaseline.limitBytes - issuedBaseline.baselineBytes - uiBackings.bytes()
          - uiBackings.pending(solidCpuOwner), issuedBaseline.baselineBytes, issuedBaseline.limitBytes);
      // The published copies stay alive until this candidate replaces them (old plus new).
      const liveCopies = liveDisplayCopies(solidBundle, subShapeBundle);
      const candidate = next.bodies.length === 0 ? EMPTY_SOLID_GEOMETRY
        : reusable && next.bodies === bodies && next.hovered === hoveredBodyId
        && next.selected === selectedBodyIds && next.appearance === appearanceInput ? solidBundle
        : buildSolidGeometry(next.bodies, next.hovered, next.selected, next.appearance ?? undefined, undefined,
          { cache: displayCopies, allocated: buffer => uiBackings.allocated(buffer),
            ...(baseline === null ? {} : { budget: { ...baseline, retained: liveCopies } }) });
      uiBackings.adopt([...(candidate.displayCopies ?? []), ...displayCopies.buffers()]);
      const overlayBudget = baseline === null ? undefined : { limitBytes: baseline.limitBytes,
        reservedBytes: baseline.baselineBytes + distinctBackingBytes([...liveCopies,
          ...(candidate.displayCopies ?? []), ...displayCopies.buffers()]) };
      const overlay = next.bodies.length === 0 ? EMPTY_SUB_SHAPE_HIGHLIGHT
        : reusable && next.bodies === bodies && next.subHovered === subShapeHoveredElementId
        && next.subSelection === subShapeSelection ? subShapeBundle
        : buildSubShapeGeometry(next.bodies, next.subHovered, next.subSelection, overlayBudget,
          buffer => uiBackings.allocated(buffer));
      uiBackings.adopt(liveDisplayCopies(candidate, overlay));
      const marks = reusable && next.bodies === bodies ? threadMarks : collectThreadMarks(next.bodies);
      observeMesh(observedOwner, 'build-complete', 'completed');
      // Environment maps (PMREM, render targets) have no known reservation, so a local display
      // that would need one is refused before any environment is created for it.
      if (baseline !== null && anyNeedsEnvironment(candidate.entries.flatMap((entry) => entry.appearances))) {
        throw new RangeError(LOCAL_ENVIRONMENT_MESSAGE);
      }
      if (!ownerIsCurrent(owner)) {
        ensureCurrentSolidOwner();
        return;
      }
      refreshEnvironment(candidate);
      // Recheck immediately before the public layer boundary, including environment callbacks.
      if (!ownerIsCurrent(owner)) {
        refreshEnvironment();
        ensureCurrentSolidOwner();
        return;
      }
      // New attribute arrays get new GPU buffers while the published ones are still alive, so a
      // local display reserves old plus new before the layer changes and refuses on overflow.
      const nextArrays = attributeArrays(candidate, overlay);
      const nextGpuBytes = attributeBytes(candidate, overlay);
      const addedGpuBytes = nextArrays.reduce((sum, array) =>
        publishedAttributeArrays.has(array) ? sum : sum + array.byteLength, 0);
      if (baseline !== null && options.gpuMeshBudget !== undefined
        && !options.gpuMeshBudget.reserve(gpuOwner, publishedGpuBytes + addedGpuBytes)) {
        throw new RangeError(GPU_MESH_BUDGET_MESSAGE);
      }
      observeMesh(observedOwner, 'publish-start');
      if (lastRender !== null) {
        try {
          solidLayer.update(candidate, lastRender.displayStyle, environments.texture);
          solidLayer.updateSubShapes(overlay);
          solidLayer.updateThreadMarks(marks);
        } catch (error) {
          restorePublishedSolidLayers();
          throw error;
        }
      }
      if (!ownerIsCurrent(owner)) {
        restorePublishedSolidLayers();
        return;
      }
      bodies = next.bodies;
      hoveredBodyId = next.hovered;
      selectedBodyIds = next.selected;
      appearanceInput = next.appearance;
      subShapeHoveredElementId = next.subHovered;
      subShapeSelection = next.subSelection;
      solidBundle = candidate;
      subShapeBundle = overlay;
      threadMarks = marks;
      solidOwner = owner;
      solidDisplayInvalidated = false;
      solidLayer.group.visible = true;
      // The replaced buffers are released by the layer; keep only the published reservation.
      publishedAttributeArrays = new Set(nextArrays);
      publishedGpuBytes = nextGpuBytes;
      if (baseline !== null) options.gpuMeshBudget?.reserve(gpuOwner, nextGpuBytes);
      else options.gpuMeshBudget?.release(gpuOwner);
      displayCopies.retainBodies(next.bodies);
      published = true;
      const retiredPublication = observedPublishedOwner;
      observedPublishedOwner = observedOwner;
      observeMesh(observedOwner, 'publish-complete', 'completed');
      if (retiredPublication !== null) observeMesh(retiredPublication, 'publication-retired', 'superseded');
    } catch (error) {
      if (error instanceof AllocatedBackingRegistrationError) uiBackings.retainUnregistered(error.backing);
      ensureCurrentSolidOwner();
      throw error;
    } finally {
      const returnedCopies = displayCopies.buffers();
      try { uiBackings.adopt(returnedCopies); }
      catch {
        // Preserve the original operation outcome while independently returning candidate reservations.
        // Completed publication stays current; an unregistered backing remains strongly held and unknown.
        const registered = new Set(uiBackings.buffers());
        for (const buffer of returnedCopies) if (!registered.has(buffer)) uiBackings.retainUnregistered(buffer);
      }
      uiBackings.retire(solidCpuOwner);
      if (!published) {
        observeMesh(observedOwner, 'operation-aborted', 'rejected');
        observeMesh(observedOwner, 'candidate-return-start', 'rejected');
        returnUnpublishedReservations(restoreCopies);
        observeMesh(observedOwner, 'candidate-return-complete', 'rejected');
      }
    }
  }

  /** Puts the copy cache and the GPU reservation back to the still-published (or cleared) display. */
  function returnUnpublishedReservations(restoreCopies: () => void): void {
    if (solidOwner === null) {
      // The display was cleared: nothing is published, so nothing stays reserved.
      displayCopies.clear();
      options.gpuMeshBudget?.release(gpuOwner);
      return;
    }
    restoreCopies();
    if (solidOwner.accounting !== null) options.gpuMeshBudget?.reserve(gpuOwner, publishedGpuBytes);
    else options.gpuMeshBudget?.release(gpuOwner);
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

  /** 各層の表示内容を同期する。renderer と camera の所有者はこの scene のまま。 */
  function updateVisibleLayers(settings: RenderSettings, rectangle: QuadRectangle, spacing: number): void {
    const currentSolid = ensureCurrentSolidOwner();
    ensureCurrentAssemblyOwner();
    const { orbit, displayStyle, showGrid, uiScale } = settings;
    if (spacing !== currentSpacing) {
      rebuildGrid(spacing);
    }
    gridGroup.visible = showGrid;

    // 立体とスケッチは組み立て直したときだけ並びを差し替える(同じ結果なら表示の入切だけ)。
    solidLayer.update(solidBundle, displayStyle, environments.texture);
    solidLayer.updateSubShapes(subShapeBundle);
    solidLayer.updateThreadMarks(currentSolid ? threadMarks : []);
    solidLayer.updateCutPreview(currentSolid ? cutPreview : null);
    solidLayer.updateSphereGrid(currentSolid ? sphereGridPositions : null, sphereGridSpec?.center);
    // 配置した部品(FR-605)。同じ一式を渡し直したときは並びを触らない(NFR-PF-1)。
    assemblyLayer.update(assemblyBundle, displayStyle, environments.texture);
    sketchLayer.update(sketchBundle, displayStyle);
    // 名前の札(基準軸・座標系)の画面上の大きさをそろえ直す(P4 仕上げ (f))。
    // ズームでカメラ距離が変わるたびに効くよう、描画のたびに計算し直す。
    referenceLayer.updateScreenScale(orbit.distance / (orbit.zoom ?? 1), rectangle.height, uiScale);
    // 測定の値の札も同じ大きさ(約 13px)にそろえる(P5 タスク31)。
    measureLayer.updateScreenScale(orbit.distance / (orbit.zoom ?? 1), rectangle.height, uiScale);
  }

  /** 1 枚描く。層の同期後、同じカメラで光源と renderer を更新する。 */
  function drawScene(settings: RenderSettings, rectangle: QuadRectangle, spacing: number): void {
    updateVisibleLayers(settings, rectangle, spacing);
    // Layer disposal callbacks may change the live owner before the renderer consumes it.
    ensureCurrentSolidOwner();
    ensureCurrentAssemblyOwner();
    currentRepairPreviewResource();
    const { orbit, projection } = settings;
    updateKeyLight(orbit);
    // Each quad pane uses this camera with the same world-space solid origins.
    // Three multiplies the double-valued inverse camera and object matrices before
    // converting modelView to GPU floats; no world Float32 mesh is retranslated.
    const camera = configureCamera(orbit, projection, rectangle);
    renderer.render(scene, camera);
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
    if (disposed || lastRender === null) return;
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

  /** カメラの確定とポインタ座標変換を、すべての pick 入口で共有する。 */
  function preparePointerRay(screenX: number, screenY: number): boolean {
    if (disposed || lastCamera === null) return false;
    if (!ensureCurrentSolidOwner()) return false;
    return prepareCameraRay(screenX, screenY);
  }

  /**
   * The camera ray alone, for plane points and rays that never read solid meshes. Sketch input
   * must not depend on (or clear) the solid display's ownership; solid picks use the gate above.
   */
  function prepareCameraRay(screenX: number, screenY: number): boolean {
    if (disposed || lastCamera === null) return false;
    setPointer(screenX, screenY);
    raycaster.setFromCamera(pointerNdc, lastCamera);
    return true;
  }

  /** 保存用の再描画とピクセル取得は必ず同じ同期処理の中で行う。 */
  function captureOwnersCurrent(reasonSink?: ThumbnailCaptureReasonSink): boolean {
    if (!ensureCurrentSolidOwner()) { reportThumbnailCaptureReason('scene:solid-owner', reasonSink); return false; }
    if (solidDisplayInvalidated) { reportThumbnailCaptureReason('scene:solid-invalidated', reasonSink); return false; }
    if (!ensureCurrentAssemblyOwner()) { reportThumbnailCaptureReason('scene:assembly-owner', reasonSink); return false; }
    if (assemblyDisplayInvalidated) { reportThumbnailCaptureReason('scene:assembly-invalidated', reasonSink); return false; }
    const state = options.readSolidMeshState?.();
    const assembly = state === undefined ? null : activeAssemblyDocument(state);
    // An empty interim display is not a proved image of the active assembly.
    const current = assembly === null || (assemblyOwner !== null && assemblyBundle.sourceDocument === assembly);
    if (!current) reportThumbnailCaptureReason('scene:assembly-source', reasonSink);
    return current;
  }

  function captureCurrentFrame<T>(capture: () => T, reasonSink?: ThumbnailCaptureReasonSink): T | null {
    if (disposed || lastRender === null) {
      reportThumbnailCaptureReason(disposed ? 'scene:disposed' : 'scene:not-rendered', reasonSink);
      return null;
    }
    reportThumbnailCaptureReason('scene:pre-redraw', reasonSink);
    if (!captureOwnersCurrent(reasonSink)) return null;
    redraw();
    reportThumbnailCaptureReason('scene:post-redraw', reasonSink);
    if (!captureOwnersCurrent(reasonSink)) return null;
    const result = capture();
    reportThumbnailCaptureReason('scene:post-image', reasonSink);
    return captureOwnersCurrent(reasonSink) ? result : null;
  }

  /** 子層を既存順で解放する。renderer はこの呼出しの後に最後に解放する。 */
  let repairPreviewRequest = 0;
  let requestedRepairPreview: ReferenceRepairPreview | null = null;
  let repairPreviewPending: Promise<void> | null = null;
  let completedRepairPreviewRequest = -1;
  const returnedRepairPreviews = new WeakSet<ReferenceRepairPreview>();
  interface RepairPreviewResource {
    readonly descriptor: ReferenceRepairPreview;
    readonly gpuOwner: symbol;
    readonly gpuBytes: number;
    readonly cpuBytes: number;
    readonly layer: ReturnType<typeof createSolidLayer> | null;
    readonly cleanup: ViewportLifetime | null;
    readonly proof: () => boolean;
    retiring: boolean;
    published: boolean;
    cleanupError: string | null;
  }
  let repairPreviewResource: RepairPreviewResource | null = null;

  function observeRepairPreview(descriptor: ReferenceRepairPreview,
    phase: Parameters<NonNullable<ViewportSceneOptions['observation']>['record']>[1],
    reason: Parameters<NonNullable<ViewportSceneOptions['observation']>['record']>[2],
    copies: number, attributes: number, reserved: number | null = null): void {
    const viewportOwnerId = options.viewportOwnerId ?? 'unobserved';
    options.observation?.record({ documentId: descriptor.documentId, generation: descriptor.generation, preview: true,
      viewportOwnerId, resourceOwnerId: `${viewportOwnerId}:repair-preview:${descriptor.operationId}`,
      operationId: `repair-preview-operation-${descriptor.operationId}`, publicationId: `repair-preview-publication-${descriptor.operationId}` },
      phase, reason, { hostDisplayCopyBytes: copies, hostGpuAttributeBytes: attributes, hostGpuReservedBytes: reserved });
  }

  function repairPreviewProof(scope: WeakRef<ReferenceRepairPreviewBorrow['scope']>, receipt: RepairPreviewReceipt,
    inspection: RepairPreviewInspection, input: WeakSet<ArrayBufferLike>, epoch: number): () => boolean {
    return () => {
      if (receipt.status !== 'known' || inspection.status !== 'known'
        || scope.deref()?.currentInspection(inspection, receipt) !== true || !uiBackings.known()) return false;
      const source = new Set<ArrayBufferLike>();
      for (const reference of inspection.sameSourceBackings) {
        const buffer = reference.deref(); if (buffer !== undefined) source.add(buffer);
      }
      let total = receipt.admittedBoundBytes + uiBackings.pending();
      for (const buffer of uiBackings.buffers()) {
        if (!(buffer instanceof ArrayBuffer) || !input.has(buffer) && !uiBackings.allocatedAfter(buffer, epoch)) return false;
        try { new Uint8Array(buffer); } catch { return false; }
        if (!source.has(buffer)) total += buffer.byteLength;
      }
      return Number.isSafeInteger(total) && total <= receipt.limitBytes;
    };
  }

  function returnRepairPreview(): boolean {
    const resource = repairPreviewResource;
    if (resource === null) return true;
    if (!resource.retiring) observeRepairPreview(resource.descriptor, resource.published ? 'release-start' : 'candidate-return-start',
      disposed ? 'disposed' : resource.published ? 'superseded' : 'rejected', resource.cpuBytes, resource.gpuBytes);
    resource.retiring = true;
    if (resource.layer !== null) resource.layer.group.visible = false;
    try {
      if (resource.layer !== null) resource.layer.dispose();
      if (resource.cleanup !== null) {
        resource.cleanup.dispose();
        if (resource.cleanup.pendingCount !== 0) { resource.cleanupError = resource.cleanup.errors.join('; '); return false; }
      }
    } catch (error) {
      resource.cleanupError = error instanceof Error ? error.message : 'Reference repair preview return failed';
      return false;
    }
    if (resource.layer !== null) scene.remove(resource.layer.group);
    options.gpuMeshBudget?.release(resource.gpuOwner);
    repairPreviewResource = null;
    returnedRepairPreviews.add(resource.descriptor);
    observeRepairPreview(resource.descriptor, resource.published ? 'release-complete' : 'candidate-return-complete',
      disposed ? 'disposed' : resource.published ? 'superseded' : 'rejected', 0, 0, 0);
    return true;
  }

  function currentRepairPreviewResource(): boolean {
    const resource = repairPreviewResource;
    if (resource === null) return true;
    const state = options.readSolidMeshState?.();
    if (!disposed && !resource.retiring && requestedRepairPreview === resource.descriptor && state !== undefined
      && borrowReferenceRepairPreview(resource.descriptor, state) !== null && resource.proof()) return true;
    returnRepairPreview();
    return false;
  }

  async function observeRepairPreviewBudget(descriptor: ReferenceRepairPreview) {
    const state = options.readSolidMeshState?.();
    const borrowed = state === undefined ? null : borrowReferenceRepairPreview(descriptor, state);
    if (borrowed === null || disposed || requestedRepairPreview !== descriptor || !uiBackings.known()) return recordReferenceRepairRejection('scene-budget:1');
    // This is a fresh asynchronous provider observation, not a reused display receipt.
    const receipt = await borrowed.scope.capture(`repair-preview:${descriptor.operationId}`, borrowed.displayBodies, borrowed.additionalOwners);
    const after = options.readSolidMeshState?.();
    if (after === undefined) return recordReferenceRepairRejection('scene-budget:2:after-unavailable');
    if (borrowReferenceRepairPreview(descriptor, after)?.scope !== borrowed.scope) return recordReferenceRepairRejection('scene-budget:2:scope-changed');
    if (disposed) return recordReferenceRepairRejection('scene-budget:2:disposed');
    if (requestedRepairPreview !== descriptor) return recordReferenceRepairRejection('scene-budget:2:descriptor-changed');
    if (receipt.status !== 'known') return recordReferenceRepairRejection(`scene-budget:2:receipt-unknown:${receipt.reason}`.slice(0, 120));
    const numbers = [receipt.limitBytes, receipt.admittedBoundBytes, receipt.workerRetainedBackingBytes,
      receipt.hostRetainedBackingBytes, receipt.pendingCloneReservedBytes];
    if (!numbers.every(value => Number.isSafeInteger(value) && value >= 0)
      || receipt.limitBytes <= 0 || receipt.limitBytes > 512 * 1024 * 1024
      || receipt.admittedBoundBytes !== receipt.workerRetainedBackingBytes + receipt.hostRetainedBackingBytes + receipt.pendingCloneReservedBytes
      || receipt.coverage !== 'registered-solid-mesh-backings-only' || !borrowed.scope.currentReceipt(receipt)) return recordReferenceRepairRejection('scene-budget:3');
    const buffers = uiBackings.buffers(), epoch = uiBackings.epoch();
    const inspection = await borrowed.scope.inspectBackings(receipt, buffers);
    const latest = options.readSolidMeshState?.();
    if (latest === undefined || borrowReferenceRepairPreview(descriptor, latest)?.scope !== borrowed.scope
      || disposed || requestedRepairPreview !== descriptor || inspection.status !== 'known'
      || inspection.coverage !== 'registered-main-solid-backings-only' || uiBackings.epoch() !== epoch
      || !uiBackings.known() || !borrowed.scope.currentInspection(inspection, receipt)) return recordReferenceRepairRejection('scene-budget:4');
    const input = new WeakSet<ArrayBufferLike>(buffers);
    const sourceBackings = new Set<ArrayBufferLike>();
    for (const reference of inspection.sameSourceBackings) {
      const buffer = reference.deref();
      if (buffer !== undefined) {
        if (!input.has(buffer)) return recordReferenceRepairRejection('scene-budget:5');
        sourceBackings.add(buffer);
      }
    }
    const current = repairPreviewProof(new WeakRef(borrowed.scope), receipt, inspection, input, epoch);
    const baseline = receipt.admittedBoundBytes;
    const union = baseline + buffers.filter(buffer => !sourceBackings.has(buffer)).reduce((sum, buffer) => sum + buffer.byteLength, 0)
      + uiBackings.pending();
    if (!Number.isSafeInteger(union) || union > receipt.limitBytes || !current()) return recordReferenceRepairRejection('scene-budget:6');
    return { borrowed, receipt, sourceBackings, baseline, union, current };
  }

  function setReferenceRepairPreview(descriptor: ReferenceRepairPreview | null): Promise<void> {
    if (disposed) return Promise.resolve();
    if (descriptor !== requestedRepairPreview) {
      requestedRepairPreview = descriptor; repairPreviewRequest++;
      returnRepairPreview(); // Hide immediately, even while a provider query is pending.
    } else if (repairPreviewResource !== null && currentRepairPreviewResource()) return Promise.resolve();
    if (repairPreviewPending !== null) return repairPreviewPending;
    const pending = drainRepairPreview();
    repairPreviewPending = pending;
    const completed = () => {
      if (repairPreviewPending !== pending) return;
      repairPreviewPending = null;
      if (!disposed && completedRepairPreviewRequest !== repairPreviewRequest) {
        void setReferenceRepairPreview(requestedRepairPreview).catch(() => { returnRepairPreview(); });
      }
    };
    void pending.then(completed, () => { returnRepairPreview(); completed(); });
    return pending;
  }

  async function drainRepairPreview(): Promise<void> {
    // One provider transaction at a time; repeated hover retains only the newest metadata.
    let completed = -1;
    while (!disposed && completed !== repairPreviewRequest) {
      completed = repairPreviewRequest;
      completedRepairPreviewRequest = completed;
      const descriptor = requestedRepairPreview;
      if (!returnRepairPreview() || descriptor === null) return;
      await buildRepairPreview(descriptor, completed);
    }
  }

  async function buildRepairPreview(descriptor: ReferenceRepairPreview, request: number): Promise<void> {
    const alive = () => !disposed && request === repairPreviewRequest && requestedRepairPreview === descriptor;
    const cpuOwner = {};
    let gpuOwner: symbol | null = null;
    let buildStarted = false, published = false, allocatedBytes = 0;
    try {
      const before = await observeRepairPreviewBudget(descriptor);
      if (!alive() || before === null || options.gpuMeshBudget === undefined) return;
      buildStarted = true;
      observeRepairPreview(descriptor, 'build-start', null, 0, 0);
      // The reservation lasts only through the synchronous count/fill transaction.
      uiBackings.reserve(cpuOwner, before.receipt.limitBytes - before.union, before.baseline,
        before.receipt.limitBytes, before.sourceBackings);
      let overlays: SubShapeHighlightBundle;
      try {
        overlays = buildSubShapeGeometry([before.borrowed.body], descriptor.elementId, [],
          { limitBytes: before.receipt.limitBytes, reservedBytes: before.union }, buffer => {
            allocatedBytes += buffer.byteLength; uiBackings.allocated(buffer);
          });
      } finally { uiBackings.retire(cpuOwner); }
      const bytes = subShapeOverlayBytes(overlays);
      observeRepairPreview(descriptor, 'build-complete', 'completed', allocatedBytes, 0);
      if (bytes === 0 || !alive()) return;
      // Actual copies have now been registered. Observe all providers again before native publication.
      const publication = await observeRepairPreviewBudget(descriptor);
      if (!alive() || publication === null || !publication.current()) return;
      gpuOwner = Symbol(`repair-preview:${descriptor.operationId}`);
      if (!options.gpuMeshBudget.reserve(gpuOwner, bytes)) { gpuOwner = null; return; }
      observeRepairPreview(descriptor, 'publish-start', null, allocatedBytes, 0,
        options.gpuMeshBudget.reservedBytes?.(gpuOwner) ?? null);
      let candidateLayer: ReturnType<typeof createSolidLayer>;
      try { candidateLayer = createSolidLayer(); }
      catch (error) {
        if (error instanceof ViewportResourceInitializationFailure && error.cleanup.pendingCount !== 0) {
          repairPreviewResource = { descriptor, gpuOwner, gpuBytes: 0, cpuBytes: 0,
            layer: null, cleanup: error.cleanup, proof: () => false, retiring: false, published: false, cleanupError: null };
          gpuOwner = null;
        }
        throw error;
      }
      repairPreviewResource = { descriptor, gpuOwner, gpuBytes: bytes, cpuBytes: bytes,
        layer: candidateLayer, cleanup: null, proof: publication.current, retiring: false, published: false, cleanupError: null };
      gpuOwner = null;
      candidateLayer.group.visible = false;
      candidateLayer.update(EMPTY_SOLID_GEOMETRY, lastRender?.displayStyle ?? 'shadedWithEdges', null);
      candidateLayer.updateSubShapes(overlays);
      const placement = publication.borrowed.placement;
      if (placement !== null) {
        candidateLayer.group.position.set(...placement.position);
        candidateLayer.group.quaternion.set(...placement.rotation);
      }
      candidateLayer.group.updateMatrix();
      // Batch origins stay local Double transforms beneath the actual Assembly placement.
      if (!alive() || !currentRepairPreviewResource()) { returnRepairPreview(); return; }
      scene.add(candidateLayer.group);
      candidateLayer.group.visible = true;
      published = true;
      if (repairPreviewResource !== null) repairPreviewResource.published = true;
      observeRepairPreview(descriptor, 'publish-complete', 'completed', allocatedBytes, bytes);
    } catch (error) {
      if (error instanceof AllocatedBackingRegistrationError) uiBackings.retainUnregistered(error.backing);
      returnRepairPreview();
      // Unavailable/unknown is a hidden preview, never a success proof or a document mutation.
    } finally {
      uiBackings.retire(cpuOwner);
      if (gpuOwner !== null) options.gpuMeshBudget?.release(gpuOwner);
      if (buildStarted && !published) {
        observeRepairPreview(descriptor, 'operation-aborted', 'rejected', allocatedBytes, 0);
        if (repairPreviewResource?.descriptor !== descriptor && !returnedRepairPreviews.has(descriptor)) {
          observeRepairPreview(descriptor, 'candidate-return-start', 'rejected', allocatedBytes, 0);
          observeRepairPreview(descriptor, 'candidate-return-complete', 'rejected', 0, 0, 0);
          returnedRepairPreviews.add(descriptor);
        }
      }
    }
  }
  function disposeOwnedLayers(): void {
    if (ownedCleanup === null) {
      if (observedPublishedOwner !== null) observeMesh(observedPublishedOwner, 'release-start', 'disposed');
      ownedCleanup = createViewportLifetime();
      ownedCleanup.register('environment', () => { environments.dispose(); });
      ownedCleanup.register('reference repair preview', () => {
        if (!returnRepairPreview()) throw new Error('Reference repair preview resources remain pending');
      });
      ownedCleanup.register('solid layer', () => { solidLayer.dispose(); });
      ownedCleanup.register('assembly layer', () => {
        assemblyLayer.dispose();
        if (assemblyLayer.meshReservation().cleanupStatus === 'pending') throw new Error('Assembly resources remain pending');
      });
      ownedCleanup.register('interference layer', () => { interferenceLayer.dispose(); });
      ownedCleanup.register('analysis field layer', () => { analysisFieldLayer.dispose(); });
      ownedCleanup.register('analysis mode layer', () => { analysisModeLayer.dispose(); });
      ownedCleanup.register('canvas images and textures', () => { canvasLayer.dispose(); });
      ownedCleanup.register('sketch layer', () => { sketchLayer.dispose(); });
      ownedCleanup.register('reference layer', () => { referenceLayer.dispose(); });
      ownedCleanup.register('tracking layer', () => { trackingLayer.dispose(); });
      ownedCleanup.register('constraint layer', () => { constraintLayer.dispose(); });
      ownedCleanup.register('inference layer', () => { inferenceLayer.dispose(); });
      ownedCleanup.register('measure layer', () => { measureLayer.dispose(); });
      const gridGeometry = grid.geometry, axisGeometry = axisLines.geometry;
      ownedCleanup.register('grid geometry', () => { gridGeometry.dispose(); });
      ownedCleanup.register('axis geometry', () => { axisGeometry.dispose(); });
      ownedCleanup.register('grid material', () => { lineMaterial.dispose(); });
      ownedCleanup.register('sky light', () => { skyLight.dispose(); });
      ownedCleanup.register('key light', () => { keyLight.dispose(); });
      ownedCleanup.register('renderer', () => { renderer.dispose(); });
    }
    ownedCleanup.dispose();
    if (ownedCleanup.pendingCount === 0 && !disposalReservationsReleased) {
      releaseMeshReservations();
      disposalDisplayCopyBytes = 0;
      disposalReservationsReleased = true;
      if (observedPublishedOwner !== null) observeMesh(observedPublishedOwner, 'release-complete', 'disposed');
    }
  }

  const viewport: ViewportScene = {
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
      rebuildSolidBundle({ ...solidInputs(), bodies: nextBodies });
    },

    setAssembly: rebuildAssembly,
    setReferenceRepairPreview,

    setInterference(result, selectedKey): void {
      interferenceLayer.update(result, selectedKey);
    },

    setBodyHighlight(nextHovered, nextSelected): void {
      if (disposed) return;
      ensureCurrentSolidOwner();
      if (bodies.length === 0 && solidOwner === null) {
        hoveredBodyId = nextHovered;
        selectedBodyIds = nextSelected;
        return;
      }
      rebuildSolidBundle({ ...solidInputs(), hovered: nextHovered, selected: nextSelected });
    },

    setAppearance(appearance): void {
      if (disposed) return;
      ensureCurrentSolidOwner();
      if (bodies.length === 0 && solidOwner === null) {
        appearanceInput = appearance;
        return;
      }
      rebuildSolidBundle({ ...solidInputs(), appearance });
    },

    setSubShapeHighlight(hoveredElementId, selection): void {
      if (disposed) return;
      ensureCurrentSolidOwner();
      if (bodies.length === 0 && solidOwner === null) {
        subShapeHoveredElementId = hoveredElementId;
        subShapeSelection = selection;
        return;
      }
      rebuildSolidBundle({ ...solidInputs(), subHovered: hoveredElementId, subSelection: selection });
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

    setAnalysisField(field): void {
      if (disposed) return;
      analysisFieldLayer.set(field);
    },
    setAnalysisMode(preview): void {
      if (disposed) return;
      analysisModeLayer.set(preview);
    },
    setPrintability(highlight): void {
      if (disposed) return;
      solidLayer.setPrintabilityHighlight(ensureCurrentSolidOwner() ? highlight : null);
    },

    setCanvases(draws): void {
      if (disposed) return;
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
          : buildSphereGridPositions({ ...spec, center: [0, 0, 0], radius: spec.radius * (1 + SPHERE_GRID_LIFT) });
    },

    pickBody(screenX, screenY): string | null {
      if (stagedPreviewDisplayed() || !preparePointerRay(screenX, screenY)) return null;
      return solidLayer.pickBody(raycaster);
    },

    pickComponent(screenX, screenY): string | null {
      if (!ensureCurrentAssemblyOwner() || !prepareCameraRay(screenX, screenY)) return null;
      return assemblyLayer.pickComponent(raycaster);
    },

    pickAssemblyFace(screenX, screenY, observation) {
      if (observation !== undefined) {
        observation.ownerPresent = assemblyOwner !== null;
        observation.displayInvalidated = assemblyDisplayInvalidated;
        observation.partCount = assemblyBundle.parts.length;
      }
      const ownerAccepted = ensureCurrentAssemblyOwner();
      if (observation !== undefined) observation.ownerAccepted = ownerAccepted;
      if (!ownerAccepted) return null;
      const cameraReady = prepareCameraRay(screenX, screenY);
      if (observation !== undefined) observation.cameraReady = cameraReady;
      if (!cameraReady) return null;
      return assemblyLayer.pickMateFace(raycaster);
    },

    pickFaceAt(screenX, screenY): { readonly featureId: string; readonly faceIndex: number } | null {
      if (stagedPreviewDisplayed() || !preparePointerRay(screenX, screenY)) return null;
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

    captureThumbnail(size = THUMBNAIL_SIZE, reasonSink?: ThumbnailCaptureReasonSink): Uint8Array | null {
      return captureCurrentFrame(() => captureThumbnailPng(canvas, size, reasonSink), reasonSink);
    },

    capturePrintFrame(): string | null {
      return captureCurrentFrame(() => capturePrintPng(canvas));
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

    meshReservation(): ViewportMeshReservation {
      const assembly = assemblyLayer.meshReservation();
      return { repairPreviewRejections: readReferenceRepairRejections(), registeredUiBackingBytes: uiBackings.known() ? uiBackings.bytes() : null,
        registeredUiPendingBytes: uiBackings.pending(),
        displayCopyBytes: Math.max(disposalDisplayCopyBytes, distinctBackingBytes([...liveDisplayCopies(solidBundle, subShapeBundle),
        ...displayCopies.buffers()])) + assembly.displayCopyBytes + (repairPreviewResource?.cpuBytes ?? 0),
        gpuMeshBytes: publishedGpuBytes + assembly.gpuMeshBytes + (repairPreviewResource?.gpuBytes ?? 0),
        assemblySourceBackingBytes: assembly.sourceBackingBytes, assemblyInstanceBytes: assembly.instanceBytes,
        assemblyCleanupReservedCpuBytes: assembly.cleanupReservedCpuBytes,
        assemblyCleanupStatus: assembly.cleanupStatus,
        viewportCleanupStatus: repairPreviewResource?.retiring === true || ownedCleanup !== null && ownedCleanup.pendingCount !== 0 ? 'pending' : 'complete',
        viewportCleanupErrors: Object.freeze([...(ownedCleanup?.errors ?? []),
          ...(repairPreviewResource?.cleanupError === null || repairPreviewResource?.cleanupError === undefined ? [] : [repairPreviewResource.cleanupError])]),
        uncovered: Object.freeze([...new Set([...UNCOVERED_MESH_RESOURCES, ...assembly.uncovered,
          ...(repairPreviewResource !== null && (repairPreviewResource.retiring || !repairPreviewResource.proof()) ? ['referenceRepairPreviewCleanup'] : []),
          ...(ownedCleanup !== null && ownedCleanup.pendingCount !== 0 ? ['retiredViewportResources'] : [])])]) };
    },

    fullyFramedBodyIds(): readonly string[] {
      if (lastCamera === null || !ensureCurrentSolidOwner()) return [];
      const camera = lastCamera;
      return bodies.filter((body) => {
        const origin = subShapeFrameOrigin(body);
        if (origin === null) return false;
        const positions = body.mesh.positions;
        if (positions.length === 0) return false;
        for (let i = 0; i < positions.length; i += 3) {
          scratch.set(
            origin[0] + positions[i], origin[1] + positions[i + 1], origin[2] + positions[i + 2],
          ).project(camera);
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
      if (!prepareCameraRay(x, y)) return null;
      planeNormal.set(plane.normal[0], plane.normal[1], plane.normal[2]);
      planeOrigin.set(plane.origin[0], plane.origin[1], plane.origin[2]);
      pickPlane.setFromNormalAndCoplanarPoint(planeNormal, planeOrigin);
      const hit = raycaster.ray.intersectPlane(pickPlane, intersection);
      return hit === null ? null : [hit.x, hit.y, hit.z];
    },

    pointerRay(x, y): PointerRay | null {
      if (!prepareCameraRay(x, y)) return null;
      const { origin, direction } = raycaster.ray;
      return {
        origin: [origin.x, origin.y, origin.z],
        direction: [direction.x, direction.y, direction.z],
      };
    },

    resize(widthPixels, heightPixels): void {
      if (disposed) return;
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
      if (disposed) return;
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
      if (disposed) { disposeOwnedLayers(); return; }
      disposed = true;
      repairPreviewRequest++; requestedRepairPreview = null;
      disposalDisplayCopyBytes = distinctBackingBytes([...liveDisplayCopies(solidBundle, subShapeBundle), ...displayCopies.buffers()]);
      assemblyOwner = null; assemblyCandidateOwner = null; assemblyBundle = EMPTY_ASSEMBLY_GEOMETRY;
      solidOwner = null;
      bodies = [];
      solidBundle = EMPTY_SOLID_GEOMETRY;
      subShapeBundle = EMPTY_SUB_SHAPE_HIGHLIGHT;
      threadMarks = [];
      appearanceInput = null;
      disposeOwnedLayers();
    },
  };
  // Transfer ownership to the completed Scene; this is not a physical return.
  construction = null;
  return viewport;
  } catch (error) {
    const initializationCleanup = createViewportLifetime();
    if (error instanceof ViewportResourceInitializationFailure && error.cleanup.pendingCount !== 0) {
      initializationCleanup.register('inner factory resources', () => {
        error.cleanup.dispose();
        if (error.cleanup.pendingCount !== 0) throw new Error(error.cleanup.errors.join('; '));
      });
    }
    for (const pending of construction?.values() ?? []) initializationCleanup.register(pending.label, pending.release);
    initializationCleanup.dispose();
    throw new ViewportSceneInitializationFailure(error, initializationCleanup);
  }
}
