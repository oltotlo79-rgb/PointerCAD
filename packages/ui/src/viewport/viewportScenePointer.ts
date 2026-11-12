import type { SolidBody } from '@pointercad/model';
import * as THREE from 'three';
import type { ProjectionMode } from '../store/viewSlice.js';
import type { OrbitState } from './cameraMath.js';
import type { ViewportScene } from './createViewportScene.js';
import type { QuadRectangle } from './quadLayout.js';
import { configureViewportCamera, fullyFramedIds, projectToScreen, type createViewportCameras } from './viewportSceneRendering.js';

/*
 * createViewportScene の視点と画面座標の行き来(FR-102・FR-106・FR-110)。最後に描いたカメラと区画を
 * 控え、画面の画素から光線・作図面の点を、ワールドの点から画素を求める。当たりの判定(立体・部品)は
 * 各表示の持ち主が、ここで用意した光線で行う。
 */

export type ScenePointer = ReturnType<typeof createScenePointer>;
type ScreenMethods = Pick<ViewportScene, 'worldToScreen' | 'screenToPlanePoint' | 'pointerRay'>;

export function createScenePointer(cameras: ReturnType<typeof createViewportCameras>, initialRectangle: QuadRectangle,
  isDisposed: () => boolean) {
  /** 最後に描いたときのカメラ。画面座標との行き来はこれが決まってからでないとできない。 */
  let lastCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera | null = null;
  let activeRectangle: QuadRectangle = initialRectangle;
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  const scratch = new THREE.Vector3();
  const intersection = new THREE.Vector3();
  const pickPlane = new THREE.Plane();
  const planeNormal = new THREE.Vector3();
  const planeOrigin = new THREE.Vector3();

  function setPointer(screenX: number, screenY: number): void {
    pointerNdc.set(2 * (screenX - activeRectangle.x) / activeRectangle.width - 1,
      1 - 2 * (screenY - activeRectangle.y) / activeRectangle.height);
  }

  /**
   * The camera ray alone, for plane points and rays that never read solid meshes. Sketch input
   * must not depend on (or clear) the solid display's ownership; solid picks use their own gate first.
   */
  function prepareCameraRay(screenX: number, screenY: number): boolean {
    if (isDisposed() || lastCamera === null) return false;
    setPointer(screenX, screenY);
    raycaster.setFromCamera(pointerNdc, lastCamera);
    return true;
  }

  /** 画面座標とワールド座標の行き来。作図の入力は立体の受領に依らず、ここだけを使う。 */
  const methods: ScreenMethods = {
    worldToScreen(point): readonly [number, number] | null {
      if (lastCamera === null) {
        return null;
      }
      return projectToScreen(point, lastCamera, activeRectangle, scratch);
    },

    screenToPlanePoint(x, y, plane) {
      if (!prepareCameraRay(x, y)) return null;
      planeNormal.set(plane.normal[0], plane.normal[1], plane.normal[2]);
      planeOrigin.set(plane.origin[0], plane.origin[1], plane.origin[2]);
      pickPlane.setFromNormalAndCoplanarPoint(planeNormal, planeOrigin);
      const hit = raycaster.ray.intersectPlane(pickPlane, intersection);
      return hit === null ? null : [hit.x, hit.y, hit.z];
    },

    pointerRay(x, y) {
      if (!prepareCameraRay(x, y)) return null;
      const { origin, direction } = raycaster.ray;
      return {
        origin: [origin.x, origin.y, origin.z],
        direction: [direction.x, direction.y, direction.z],
      };
    },
  };

  return {
    methods,
    raycaster,
    camera: () => lastCamera,
    prepareCameraRay,

    configureCamera(orbit: OrbitState, projection: ProjectionMode, rectangle: QuadRectangle): THREE.Camera {
      const camera = configureViewportCamera(cameras, orbit, projection, rectangle);
      // 画面座標との行き来(worldToScreen / screenToPlanePoint / pickBody)はこのカメラで行う。
      lastCamera = camera;
      activeRectangle = rectangle;
      return camera;
    },

    /** 明示的な診断時だけ実メッシュ全頂点を投影する。描画ループでは呼ばない。 */
    fullyFramed(bodies: readonly SolidBody[], camera: THREE.Camera): readonly string[] {
      return fullyFramedIds(bodies, camera, scratch);
    },
  };
}
