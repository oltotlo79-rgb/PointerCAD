import { DEFAULT_WORK_PLANE_ID, WORK_PLANES } from '@pointercad/model';
import * as THREE from 'three';
import { readReferenceRepairRejections } from '../solid/referenceRepairPreview.js';
import { constraintKindSymbol } from '../sketch/constraintSummary.js';
import { createSolidFieldLayer } from '../solidAnalysis/solidFieldLayer.js';
import { createSolidModeLayer } from '../solidAnalysis/solidModeLayer.js';
import { activeAssemblyDocument } from '../store/documentKind.js';
import {
  captureAssemblyMeshAdmission, currentAssemblyMeshAdmission, type AssemblyMeshAdmission, type AssemblyUiBackingLedger,
} from './assemblyMeshAdmission.js';
import type { DisplayCopyCache, SolidGeometryBundle } from './buildSolidGeometry.js';
import { subShapeOverlayBytes, type SubShapeHighlightBundle } from './buildSubShapeGeometry.js';
import type { OrbitState } from './cameraMath.js';
import { createCanvasLayer } from './canvasLayer.js';
import type { AssemblyGeometryBundle, AssemblyLayer } from './createAssemblyLayer.js';
import { createConstraintLayer } from './createConstraintLayer.js';
import type { EnvironmentStore } from './createEnvironment.js';
import { createInterferenceLayer } from './createInterferenceLayer.js';
import { createMeasureLayer } from './createMeasureLayer.js';
import { createReferenceLayer } from './createReferenceLayer.js';
import { createSketchLayer } from './createSketchLayer.js';
import { createSolidLayer } from './createSolidLayer.js';
import { createTrackingLayer } from './createTrackingLayer.js';
import type { SectionViewRender, ViewportMeshReservation, ViewportSceneOptions } from './createViewportScene.js';
import { isCylinderBasisGuideCurrent, type CylinderBasisGuide } from './cylinderBasisGuide.js';
import { isPlanarBasisGuideCurrent, type PlanarBasisGuide } from './planarBasisGuide.js';
import {
  captureWorldMeshAdmission, meshLayoutsUnchanged, type GpuMeshBudget, type SolidMeshAdmission, type SolidMeshAdmissionState,
} from './solidMeshAdmission.js';
import { DEFAULT_THEME_COLORS, type ThemeColors } from './themeColors.js';
import type { ViewportLifetime } from './viewportLifetime.js';
import type { createViewportRepairPreview } from './viewportRepairPreview.js';
import { KEY_LIGHT_INTENSITY } from './viewportSceneRendering.js';

/*
 * createViewportScene が作成・保持・更新・破棄する資源の単位(E08)。公開 API は
 * createViewportScene.ts のまま。ここに移したのは、構築中の取得の台帳、光源・方眼・各層の
 * 作成、完成後の破棄の登録、テーマ色と表示の更新、断面のクリッピング平面、立体の表示用
 * バッファの勘定、配置した部品の表示の持ち主。取得の順序・scene へ足す順序・破棄の
 * ラベルと順序は元の主関数と同じ。
 */

/** 構築中の台帳に残っている 1 件。完成した Scene へ渡すまで、失敗時はこれで返す。 */
 interface PendingAcquisition {
  readonly label: string;
  readonly release: () => void;
}

/** 構築中だけ取得を台帳に載せる。返した物は台帳から外れ、引き渡し後はその場で返す。 */
 type SceneAcquire = <T extends { dispose(): void }>(label: string, resource: T, dispose?: () => void) => T;

export function createSceneConstruction() {
  // Construction owns each actual acquisition until successful return or handoff.
  // Null means the completed Scene owns resources through disposeOwnedLayers.
  let construction: Map<{ dispose(): void }, PendingAcquisition> | null = new Map();
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
  return {
    acquired,
    returnAcquired,
    /** Transfer ownership to the completed Scene; this is not a physical return. */
    handOff(): void { construction = null; },
    /** 失敗時に返す残り。取得した順に並ぶ。 */
    pending(): Iterable<PendingAcquisition> { return construction?.values() ?? []; },
  };
}

/**
 * 空と地面の色で全体を起こす補助光。真上は白のまま、地面側は地の色に馴染ませるので
 * テーマが決める(--pcad-scene-ground)。明るいテーマでは下面が沈みすぎない明るさにする。
 */
const SKY_COLOR = 0xffffff;
const HEMISPHERE_INTENSITY = 0.9;

export type ViewportSceneLayers = ReturnType<typeof createSceneLayers>;

/**
 * 光源・方眼・各層を作り、取得の台帳と scene へ同じ順で足す。配置した部品の層だけは
 * Scene 側の持ち主の判定を閉じ込めて作るので、作る関数を受け取り同じ位置で呼ぶ。
 */
export function createSceneLayers(scene: THREE.Scene, acquired: SceneAcquire, createAssembly: () => AssemblyLayer) {
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

  const assemblyLayer = createAssembly();
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
  const cylinderBasisLayer = acquired('cylinderBasisLayer', createMeasureLayer());
  cylinderBasisLayer.group.name = 'cylinder-basis-guide';
  scene.add(cylinderBasisLayer.group);
  // 測定と円筒表示のinstanceを共有せず、同じ描画/解放機構を使う。
  const planarBasisLayers = ['origin', 'x', 'y'].map(member => {
    const layer = acquired(`planar basis ${member}`, createMeasureLayer());
    layer.group.name = `planar-basis-${member}`;
    return layer;
  });
  for (const layer of planarBasisLayers) scene.add(layer.group);

  return { skyLight, keyLight, lineMaterial, gridGroup, grid, axisLines, solidLayer, assemblyLayer, interferenceLayer,
    analysisFieldLayer, analysisModeLayer, canvasLayer, sketchLayer, referenceLayer, trackingLayer, constraintLayer,
    inferenceLayer, measureLayer, cylinderBasisLayer, planarBasisLayers };
}

/** 完成した Scene の層と描画資源の破棄を登録する(登録順がそのまま破棄の順)。 */
export function registerSceneLayerCleanup(
  ownedCleanup: ViewportLifetime,
  layers: ViewportSceneLayers,
  environments: Pick<EnvironmentStore, 'dispose'>,
  repairPreviews: Pick<ReturnType<typeof createViewportRepairPreview>, 'returnResources'>,
  renderer: Pick<THREE.WebGLRenderer, 'dispose'>,
): void {
  const { solidLayer, assemblyLayer, grid, axisLines } = layers;
  ownedCleanup.register('environment', () => { environments.dispose(); });
  ownedCleanup.register('reference repair preview', () => {
    if (!repairPreviews.returnResources()) throw new Error('Reference repair preview resources remain pending');
  });
  ownedCleanup.register('solid layer', () => { solidLayer.dispose(); });
  ownedCleanup.register('assembly layer', () => {
    assemblyLayer.dispose();
    if (assemblyLayer.meshReservation().cleanupStatus === 'pending') throw new Error('Assembly resources remain pending');
  });
  ownedCleanup.register('interference layer', () => { layers.interferenceLayer.dispose(); });
  ownedCleanup.register('analysis field layer', () => { layers.analysisFieldLayer.dispose(); });
  ownedCleanup.register('analysis mode layer', () => { layers.analysisModeLayer.dispose(); });
  ownedCleanup.register('canvas images and textures', () => { layers.canvasLayer.dispose(); });
  ownedCleanup.register('sketch layer', () => { layers.sketchLayer.dispose(); });
  ownedCleanup.register('reference layer', () => { layers.referenceLayer.dispose(); });
  ownedCleanup.register('tracking layer', () => { layers.trackingLayer.dispose(); });
  ownedCleanup.register('constraint layer', () => { layers.constraintLayer.dispose(); });
  ownedCleanup.register('inference layer', () => { layers.inferenceLayer.dispose(); });
  ownedCleanup.register('measure layer', () => { layers.measureLayer.dispose(); });
  ownedCleanup.register('cylinder basis layer', () => { layers.cylinderBasisLayer.dispose(); });
  for (const [index, layer] of layers.planarBasisLayers.entries()) {
    ownedCleanup.register(`planar basis layer ${index}`, () => { layer.dispose(); });
  }
  const gridGeometry = grid.geometry, axisGeometry = axisLines.geometry;
  ownedCleanup.register('grid geometry', () => { gridGeometry.dispose(); });
  ownedCleanup.register('axis geometry', () => { axisGeometry.dispose(); });
  ownedCleanup.register('grid material', () => { layers.lineMaterial.dispose(); });
  ownedCleanup.register('sky light', () => { layers.skyLight.dispose(); });
  ownedCleanup.register('key light', () => { layers.keyLight.dispose(); });
  ownedCleanup.register('renderer', () => { renderer.dispose(); });
}

/** テーマの色を光源と各層へ配る。頂点ごとの色を持つ方眼と軸は、呼び出し側が先に作り直す。 */
export function applySceneThemeColors(layers: ViewportSceneLayers, colors: ThemeColors): void {
  layers.skyLight.groundColor.setHex(colors.sceneGround);
  layers.solidLayer.setThemeColors(colors);
  layers.assemblyLayer.setThemeColors(colors);
  layers.interferenceLayer.setThemeColors(colors);
  layers.sketchLayer.setThemeColors(colors);
  layers.referenceLayer.setThemeColors(colors);
  layers.trackingLayer.setThemeColors(colors);
  layers.constraintLayer.setThemeColors(colors);
  layers.inferenceLayer.setThemeColors(colors);
  layers.measureLayer.setThemeColors(colors);
  layers.cylinderBasisLayer.setThemeColors(colors);
  for (const layer of layers.planarBasisLayers) layer.setThemeColors(colors);
}

/** 円筒・平面の基準の案内は、いまの立体と文書の状態に合うときだけ出す。 */
export function updateBasisGuideLayers(
  layers: ViewportSceneLayers,
  currentSolid: boolean,
  cylinderGuide: CylinderBasisGuide | null,
  planarGuide: PlanarBasisGuide | null,
  basisState: SolidMeshAdmissionState | undefined,
): void {
  const basisCurrent = currentSolid && cylinderGuide !== null && basisState !== undefined
    && isCylinderBasisGuideCurrent(cylinderGuide, basisState);
  layers.cylinderBasisLayer.update(basisCurrent ? cylinderGuide?.drawing ?? null : null);
  layers.cylinderBasisLayer.group.visible = basisCurrent;
  const planarCurrent = currentSolid && planarGuide !== null && basisState !== undefined
    && isPlanarBasisGuideCurrent(planarGuide, basisState);
  const planarDrawings = planarGuide === null ? []
    : [planarGuide.drawing, planarGuide.xDrawing, planarGuide.yDrawing];
  layers.planarBasisLayers.forEach((layer, index) => {
    layer.update(planarCurrent ? planarDrawings[index] ?? null : null);
    layer.group.visible = planarCurrent;
  });
}

/** 札の画面上の大きさを、描画のたびに視点の距離と区画の高さからそろえ直す。 */
export function updateLabelScreenScale(layers: ViewportSceneLayers, orbit: OrbitState, rectangleHeight: number,
  uiScale: number): void {
  // 名前の札(基準軸・座標系)の画面上の大きさをそろえ直す(P4 仕上げ (f))。
  // ズームでカメラ距離が変わるたびに効くよう、描画のたびに計算し直す。
  layers.referenceLayer.updateScreenScale(orbit.distance / (orbit.zoom ?? 1), rectangleHeight, uiScale);
  // 測定の値の札も同じ大きさ(約 13px)にそろえる(P5 タスク31)。
  layers.measureLayer.updateScreenScale(orbit.distance / (orbit.zoom ?? 1), rectangleHeight, uiScale);
  layers.cylinderBasisLayer.updateScreenScale(orbit.distance / (orbit.zoom ?? 1), rectangleHeight, uiScale);
  for (const layer of layers.planarBasisLayers) {
    layer.updateScreenScale(orbit.distance / (orbit.zoom ?? 1), rectangleHeight, uiScale);
  }
}

/**
 * ビューの断面表示(FR-111、タスク35)のクリッピング平面。**1 枚を使い回す**
 * (引いている最中は中身だけ書き換える)。切っているあいだは材質へ配らない。
 */
export function createSectionClipping(layers: Pick<ViewportSceneLayers, 'solidLayer' | 'assemblyLayer' | 'interferenceLayer'>) {
  const { solidLayer, assemblyLayer, interferenceLayer } = layers;
  const sectionPlane = new THREE.Plane();
  /** いま平面を配ってあるか。枚数(0 ↔ 1)が変わったときだけ材質へ配り直す。 */
  let sectionActive = false;
  function setSectionView(view: SectionViewRender | null): void {
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
  }
  return { setSectionView };
}

/** Every mesh attribute array the layer uploads for a bundle and its overlays. */
export function attributeArrays(bundle: SolidGeometryBundle, overlay: SubShapeHighlightBundle): ArrayBufferView[] {
  return [...bundle.entries.flatMap((entry) => [entry.positions, entry.normals, entry.uv, entry.indices,
    entry.edgePositions]),
  ...[...overlay.hovered.batches, ...overlay.selected.batches].flatMap((batch) => [batch.facePositions,
    batch.faceNormals, batch.faceIndices, batch.edgePositions, batch.vertexPositions])];
}

/** GPU buffers are per attribute: CPU aliasing never merges two attributes into one buffer. */
export function attributeBytes(bundle: SolidGeometryBundle, overlay: SubShapeHighlightBundle): number {
  let bytes = subShapeOverlayBytes(overlay);
  for (const entry of bundle.entries) {
    bytes += entry.positions.byteLength + entry.normals.byteLength + entry.uv.byteLength
      + entry.indices.byteLength + entry.edgePositions.byteLength;
  }
  return bytes;
}

/** UI-created typed copies alive for a bundle and overlay (each backing once). */
export function liveDisplayCopies(bundle: SolidGeometryBundle, overlay: SubShapeHighlightBundle): ArrayBufferLike[] {
  return [...(bundle.displayCopies ?? []), ...[...overlay.hovered.batches, ...overlay.selected.batches]
    .flatMap((batch) => [batch.facePositions.buffer, batch.faceNormals.buffer, batch.faceIndices.buffer,
      batch.edgePositions.buffer, batch.vertexPositions.buffer])];
}

/** Puts the copy cache and the GPU reservation back to the still-published (or cleared) display. */
export function returnUnpublishedReservations(
  published: { readonly owner: SolidMeshAdmission | null; readonly gpuBytes: number },
  displayCopies: DisplayCopyCache,
  gpuMeshBudget: GpuMeshBudget | undefined,
  gpuOwner: symbol,
  restoreCopies: () => void,
): void {
  const solidOwner = published.owner;
  if (solidOwner === null) {
    // The display was cleared: nothing is published, so nothing stays reserved.
    displayCopies.clear();
    gpuMeshBudget?.release(gpuOwner);
    return;
  }
  restoreCopies();
  if (solidOwner.accounting !== null) gpuMeshBudget?.reserve(gpuOwner, published.gpuBytes);
  else gpuMeshBudget?.release(gpuOwner);
}

/** meshReservation の材料。読む順は元の meshReservation と同じ(配置の層 → 参照修復の予告)。 */
 interface SceneReservationSources {
  readonly assembly: ReturnType<AssemblyLayer['meshReservation']>;
  readonly repair: ReturnType<ReturnType<typeof createViewportRepairPreview>['meshReservation']>;
  readonly uiBackings: AssemblyUiBackingLedger;
  /** 立体の表示用の写し(破棄の途中は破棄時点の値との大きい方)。 */
  readonly solidDisplayCopyBytes: number;
  readonly publishedGpuBytes: number;
  readonly environments: EnvironmentStore;
  readonly ownedCleanup: ViewportLifetime | null;
}

const UNCOVERED_MESH_RESOURCES: readonly string[] = Object.freeze(['textures', 'pmrem', 'materials',
  'threadMarks', 'sphereGrid', 'cutPreview', 'sectionHandle', 'printOpenEdges', 'jsObjectOverhead']);

export function composeMeshReservation(sources: SceneReservationSources): ViewportMeshReservation {
  const { assembly, repair, uiBackings, environments, ownedCleanup } = sources;
  return { repairPreviewRejections: readReferenceRepairRejections(), registeredUiBackingBytes: uiBackings.known() ? uiBackings.bytes() : null,
    registeredUiPendingBytes: uiBackings.pending(),
    displayCopyBytes: sources.solidDisplayCopyBytes + assembly.displayCopyBytes + repair.displayCopyBytes,
    gpuMeshBytes: sources.publishedGpuBytes + assembly.gpuMeshBytes + repair.gpuMeshBytes,
    environmentReservedBytes: environments.reservedBytes,
    environmentCleanupStatus: environments.cleanupPending ? 'pending' : 'complete',
    assemblySourceBackingBytes: assembly.sourceBackingBytes, assemblyInstanceBytes: assembly.instanceBytes,
    assemblyCleanupReservedCpuBytes: assembly.cleanupReservedCpuBytes,
    assemblyCleanupStatus: assembly.cleanupStatus,
    viewportCleanupStatus: environments.cleanupPending || repair.cleanupPending
      || ownedCleanup !== null && ownedCleanup.pendingCount !== 0 ? 'pending' : 'complete',
    viewportCleanupErrors: Object.freeze([...(ownedCleanup?.errors ?? []),
      ...repair.cleanupErrors]),
    uncovered: Object.freeze([...new Set([...UNCOVERED_MESH_RESOURCES, ...assembly.uncovered,
      ...repair.uncovered,
      ...(ownedCleanup !== null && ownedCleanup.pendingCount !== 0 ? ['retiredViewportResources'] : [])])]) };
}

/** 配置した部品の表示の持ち主。形の一式・取り込んだときの状態・メッシュの受け入れを一緒に持つ。 */
export interface AssemblyOwner {
  readonly bundle: AssemblyGeometryBundle;
  readonly state: SolidMeshAdmissionState | null;
  readonly meshes: readonly SolidMeshAdmission[];
  readonly admission: AssemblyMeshAdmission | null;
}

/** 持ち主が古いと判定した最初の比較の名前(診断用。値や文書は持たない)。 */
export type AssemblyOwnerStaleReason = 'disposed' | 'mesh-layout' | 'no-state' | 'no-reader' | 'admission'
  | 'activeDocumentId' | 'assembly' | 'assemblyView' | 'drawing' | 'cancelRequestCount' | 'recomputeCancelled'
  | 'requestedGeneration' | 'completedGeneration' | 'lastOutcome' | 'documentVersion' | 'assemblyLibrary'
  | 'view-source' | 'part-bodies';

/**
 * 持ち主が古い理由。いまのままなら null。判定の順と内容は isAssemblyOwnerCurrent と同じ
 * (isAssemblyOwnerCurrent はこの関数が null を返すことと同値)。
 */
export function assemblyOwnerStaleReason(owner: AssemblyOwner, disposed: boolean,
  options: ViewportSceneOptions): AssemblyOwnerStaleReason | null {
  if (disposed) return 'disposed';
  if (owner.meshes.some(mesh => !meshLayoutsUnchanged(mesh, mesh.bodies))) return 'mesh-layout';
  const before = owner.state;
  if (before === null) return options.readSolidMeshState === undefined ? null : 'no-state';
  const now = options.readSolidMeshState?.();
  if (owner.admission !== null && (now === undefined || !currentAssemblyMeshAdmission(owner.admission, now))) return 'admission';
  if (now === undefined) return 'no-reader';
  if (now.activeDocumentId !== before.activeDocumentId) return 'activeDocumentId';
  if (now.assembly !== before.assembly) return 'assembly';
  if (now.assemblyView !== before.assemblyView) return 'assemblyView';
  if (now.drawing !== before.drawing) return 'drawing';
  if (now.cancelRequestCount !== before.cancelRequestCount) return 'cancelRequestCount';
  if (now.recomputeCancelled !== before.recomputeCancelled) return 'recomputeCancelled';
  // attachAssembly owns these shared counters only while the active document is an assembly.
  if (before.assembly !== null) {
    if (now.requestedGeneration !== before.requestedGeneration) return 'requestedGeneration';
    if (now.completedGeneration !== before.completedGeneration) return 'completedGeneration';
    if (now.lastOutcome !== before.lastOutcome) return 'lastOutcome';
    if (now.documentVersion !== before.documentVersion) return 'documentVersion';
    if (now.assemblyLibrary !== before.assemblyLibrary) return 'assemblyLibrary';
  }
  if (owner.bundle.parts.length === 0) return null;
  if (now.assemblyView?.sourceDocument !== now.assembly) return 'view-source';
  return owner.bundle.parts.every(part => now.assemblyView?.bodies.get(part.partKey) === part.bodies) ? null : 'part-bodies';
}

/** 持ち主がいまの文書・表示・計算の世代のままか。破棄した Scene の持ち主は常に古い。 */
export function isAssemblyOwnerCurrent(owner: AssemblyOwner, disposed: boolean, options: ViewportSceneOptions): boolean {
  return assemblyOwnerStaleReason(owner, disposed, options) === null;
}

/** 一式ごとに持ち主を 1 つだけ作る(同じ一式を渡し直したときは、いまのままなら同じ持ち主)。 */
export function createAssemblyOwnerCapture(options: ViewportSceneOptions,
  assemblyOwnerCurrent: (owner: AssemblyOwner) => boolean) {
  const offeredAssemblyOwners = new WeakMap<AssemblyGeometryBundle, AssemblyOwner>();
  return function captureAssemblyOwner(bundle: AssemblyGeometryBundle): AssemblyOwner | null {
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
  };
}
