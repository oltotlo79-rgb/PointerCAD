import * as THREE from 'three';

import { cameraPosition, type OrbitState } from '../viewport/cameraMath.js';
import { createFaceTexture, FACE_LABEL_KEYS } from './faceTexture.js';
import {
  regionFromLocalPoint,
  REGION_THRESHOLD,
  type AxisSign,
  type ViewCubeRegion,
} from './viewCubeMath.js';

/** ビューキューブの描画一式。視点は持たず、呼ばれるたびに渡された視点で描く。 */
export interface ViewCubeScene {
  /** 視点とホバー中の領域を反映して描く。前回と同じ内容なら描き直さない。 */
  render(orbit: OrbitState, highlighted: ViewCubeRegion | null): void;
  /** canvas 上の位置(-1 〜 +1 の正規化座標)から、指している領域を返す。 */
  pick(normalizedX: number, normalizedY: number): ViewCubeRegion | null;
  /** 表示の一辺(画素)を合わせる。 */
  resize(sizePixels: number): void;
  dispose(): void;
}

/** 立方体の一辺の半分。領域判定(viewCubeMath)は -1 〜 +1 を前提とするので 1 にする。 */
const CUBE_HALF_SIZE = 1;

/** 本アプリは Z 軸が上(計画書 §0.a-0.9)。 */
const UP_AXIS = new THREE.Vector3(0, 0, 1);

const CAMERA_FIELD_OF_VIEW_DEGREES = 35;
const CAMERA_NEAR_PLANE = 0.1;
const CAMERA_FAR_PLANE = 100;

/**
 * カメラと立方体の距離。
 *
 * 等角視(角が正面を向く向き)では、手前寄りの角がカメラから 6.5 - 1/√3 ≒ 5.92 の距離に、
 * 視線から √(3 - 1/3) ≒ 1.633 だけ離れて見える。画角 35 度の半分の正接が 0.3153 なので、
 * 画面の半分に対する占有率は 1.633 / 5.92 / 0.3153 ≒ 0.87 に収まり、角が枠から出ない。
 * 計画書の 4 では占有率が 1.5 を超えて角が切れるため、検算のうえ広げた。
 */
const CAMERA_DISTANCE = 6.5;

/** 端末の画素密度をそのまま使うと高精細画面で負荷が跳ね上がるため上限を設ける(NFR-PF-1)。 */
const MAX_PIXEL_RATIO = 2;

/** ホバー中の領域を示す板を、面からわずかに浮かせる量。面と重なってちらつくのを防ぐ。 */
const HIGHLIGHT_LIFT = 0.012;
const HIGHLIGHT_COLOR = 0x2f9bff;
const HIGHLIGHT_OPACITY = 0.42;

/** 領域の板の中心。面の中央(0)ならキューブの中心、端(±1)なら外寄りに置く。 */
function highlightCenter(sign: AxisSign): number {
  return sign === 0 ? 0 : sign * ((1 + REGION_THRESHOLD) / 2) * CUBE_HALF_SIZE;
}

/** 領域の板の一辺。しきい値で区切られた 3 × 3 の升目に合わせる。 */
function highlightSize(sign: AxisSign): number {
  const half = sign === 0 ? REGION_THRESHOLD : (1 - REGION_THRESHOLD) / 2;
  return 2 * (half * CUBE_HALF_SIZE + HIGHLIGHT_LIFT);
}

function regionKey(region: ViewCubeRegion | null): string {
  return region === null ? '' : `${region.x},${region.y},${region.z}`;
}

/**
 * 本体のビューポートとは別の小さな canvas に、独立した描画器で立方体だけを描く(FR-103)。
 * 当たり判定は three.js の Raycaster で行い、当たった点を viewCubeMath の領域判定へ渡す。
 */
export function createViewCubeScene(canvas: HTMLCanvasElement, sizePixels: number): ViewCubeScene {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.setClearAlpha(0);

  const scene = new THREE.Scene();

  // 面の文字を確実に読ませたいので、光の当たり方に左右されない材質で描く。
  const materials = FACE_LABEL_KEYS.map(
    (key) => new THREE.MeshBasicMaterial({ map: createFaceTexture(key) }),
  );
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(CUBE_HALF_SIZE * 2, CUBE_HALF_SIZE * 2, CUBE_HALF_SIZE * 2),
    materials,
  );
  // three.js の既定は Y 上、本アプリは Z 上。立方体を倒して軸の意味を合わせる。
  // 向き(+90 度)と面の並びの対応は faceTexture.ts の FACE_LABEL_KEYS の注釈を参照。
  cube.rotation.x = Math.PI / 2;
  scene.add(cube);

  // ホバー中の面・辺・頂点を示す板(NFR-UX-7)。位置と大きさは領域ごとに付け替える。
  const highlightMaterial = new THREE.MeshBasicMaterial({
    color: HIGHLIGHT_COLOR,
    transparent: true,
    opacity: HIGHLIGHT_OPACITY,
    depthWrite: false,
  });
  const highlight = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), highlightMaterial);
  highlight.visible = false;
  scene.add(highlight);

  const camera = new THREE.PerspectiveCamera(
    CAMERA_FIELD_OF_VIEW_DEGREES,
    1,
    CAMERA_NEAR_PLANE,
    CAMERA_FAR_PLANE,
  );
  camera.up.copy(UP_AXIS);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  // 前回描いた内容。同じなら描き直さず、待機中に GPU を回し続けないようにする(NFR-PF-1)。
  let lastAzimuth = Number.NaN;
  let lastElevation = Number.NaN;
  let lastRegionKey = '';

  function applySize(pixels: number): void {
    const size = Math.max(Math.round(pixels), 1);
    // CSS で大きさを指定済みなので描画バッファだけを合わせる。
    renderer.setSize(size, size, false);
  }
  applySize(sizePixels);

  return {
    render(orbit, highlighted): void {
      const key = regionKey(highlighted);
      if (
        orbit.azimuth === lastAzimuth &&
        orbit.elevation === lastElevation &&
        key === lastRegionKey
      ) {
        return;
      }
      lastAzimuth = orbit.azimuth;
      lastElevation = orbit.elevation;
      lastRegionKey = key;

      if (highlighted === null) {
        highlight.visible = false;
      } else {
        highlight.visible = true;
        highlight.position.set(
          highlightCenter(highlighted.x),
          highlightCenter(highlighted.y),
          highlightCenter(highlighted.z),
        );
        highlight.scale.set(
          highlightSize(highlighted.x),
          highlightSize(highlighted.y),
          highlightSize(highlighted.z),
        );
      }

      // 立方体は原点に固定し、本体のビューポートと同じ向きからカメラだけを回す。
      const [x, y, z] = cameraPosition({
        ...orbit,
        distance: CAMERA_DISTANCE,
        target: [0, 0, 0],
      });
      camera.position.set(x, y, z);
      camera.up.copy(UP_AXIS);
      camera.lookAt(0, 0, 0);
      // 描画の前後どちらで pick が呼ばれても当たり判定がずれないようにする。
      camera.updateMatrixWorld();

      renderer.render(scene, camera);
    },

    pick(normalizedX, normalizedY): ViewCubeRegion | null {
      pointer.set(normalizedX, normalizedY);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(cube, false).at(0);
      if (hit === undefined) {
        return null;
      }
      // シーンのワールド座標は Z 上で、立方体は原点中心・軸に沿った一辺 2×CUBE_HALF_SIZE。
      // 交点をそのまま -1 〜 +1 へ直せば領域判定へ渡せる(立方体の回転に依存しない)。
      return regionFromLocalPoint([
        hit.point.x / CUBE_HALF_SIZE,
        hit.point.y / CUBE_HALF_SIZE,
        hit.point.z / CUBE_HALF_SIZE,
      ]);
    },

    resize(pixels): void {
      applySize(pixels);
      // 大きさが変わったら描き直しが要るので、前回の記録を無効にする。
      lastAzimuth = Number.NaN;
    },

    dispose(): void {
      cube.geometry.dispose();
      for (const material of materials) {
        material.map?.dispose();
        material.dispose();
      }
      highlight.geometry.dispose();
      highlightMaterial.dispose();
      renderer.dispose();
    },
  };
}
