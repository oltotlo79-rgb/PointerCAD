import type {
  ResolvedReferences,
  AssemblyInterferenceResult,
  ResolvedSketch,
  SketchMesh,
  SolidBody,
  Vec3,
  WorkPlane,
} from '@pointercad/model';
import * as THREE from 'three';
import type { CylinderBasisGuide } from './cylinderBasisGuide.js';
import type { PlanarBasisGuide } from './planarBasisGuide.js';
import type { readReferenceRepairRejections, ReferenceRepairPreview } from '../solid/referenceRepairPreview.js';
import { createViewportRepairPreview } from './viewportRepairPreview.js';

import { viewportPixelRatio } from './viewportRenderScale.js';

import { capturePrintPng } from '../file/printView.js';
import { captureThumbnailPng, THUMBNAIL_SIZE, reportThumbnailCaptureReason, type ThumbnailCaptureReasonSink } from '../file/thumbnail.js';
import type { PointerRay, TrackCandidate } from '../sketch/trackMath.js';
import type { EditPreview } from '../sketch/trimPreview.js';
import { faceIndexOfTriangle } from '../solid/pickSubShape.js';
import type { DisplayStyle, ProjectionMode } from '../store/viewSlice.js';
import { activeAssemblyDocument } from '../store/documentKind.js';
import { assemblyUiBackings, assemblyMeshBudget, type AssemblyUiBackingLedger } from './assemblyMeshAdmission.js';
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
} from './buildSolidGeometry.js';
import { createEnvironmentStore, createEnvironmentTarget, type EnvironmentCandidate } from './createEnvironment.js';
import {
  buildSubShapeGeometry, EMPTY_SUB_SHAPE_HIGHLIGHT,
} from './buildSubShapeGeometry.js';
import {
  buildSphereGridPositions,
  isValidSphereGridStep,
  type SphereGridSpec,
} from './buildSphereGrid.js';
import {
  HOME_ORBIT,
  type OrbitState,
} from './cameraMath.js';
import type { ConstraintMark } from '../sketch/constraintPicking.js';
import type { CanvasDraw } from './canvasLayer.js';
import {
  assemblyAppearanceSpecs,
  createAssemblyLayer,
  EMPTY_ASSEMBLY_GEOMETRY,
  type AssemblyGeometryBundle,
} from './createAssemblyLayer.js';
import type { SolidFieldMesh } from '../solidAnalysis/solidFieldView.js';
import type { SolidModeDrawing } from '../solidAnalysis/solidModeLayer.js';
import type { MeasurementState } from './createMeasureLayer.js';
import type {
  CutPreview,
  PrintabilityHighlight,
  SectionHandle,
  ThreadMarkInfo,
} from './createSolidLayer.js';
import type { SectionPlaneNumbers } from './sectionView.js';
import { axisLength, gridExtent, gridFadeOpacity, gridSpacing, isMajorGridLine } from './gridMath.js';
import { DEFAULT_THEME_COLORS, type ThemeColors } from './themeColors.js';
import { createViewportLifetime, ViewportResourceInitializationFailure, type ViewportLifetime } from './viewportLifetime.js';
import type { createViewportMeshObservation, ViewportMeshOwner } from './viewportMeshObservation.js';
import type { QuadRectangle, QuadViewId } from './quadLayout.js';
import type { QuadCameraState } from './quadCamera.js';
import {
  captureSolidMeshAdmission, captureWorldMeshAdmission, displayCopyBaseline, isSolidMeshAdmissionCurrent,
  meshLayoutsUnchanged, type GpuMeshBudget, type SolidMeshAdmission, type SolidMeshAdmissionState,
} from './solidMeshAdmission.js';
import type { AssemblyMateFaceHit as TypeAssemblyMateFaceHit } from './createAssemblyLayer.js';
import {
  applySceneThemeColors, assemblyOwnerStaleReason, attributeArrays, attributeBytes, composeMeshReservation, createAssemblyOwnerCapture,
  createSceneConstruction, createSceneLayers, createSectionClipping, isAssemblyOwnerCurrent, liveDisplayCopies,
  registerSceneLayerCleanup, returnUnpublishedReservations, updateBasisGuideLayers, updateLabelScreenScale,
  type AssemblyOwner, type AssemblyOwnerStaleReason,
} from './viewportSceneResources.js';
import {
  configureViewportCamera, createViewportCameras, fullyFramedIds, logicalQuadPanes, placeKeyLight, projectToScreen,
} from './viewportSceneRendering.js';


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
  /** Known PMREM payload reservation; separate from mesh attributes and OS GPU measurements. */
  readonly environmentReservedBytes: number;
  readonly environmentCleanupStatus: 'complete' | 'pending';
  readonly assemblySourceBackingBytes: number;
  readonly assemblyInstanceBytes: number;
  readonly assemblyCleanupReservedCpuBytes: number;
  readonly assemblyCleanupStatus: 'complete' | 'pending';
  readonly viewportCleanupStatus: 'complete' | 'pending';
  readonly viewportCleanupErrors: readonly string[];
  readonly uncovered: readonly string[];
}

const GPU_MESH_BUDGET_MESSAGE = 'Local display mesh buffers exceed the GPU budget';

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

/** 部品pickが実際に通った判定だけを書く。未実行の判定は未設定のまま。 */
export interface AssemblyComponentPickObservation {
  /** 押した時点の表示の持ち主の有無・失効・部品数(判定の前に読む。BUG.VIEW-PICK-NULL の観測)。 */
  ownerPresent?: boolean;
  displayInvalidated?: boolean;
  partCount?: number;
  /** 持ち主を断った時だけ、最初に外れた比較の名前。 */
  ownerStaleReason?: AssemblyOwnerStaleReason | 'no-owner';
  ownerAccepted?: boolean;
  cameraReady?: boolean;
  hitComponentId?: string | null;
  failed?: boolean;
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
  /** Selected current cylinder's native zero direction. Derived display only. */
  setCylinderBasisGuide(guide: CylinderBasisGuide | null): void;
  /** 現在選択した平面の実原点と正のX/Y方向。表示専用。 */
  setPlanarBasisGuide(guide: PlanarBasisGuide | null): void;
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
  pickComponent(screenX: number, screenY: number, observation?: AssemblyComponentPickObservation): string | null;
  pickAssemblyFace(screenX: number, screenY: number, observation?: AssemblyFacePickObservation): TypeAssemblyMateFaceHit | null;
  /**
   * 部品の表示を、持ち主の失効(store に出ない台帳の受領の失効を含む)で片付けたまま、まだ作り直していないか
   * (BUG.VIEW-PICK-NULL)。真の間の拾いの null は、片付いた空の層に当てただけで「何も無い所」の証拠にならない。
   * 印を読むだけで、持ち主の判定も状態の読み出しもしない。
   */
  assemblyDisplayInvalidated(): boolean;
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

/** 押した時点の表示の持ち主の有無・失効・部品数を、持ち主の判定の前に観測へ写す(BUG.VIEW-PICK-NULL)。 */
function observePickOwnerState(observation: AssemblyFacePickObservation | AssemblyComponentPickObservation | undefined,
  owner: AssemblyOwner | null, displayInvalidated: boolean, bundle: AssemblyGeometryBundle): void {
  if (observation === undefined) return;
  observation.ownerPresent = owner !== null;
  observation.displayInvalidated = displayInvalidated;
  observation.partCount = bundle.parts.length;
}

/** 部品pickの 1 回の持ち主の判定を観測へ写し、受け入れたかを返す(断った時だけ最初に外れた理由を書く)。 */
function observeComponentOwnerVerdict(observation: AssemblyComponentPickObservation | undefined,
  refusal: AssemblyOwnerStaleReason | 'no-owner' | null): boolean {
  const ownerAccepted = refusal === null;
  if (observation !== undefined) observation.ownerAccepted = ownerAccepted;
  if (observation !== undefined && refusal !== null) observation.ownerStaleReason = refusal;
  return ownerAccepted;
}

export function createViewportScene(canvas: HTMLCanvasElement, options: ViewportSceneOptions = {}): ViewportScene {
  const uiBackings = options.uiBackings ?? assemblyUiBackings;
  const construction = createSceneConstruction();
  const { acquired, returnAcquired } = construction;
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

  // 光源・方眼・各層は viewportSceneResources.ts が同じ取得順・scene へ足す順で作る。
  const layers = createSceneLayers(scene, acquired, () => {
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
    return assemblyLayer;
  });
  const { gridGroup, grid, axisLines, solidLayer, assemblyLayer, interferenceLayer, analysisFieldLayer, analysisModeLayer,
    canvasLayer, sketchLayer, referenceLayer, trackingLayer, constraintLayer, inferenceLayer, measureLayer,
    cylinderBasisLayer, planarBasisLayers } = layers;
  let cylinderGuide: CylinderBasisGuide | null = null;
  let planarGuide: PlanarBasisGuide | null = null;
  const cameras = createViewportCameras();

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
  /** スケッチの入力のどれかが変わったときに、描画用の並びを組み立て直す。 */
  function rebuildSketchBundle(): void {
    sketchBundle = buildSketchGeometry(
      resolvedSketch,
      sketchMesh,
      sketchHighlight,
      constructionIds,
      constrainedIds,
    );
  }

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
  let assemblyOwner: AssemblyOwner | null = null;
  let assemblyCandidateOwner: AssemblyOwner | null = null;

  function assemblyOwnerCurrent(owner: AssemblyOwner): boolean {
    return isAssemblyOwnerCurrent(owner, disposed, options);
  }
  const captureAssemblyOwner = createAssemblyOwnerCapture(options, assemblyOwnerCurrent);

  let assemblyDisplayInvalidated = false;

  function clearAssemblyDisplay(): void {
    assemblyDisplayInvalidated = true;
    assemblyLayer.group.visible = false;
    assemblyOwner = null; assemblyCandidateOwner = null;
    assemblyBundle = EMPTY_ASSEMBLY_GEOMETRY;
    assemblyLayer.update(EMPTY_ASSEMBLY_GEOMETRY, lastRender?.displayStyle ?? 'shadedWithEdges', environments.texture);
    refreshEnvironment();
  }

  /**
   * 表示の持ち主を 1 回だけ判定する。受け入れたら null、断ったら最初に外れた理由(古い持ち主はここで消す)。
   * 判定の回数・順・副作用は観測の有無で変えない(理由は同じ 1 回の判定から返す)。
   */
  function verifyCurrentAssemblyOwner(): AssemblyOwnerStaleReason | 'no-owner' | null {
    if (disposed) return 'disposed';
    if (assemblyOwner === null) return assemblyBundle.parts.length === 0 ? null : 'no-owner';
    const staleReason = assemblyOwnerStaleReason(assemblyOwner, disposed, options);
    if (staleReason === null) return null;
    clearAssemblyDisplay();
    return staleReason;
  }

  function ensureCurrentAssemblyOwner(): boolean {
    return verifyCurrentAssemblyOwner() === null;
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
    let environmentCandidate: EnvironmentCandidate | null = null;
    try {
      if (!assemblyOwnerCurrent(owner)) return;
      // Environment preparation sees candidate appearances without exposing candidate mesh geometry.
      const environmentSpecs = [...solidBundle.entries.flatMap(entry => entry.appearances),
        ...assemblyAppearanceSpecs(bundle)];
      environmentCandidate = environments.prepareEnvironment(anyNeedsEnvironment(environmentSpecs));
      if (!assemblyOwnerCurrent(owner)) { ensureCurrentAssemblyOwner(); return; }
      assemblyLayer.update(bundle, lastRender?.displayStyle ?? 'shadedWithEdges', environmentCandidate.texture);
      if (!assemblyOwnerCurrent(owner)) { clearAssemblyDisplay(); return; }
      environmentCandidate.commit(scene);
      assemblyBundle = bundle; assemblyOwner = owner; assemblyLayer.group.visible = true;
      assemblyDisplayInvalidated = false;
    } catch (error) {
      assemblyBundle = previousBundle;
      refreshEnvironment(); ensureCurrentAssemblyOwner();
      throw error;
    } finally {
      assemblyCandidateOwner = null;
      try { environmentCandidate?.rollback(); } catch { /* Failed cleanup stays reserved by the environment store. */ }
    }
    refreshEnvironment();
  }

  /**
   * 映り込み用の環境マップ(FR-1107、§0.a-0.9)。**鏡・ガラスを 1 つでも使っているときだけ
   * 作り、使わなくなったら捨てる**(NFR-PF-5)。レンダラを持っているのはここだけなので、
   * 作る・捨てるの判断もここで行い、`createSolidLayer` へはできあがったものを渡す。
   */
  const environments = acquired('environments', createEnvironmentStore(() => createEnvironmentTarget(renderer), options.gpuMeshBudget));

  /**
   * いまの外観で環境マップが要るかを見直す。**組み立て直したときにだけ呼ぶ**
   * (毎コマ呼ぶと、鏡を 1 つ足すたびに焼き直すことになる)。
   */
  function refreshEnvironment(bundle = solidBundle, assembly = assemblyBundle): void {
    const used = [
      ...bundle.entries.flatMap((entry) => entry.appearances),
      ...assemblyAppearanceSpecs(assembly),
    ];
    environments.prepareEnvironment(anyNeedsEnvironment(used)).commit(scene);
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
    refreshEnvironment();
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
    let environmentCandidate: EnvironmentCandidate | null = null;
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
      if (!ownerIsCurrent(owner)) {
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
      // Reserve old + candidate mesh attributes BEFORE PMREM's output and temporary peak.
      // Preparing does not retire the published environment or mutate scene.environment.
      environmentCandidate = environments.prepareEnvironment(anyNeedsEnvironment([
        ...candidate.entries.flatMap(entry => entry.appearances), ...assemblyAppearanceSpecs(assemblyBundle),
      ]));
      if (!ownerIsCurrent(owner)) {
        ensureCurrentSolidOwner();
        return;
      }
      observeMesh(observedOwner, 'publish-start');
      if (lastRender !== null) {
        try {
          solidLayer.update(candidate, lastRender.displayStyle, environmentCandidate.texture);
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
      environmentCandidate.commit(scene);
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
        try { environmentCandidate?.rollback(); } catch { /* Retain failed cleanup and its reservation for retry. */ }
        observeMesh(observedOwner, 'operation-aborted', 'rejected');
        observeMesh(observedOwner, 'candidate-return-start', 'rejected');
        returnUnpublishedReservations({ owner: solidOwner, gpuBytes: publishedGpuBytes }, displayCopies,
          options.gpuMeshBudget, gpuOwner, restoreCopies);
        observeMesh(observedOwner, 'candidate-return-complete', 'rejected');
      }
    }
  }

  /** 部分形状(面・辺・頂点)の強調の現在値(§0.a-0.7)。 */
  let subShapeHoveredElementId: string | null = null;
  let subShapeSelection: readonly string[] = [];
  let subShapeBundle = EMPTY_SUB_SHAPE_HIGHLIGHT;

  /** ねじの簡略表示の印(§0.a-0.15)。ボディの一覧から導くだけで、別の入力は持たない。 */
  let threadMarks: readonly ThreadMarkInfo[] = [];

  /** 切断面の予告(FR-432、タスク27e)。道具を使っている間だけ入り、確定・取消で null に戻る。 */
  let cutPreview: CutPreview | null = null;

  const sectionClipping = createSectionClipping(layers);

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
    const basisState = options.readSolidMeshState?.();
    updateBasisGuideLayers(layers, currentSolid, cylinderGuide, planarGuide, basisState);
    // 配置した部品(FR-605)。同じ一式を渡し直したときは並びを触らない(NFR-PF-1)。
    assemblyLayer.update(assemblyBundle, displayStyle, environments.texture);
    sketchLayer.update(sketchBundle, displayStyle);
    updateLabelScreenScale(layers, orbit, rectangle.height, uiScale);
  }

  /** 1 枚描く。層の同期後、同じカメラで光源と renderer を更新する。 */
  function drawScene(settings: RenderSettings, rectangle: QuadRectangle, spacing: number): void {
    updateVisibleLayers(settings, rectangle, spacing);
    // Layer disposal callbacks may change the live owner before the renderer consumes it.
    ensureCurrentSolidOwner();
    ensureCurrentAssemblyOwner();
    repairPreviews.ensureCurrent();
    const { orbit, projection } = settings;
    placeKeyLight(layers.keyLight, orbit);
    // Each quad pane uses this camera with the same world-space solid origins.
    // Three multiplies the double-valued inverse camera and object matrices before
    // converting modelView to GPU floats; no world Float32 mesh is retranslated.
    const camera = configureCamera(orbit, projection, rectangle);
    renderer.render(scene, camera);
  }

  function configureCamera(orbit: OrbitState, projection: ProjectionMode, rectangle: QuadRectangle): THREE.Camera {
    const camera = configureViewportCamera(cameras, orbit, projection, rectangle);
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
    return logicalQuadPanes(renderer.getPixelRatio(), canvas.width, canvas.height, quadProjection);
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

  const repairPreviews = createViewportRepairPreview(scene, uiBackings, options, () => lastRender?.displayStyle);

  function disposeOwnedLayers(): void {
    if (ownedCleanup === null) {
      if (observedPublishedOwner !== null) observeMesh(observedPublishedOwner, 'release-start', 'disposed');
      ownedCleanup = createViewportLifetime();
      registerSceneLayerCleanup(ownedCleanup, layers, environments, repairPreviews, renderer);
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
      rebuildSketchBundle();
    },

    setConstructionIds(ids): void {
      constructionIds = ids;
      rebuildSketchBundle();
    },

    setConstrainedFeatureIds(ids): void {
      constrainedIds = ids;
      rebuildSketchBundle();
    },

    setSketchHighlight(hoveredElementId, selection): void {
      sketchHighlight = { hoveredElementId, selection };
      rebuildSketchBundle();
    },

    setBodies(nextBodies): void {
      rebuildSolidBundle({ ...solidInputs(), bodies: nextBodies });
    },

    setAssembly: rebuildAssembly, assemblyDisplayInvalidated: () => assemblyDisplayInvalidated,
    setReferenceRepairPreview: repairPreviews.setReferenceRepairPreview,

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

    setSectionView: sectionClipping.setSectionView,

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

    setCylinderBasisGuide(guide): void {
      if (disposed) return;
      cylinderGuide = guide;
      if (guide === null) cylinderBasisLayer.update(null);
    },

    setPlanarBasisGuide(guide): void {
      if (disposed) return;
      planarGuide = guide;
      for (const layer of planarBasisLayers) {
        layer.update(null);
        layer.group.visible = false;
      }
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

    pickComponent(screenX, screenY, observation): string | null {
      try {
        observePickOwnerState(observation, assemblyOwner, assemblyDisplayInvalidated, assemblyBundle);
        // One owner verdict per pick, observed or not; the recorded reason is that verdict's own result.
        const ownerAccepted = observeComponentOwnerVerdict(observation, verifyCurrentAssemblyOwner());
        if (!ownerAccepted) return null;
        const cameraReady = prepareCameraRay(screenX, screenY);
        if (observation !== undefined) observation.cameraReady = cameraReady;
        if (!cameraReady) return null;
        const hit = assemblyLayer.pickComponent(raycaster);
        if (observation !== undefined) observation.hitComponentId = hit;
        return hit;
      } catch (error) {
        if (observation !== undefined) observation.failed = true;
        throw error;
      }
    },

    pickAssemblyFace(screenX, screenY, observation) {
      observePickOwnerState(observation, assemblyOwner, assemblyDisplayInvalidated, assemblyBundle);
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
      applySceneThemeColors(layers, colors);
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
      const repair = repairPreviews.meshReservation();
      return composeMeshReservation({ assembly, repair, uiBackings, publishedGpuBytes, environments, ownedCleanup,
        solidDisplayCopyBytes: Math.max(disposalDisplayCopyBytes, distinctBackingBytes([...liveDisplayCopies(solidBundle, subShapeBundle),
          ...displayCopies.buffers()])) });
    },

    fullyFramedBodyIds(): readonly string[] {
      if (lastCamera === null || !ensureCurrentSolidOwner()) return [];
      return fullyFramedIds(bodies, lastCamera, scratch);
    },

    worldToScreen(point): readonly [number, number] | null {
      if (lastCamera === null) {
        return null;
      }
      return projectToScreen(point, lastCamera, activeRectangle, scratch);
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
      repairPreviews.retire();
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
  construction.handOff();
  return viewport;
  } catch (error) {
    const initializationCleanup = createViewportLifetime();
    if (error instanceof ViewportResourceInitializationFailure && error.cleanup.pendingCount !== 0) {
      initializationCleanup.register('inner factory resources', () => {
        error.cleanup.dispose();
        if (error.cleanup.pendingCount !== 0) throw new Error(error.cleanup.errors.join('; '));
      });
    }
    for (const pending of construction.pending()) initializationCleanup.register(pending.label, pending.release);
    initializationCleanup.dispose();
    throw new ViewportSceneInitializationFailure(error, initializationCleanup);
  }
}
