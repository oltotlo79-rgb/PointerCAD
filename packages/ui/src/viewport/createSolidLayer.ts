/**
 * ソリッド(立体)の表示層。
 *
 * 対応要件: FR-105(表示スタイル)、FR-106(ホバー・選択・当たり判定)、NFR-PF-1(60fps)。
 *
 * `buildSolidGeometry` が組み立てた並びを three.js の部品へ流し込む。**毎フレーム
 * 作り直さない**。同じ組み立て結果を渡し直したときは何もせず、ボディの並びが同じ
 * (同じ Float32Array)なら入れ物も触らない。常時の描画ループはここにも作らない。
 *
 * 色は画面の配色(packages/ui/src/shell/appShell.css の --pcad-* トークン)から
 * `themeColors.ts` が読み取って渡す(three.js は CSS 変数を直接読めないため)。
 * テーマを変えたときは `setThemeColors` で材質の色だけを塗り替え、**部品は作り直さない**
 * (FR-908 の即時反映、NFR-PF-1)。映り込み(鏡・ガラス、FR-1107)の環境マップは外から渡される。
 * 作る・捨てるの判断はレンダラとシーンを持つ `createViewportScene.ts` が行う。
 *
 * 責務の分け方:
 *
 * | 責務 | 置き場所 | 持つ資源 | 寿命 |
 * |---|---|---|---|
 * | 部品を作る順の固定・断面表示の平面を配る・テーマ・破棄 | この関数 | 稜線の材質 3 つ、部分形状の重ね描きの雛形 2 組、断面の平面の入れ物 | 作ってから `dispose` まで |
 * | ボディの面と稜線(形・外観・表示スタイル・当たり判定) | `solidLayerBodies.ts` | ボディごとの面と稜線の形、当たり判定の的 | ボディが減れば 1 回ずつ解放、残りは `dispose` |
 * | 部分形状の重ね描き(ボディごと) | `solidLayerResources.ts` | ボディごとの重ね描きの形 | 強調が外れれば解放 |
 * | 補助の表示(ねじの印・球面の案内線・切断の予告・断面のつまみ) | `solidLayerHelpers.ts` | 補助の形と材質、印ごとの線 | 印が減れば解放、残りは `dispose` |
 * | 3D プリントの点検の色 | `solidLayerPrintability.ts` | 開いた辺の材質と線、割り当ての控え | 点検を閉じれば線を解放 |
 * | 並びの差し替えと解放の決まり | `solidLayerBuffers.ts` | — | — |
 * | 描く順 | `solidLayerRenderOrder.ts` | — | — |
 *
 * 外観は**面ごと・立体ごと(FR-1106〜1109)**。まとまり(`geometry.addGroup`)を作るのは純関数
 * `appearance/buildFaceGroups.ts`、材質は見え方が同じなら使い回し、使われなくなったら捨てる
 * (`appearance/createAppearanceMaterial.ts`)。**毎コマは作り直さない。**
 */

import type { PrintabilityReport, ResolvedPlane, Vec3 } from '@pointercad/model';
import * as THREE from 'three';

import { createAppearanceMaterialStore, type PatternTextureSource } from '../appearance/createAppearanceMaterial.js';
import type { DisplayStyle } from '../store/viewSlice.js';
import type { SolidEmphasis, SolidGeometryBundle } from './buildSolidGeometry.js';
import type { SubShapeEmphasis, SubShapeHighlightBatch, SubShapeHighlightBundle } from './buildSubShapeGeometry.js';
import { createSolidBodyDraws, type BodyDraw } from './solidLayerBodies.js';
import { borrowedGeometryRelease, geometryAttributeBytes, setGeometryAttributes, setVectorAttribute } from './solidLayerBuffers.js';
import { createSolidHelperDisplays, type ThreadMarkInfo } from './solidLayerHelpers.js';
import { createSolidPrintability } from './solidLayerPrintability.js';
import { SUB_SHAPE_FACE_RENDER_ORDER, SUB_SHAPE_LINE_RENDER_ORDER } from './solidLayerRenderOrder.js';
import { createSolidSubShapeResources, SUB_SHAPE_EMPHASES, type SubShapeOverlay,
  type SubShapeFaceMesh, type SubShapeLines, type SubShapePoints } from './solidLayerResources.js';
import { DEFAULT_THEME_COLORS, type ThemeColors } from './themeColors.js';
import { createViewportLifetime, createViewportConstructionOwner, type ViewportLifetime } from './viewportLifetime.js';

// ねじの印の形とその線分を組み立てる純関数は補助の表示(`solidLayerHelpers.ts`)が持つ。ここから公開を続ける。
export { buildThreadMarkPositions, type ThreadMarkInfo } from './solidLayerHelpers.js';

/** 部分形状の強調(重ね描き)の面の不透明度。 */
const SUB_SHAPE_FACE_OPACITY = 0.35;
/** 部分形状の頂点の点の大きさ(px)。画面上の大きさを一定にする。 */
const SUB_SHAPE_POINT_SIZE = 8;

/**
 * 切断面の予告表示に渡すもの(FR-432)。
 * 平面と、対象のボディの境界箱の対角長と、残る側の 3 つだけ。
 */
export interface CutPreview {
  readonly plane: ResolvedPlane;
  /** 四角の対角の長さ(= 対象の境界箱の対角長)。 */
  readonly diagonal: number;
  readonly keep: 'positive' | 'negative';
}

/**
 * 断面表示のつまみ(FR-111)。**平面と残す側だけ**を受け取り、四角の大きさ(対角長)は
 * 層がいま描いているボディから測る(呼び出し側が境界箱を測り直さなくてよい)。
 */
export interface SectionHandle {
  /** つまみを出す平面。オフセットを載せた後の位置で渡す(四角はこの原点を中心にする)。 */
  readonly plane: ResolvedPlane;
  /** 残る側。矢印がこちらを向く(`positive` は法線の向き)。 */
  readonly keep: 'positive' | 'negative';
}

/**
 * 3D プリントの点検の色表示(FR-815)。
 *
 * **外観を上書きせず、割り当てを一時的に差し替えるだけ**にする。`null` を渡せば
 * 元の外観に戻る(材質そのものは `materialStore` が鍵で持っているので、作り直しも起きない)。
 */
export interface PrintabilityHighlight {
  /** 点検の結果(三角形ごとの真偽と要約)。 */
  readonly report: PrintabilityReport;
  /**
   * 立体ごとの「結果の中での先頭の三角形の番号」(`solid/printabilityColors.ts` の
   * `printabilityTriangleOffsets` が作る)。**この表に無い立体には色を塗らない**
   * ——点検を頼まなかった立体は、点検の間も元の外観のままにする。
   */
  readonly triangleOffsets: ReadonlyMap<string, number>;
}

export interface SolidLayer {
  /** シーンへ足す入れ物。 */
  readonly group: THREE.Group;
  /**
   * 描画データと表示スタイルを反映する。
   * 同じ組み立て結果(同一オブジェクト)を渡し直したときは並びを触らない。
   *
   * `environment` は映り込み用の環境マップ(FR-1107)。鏡・ガラスが 1 つも無ければ `null`
   * で、そのときは材質にも入れない。作る・捨てるの判断は
   * `createViewportScene.ts` が行う(レンダラとシーンを持っているのがそちらのため)。
   */
  update(
    bundle: SolidGeometryBundle,
    displayStyle: DisplayStyle,
    environment?: THREE.Texture | null,
  ): void;
  /**
   * 部分形状(面・辺・頂点)のホバー・選択の強調を差し替える。
   * `update` と同じく、同じ組み立て結果を渡し直したときは並びを触らない。
   */
  updateSubShapes(bundle: SubShapeHighlightBundle): void;
  /**
   * ねじの簡略表示の印を差し替える。全ボディぶんをまとめた 1 本の配列で渡す
   * (`createViewportScene.ts` がボディの一覧から集める)。同じ配列(同一参照)を渡し直したときは
   * 並びを触らない。
   */
  updateThreadMarks(marks: readonly ThreadMarkInfo[]): void;
  /**
   * 球面の案内線(球面グリッド、FR-431)の線分列を差し替える。
   *
   * **緯線・経線をまとめて 1 本の `LineSegments`** に入れる。`null` で消える。
   * **同じ並び(同一参照)を渡し直したときは並びを触らない**(NFR-PF-1。ねじの印・
   * 切断の予告と同じ約束)ので、呼び出し側は球も間隔も変わっていないときに組み立て直さない。
   */
  updateSphereGrid(positions: Float32Array | null, origin?: Vec3): void;
  /**
   * 切断面の予告表示を差し替える(FR-432)。
   *
   * **四角は 1 枚だけ**で、ボディごとには作らない。`null` を渡すと消える(確定・取消の
   * どちらでも呼び出し側が `null` を渡す)。**同じ内容(同一参照)を渡し直したときは
   * 並びを触らない**(NFR-PF-1。ねじの印・部分形状の重ね描きと同じ約束)。
   */
  updateCutPreview(preview: CutPreview | null): void;
  /**
   * ビューの断面表示(FR-111)のクリッピング平面を配る。
   *
   * **立体を描くすべての材質へ、同じ 1 本の配列をそのまま渡す**(面の材質はボディごとに
   * 配列になっている)。`material.clippingPlanes` は材質ごとの欄なので、
   * 1 つでも配り漏らすとその立体・その面だけ切れない(§1.5-20)。
   *
   * **切っていないときは空**にする。three.js は `clippingPlanes` が空(または `null`)の
   * 材質を従来どおりに描くので、断面表示を使わない限り費用はゼロ(NFR-PF-1)。
   *
   * 新しい材質は外観を反映するとき(`update`)にしか作られないので、そこでも配り直す。
   */
  setSectionPlanes(planes: readonly THREE.Plane[]): void;
  /**
   * 3D プリントの点検の色を出す / 消す(FR-815)。
   *
   * 出しているあいだ、点検を頼んだ立体は**外観の割り当てを無視して 3 材質**
   * (既定 + 赤 + 橙)で描かれ、開いた辺を持つ三角形の輪郭が紫の線で重なる。
   * `null` を渡すと**元の外観に戻る**(形も体積も一切変わらない。再計算は起きない)。
   */
  setPrintabilityHighlight(highlight: PrintabilityHighlight | null): void;
  /**
   * 断面表示のつまみを差し替える。`null` で消える。
   *
   * 切断の予告(`updateCutPreview`)と同じ四角と矢印を、色だけ変えて出す。
   * **四角の大きさはいま描いているボディから測る**ので、呼び出し側は平面と残す側だけを
   * 渡せばよい。予告と違って**毎回組み立て直す**(つまみは引いている最中に動くので、
   * 同じ値を渡し直す場面がほとんど無い)。
   */
  updateSectionHandle(handle: SectionHandle | null): void;
  /**
   * 表示テーマの色を反映する(FR-908)。材質の色を塗り替えるだけで、
   * 部品も並びも作り直さない(NFR-PF-1)。
   */
  setThemeColors(colors: ThemeColors): void;
  /** 光線に当たったボディの featureId。当たらなければ null(FR-106)。 */
  pickBody(raycaster: THREE.Raycaster): string | null;
  /**
   * 光線に当たった面。当たったボディの featureId と、その三角形の通し番号を返す
   * (面の通し番号への変換は `createViewportScene.ts` の `pickFaceAt` が行う、FR-106)。
   */
  pickFace(raycaster: THREE.Raycaster): { readonly featureId: string; readonly triangleIndex: number } | null;
  /**
   * Bytes of every mesh attribute and index the renderer uploads for body faces, body edges and
   * sub-shape overlays. One GPU buffer per attribute, so two attributes viewing the same CPU
   * array count twice. Helper lines (thread marks, sphere grid, cut preview, section handle,
   * print open edges), textures and materials are outside this count.
   */
  meshBufferBytes(): number;
  dispose(): void;
}

/**
 * 部分形状の重ね描き 3 本を 1 色ぶん作る。面は半透明のメッシュ、辺・頂点は
 * `depthTest: false`(裏側も見える)。renderOrder は面が立体の面の直後、
 * 辺・頂点はスケッチの面の縁と同じ層(`solidLayerRenderOrder.ts`)。
 */
function createSubShapeOverlay(color: number, shared?: SubShapeOverlay,
  parent?: ReturnType<typeof createViewportConstructionOwner>): SubShapeOverlay {
  const construction = createViewportConstructionOwner();
  function acquired<T extends { dispose(): void }>(resource: T): T {
    const release = resource instanceof THREE.BufferGeometry ? borrowedGeometryRelease(resource) : () => { resource.dispose(); };
    return construction.acquire('overlay factory resource', resource, release);
  }
  try {
  const faces: SubShapeFaceMesh = new THREE.Mesh(
    acquired(new THREE.BufferGeometry()),
    shared?.faces.material ?? acquired(new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: SUB_SHAPE_FACE_OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false,
      // 元の面とほぼ同じ位置に重なるので、z 争いを避けて必ず手前に出す
      // (立体側の polygonOffsetFactor/Units は +1 で奥へ押すので、符号を反対にする)。
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    })),
  );
  faces.renderOrder = SUB_SHAPE_FACE_RENDER_ORDER;
  faces.visible = false;

  const edges: SubShapeLines = new THREE.LineSegments(
    acquired(new THREE.BufferGeometry()),
    shared?.edges.material ?? acquired(new THREE.LineBasicMaterial({
      color,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })),
  );
  edges.renderOrder = SUB_SHAPE_LINE_RENDER_ORDER;
  edges.visible = false;

  const vertices: SubShapePoints = new THREE.Points(
    acquired(new THREE.BufferGeometry()),
    shared?.vertices.material ?? acquired(new THREE.PointsMaterial({
      color,
      size: SUB_SHAPE_POINT_SIZE,
      sizeAttenuation: false,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })),
  );
  vertices.renderOrder = SUB_SHAPE_LINE_RENDER_ORDER;
  vertices.visible = false;

  const overlayGroup = new THREE.Group();
  overlayGroup.add(faces, edges, vertices);
  const overlay = { group: overlayGroup, faces, edges, vertices };
  construction.handoff(parent === undefined ? undefined : (resource, label, release) => {
    parent.acquire(label, resource, release);
  });
  return overlay;
  } catch (error) { throw construction.fail(error); }
}

/** 部分形状の重ね描き 1 組へ、組み立て済みの並びを流し込む。 */
function applySubShapeOverlay(overlay: SubShapeOverlay, batch: SubShapeHighlightBatch): void {
  overlay.group.position.set(batch.origin[0], batch.origin[1], batch.origin[2]);
  overlay.group.updateMatrixWorld(true);
  setGeometryAttributes(overlay.faces.geometry, [
    { name: 'position', values: batch.facePositions },
    { name: 'normal', values: batch.faceNormals },
  ], batch.faceIndices);
  overlay.faces.geometry.computeBoundingSphere();
  overlay.faces.visible = batch.facePositions.length > 0;

  setVectorAttribute(overlay.edges.geometry, 'position', batch.edgePositions);
  overlay.edges.geometry.computeBoundingSphere();
  overlay.edges.visible = batch.edgePositions.length > 0;

  setVectorAttribute(overlay.vertices.geometry, 'position', batch.vertexPositions);
  overlay.vertices.geometry.computeBoundingSphere();
  overlay.vertices.visible = batch.vertexPositions.length > 0;
}

/** 破棄で解放する相手。どれも層が作り、層だけが持つ。 */
interface SolidLayerParts {
  readonly group: THREE.Group;
  readonly edgeMaterials: Readonly<Record<SolidEmphasis, THREE.LineBasicMaterial>>;
  readonly subShapeOverlays: Readonly<Record<SubShapeEmphasis, SubShapeOverlay>>;
  readonly subShapeResources: ReturnType<typeof createSolidSubShapeResources>;
  readonly draws: readonly BodyDraw[];
  readonly bodies: ReturnType<typeof createSolidBodyDraws>;
  readonly helpers: ReturnType<typeof createSolidHelperDisplays>;
  readonly printing: ReturnType<typeof createSolidPrintability>;
  readonly materialStore: ReturnType<typeof createAppearanceMaterialStore>;
}

/**
 * 破棄の手順を 1 回だけ組む: 部品を入れ物から外し、作りかけの重ね描きの後始末、全ての形、材質の入れ物
 * (外観の材質と柄)、全ての材質の順。どれかが失敗しても他の解放は続け、失敗した物だけを次の破棄で
 * やり直す(WebGL の資源は GC で戻らない)。
 */
function registerSolidLayerCleanup(cleanup: ViewportLifetime, parts: SolidLayerParts): void {
  const { group, edgeMaterials, subShapeOverlays, subShapeResources, draws, bodies, helpers, printing,
    materialStore } = parts;
  cleanup.register('detach solid objects', () => { group.clear(); });
  for (const owner of subShapeResources.pendingCleanup) cleanup.register('failed overlay construction', () => {
    owner.dispose();
    if (owner.pendingCount !== 0) throw new Error(owner.errors.join('; '));
  });
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>(Object.values(edgeMaterials));
  for (const draw of draws) { geometries.add(draw.mesh.geometry); geometries.add(draw.edges.geometry); }
  for (const emphasis of SUB_SHAPE_EMPHASES) {
    for (const overlay of [subShapeOverlays[emphasis], ...subShapeResources.bodyOverlays[emphasis].values()]) {
      geometries.add(overlay.faces.geometry); geometries.add(overlay.edges.geometry);
      geometries.add(overlay.vertices.geometry);
    }
    const overlay = subShapeOverlays[emphasis];
    materials.add(overlay.faces.material); materials.add(overlay.edges.material); materials.add(overlay.vertices.material);
  }
  for (const draw of helpers.markDraws()) geometries.add(draw.geometry);
  for (const geometry of printing.openEdgeGeometries()) geometries.add(geometry);
  for (const draw of helpers.ownedObjects()) { geometries.add(draw.geometry); materials.add(draw.material); }
  materials.add(printing.material);
  for (const geometry of geometries) cleanup.register('solid geometry', bodies.geometryRelease(geometry));
  cleanup.register('appearance materials and textures', () => { materialStore.dispose(); });
  for (const material of materials) cleanup.register('solid material', () => { material.dispose(); });
}

/**
 * 立体の層を作る。
 *
 * `patterns` は柄のテクスチャの出どころ(FR-1108)。既定は実物
 * (`appearance/patternTexture.ts`)で、canvas の無い Node の検査からは偽物を渡せる
 * (`createAppearanceMaterial.ts` の `PatternTextureSource`)。
 *
 * 部品を作る順(材質と部品の通し番号)は描く順の見分けに効くので、稜線の材質 → 部分形状の重ね描き →
 * 補助の表示 → 点検の材質の順を変えない。
 */
export function createSolidLayer(patterns?: PatternTextureSource): SolidLayer {
  const construction = createViewportConstructionOwner();
  function acquired<T extends { dispose(): void }>(resource: T): T {
    const release = resource instanceof THREE.BufferGeometry ? borrowedGeometryRelease(resource) : () => { resource.dispose(); };
    return construction.acquire('solid factory resource', resource, release);
  }
  try {
  const group = new THREE.Group();
  let cleanup: ViewportLifetime | null = null;
  /** いま効いているテーマの色。`setThemeColors` が来るまでは既定(ダーク)。 */
  let colors: ThemeColors = DEFAULT_THEME_COLORS;
  /**
   * 面の材質の入れ物(FR-1106〜1109)。**ビューポートに 1 つだけ**持ち、見え方(`appearanceKeyText`)が
   * 同じ外観には同じ材質を返す。使われなくなった材質と柄のテクスチャは `collect` / `dispose` が捨てる。
   * 作った時点ではまだ材質も柄も頼んでいない。渡された柄の出どころは別の層のものでもよい。
   */
  const materialStore = createAppearanceMaterialStore(patterns);
  /**
   * 稜線の材質は強調の度合いごとに 1 つずつ。ボディごとには作らず、どれを使うかだけを切り替える。
   * `none` の色だけは表示スタイルで変わる(面の上か、稜線だけか)。
   */
  const edgeMaterials: Readonly<Record<SolidEmphasis, THREE.LineBasicMaterial>> = {
    none: acquired(new THREE.LineBasicMaterial({ color: DEFAULT_THEME_COLORS.solidEdgeOverSolid })),
    hovered: acquired(new THREE.LineBasicMaterial({ color: DEFAULT_THEME_COLORS.hovered })),
    selected: acquired(new THREE.LineBasicMaterial({ color: DEFAULT_THEME_COLORS.selected })),
  };
  /**
   * 部分形状(面・辺・頂点)の重ね描きの雛形。ホバー用・選択用の 2 組の材質だけを作り、
   * ボディごとの重ね描き(`solidLayerResources.ts`)はこの材質を借りる。
   */
  const subShapeOverlays: Readonly<Record<SubShapeEmphasis, SubShapeOverlay>> = {
    hovered: createSubShapeOverlay(DEFAULT_THEME_COLORS.hovered, undefined, construction),
    selected: createSubShapeOverlay(DEFAULT_THEME_COLORS.selected, undefined, construction),
  };
  const subShapeResources = createSolidSubShapeResources(group, subShapeOverlays,
    createSubShapeOverlay, applySubShapeOverlay, borrowedGeometryRelease);
  const draws: BodyDraw[] = [];
  const helpers = createSolidHelperDisplays({ group, acquired, draws });
  /**
   * いま配っているクリッピング平面(FR-111)。**入れ物は 1 つのまま**で中身だけ入れ替えるので、
   * 材質へ配り直さなくても切る位置の変化がそのまま効く(three.js は毎コマこの配列を読み、枚数が
   * 変わったときだけシェーダを組み直す)。空のあいだは費用ゼロ。
   */
  const sectionPlanes: THREE.Plane[] = [];
  const printing = createSolidPrintability({ group, acquired, getColors: () => colors });
  const bodies = createSolidBodyDraws({ group, draws, edgeMaterials, materialStore, planFor: printing.planFor,
    getColors: () => colors });
  let lastBundle: SolidGeometryBundle | null = null;

  /**
   * 断面表示のクリッピングを配る相手(FR-111、§1.5-20)。**立体そのものと、その上に重ねる印**を全部入れる:
   * 面の材質(見え方が同じなら使い回されるので同じ材質が 2 度出うる)、稜線の 3 本、部分形状の重ね描き
   * 6 本、ねじの印、球面の案内線、点検の紫の線。切ったのに強調や印だけ空中に残るのを防ぐ。
   * 切断の予告とつまみは平面の上にあるので入れない(自分で消えてしまう)。
   */
  function applySectionPlanes(): void {
    const collected = new Set<THREE.Material>();
    for (const draw of draws) {
      for (const material of draw.mesh.material) collected.add(material);
    }
    collected.add(edgeMaterials.none);
    collected.add(edgeMaterials.hovered);
    collected.add(edgeMaterials.selected);
    for (const emphasis of SUB_SHAPE_EMPHASES) {
      const overlay = subShapeOverlays[emphasis];
      collected.add(overlay.faces.material);
      collected.add(overlay.edges.material);
      collected.add(overlay.vertices.material);
    }
    for (const material of helpers.clippedMaterials()) collected.add(material);
    collected.add(printing.material);
    for (const material of collected) material.clippingPlanes = sectionPlanes;
  }

  /** 部品の数をボディの数に合わせ、形と外観を流し込み、形に付いて動く表示を合わせ直す。 */
  function syncDraws(entries: SolidGeometryBundle['entries']): void {
    bodies.sync(entries);
    // 新しく作られた面の材質にも断面表示の平面を配る(配り漏らすとその立体だけ切れない)。
    applySectionPlanes();
    helpers.rebuildSectionHandle();
    // 形が変われば開いた辺の位置も変わるので、点検を出しているあいだは引き直す。
    printing.rebuildOpenEdges(entries);
  }

  const layer: SolidLayer = {
    group,
    update(bundle, displayStyle, nextEnvironment = null): void {
      if (cleanup !== null) return;
      bodies.setEnvironment(nextEnvironment);
      // 並びも外観も前回のままなら、表示スタイルの入切だけで済ませる(毎コマの作り直しをしない)。
      if (bundle !== lastBundle || bodies.appearanceDirty || bodies.pending) {
        syncDraws(bundle.entries);
        lastBundle = bundle;
      }
      bodies.applyStyle(bundle.entries, displayStyle);
    },
    updateSubShapes(bundle): void {
      if (cleanup !== null) return;
      subShapeResources.update(bundle);
    },
    updateThreadMarks(marks): void {
      if (cleanup !== null) return;
      helpers.updateThreadMarks(marks);
    },
    updateSphereGrid(positions, origin = [0, 0, 0]): void {
      if (cleanup !== null) return;
      helpers.updateSphereGrid(positions, origin);
    },
    updateCutPreview(preview): void {
      if (cleanup !== null) return;
      helpers.updateCutPreview(preview);
    },
    setSectionPlanes(planes): void {
      if (cleanup !== null) return;
      // 入れ物は作り直さない(材質が持っている参照をそのまま生かす)。中身だけ入れ替える。
      sectionPlanes.length = 0;
      for (const plane of planes) {
        sectionPlanes.push(plane);
      }
      applySectionPlanes();
    },
    updateSectionHandle(handle): void {
      if (cleanup !== null) return;
      helpers.updateSectionHandle(handle);
    },
    setPrintabilityHighlight(highlight): void {
      if (cleanup !== null) return;
      if (!printing.set(highlight)) return;
      // 材質の割り当てが変わるので、次の `update` を待たずにここで反映する
      // (点検は押した瞬間に色が変わってほしい。NFR-UX-7)。
      bodies.markAppearanceDirty();
      if (lastBundle !== null) syncDraws(lastBundle.entries);
      else printing.rebuildOpenEdges([]);
    },
    setThemeColors(next): void {
      if (cleanup !== null) return;
      colors = next;
      bodies.applyTheme(next);
      for (const emphasis of SUB_SHAPE_EMPHASES) {
        const overlay = subShapeOverlays[emphasis];
        const color = emphasis === 'hovered' ? next.hovered : next.selected;
        overlay.faces.material.color.setHex(color);
        overlay.edges.material.color.setHex(color);
        overlay.vertices.material.color.setHex(color);
      }
      helpers.applyTheme(next);
      printing.applyTheme(next);
    },
    pickFace: (raycaster) => bodies.pickFace(raycaster),
    pickBody: (raycaster) => bodies.pickBody(raycaster),
    meshBufferBytes(): number {
      if (subShapeResources.pendingCleanup.length !== 0) throw new Error('Solid overlay retained backing is unknown');
      let bytes = bodies.meshBytes();
      for (const emphasis of SUB_SHAPE_EMPHASES) {
        for (const overlay of subShapeResources.bodyOverlays[emphasis].values()) {
          bytes += geometryAttributeBytes(overlay.faces.geometry) + geometryAttributeBytes(overlay.edges.geometry)
            + geometryAttributeBytes(overlay.vertices.geometry);
        }
      }
      return bytes;
    },
    dispose(): void {
      if (cleanup === null) {
        cleanup = createViewportLifetime();
        group.visible = false;
        bodies.clearPickTargets();
        registerSolidLayerCleanup(cleanup, { group, edgeMaterials, subShapeOverlays, subShapeResources, draws, bodies,
          helpers, printing, materialStore });
      }
      cleanup.dispose();
      if (cleanup.pendingCount !== 0) throw new Error(cleanup.errors.join('; '));
      bodies.reset();
      subShapeResources.clear();
      helpers.reset();
      printing.reset();
      // 平面は材質が捨てられた後には誰も読まない。入れ物だけ空にしておく。
      sectionPlanes.length = 0;
      lastBundle = null;
    },
  };
  construction.handoff();
  return layer;
  } catch (error) { throw construction.fail(error); }
}
