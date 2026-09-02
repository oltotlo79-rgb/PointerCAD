import {
  DEFAULT_WORK_PLANE_ID,
  WORK_PLANES,
  type PartMesh,
  type ResolvedSketch,
  type SketchMesh,
  type Vec3,
  type WorkPlane,
  type WorkPlaneId,
} from '@pointercad/model';
import * as THREE from 'three';

import type { DisplayStyle, ProjectionMode } from '../store/useAppStore.js';
import {
  buildSketchGeometry,
  EMPTY_RESOLVED_SKETCH,
  NO_HIGHLIGHT,
  type SketchHighlight,
} from './buildSketchGeometry.js';
import {
  cameraPosition,
  clamp,
  HOME_ORBIT,
  orthographicFrustumHeight,
  VERTICAL_FIELD_OF_VIEW,
  type OrbitState,
} from './cameraMath.js';
import { createSketchLayer } from './createSketchLayer.js';
import { axisLength, gridExtent, gridFadeOpacity, gridSpacing, isMajorGridLine } from './gridMath.js';

/** ビューポートの描画一式。視点は持たず、呼ばれるたびに渡された視点で描く。 */
export interface ViewportScene {
  render(orbit: OrbitState, projection: ProjectionMode, displayStyle: DisplayStyle, showGrid: boolean): void;
  setMesh(mesh: PartMesh | null): void;
  /** スケッチの表示を差し替える(FR-105、FR-310)。 */
  setSketch(sketch: ResolvedSketch, mesh: SketchMesh | null): void;
  /** ホバー・選択の強調を差し替える(FR-106)。 */
  setSketchHighlight(hoveredElementId: string | null, selection: readonly string[]): void;
  /** いま描いている作図面(§0.a-0.3)。薄い矩形で向きを示す。 */
  setWorkPlane(id: WorkPlaneId): void;
  /** ワールド座標を canvas 上の画素座標へ。まだ一度も描いていない・画面の外なら null。 */
  worldToScreen(point: Vec3): readonly [number, number] | null;
  /** canvas 上の画素座標から、作図面の上の点を求める。平面と視線が平行なら null。 */
  screenToPlanePoint(x: number, y: number, plane: WorkPlane): Vec3 | null;
  resize(widthPixels: number, heightPixels: number): void;
  dispose(): void;
}

/** 本アプリは Z 軸が上(計画書 §0.a-0.9)。three.js の既定(Y 上)から変える。 */
const UP_AXIS = new THREE.Vector3(0, 0, 1);

/** 端末の画素密度をそのまま使うと高精細画面で負荷が跳ね上がるため上限を設ける(NFR-PF-1)。 */
const MAX_PIXEL_RATIO = 2;

const NEAR_PLANE = 0.05;
const FAR_PLANE = 200_000;

/** 面の上に重ねる稜線は暗く、稜線だけのときは背景から浮くよう明るくする(FR-105)。 */
const EDGE_COLOR_OVER_SOLID = 0x0f1115;
const EDGE_COLOR_WIREFRAME = 0xd6dae2;

/** 立体の色味。艶を抑えた樹脂のような明るい灰にして、面の向きの差を読み取りやすくする。 */
const SOLID_COLOR = 0xb8bfcc;
const SOLID_ROUGHNESS = 0.55;
const SOLID_METALNESS = 0.05;

/** 方眼の色。副線は背景から浮きすぎない濃さに、主線はその一段上に置く(FR-104)。 */
const GRID_MINOR_COLOR = 0x343945;
const GRID_MAJOR_COLOR = 0x454b59;

interface AxisDefinition {
  readonly color: number;
  readonly direction: readonly [number, number, number];
}

/** 原点を通る 3 本の軸。色は X 赤・Y 緑・Z 青(FR-104)。 */
const AXES: readonly AxisDefinition[] = [
  { color: 0xe5484d, direction: [1, 0, 0] },
  { color: 0x46a758, direction: [0, 1, 0] },
  { color: 0x3e63dd, direction: [0, 0, 1] },
];

/** 軸 1 本を何本の線分に割るか。頂点ごとの薄まりを線の途中でも効かせるために分ける。 */
const AXIS_SEGMENTS_PER_SIDE = 40;

/** 空と地面の色で全体を起こす補助光。真上は白、地面側は背景に馴染む暗い灰。 */
const SKY_COLOR = 0xffffff;
const GROUND_COLOR = 0x3a3f4a;
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
function buildGridGeometry(spacing: number): THREE.BufferGeometry {
  const extent = gridExtent(spacing);
  const halfCount = Math.round(extent / spacing);
  const minorColor = new THREE.Color(GRID_MINOR_COLOR);
  const majorColor = new THREE.Color(GRID_MAJOR_COLOR);
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
function buildAxisGeometry(length: number): THREE.BufferGeometry {
  const buffer = createLineBuffer();

  for (const axis of AXES) {
    const color = new THREE.Color(axis.color);
    for (let step = -AXIS_SEGMENTS_PER_SIDE; step < AXIS_SEGMENTS_PER_SIDE; step += 1) {
      const from = (step / AXIS_SEGMENTS_PER_SIDE) * length;
      const to = ((step + 1) / AXIS_SEGMENTS_PER_SIDE) * length;
      pushFadedSegment(
        buffer,
        [axis.direction[0] * from, axis.direction[1] * from, axis.direction[2] * from],
        [axis.direction[0] * to, axis.direction[1] * to, axis.direction[2] * to],
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

  const skyLight = new THREE.HemisphereLight(SKY_COLOR, GROUND_COLOR, HEMISPHERE_INTENSITY);
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

  const solid = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshStandardMaterial({
      color: SOLID_COLOR,
      roughness: SOLID_ROUGHNESS,
      metalness: SOLID_METALNESS,
      side: THREE.DoubleSide,
      // 面と稜線を同時に出すとき、稜線が面に埋もれてちらつくのを防ぐ(FR-105)。
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
  );
  solid.visible = false;
  scene.add(solid);

  const edges = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: EDGE_COLOR_OVER_SOLID }),
  );
  edges.visible = false;
  scene.add(edges);

  /**
   * 方眼と軸で共有する線の材質。頂点ごとの色と不透明度をそのまま使うので材質色は白のまま。
   * 深度は書かないので、立体に隠れることはあっても線どうしが互いを隠すことはない。
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

  const sketchLayer = createSketchLayer();
  sketchLayer.setWorkPlane(WORK_PLANES[DEFAULT_WORK_PLANE_ID]);
  scene.add(sketchLayer.group);

  let currentSpacing = 0;

  /** 方眼と XYZ 軸を作り直す(FR-104)。間隔が変わったときだけ呼ぶ。 */
  function rebuildGrid(spacing: number): void {
    grid.geometry.dispose();
    grid.geometry = buildGridGeometry(spacing);
    axisLines.geometry.dispose();
    axisLines.geometry = buildAxisGeometry(axisLength(spacing));
    // 作図面の矩形は方眼と同じ広がりにする。
    sketchLayer.setWorkPlaneExtent(gridExtent(spacing));
    currentSpacing = spacing;
  }
  rebuildGrid(gridSpacing(HOME_ORBIT.distance));

  let currentEdgeColor = EDGE_COLOR_OVER_SOLID;
  let hasMesh = false;
  let width = 1;
  let height = 1;

  /** スケッチの現在値。組み立て直すのは変化したときだけ(NFR-PF-1)。 */
  let resolvedSketch: ResolvedSketch = EMPTY_RESOLVED_SKETCH;
  let sketchMesh: SketchMesh | null = null;
  let sketchHighlight: SketchHighlight = NO_HIGHLIGHT;
  let sketchBundle = buildSketchGeometry(resolvedSketch, sketchMesh, sketchHighlight);

  /** 最後に描いたときのカメラ。画面座標との行き来はこれが決まってからでないとできない。 */
  let lastCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera | null = null;
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  const scratch = new THREE.Vector3();
  const intersection = new THREE.Vector3();
  const pickPlane = new THREE.Plane();
  const planeNormal = new THREE.Vector3();
  const planeOrigin = new THREE.Vector3();

  return {
    setMesh(mesh): void {
      solid.geometry.dispose();
      edges.geometry.dispose();

      if (mesh === null) {
        hasMesh = false;
        solid.geometry = new THREE.BufferGeometry();
        edges.geometry = new THREE.BufferGeometry();
        return;
      }

      const surfaceGeometry = new THREE.BufferGeometry();
      surfaceGeometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
      surfaceGeometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
      surfaceGeometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      solid.geometry = surfaceGeometry;

      const edgeGeometry = new THREE.BufferGeometry();
      edgeGeometry.setAttribute('position', new THREE.BufferAttribute(mesh.edgePositions, 3));
      edges.geometry = edgeGeometry;

      hasMesh = true;
    },

    setSketch(nextSketch, nextMesh): void {
      resolvedSketch = nextSketch;
      sketchMesh = nextMesh;
      sketchBundle = buildSketchGeometry(resolvedSketch, sketchMesh, sketchHighlight);
    },

    setSketchHighlight(hoveredElementId, selection): void {
      sketchHighlight = { hoveredElementId, selection };
      sketchBundle = buildSketchGeometry(resolvedSketch, sketchMesh, sketchHighlight);
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
      const spacing = gridSpacing(orbit.distance);
      if (spacing !== currentSpacing) {
        rebuildGrid(spacing);
      }
      gridGroup.visible = showGrid;

      // 形が無い間は面も稜線も出さない(空状態の案内だけを見せる)。
      solid.visible = hasMesh && displayStyle !== 'wireframe';
      edges.visible = hasMesh && displayStyle !== 'shaded';

      // スケッチは組み立て直したときだけ並びを差し替える(同じ結果なら表示の入切だけ)。
      sketchLayer.update(sketchBundle, displayStyle);

      const edgeColor = displayStyle === 'wireframe' ? EDGE_COLOR_WIREFRAME : EDGE_COLOR_OVER_SOLID;
      if (edgeColor !== currentEdgeColor) {
        edges.material.color.setHex(edgeColor);
        currentEdgeColor = edgeColor;
      }

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

      // 画面座標との行き来(worldToScreen / screenToPlanePoint)はこのカメラで行う。
      lastCamera = camera;
      renderer.render(scene, camera);
    },

    dispose(): void {
      sketchLayer.dispose();
      grid.geometry.dispose();
      axisLines.geometry.dispose();
      lineMaterial.dispose();
      skyLight.dispose();
      keyLight.dispose();
      solid.geometry.dispose();
      solid.material.dispose();
      edges.geometry.dispose();
      edges.material.dispose();
      renderer.dispose();
    },
  };
}
