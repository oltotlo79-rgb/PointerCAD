import { appearanceOf, isFreeWorkPlaneId } from '@pointercad/model';
import { buildAppearanceInput } from '../appearance/appearanceCommands.js';
import { t } from '../i18n/t.js';
import { isSheetFlatDisplayed } from '../sheetMetal/sheetCreationActions.js';
import { constrainedFeatureIdsOfStore } from '../sketch/constraintActions.js';
import { constraintMarksOf } from '../sketch/constraintPicking.js';
import { constructionFeatureIds } from '../sketch/featureSummary.js';
import { solidAnalysisLayersChanged, solidAnalysisLayersOf } from '../solidAnalysis/solidModalViewport.js';
import type { AppState } from '../store/appState.js';
import { activePartDocument } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import type { CameraControls } from './attachCameraControls.js';
import type { CutPreview } from './createSolidLayer.js';
import type { ViewportScene } from './createViewportScene.js';
import { cylinderBasisGuide } from './cylinderBasisGuide.js';
import { planarBasisGuide } from './planarBasisGuide.js';
import { sketchDragTimingOwnerChanged, type sketchDragTimingForE2E } from './sketchDragTiming.js';
import { solidBodiesForAdmission, solidMeshOwnershipChanged } from './solidMeshAdmission.js';
import type { ViewportAssemblyInput } from './viewportCanvasAssemblyInput.js';
import {
  assemblyBundleOf, cutPreviewOf, printabilityHighlightOf, sectionViewRenderOf, sphereGridNeedsUpdate, sphereGridSpecOf,
} from './viewportCanvasStoreViews.js';

/*
 * ViewportCanvas のストアから scene への受け渡し(rules/04: 画面状態は Zustand ストア 1 本)。起動時に全ての表示を
 * 1 回渡し、その後はストアの変化のうち材料が変わったものだけを、決まった順に渡し直す(同じ値を渡し直すと層は
 * 並びを触らない約束を、参照を作り直して壊さないため。NFR-PF-1)。描画の予約は最後に 1 回だけ判断する。
 */

/** 受け渡しの相手。スケッチの形の差し替えと参照修復の予告は ViewportCanvas が持つ(待ちの後に文書を変えない点検の対象)。 */
export interface ViewportStoreSync {
  readonly canvas: HTMLCanvasElement;
  readonly scene: ViewportScene;
  readonly isAlive: () => boolean;
  readonly sketchTiming: ReturnType<typeof sketchDragTimingForE2E>;
  /** スケッチの形(文書どおり、または引っぱっている最中の仮の形)を scene へ渡す。hidden なら空のスケッチ。 */
  readonly publishSketch: (state: AppState, hidden: boolean) => void;
  readonly syncRepairPreview: (state: AppState) => void;
  readonly showCutPreview: (preview: CutPreview | null) => void;
  readonly assemblyInput: Pick<ViewportAssemblyInput, 'assemblyReady' | 'startDocumentInputs'>;
  readonly invalidateThumbnailPublication: () => void;
  readonly syncCanvasImages: () => void;
  readonly requestDraw: () => void;
  readonly markThemeDirty: () => void;
  readonly cancelAssemblyDrag: () => void;
  readonly controls: Pick<CameraControls, 'goHome' | 'getOrbit'>;
}

/** 平面の基準の案内の札(FR-329 の表示の言葉)。 */
function planarGuideLabels() {
  return { origin: t('viewport.planarOrigin'), x: t('viewport.planarPositiveX'), y: t('viewport.planarPositiveY') };
}

/** 起動時に、ストアの今の状態を全ての表示へ 1 回渡す。 */
export function syncInitialScene(sync: ViewportStoreSync): void {
  const { scene } = sync;
  scene.resize(sync.canvas.clientWidth, sync.canvas.clientHeight);
  const initial = useAppStore.getState();
  // 引っぱっている最中(FR-313)は仮の形を描く。文書どおりの形
  // (`resolvedSketch`)は当たり判定・プロパティ・吸着がそのまま読み続ける。
  const initialSketchHidden = activePartDocument(initial) === null || isSheetFlatDisplayed(initial);
  sync.publishSketch(initial, initialSketchHidden);
  scene.setSketchHighlight(initial.hoveredElementId, initial.selection);
  scene.setBodies(solidBodiesForAdmission(initial));
  // 配置した部品(FR-605)。アセンブリを開いていないあいだは空のまま。
  if (sync.assemblyInput.assemblyReady()) scene.setAssembly(assemblyBundleOf(useAppStore.getState()));
  scene.setInterference(initial.assemblyInterferenceResult, initial.assemblyInterferenceSelectedKey);
  // 外観の割り当て(FR-1106〜1109)。文書の割り当てと、カーネルが選び直した面の対応から
  // 組み立てる。割り当てが 1 つも無ければ既定の外観 1 色になる。
  scene.setAppearance(
    buildAppearanceInput(appearanceOf(initial.document), initial.appearanceMatches),
  );
  scene.setBodyHighlight(initial.hoveredElementId, initial.selection);
  scene.setSubShapeHighlight(initial.hoveredElementId, initial.selection);
  sync.syncRepairPreview(initial);
  scene.setWorkPlane(initial.workPlane);
  // 3D スケッチ(作図面なし、FR-330)では作図面の矩形を出さない。
  scene.setWorkPlaneVisible(!isFreeWorkPlaneId(initial.workPlaneId));
  // 構築線(FR-320)は履歴を見ないと分からないので、文書から引いて渡す。
  scene.setConstructionIds(constructionFeatureIds(initial.sketch));
  // 完全に決まった要素(FR-313、利用者の決定②)。判定は純関数 1 か所。
  scene.setConstrainedFeatureIds(constrainedFeatureIdsOfStore(initial));
  scene.setReferences(initial.resolvedReferences);
  scene.setEditPreview(initial.editPreview);
  scene.setTracking(initial.trackIndicator);
  // 拘束の印(FR-313)。一覧の行(`constraintSummaries`)を印へ開く。
  scene.setConstraintMarks(constraintMarksOf(initial.constraintSummaries));
  scene.setSelectedConstraint(initial.selectedConstraintId);
  // 推定した拘束の予告(FR-333)。線を引いている最中だけ出る。
  scene.setInferredConstraintMarks(initial.inferredConstraints?.marks ?? null);
  // 測定の結果(FR-1102)。線・弧・端の丸・値の札を出す。
  scene.setMeasurement(initial.measurement);
  // 切断面の予告(FR-432)。切断の段が開いている間だけ出る。
  sync.showCutPreview(cutPreviewOf(initial));
  // 球面の案内線(FR-431)。球を選んでいる間(または「いつも出す」)だけ出る。
  scene.setSphereGrid(sphereGridSpecOf(initial));
  scene.setCylinderBasisGuide(cylinderBasisGuide(initial, t('viewport.cylinderZeroDirection')));
  scene.setPlanarBasisGuide(planarBasisGuide(initial, planarGuideLabels()));
  // ビューの断面表示(FR-111)。入れているあいだだけ平面を配る。
  scene.setSectionView(sectionViewRenderOf(initial.sectionView));
  // 3D プリントの点検の色(FR-815)。点検を出しているあいだだけ塗る。
  scene.setPrintability(printabilityHighlightOf(initial));
  // 立体解析の場(完了した現在の結果だけ)。結果が無ければ何も描かない。
  { const layers = solidAnalysisLayersOf(initial); scene.setAnalysisField(layers.field); scene.setAnalysisMode(layers.mode); }
  // 下絵(FR-332)。復号が済んだものから順に貼られる。
  sync.syncCanvasImages();
  sync.requestDraw();
}

/** スケッチの形・立体・外観・強調(FR-105、FR-106、FR-310、FR-1106)。 */
function syncShapesAndHighlights(sync: ViewportStoreSync, next: AppState, previous: AppState): void {
  const { scene } = sync;
  // スケッチの形と、カーネルが返した面(FR-105、FR-310)。
  if (
    // 最初のpreview前は形の参照が同じでも、取消後のbaselineを観測へ再結合する。
    sketchDragTimingOwnerChanged(sync.sketchTiming, next.sketchDrag, previous.sketchDrag) ||
    next.resolvedSketch !== previous.resolvedSketch ||
    next.sketchMesh !== previous.sketchMesh ||
    // 引っぱっている最中の仮の形(FR-313)。1 コマに 1 回だけ差し替わる。
    next.dragResolved !== previous.dragResolved || next.assembly !== previous.assembly ||
    isSheetFlatDisplayed(next) !== isSheetFlatDisplayed(previous)
  ) {
    const sketchHidden = activePartDocument(next) === null || isSheetFlatDisplayed(next);
    sync.publishSketch(next, sketchHidden);
  }
  // 立体(FR-105)。カーネルが返した三角形と稜線をボディごとに描く。
  if (solidMeshOwnershipChanged(next, previous)) {
    scene.setBodies(solidBodiesForAdmission(next));
  }
  // 外観(FR-1106〜1109)。**割り当ての表そのものが変わったときだけ**組み立て直す。
  // 文書が変わるたびに作り直すと、スケッチを 1 本引いただけで材質の入れ替えが起きる
  // (`appearanceOf` は割り当てが変わらなければ同じ表を返す)。
  if (
    appearanceOf(next.document) !== appearanceOf(previous.document) ||
    next.appearanceMatches !== previous.appearanceMatches
  ) {
    scene.setAppearance(buildAppearanceInput(appearanceOf(next.document), next.appearanceMatches));
  }
  // ホバー・選択の強調(FR-106)。スケッチの要素・ボディ・部分形状(面・辺・頂点)は
  // 同じ選択を共有していて、id の形でどれを強調するかが決まる。
  // 選択の種類(selectionKind)が変わると選択は空になる(useAppStore.setSelectionKind)が、
  // ホバーは残ることがあるので、種類の変化そのものも見て古い形の強調を残さない。
  if (
    next.hoveredElementId !== previous.hoveredElementId ||
    next.selection !== previous.selection ||
    next.selectionKind !== previous.selectionKind
  ) {
    scene.setSketchHighlight(next.hoveredElementId, next.selection);
    scene.setBodyHighlight(next.hoveredElementId, next.selection);
    scene.setSubShapeHighlight(next.hoveredElementId, next.selection);
  }
}

/** 配置した部品と干渉の表示(FR-605、FR-606)。 */
function syncAssemblyDisplay(sync: ViewportStoreSync, next: AppState, previous: AppState): void {
  const { scene } = sync;
  /*
    配置した部品(FR-605)。**アセンブリ文書か強調が変わったときだけ**
    仕分け直す(NFR-PF-1。同じ一式を渡し直すと層は並びを触らないが、ここで毎回
    作り直すと参照が変わってその約束が効かなくなる)。
  */
  if (
    next.assembly !== previous.assembly ||
    next.assemblyView !== previous.assemblyView ||
    next.requestedGeneration !== previous.requestedGeneration ||
    next.completedGeneration !== previous.completedGeneration ||
    next.recomputeCancelled !== previous.recomputeCancelled ||
    next.assemblyDragOverlay !== previous.assemblyDragOverlay ||
    next.assemblyMotionPlacements !== previous.assemblyMotionPlacements ||
    next.assemblyOccurrenceDrives !== previous.assemblyOccurrenceDrives ||
    next.assemblyMotionSourceDocument !== previous.assemblyMotionSourceDocument ||
    next.assemblyMateDraft !== previous.assemblyMateDraft ||
    next.hoveredElementId !== previous.hoveredElementId ||
    next.selection !== previous.selection
  ) {
    if (sync.assemblyInput.assemblyReady()) scene.setAssembly(assemblyBundleOf(useAppStore.getState()));
  }
  if (next.assemblyInterferenceResult !== previous.assemblyInterferenceResult
    || next.assemblyInterferenceSelectedKey !== previous.assemblyInterferenceSelectedKey) {
    scene.setInterference(next.assemblyInterferenceResult, next.assemblyInterferenceSelectedKey);
  }
}

/** 形を変えない重ね表示(切断の予告・基準の案内・球面の案内線・断面・解析の場・点検の色・下絵)。 */
function syncOverlays(sync: ViewportStoreSync, next: AppState, previous: AppState): void {
  const { scene } = sync;
  /*
    切断面の予告(FR-432)。**材料が変わったときだけ**組み立て直す
    (NFR-PF-1。同じ内容を渡し直すと層は並びを触らないが、ここで毎回作り直すと
    参照が変わってしまい、その約束が効かなくなる)。式は確定と同じく変数表と表示の単位で
    読むので、パラメータの解析・表示の単位が変わったときも組み立て直す。
  */
  if (
    next.numericInput !== previous.numericInput ||
    next.selection !== previous.selection ||
    next.bodies !== previous.bodies ||
    next.document !== previous.document ||
    next.parameterAnalysis !== previous.parameterAnalysis ||
    next.displaySettings.lengthUnit !== previous.displaySettings.lengthUnit
  ) {
    sync.showCutPreview(cutPreviewOf(next));
  }
  /*
    球面の案内線(FR-431)。**材料が変わったときだけ**組み立て直す。
    文書・選択・設定に加え、図形由来の係数の現在値が使えるかも通知する。
    世代・履歴位置・計算状態だけの変更でも古い線を消し、現在値へ戻ったら描き直す。
    中身が同じなら `setSphereGrid` が線分の組み立てそのものを省く(NFR-PF-1)。
  */
  if (sphereGridNeedsUpdate(next, previous) || solidMeshOwnershipChanged(next, previous)
    || next.assembly !== previous.assembly || next.drawing !== previous.drawing) {
    scene.setCylinderBasisGuide(cylinderBasisGuide(next, t('viewport.cylinderZeroDirection')));
    scene.setPlanarBasisGuide(planarBasisGuide(next, planarGuideLabels()));
  }
  if (sphereGridNeedsUpdate(next, previous)) {
    scene.setSphereGrid(sphereGridSpecOf(next));
  }
  /*
    ビューの断面表示(FR-111)。**札が変わったときだけ**平面を作り直す。
    つまみの四角の広さはボディから測るが、その測り直しは層の側(`syncDraws`)が
    形の差し替えと同じ機会に行うので、ここではボディの変化を見る必要が無い。
  */
  if (next.sectionView !== previous.sectionView) {
    scene.setSectionView(sectionViewRenderOf(next.sectionView));
  }
  // 立体解析の場。失敗・取消・古い結果・文書の差し替えでは結果が消えるので、場も消える。
  if (solidAnalysisLayersChanged(next, previous)) {
    const layers = solidAnalysisLayersOf(next);
    scene.setAnalysisField(layers.field); scene.setAnalysisMode(layers.mode);
    sync.requestDraw();
  }
  /*
    3D プリントの点検の色(FR-815)。**結果が入れ替わったときだけ**渡し直す。
    塗る相手(`printabilityOffsets`)は結果と必ず一緒に入れ替わる(ストアの決め)ので、
    結果の入れ替わりだけを見ればよい。**再計算は 1 回も走らない**。
  */
  if (next.printability !== previous.printability || next.bodies !== previous.bodies) {
    const highlight = printabilityHighlightOf(next);
    scene.setPrintability(highlight);
    if (
      highlight === null &&
      next.printability !== null &&
      next.printabilityOffsets !== null
    ) {
      next.invalidatePrintability();
    }
  }
  /*
    下絵(FR-332)。**文書か画像の表が変わったときだけ**貼り直す。
    入切・移動・不透明度は文書の変化として届くが、**再計算は 1 回も走らない**
    (`affectsShape` が下絵を見ないので `isComputing` も立たない)。
  */
  if (next.document !== previous.document || next.canvases !== previous.canvases
    || next.canvasRectification !== previous.canvasRectification
    || next.canvasImageRetries !== previous.canvasImageRetries
    || next.assembly !== previous.assembly || next.drawing !== previous.drawing
    || next.activeDocumentId !== previous.activeDocumentId) {
    sync.syncCanvasImages();
  }
}

/** 作図の補助(作図面・構築線・完全に決まった要素・基準・トリムの予告・吸着の案内線・拘束の印・測定)。 */
function syncSketchAids(sync: ViewportStoreSync, next: AppState, previous: AppState): void {
  const { scene } = sync;
  // 作図面が変わったら矩形の向きを変える。任意の作業平面(FR-328)は
  // 文書が変わっても面の位置が動くので、解いた面そのものの変化を見る。
  if (next.workPlane !== previous.workPlane) {
    scene.setWorkPlane(next.workPlane);
  }
  if (next.workPlaneId !== previous.workPlaneId) {
    scene.setWorkPlaneVisible(!isFreeWorkPlaneId(next.workPlaneId));
  }
  // 構築線(FR-320)の入り切りは履歴の変化にだけ表れる(解決済みの曲線には出ない)。
  if (next.sketch !== previous.sketch) {
    scene.setConstructionIds(constructionFeatureIds(next.sketch));
  }
  /*
    完全に決まった要素の色分け(FR-313、利用者の決定②)。
    判定の材料は履歴・解決結果・拘束の診断・作図面の 4 つなので、そのどれかが
    変わったときだけ数え直す(解決はし直さない、NFR-PF-1)。
  */
  if (
    next.sketch !== previous.sketch ||
    next.resolvedSketch !== previous.resolvedSketch ||
    next.constraintDiagnosis !== previous.constraintDiagnosis ||
    next.workPlaneId !== previous.workPlaneId ||
    next.workPlane !== previous.workPlane
  ) {
    scene.setConstrainedFeatureIds(constrainedFeatureIdsOfStore(next));
  }
  // 基準ジオメトリ(FR-329)。文書から解いた控えが変わったときだけ出し直す。
  if (next.resolvedReferences !== previous.resolvedReferences) {
    scene.setReferences(next.resolvedReferences);
  }
  // トリム・延長の予告(FR-322)。同じ区間なら
  // `attachSketchInteraction` 側が入れ直さないので、ここは変化だけを見ればよい。
  if (next.editPreview !== previous.editPreview) {
    scene.setEditPreview(next.editPreview);
  }
  // 向きの吸着の案内線(FR-110)。同じ線のままポインタが滑っている間は
  // `attachSketchInteraction` 側が入れ直さないので、ここは変化だけを見ればよい。
  if (next.trackIndicator !== previous.trackIndicator) {
    scene.setTracking(next.trackIndicator);
  }
  // 拘束の印(FR-313)。一覧・当たり判定と同じ 1 つ(`constraintSummaries`)を
  // 見るので、ここでは控えが差し替わったときだけ開き直せばよい。
  if (next.constraintSummaries !== previous.constraintSummaries) {
    scene.setConstraintMarks(constraintMarksOf(next.constraintSummaries));
  }
  if (next.selectedConstraintId !== previous.selectedConstraintId) {
    scene.setSelectedConstraint(next.selectedConstraintId);
  }
  /*
    推定した拘束の予告(FR-333)。控えが差し替わったときだけ出し直す。
    `attachSketchInteraction.ts` は中身が変わらないコマでは書き直さない
    (`sameInferredPreview`)ので、ここが毎コマ動くことはない(NFR-PF-1)。
  */
  if (next.inferredConstraints !== previous.inferredConstraints) {
    scene.setInferredConstraintMarks(next.inferredConstraints?.marks ?? null);
  }
  // 測定の結果(FR-1102)。控えが差し替わったときだけ出し直す。測るのも
  // 消すのもストア側の仕事なので、ここは変化を見て渡すだけ(NFR-PF-1)。
  if (next.measurement !== previous.measurement) {
    scene.setMeasurement(next.measurement);
  }
}

/** 視点とテーマの要求(FR-108、FR-908)。視点の正本は attachCameraControls にしか無い。 */
function syncViewRequests(sync: ViewportStoreSync, next: AppState, previous: AppState): void {
  // 表示テーマが変わったら 3D の色も読み直す(FR-908。拡大率は 3D の色を変えない)。
  if (next.displaySettings.theme !== previous.displaySettings.theme) {
    sync.markThemeDirty();
  }
  // ホーム視点への復帰要求(FR-108)。数が増えたときだけ戻す。
  if (next.projection !== previous.projection) {
    sync.cancelAssemblyDrag();
  }
  if (next.homeViewRequestCount !== previous.homeViewRequestCount) {
    sync.controls.goHome();
  }
  // 標準の向きの要求(viewOrientationRequest)はここでは扱わない。ビューキューブが面を押した時と同じ遷移で
  // setOrbit を通して移す(viewcube/ViewCube.tsx。4 分割の向きの決まった区画では命令の側で断る)。
  // 「視点に合わせる」の要求。視点の正本はここにしか無いので、
  // 今の視点をストアへ渡し返して作図面を決めてもらう。
  if (next.matchWorkPlaneRequestCount !== previous.matchWorkPlaneRequestCount) {
    useAppStore.getState().matchWorkPlaneToView(sync.controls.getOrbit());
  }
}

/** ストアの変化を 1 回受け取り、材料が変わった表示だけを決まった順に渡し直す。 */
export function syncStoreChange(sync: ViewportStoreSync, next: AppState, previous: AppState): void {
  // Do not skip subscribers or admission checks: only the final draw request is conditional.
  const progressOnly = next.assemblyInterferenceProgress !== previous.assemblyInterferenceProgress
    && Object.keys(next).length === Object.keys(previous).length
    && Object.keys(next).every(key => key === 'assemblyInterferenceProgress'
      || Object.is(Reflect.get(next, key), Reflect.get(previous, key)));
  // render中に所有が変わって元へ戻る場合も、旧receiptを再利用しない。
  if (sync.sketchTiming !== undefined && (next.sketchDrag !== previous.sketchDrag || next.document !== previous.document
    || next.documentVersion !== previous.documentVersion
    || activePartDocument(next) !== activePartDocument(previous)
    || isSheetFlatDisplayed(next) !== isSheetFlatDisplayed(previous))) sync.sketchTiming.invalidateScene();
  if (!sync.isAlive()) return;
  if (next.activeDocumentId !== previous.activeDocumentId || next.assembly !== previous.assembly
    || next.document !== previous.document) {
    sync.assemblyInput.startDocumentInputs();
  }
  // Remember invalidation even if a document/cancel/generation changes and returns
  // while a same-publication receipt refresh is pending. Owner-only refresh is allowed.
  if (solidMeshOwnershipChanged(next, previous) || next.documentVersion !== previous.documentVersion
    || next.assemblyLibrary !== previous.assemblyLibrary || next.isComputing !== previous.isComputing
    || next.assemblyView?.sourceDocument !== previous.assemblyView?.sourceDocument
    || next.assemblyView?.bodies !== previous.assemblyView?.bodies
    || next.assemblyView?.resolved !== previous.assemblyView?.resolved
    || next.assemblyView?.appearances !== previous.assemblyView?.appearances
    || next.documentSaveOperation !== previous.documentSaveOperation && next.documentSaveOperation?.stage === 'cancelled') {
    sync.invalidateThumbnailPublication();
  }
  sync.syncRepairPreview(next);
  syncShapesAndHighlights(sync, next, previous);
  syncAssemblyDisplay(sync, next, previous);
  syncOverlays(sync, next, previous);
  syncSketchAids(sync, next, previous);
  syncViewRequests(sync, next, previous);
  // Still inspect exact current source/receipt/backings; invalid ownership keeps its old draw/refresh path.
  if (!progressOnly || !sync.assemblyInput.assemblyReady()) sync.requestDraw();
}
