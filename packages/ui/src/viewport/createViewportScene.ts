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

import type { ThumbnailCaptureReasonSink } from '../file/thumbnail.js';
import type { PointerRay, TrackCandidate } from '../sketch/trackMath.js';
import type { EditPreview } from '../sketch/trimPreview.js';
import type { DisplayStyle, ProjectionMode } from '../store/viewSlice.js';
import { assemblyUiBackings, type AssemblyUiBackingLedger } from './assemblyMeshAdmission.js';
import { anyNeedsEnvironment } from '../appearance/createAppearanceMaterial.js';
import type { AppearanceInput } from './buildSolidGeometry.js';
import { createEnvironmentStore, createEnvironmentTarget } from './createEnvironment.js';
import type { SphereGridSpec } from './buildSphereGrid.js';
import { HOME_ORBIT, type OrbitState } from './cameraMath.js';
import type { ConstraintMark } from '../sketch/constraintPicking.js';
import type { CanvasDraw } from './canvasLayer.js';
import { assemblyAppearanceSpecs, type AssemblyGeometryBundle } from './createAssemblyLayer.js';
import type { SolidFieldMesh } from '../solidAnalysis/solidFieldView.js';
import type { SolidModeDrawing } from '../solidAnalysis/solidModeLayer.js';
import type { MeasurementState } from './createMeasureLayer.js';
import type {
  CutPreview,
  PrintabilityHighlight,
  SectionHandle,
} from './createSolidLayer.js';
import type { SectionPlaneNumbers } from './sectionView.js';
import { gridSpacing } from './gridMath.js';
import type { ThemeColors } from './themeColors.js';
import { createViewportLifetime, ViewportResourceInitializationFailure, type ViewportLifetime } from './viewportLifetime.js';
import type { createViewportMeshObservation } from './viewportMeshObservation.js';
import type { QuadViewId } from './quadLayout.js';
import type { QuadCameraState } from './quadCamera.js';
import type { GpuMeshBudget, SolidMeshAdmissionState } from './solidMeshAdmission.js';
import type { AssemblyMateFaceHit as TypeAssemblyMateFaceHit } from './createAssemblyLayer.js';
import {
  applySceneThemeColors, composeMeshReservation, createSceneConstruction, createSceneLayers, registerSceneLayerCleanup,
  type AssemblyOwnerStaleReason,
} from './viewportSceneResources.js';
import { createViewportCameras } from './viewportSceneRendering.js';
import { createSceneAssemblyDisplay } from './viewportSceneAssemblyDisplay.js';
import { createSceneCapture } from './viewportSceneCapture.js';
import { createSceneFrame } from './viewportSceneFrame.js';
import { createSceneGrid } from './viewportSceneGrid.js';
import { createSceneOverlays } from './viewportSceneOverlays.js';
import { createScenePointer } from './viewportScenePointer.js';
import { createSceneRenderer } from './viewportSceneRenderer.js';
import { createSceneSketchInputs } from './viewportSceneSketchInputs.js';
import { createSceneSolidDisplay } from './viewportSceneSolidDisplay.js';


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

/**
 * ビューの断面表示(FR-111)を描くのに要るもの。
 *
 * 平面の**数**は `sectionView.ts` の `toThreePlane`(three.js に触れない純関数)が
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
  /** 押した時点の表示の持ち主の有無・失効・部品数(判定の前に読む。拾いの null が片付いた表示か何も無い所かを見分ける観測)。 */
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
   * 構築線(FR-320)として破線で引く要素の id を差し替える。
   * 解決済みの曲線は construction を持たないので、履歴から引いた集合を外から渡す。
   */
  setConstructionIds(ids: ReadonlySet<string>): void;
  /**
   * 完全に決まった要素(FR-313、利用者の決定②)の
   * フィーチャー id を差し替える。判定は `constrainedElements.ts` が行い、ここは
   * 受け取った集合を組み立てへ渡すだけにする(判定を 2 か所に置かない)。
   */
  setConstrainedFeatureIds(ids: ReadonlySet<string>): void;
  /** ホバー・選択の強調を差し替える(FR-106)。 */
  setSketchHighlight(hoveredElementId: string | null, selection: readonly string[]): void;
  /** ソリッドの表示を差し替える(FR-105)。ボディの id はフィーチャーの id。 */
  setBodies(bodies: readonly SolidBody[]): void;
  /**
   * 配置した部品の表示を差し替える(FR-605)。
   *
   * 渡すのは `createAssemblyLayer.ts` の `buildAssemblyGeometry` が仕分けた一式で、
   * **形は部品の鍵ごとに 1 つ**・配置は置いた数だけ入っている。
   * `EMPTY_ASSEMBLY_GEOMETRY` を渡すと消える(アセンブリを開いていないあいだの値)。
   * **同じ一式(同一参照)を渡し直したときは並びを触らない**(NFR-PF-1)。
   */
  setAssembly(bundle: AssemblyGeometryBundle): void;
  /** 干渉解析の共通形状と、一覧で選んだ組を独立層へ渡す。 */
  setInterference(result: AssemblyInterferenceResult | null, selectedKey: string | null): void;
  /**
   * 外観の割り当てを差し替える(FR-1106〜1109)。文書の割り当てと、
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
   * 切断面の予告表示を差し替える(FR-432)。
   * `null` で消える。**同じ内容(同一参照)を渡し直すと並びを触らない**(NFR-PF-1)ので、
   * 呼び出し側は予告の値を毎回作り直さず、変わったときだけ新しい値を渡す。
   */
  setCutPreview(preview: CutPreview | null): void;
  /**
   * ビューの断面表示(FR-111)を差し替える。`null` で切る(元に戻る)。
   *
   * **形は変えない。** 材質のクリッピング平面を差し替えるだけなので、体積も三角形も
   * 1 つも変わらず、再計算(`isComputing`)も走らない。切っていないあいだは平面が
   * 1 枚も無く、費用はゼロ(NFR-PF-1)。
   */
  setSectionView(view: SectionViewRender | null): void;
  /**
   * 3D プリントの点検の色(FR-815)を出す / 消す。`null` で閉じる。
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
   * 下絵の画像(FR-332)を差し替える。空の並びで消える。
   *
   * **形は 1 つも変わらない。** 下絵は押し出しの材料にも当たり判定にもならないので、
   * 入切・移動・不透明度の変更で再計算(`isComputing`)は走らない。
   * 入切で外したもの・作図面を解けないもの・画像をまだ復号できていないものは、
   * 呼び出し側が並びから外して渡す(この層は渡された分だけを描く)。
   */
  setCanvases(draws: readonly CanvasDraw[]): void;
  /**
   * 球面の案内線(球面グリッド、FR-431)を差し替える。`null` で消える。
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
   * 部品の表示を、持ち主の失効(store に出ない台帳の受領の失効を含む)で片付けたまま、まだ作り直していないか。
   * 真の間の拾いの null は、片付いた空の層に当てただけで「何も無い所」の証拠にならない。
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
   * いまの絵をもう 1 回描いて、一辺 `size` の PNG のバイト列にする。
   * `preserveDrawingBuffer` を常時有効にすると描画が重くなる(NFR-PF-1)ので、
   * **描いた直後の同じ同期処理の中**で読む。まだ一度も描いていなければ null。
   */
  captureThumbnail(size?: number, reasonSink?: ThumbnailCaptureReasonSink): Uint8Array | null;
  /**
   * いまの絵をもう 1 回描いて、**印刷用の 1 コマ**(PNG の data URL)にする
   * (FR-810、FR-908)。読む時機は `captureThumbnail` と同じ理由で
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
   * いま描いている作図面。薄い矩形で向きを示す。
   * 任意の作業平面(FR-328)も出せるよう、id ではなく**解いた面そのもの**を受け取る
   * (解くのはストア側の `workPlane`)。
   */
  setWorkPlane(plane: WorkPlane): void;
  /** 作図面の矩形を出すか(3D スケッチでは出さない。FR-330)。 */
  setWorkPlaneVisible(visible: boolean): void;
  /**
   * トリム・延長の予告(FR-322)。マウスを乗せた区間(消える区間)と、
   * 伸びる区間の折れ線を、もとの線の上へ重ねて描く。`null` で消す。
   */
  setEditPreview(preview: EditPreview | null): void;
  /**
   * 向きの吸着の案内線(FR-110)。細い破線を画面いっぱいに引く。
   * 同時に出すのは最大 2 本で、`null` か空で消す。
   */
  setTracking(lines: readonly TrackCandidate[] | null): void;
  /**
   * 拘束の印(FR-313)。要素の脇に記号の小さな札を常時出す。
   * `null` か空で消す。当たり判定は `constraintPicking.ts` の `constraintMarkAt` が
   * 同じ並びを見て行う(描画・当たり判定・選択の 3 つをそろえる)。
   */
  setConstraintMarks(marks: readonly ConstraintMark[] | null): void;
  /** 一覧・印で選んでいる拘束(FR-313)。その印だけ大きく出す。`null` で解除。 */
  setSelectedConstraint(constraintId: string | null): void;
  /**
   * 線を引いている最中に推定した拘束の**予告**の印(FR-333)。
   * 図柄は確定後の拘束の印とまったく同じで、`null` か空で消す。
   * 実在の拘束ではないので当たり判定には出ない(押しても選ばれない)。
   */
  setInferredConstraintMarks(marks: readonly ConstraintMark[] | null): void;
  /** 基準ジオメトリ(基準軸・基準点・座標系、FR-329)を出す。 */
  setReferences(references: ResolvedReferences): void;
  /**
   * 測定の結果(FR-1102)。測った 2 点を結ぶ線と端の丸、角度の 2 本の線と弧、
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
   * (`trackMath.ts` の `closestParameterToRay`)。
   */
  pointerRay(x: number, y: number): PointerRay | null;
  resize(widthPixels: number, heightPixels: number): void;
  /** 視点操作中は描画画素を減らし、離したら通常解像度へ戻す。 */
  setInteractiveRendering(active: boolean): void;
  dispose(): void;
}

/*
 * 責務ごとの持ち主(レンダラ・方眼・スケッチの入力・立体・部品・重ね表示・視点と画面座標・描画・保存の 1 コマ)を
 * 構築中の台帳へ同じ取得順で作り、ViewportScene の窓口へまとめる。ここに残すのは、構築の失敗の巻き戻し、
 * 立体と部品の両方が使う映り込みの環境マップ、テーマの配り分け、表示の予約の報告、破棄の順序だけ。
 */
export function createViewportScene(canvas: HTMLCanvasElement, options: ViewportSceneOptions = {}): ViewportScene {
  const uiBackings = options.uiBackings ?? assemblyUiBackings;
  const construction = createSceneConstruction();
  try {
  let disposed = false;
  let ownedCleanup: ViewportLifetime | null = null;
  const isDisposed = (): boolean => disposed;
  const output = createSceneRenderer(canvas, construction.acquired, isDisposed);
  const { renderer } = output;

  const scene = new THREE.Scene();
  // シーンの原点は動かさない。毎コマ恒等行列を再設定すると、変更の無い全ての部品へも
  // world 行列の強制更新が伝わる。カメラや各層の動く要素は自身の更新設定で追従する。
  scene.matrixAutoUpdate = false;

  // 後から作る持ち主(描画・環境マップ・視点)は、呼ばれた時にだけ読む(構築中には呼ばない)。
  const later = { displayStyle: () => frame.displayStyle(), environments: () => environments, refreshEnvironment,
    pointer: () => pointer };
  const assembly = createSceneAssemblyDisplay({ ...later, options, uiBackings, acquired: construction.acquired, scene,
    isDisposed, solidBundle: () => solid.bundle() });
  // 光源・方眼・各層は viewportSceneResources.ts が同じ取得順・scene へ足す順で作る。配置した部品の層だけは、
  // 部品の表示の持ち主が持ち主の判定を閉じ込めて同じ位置で作る。
  const layers = createSceneLayers(scene, construction.acquired, assembly.createLayer);
  const cameras = createViewportCameras();
  const grid = createSceneGrid(layers, construction, gridSpacing(HOME_ORBIT.distance));
  const sketch = createSceneSketchInputs(layers);
  const solid = createSceneSolidDisplay({ ...later, options, uiBackings, solidLayer: layers.solidLayer, scene, isDisposed,
    assemblyBundle: () => assembly.bundle() });

  /**
   * 映り込み用の環境マップ(FR-1107)。**鏡・ガラスを 1 つでも使っているときだけ
   * 作り、使わなくなったら捨てる**(NFR-PF-5)。レンダラを持っているのはここだけなので、
   * 作る・捨てるの判断もここで行い、`createSolidLayer` へはできあがったものを渡す。
   */
  const environments = construction.acquired('environments',
    createEnvironmentStore(() => createEnvironmentTarget(renderer), options.gpuMeshBudget));

  /**
   * いまの外観で環境マップが要るかを見直す。**組み立て直したときにだけ呼ぶ**
   * (毎コマ呼ぶと、鏡を 1 つ足すたびに焼き直すことになる)。
   */
  function refreshEnvironment(): void {
    const used = [
      ...solid.bundle().entries.flatMap((entry) => entry.appearances),
      ...assemblyAppearanceSpecs(assembly.bundle()),
    ];
    environments.prepareEnvironment(anyNeedsEnvironment(used)).commit(scene);
  }

  const overlays = createSceneOverlays(layers, options, isDisposed);
  const pointer = createScenePointer(cameras, { x: 0, y: 0, width: output.width(), height: output.height() }, isDisposed);
  const frame = createSceneFrame({ canvas, scene, output, layers, grid, solid, assembly, overlays, sketchBundle: sketch.bundle,
    pointer, ensureRepairPreviewCurrent: () => { repairPreviews.ensureCurrent(); }, isDisposed });
  const repairPreviews = createViewportRepairPreview(scene, uiBackings, options, () => frame.displayStyle());
  const capture = createSceneCapture({ canvas, options, isDisposed, frame, solid, assembly });

  /** 層と描画資源の破棄を 1 回だけ登録して試し、返せなかった物は次の dispose で返し直す。 */
  function disposeOwnedLayers(): void {
    if (ownedCleanup === null) {
      solid.observeReleaseStart();
      ownedCleanup = createViewportLifetime();
      registerSceneLayerCleanup(ownedCleanup, layers, environments, repairPreviews, renderer);
    }
    ownedCleanup.dispose();
    solid.releaseAfterCleanup(ownedCleanup.pendingCount);
  }

  const viewport: ViewportScene = {
    ...sketch.methods, ...solid.methods, ...assembly.methods, ...overlays.methods, ...pointer.methods, ...output.methods,
    ...frame.methods, ...capture.methods,
    setReferenceRepairPreview: repairPreviews.setReferenceRepairPreview,

    setThemeColors(next): void {
      // 方眼と軸は頂点ごとの色を持つので、いまの間隔のまま組み立て直してから各層へ配る。
      grid.setColors(next);
      applySceneThemeColors(layers, next);
    },

    meshReservation(): ViewportMeshReservation {
      const assemblyReading = layers.assemblyLayer.meshReservation();
      const repair = repairPreviews.meshReservation();
      return composeMeshReservation({ assembly: assemblyReading, repair, uiBackings, publishedGpuBytes: solid.publishedGpuBytes(),
        environments, ownedCleanup, solidDisplayCopyBytes: solid.reportedDisplayCopyBytes() });
    },

    dispose(): void {
      if (disposed) { disposeOwnedLayers(); return; }
      disposed = true;
      repairPreviews.retire();
      assembly.retire();
      solid.retire();
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
