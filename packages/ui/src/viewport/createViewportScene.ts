import {
  DEFAULT_WORK_PLANE_ID,
  WORK_PLANES,
  type ResolvedSketch,
  type SketchMesh,
  type SolidBody,
  type Vec3,
  type WorkPlane,
  type WorkPlaneId,
} from '@pointercad/model';
import * as THREE from 'three';

import { captureThumbnailPng, THUMBNAIL_SIZE } from '../file/thumbnail.js';
import { faceIndexOfTriangle } from '../solid/pickSubShape.js';
import type { DisplayStyle, ProjectionMode } from '../store/useAppStore.js';
import {
  buildSketchGeometry,
  EMPTY_RESOLVED_SKETCH,
  NO_HIGHLIGHT,
  type SketchHighlight,
} from './buildSketchGeometry.js';
import { buildSolidGeometry, EMPTY_SOLID_GEOMETRY } from './buildSolidGeometry.js';
import { buildSubShapeGeometry, EMPTY_SUB_SHAPE_HIGHLIGHT } from './buildSubShapeGeometry.js';
import {
  cameraPosition,
  clamp,
  HOME_ORBIT,
  orthographicFrustumHeight,
  VERTICAL_FIELD_OF_VIEW,
  type OrbitState,
} from './cameraMath.js';
import { createSketchLayer } from './createSketchLayer.js';
import { createSolidLayer, type ThreadMarkInfo } from './createSolidLayer.js';
import { axisLength, gridExtent, gridFadeOpacity, gridSpacing, isMajorGridLine } from './gridMath.js';
import { DEFAULT_THEME_COLORS, type ThemeColors } from './themeColors.js';

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
}

/** ビューポートの描画一式。視点は持たず、呼ばれるたびに渡された視点で描く。 */
export interface ViewportScene {
  render(orbit: OrbitState, projection: ProjectionMode, displayStyle: DisplayStyle, showGrid: boolean): void;
  /** スケッチの表示を差し替える(FR-105、FR-310)。 */
  setSketch(sketch: ResolvedSketch, mesh: SketchMesh | null): void;
  /** ホバー・選択の強調を差し替える(FR-106)。 */
  setSketchHighlight(hoveredElementId: string | null, selection: readonly string[]): void;
  /** ソリッドの表示を差し替える(FR-105)。ボディの id はフィーチャーの id(§0.a-0.5)。 */
  setBodies(bodies: readonly SolidBody[]): void;
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
   * 画面座標(canvas の左上を原点とした画素)にあるボディの featureId。無ければ null
   * (FR-106)。透視投影でも平行投影でも、最後に描いたカメラで判定する。
   */
  pickBody(screenX: number, screenY: number): string | null;
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
   * 表示テーマの色を反映する(FR-908)。方眼と軸は色を頂点へ焼き込んでいるので作り直し、
   * 立体・スケッチの各層は材質の色を塗り替えるだけ。**テーマを変えたときにだけ呼ぶ。**
   */
  setThemeColors(colors: ThemeColors): void;
  /** いま描いている作図面(§0.a-0.3)。薄い矩形で向きを示す。 */
  setWorkPlane(id: WorkPlaneId): void;
  /** ワールド座標を canvas 上の画素座標へ。まだ一度も描いていない・画面の外なら null。 */
  worldToScreen(point: Vec3): readonly [number, number] | null;
  /** canvas 上の画素座標から、作図面の上の点を求める。平面と視線が平行なら null。 */
  screenToPlanePoint(x: number, y: number, plane: WorkPlane): Vec3 | null;
  resize(widthPixels: number, heightPixels: number): void;
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

/** 本アプリは Z 軸が上(計画書 §0.a-0.9)。three.js の既定(Y 上)から変える。 */
const UP_AXIS = new THREE.Vector3(0, 0, 1);

/** 端末の画素密度をそのまま使うと高精細画面で負荷が跳ね上がるため上限を設ける(NFR-PF-1)。 */
const MAX_PIXEL_RATIO = 2;

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

export function createViewportScene(canvas: HTMLCanvasElement): ViewportScene {
  // 背景は CSS(.pcad-viewport の縦グラデーション)に任せ、描画結果だけを重ねる。
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();

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

  const sketchLayer = createSketchLayer();
  sketchLayer.setWorkPlane(WORK_PLANES[DEFAULT_WORK_PLANE_ID]);
  scene.add(sketchLayer.group);

  let currentSpacing = 0;

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
    currentSpacing = spacing;
  }
  rebuildGrid(gridSpacing(HOME_ORBIT.distance));

  let width = 1;
  let height = 1;

  /** スケッチの現在値。組み立て直すのは変化したときだけ(NFR-PF-1)。 */
  let resolvedSketch: ResolvedSketch = EMPTY_RESOLVED_SKETCH;
  let sketchMesh: SketchMesh | null = null;
  let sketchHighlight: SketchHighlight = NO_HIGHLIGHT;
  let sketchBundle = buildSketchGeometry(resolvedSketch, sketchMesh, sketchHighlight);

  /** ボディの現在値。組み立て直すのは変化したときだけ(NFR-PF-1)。 */
  let bodies: readonly SolidBody[] = [];
  let hoveredBodyId: string | null = null;
  let selectedBodyIds: readonly string[] = [];
  let solidBundle = EMPTY_SOLID_GEOMETRY;

  /** 部分形状(面・辺・頂点)の強調の現在値(§0.a-0.7)。 */
  let subShapeHoveredElementId: string | null = null;
  let subShapeSelection: readonly string[] = [];
  let subShapeBundle = EMPTY_SUB_SHAPE_HIGHLIGHT;

  /** ねじの簡略表示の印(§0.a-0.15)。ボディの一覧から導くだけで、別の入力は持たない。 */
  let threadMarks: readonly ThreadMarkInfo[] = [];

  /** 最後に描いたときのカメラ。画面座標との行き来はこれが決まってからでないとできない。 */
  let lastCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera | null = null;
  /** 最後に描いたときの見せ方。サムネイルを撮るときに同じ絵を描き直すのに使う。 */
  let lastRender: RenderSettings | null = null;
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  const scratch = new THREE.Vector3();
  const intersection = new THREE.Vector3();
  const pickPlane = new THREE.Plane();
  const planeNormal = new THREE.Vector3();
  const planeOrigin = new THREE.Vector3();

  /** 1 枚描く。表示スタイルの反映からカメラの置き直しまで、絵を作る手順はここだけ。 */
  function drawScene(settings: RenderSettings): void {
    const { orbit, projection, displayStyle, showGrid } = settings;
    const spacing = gridSpacing(orbit.distance);
    if (spacing !== currentSpacing) {
      rebuildGrid(spacing);
    }
    gridGroup.visible = showGrid;

    // 立体とスケッチは組み立て直したときだけ並びを差し替える(同じ結果なら表示の入切だけ)。
    solidLayer.update(solidBundle, displayStyle);
    solidLayer.updateSubShapes(subShapeBundle);
    solidLayer.updateThreadMarks(threadMarks);
    sketchLayer.update(sketchBundle, displayStyle);

    updateKeyLight(orbit);

    const [x, y, z] = cameraPosition(orbit);
    const aspect = width / height;
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
    camera.up.copy(UP_AXIS);
    camera.lookAt(orbit.target[0], orbit.target[1], orbit.target[2]);
    camera.updateProjectionMatrix();

    // 画面座標との行き来(worldToScreen / screenToPlanePoint / pickBody)はこのカメラで行う。
    lastCamera = camera;
    lastRender = settings;
    renderer.render(scene, camera);
  }

  return {
    setSketch(nextSketch, nextMesh): void {
      resolvedSketch = nextSketch;
      sketchMesh = nextMesh;
      sketchBundle = buildSketchGeometry(resolvedSketch, sketchMesh, sketchHighlight);
    },

    setSketchHighlight(hoveredElementId, selection): void {
      sketchHighlight = { hoveredElementId, selection };
      sketchBundle = buildSketchGeometry(resolvedSketch, sketchMesh, sketchHighlight);
    },

    setBodies(nextBodies): void {
      bodies = nextBodies;
      solidBundle = buildSolidGeometry(bodies, hoveredBodyId, selectedBodyIds);
      // ボディの形が変わると強調する三角形・線分の座標も変わるので組み立て直す。
      subShapeBundle = buildSubShapeGeometry(bodies, subShapeHoveredElementId, subShapeSelection);
      // ねじの印もボディの一覧から導く値なので、ここで一緒に組み立て直す(§0.a-0.15)。
      threadMarks = collectThreadMarks(bodies);
    },

    setBodyHighlight(nextHovered, nextSelected): void {
      hoveredBodyId = nextHovered;
      selectedBodyIds = nextSelected;
      solidBundle = buildSolidGeometry(bodies, hoveredBodyId, selectedBodyIds);
    },

    setSubShapeHighlight(hoveredElementId, selection): void {
      subShapeHoveredElementId = hoveredElementId;
      subShapeSelection = selection;
      subShapeBundle = buildSubShapeGeometry(bodies, subShapeHoveredElementId, subShapeSelection);
    },

    pickBody(screenX, screenY): string | null {
      if (lastCamera === null) {
        return null;
      }
      pointerNdc.set((screenX / width) * 2 - 1, -((screenY / height) * 2 - 1));
      // 平行投影でも setFromCamera が視線の起点と向きを組み立て直す(three.js が
      // カメラの種類を見て分ける)ので、投影の切替でそのまま動く。
      raycaster.setFromCamera(pointerNdc, lastCamera);
      return solidLayer.pickBody(raycaster);
    },

    pickFaceAt(screenX, screenY): { readonly featureId: string; readonly faceIndex: number } | null {
      if (lastCamera === null) {
        return null;
      }
      pointerNdc.set((screenX / width) * 2 - 1, -((screenY / height) * 2 - 1));
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
      drawScene(lastRender);
      return captureThumbnailPng(canvas, size);
    },

    setThemeColors(next): void {
      colors = next;
      // 方眼と軸は頂点ごとの色を持つので、いまの間隔のまま組み立て直す。
      rebuildGrid(currentSpacing);
      skyLight.groundColor.setHex(colors.sceneGround);
      solidLayer.setThemeColors(colors);
      sketchLayer.setThemeColors(colors);
    },

    setWorkPlane(id): void {
      sketchLayer.setWorkPlane(WORK_PLANES[id]);
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
      return [((scratch.x + 1) / 2) * width, ((1 - scratch.y) / 2) * height];
    },

    screenToPlanePoint(x, y, plane): Vec3 | null {
      if (lastCamera === null) {
        return null;
      }
      pointerNdc.set((x / width) * 2 - 1, -((y / height) * 2 - 1));
      raycaster.setFromCamera(pointerNdc, lastCamera);
      planeNormal.set(plane.normal[0], plane.normal[1], plane.normal[2]);
      planeOrigin.set(plane.origin[0], plane.origin[1], plane.origin[2]);
      pickPlane.setFromNormalAndCoplanarPoint(planeNormal, planeOrigin);
      const hit = raycaster.ray.intersectPlane(pickPlane, intersection);
      return hit === null ? null : [hit.x, hit.y, hit.z];
    },

    resize(widthPixels, heightPixels): void {
      width = Math.max(widthPixels, 1);
      height = Math.max(heightPixels, 1);
      // CSS の大きさは指定済みなので描画バッファだけを合わせる。
      renderer.setSize(width, height, false);
    },

    render(orbit, projection, displayStyle, showGrid): void {
      drawScene({ orbit, projection, displayStyle, showGrid });
    },

    dispose(): void {
      solidLayer.dispose();
      sketchLayer.dispose();
      grid.geometry.dispose();
      axisLines.geometry.dispose();
      lineMaterial.dispose();
      skyLight.dispose();
      keyLight.dispose();
      renderer.dispose();
    },
  };
}
