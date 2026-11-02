import type { SolidBody, Vec3 } from '@pointercad/model';
import * as THREE from 'three';
import { subShapeFrameOrigin } from '../solid/subShapeSelection.js';
import type { ProjectionMode } from '../store/viewSlice.js';
import {
  cameraPosition,
  clamp,
  orthographicFrustumHeight,
  VERTICAL_FIELD_OF_VIEW,
  type OrbitState,
} from './cameraMath.js';
import { quadLayout, type QuadRectangle } from './quadLayout.js';

/*
 * createViewportScene の描画の単位(E08)。透視・平行投影のカメラ 2 台、主光源の向き、
 * 4 区画の論理座標、画面座標への投影をここに置く。renderer・scene・最後に使ったカメラの
 * 控え(画面座標との行き来に使う)の持ち主は createViewportScene のまま。
 */

/** 本アプリは Z 軸が上(計画書 §0.a-0.9)。three.js の既定(Y 上)から変える。 */
const UP_AXIS = new THREE.Vector3(0, 0, 1);

const NEAR_PLANE = 0.05;
const FAR_PLANE = 200_000;

/** 面の明暗差を作る主光源。視点の右上前方に置き、カメラに追従させる。 */
export const KEY_LIGHT_INTENSITY = 0.8;
const KEY_LIGHT_AZIMUTH_OFFSET = 0.55;
const KEY_LIGHT_ELEVATION_OFFSET = 0.5;
/** 真上・真下から照らすと上面と側面の差が消えるので、仰角に上限を設ける。 */
const KEY_LIGHT_MAX_ELEVATION = 1.2;

/** 1 つの Scene が持つカメラ 2 台。描画のたびに作らず、投影の切替でどちらかを使う。 */
export interface ViewportCameras {
  readonly perspective: THREE.PerspectiveCamera;
  readonly orthographic: THREE.OrthographicCamera;
}

export function createViewportCameras(): ViewportCameras {
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
  return { perspective: perspectiveCamera, orthographic: orthographicCamera };
}

/** 主光源を視点の右上前方へ置き直す。どの向きから見ても隣り合う面に明暗差が出る。 */
export function placeKeyLight(keyLight: THREE.DirectionalLight, orbit: OrbitState): void {
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

/** 視点・投影・区画からカメラを合わせる。どのカメラを控えるかは呼び出し側が決める。 */
export function configureViewportCamera(
  cameras: ViewportCameras,
  orbit: OrbitState,
  projection: ProjectionMode,
  rectangle: QuadRectangle,
): THREE.PerspectiveCamera | THREE.OrthographicCamera {
  const [x, y, z] = cameraPosition(orbit);
  const aspect = rectangle.width / rectangle.height;
  const camera = projection === 'perspective' ? cameras.perspective : cameras.orthographic;

  if (projection === 'perspective') {
    cameras.perspective.aspect = aspect;
  } else {
    // 透視投影と見た目の大きさを揃える(FR-102)。
    const frustumHeight = orthographicFrustumHeight(orbit.distance);
    cameras.orthographic.top = frustumHeight / 2;
    cameras.orthographic.bottom = -frustumHeight / 2;
    cameras.orthographic.left = (-frustumHeight * aspect) / 2;
    cameras.orthographic.right = (frustumHeight * aspect) / 2;
  }
  camera.position.set(x, y, z);
  if (orbit.up === undefined) camera.up.copy(UP_AXIS);
  else camera.up.set(...orbit.up);
  camera.zoom = orbit.zoom ?? 1;
  camera.lookAt(orbit.target[0], orbit.target[1], orbit.target[2]);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return camera;
}

/** 4 区画を描画バッファの画素から論理座標へ直す。幅か高さが 0 の区画は描かない。 */
export function logicalQuadPanes(ratio: number, bufferWidth: number, bufferHeight: number, projection: ProjectionMode) {
  const logical = (rectangle: QuadRectangle): QuadRectangle => ({
    x: rectangle.x / ratio, y: rectangle.y / ratio,
    width: rectangle.width / ratio, height: rectangle.height / ratio,
  });
  return quadLayout(bufferWidth, bufferHeight, projection)
    .filter((pane) => pane.rectangle.width > 0 && pane.rectangle.height > 0)
    .map((pane) => ({ ...pane, rectangle: logical(pane.rectangle), scissor: logical(pane.scissor) }));
}

/** 点をカメラで区画の画面座標へ写す。`scratch` は呼び出し側が使い回す入れ物。 */
export function projectToScreen(
  point: Vec3,
  camera: THREE.Camera,
  rectangle: QuadRectangle,
  scratch: THREE.Vector3,
): readonly [number, number] | null {
  scratch.set(point[0], point[1], point[2]).project(camera);
  // 視点の後ろ(z > 1)や手前の切り取り面より近い点は画面に無い。
  if (scratch.z < -1 || scratch.z > 1) {
    return null;
  }
  return [rectangle.x + ((scratch.x + 1) / 2) * rectangle.width,
    rectangle.y + ((1 - scratch.y) / 2) * rectangle.height];
}

/** 明示的な診断時だけ、実メッシュの全頂点を投影して、全体が視野に入っているボディを返す。 */
export function fullyFramedIds(
  bodies: readonly SolidBody[],
  camera: THREE.Camera,
  scratch: THREE.Vector3,
): readonly string[] {
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
}
