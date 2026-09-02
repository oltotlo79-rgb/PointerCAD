import type { PartMesh } from '@pointercad/model';
import * as THREE from 'three';

import type { DisplayStyle, ProjectionMode } from '../store/useAppStore.js';
import {
  cameraPosition,
  HOME_ORBIT,
  orthographicFrustumHeight,
  VERTICAL_FIELD_OF_VIEW,
  type OrbitState,
} from './cameraMath.js';
import { axisLength, gridExtent, gridSpacing } from './gridMath.js';

/** ビューポートの描画一式。視点は持たず、呼ばれるたびに渡された視点で描く。 */
export interface ViewportScene {
  render(orbit: OrbitState, projection: ProjectionMode, displayStyle: DisplayStyle, showGrid: boolean): void;
  setMesh(mesh: PartMesh | null): void;
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
const EDGE_COLOR_OVER_SOLID = 0x101014;
const EDGE_COLOR_WIREFRAME = 0xd6dae2;

export function createViewportScene(canvas: HTMLCanvasElement): ViewportScene {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.setClearColor(0x2b2b2e, 1);

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1.4));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
  keyLight.position.set(1, 1, 2);
  scene.add(keyLight);

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
      color: 0xb0b6c0,
      roughness: 0.65,
      metalness: 0.05,
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

  const gridGroup = new THREE.Group();
  scene.add(gridGroup);
  let grid: THREE.GridHelper | null = null;
  let axes: THREE.AxesHelper | null = null;
  let currentSpacing = 0;

  let currentEdgeColor = EDGE_COLOR_OVER_SOLID;
  let hasMesh = false;
  let width = 1;
  let height = 1;

  function disposeGrid(): void {
    if (grid !== null) {
      gridGroup.remove(grid);
      grid.dispose();
      grid = null;
    }
    if (axes !== null) {
      gridGroup.remove(axes);
      axes.dispose();
      axes = null;
    }
  }

  /** 方眼と XYZ 軸を作り直す(FR-104)。間隔はカメラ距離で段階的に変わる。 */
  function rebuildGrid(spacing: number): void {
    disposeGrid();

    const extent = gridExtent(spacing);
    grid = new THREE.GridHelper(extent * 2, Math.round((extent * 2) / spacing), 0x5a5a60, 0x3a3a40);
    // GridHelper は XZ 平面に作られるので、Z が上の座標系へ倒す。
    grid.rotation.x = Math.PI / 2;
    gridGroup.add(grid);

    // X 赤・Y 緑・Z 青(AxesHelper の既定)。方眼の中心線と重なるので後から描く。
    axes = new THREE.AxesHelper(axisLength(spacing));
    axes.renderOrder = 1;
    gridGroup.add(axes);

    currentSpacing = spacing;
  }
  rebuildGrid(gridSpacing(HOME_ORBIT.distance));

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

      const edgeColor = displayStyle === 'wireframe' ? EDGE_COLOR_WIREFRAME : EDGE_COLOR_OVER_SOLID;
      if (edgeColor !== currentEdgeColor) {
        edges.material.color.setHex(edgeColor);
        currentEdgeColor = edgeColor;
      }

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

      renderer.render(scene, camera);
    },

    dispose(): void {
      disposeGrid();
      solid.geometry.dispose();
      solid.material.dispose();
      edges.geometry.dispose();
      edges.material.dispose();
      renderer.dispose();
    },
  };
}
