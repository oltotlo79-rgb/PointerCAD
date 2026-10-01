import * as THREE from 'three';

import { cameraPosition, type OrbitState } from '../viewport/cameraMath.js';
import { DEFAULT_THEME_COLORS, type ThemeColors } from '../viewport/themeColors.js';
import { createAxisTexture, createCubeTexture } from './faceTexture.js';
import { VIEW_CUBE_CAMERA_DISTANCE, VIEW_CUBE_FIELD_OF_VIEW } from './viewCubeCamera.js';
import { createRegionGeometry, createViewCubeGeometry } from './viewCubeGeometry.js';
import { regionFromLocalPoint, type ViewCubeRegion } from './viewCubeMath.js';

export interface ViewCubeScene {
  /** Equal orientation, region and press state do not submit another frame. */
  render(orbit: OrbitState, highlighted: ViewCubeRegion | null, pressed?: boolean): void;
  pick(normalizedX: number, normalizedY: number): ViewCubeRegion | null;
  resize(sizePixels: number): void;
  setThemeColors(colors: ThemeColors): void;
  dispose(): void;
}

const MAX_PIXEL_RATIO = 2;
const UP_AXIS = new THREE.Vector3(0, 0, 1);
const GUIDE_HEIGHT = -1.24;
const GUIDE_RADIUS = 1.5;
const GUIDE_SEGMENTS = 48;
const GUIDE_WIDTH = 0.035;
const LABEL_RADIUS = 0.82;

function regionKey(region: ViewCubeRegion | null): string {
  return region === null ? '' : [region.x, region.y, region.z].join(',');
}

/** Flat ribbons keep a visible width on WebGL implementations with 1px lines. */
function guideGeometry(colors: ThemeColors): THREE.BufferGeometry {
  const positions: number[] = [], vertexColors: number[] = [];
  const ringColor = new THREE.Color(colors.viewCubeEdge);
  function line(from: number[], to: number[], color: THREE.Color): void {
    const a = new THREE.Vector3(from[0], from[1], from[2]), b = new THREE.Vector3(to[0], to[1], to[2]);
    const width = b.clone().sub(a).cross(UP_AXIS).normalize().multiplyScalar(GUIDE_WIDTH / 2);
    const corners = [a.clone().add(width), a.clone().sub(width), b.clone().sub(width), b.clone().add(width)];
    for (const index of [0, 1, 2, 0, 2, 3]) {
      positions.push(...corners[index].toArray());
      vertexColors.push(...color.toArray());
    }
  }
  function onRing(angle: number, radius: number): number[] {
    return [Math.cos(angle) * radius, Math.sin(angle) * radius, GUIDE_HEIGHT];
  }
  for (let index = 0; index < GUIDE_SEGMENTS; index += 1) {
    const angle = index * Math.PI * 2 / GUIDE_SEGMENTS;
    line(onRing(angle, GUIDE_RADIUS), onRing((index + 1) * Math.PI * 2 / GUIDE_SEGMENTS, GUIDE_RADIUS), ringColor);
    if (index % 4 === 0) line(onRing(angle, GUIDE_RADIUS), onRing(angle, GUIDE_RADIUS - (index % 12 === 0 ? 0.14 : 0.07)), ringColor);
  }
  // Last three ribbons are positioned in the camera plane when orientation changes.
  for (const color of [colors.axisX, colors.axisY, colors.axisZ]) line([0, 0, 0], [0, 0, 0], new THREE.Color(color));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(vertexColors, 3));
  return geometry;
}

/**
 * A bevelled cube, compass and axis labels with no lights, shadows or idle loop.
 * Five draws at rest, seven on hover (previously seven/eight). Picking deliberately
 * uses the original six-sided box and the unchanged 0.5 region boundary.
 */
export function createViewCubeScene(canvas: HTMLCanvasElement, sizePixels: number): ViewCubeScene {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearAlpha(0);
  const scene = new THREE.Scene();
  const cubeGeometry = createViewCubeGeometry();
  const material = new THREE.MeshBasicMaterial({ vertexColors: true });
  const cube = new THREE.Mesh(cubeGeometry, material);
  cube.rotation.x = Math.PI / 2;
  scene.add(cube);

  // Decoration must not make an existing corner or edge target harder to acquire.
  const pickGeometry = new THREE.BoxGeometry(2, 2, 2);
  const pickMaterial = new THREE.MeshBasicMaterial();
  const pickCube = new THREE.Mesh(pickGeometry, pickMaterial);
  pickCube.updateMatrixWorld();

  const guideMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const guide = new THREE.Mesh(guideGeometry(DEFAULT_THEME_COLORS), guideMaterial);
  scene.add(guide);
  const axisLabels = (['X', 'Y', 'Z'] as const).map(label => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, depthTest: false }));
    sprite.scale.setScalar(0.4);
    scene.add(sprite);
    return { label, sprite };
  });

  const regions = new Map<string, { surface: THREE.BufferGeometry; outline: THREE.EdgesGeometry }>();
  for (const x of [-1, 0, 1] as const) {
    for (const y of [-1, 0, 1] as const) {
      for (const z of [-1, 0, 1] as const) {
        if (x === 0 && y === 0 && z === 0) continue;
        const region = { x, y, z };
        const surface = createRegionGeometry(cubeGeometry, region);
        regions.set(regionKey(region), { surface, outline: new THREE.EdgesGeometry(surface, 25) });
      }
    }
  }
  const emptyGeometry = new THREE.BufferGeometry();
  const highlightMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.3, depthWrite: false });
  const highlight = new THREE.Mesh(emptyGeometry, highlightMaterial);
  const outlineMaterial = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.95, depthWrite: false });
  const outline = new THREE.LineSegments(emptyGeometry, outlineMaterial);
  highlight.visible = false;
  outline.visible = false;
  scene.add(highlight, outline);

  const camera = new THREE.PerspectiveCamera(VIEW_CUBE_FIELD_OF_VIEW, 1, 0.1, 100);
  camera.up.copy(UP_AXIS);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let lastAzimuth = Number.NaN, lastElevation = Number.NaN, lastRegionKey = '';
  let lastPressed = false;
  let lastSize = 0, lastPixelRatio = 0;

  function placeAxisLabels(): void {
    const directions = axisLabels.map((_axis, index) => {
      const direction = new THREE.Vector3().setComponent(index, 1).project(camera);
      // An axis looking straight at the viewer has no projected direction.
      return Math.hypot(direction.x, direction.y) < 1e-6 ? Math.PI / 2 + index * Math.PI * 2 / 3 : Math.atan2(direction.y, direction.x);
    });
    const angles: number[] = [];
    const signedAngle = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));
    const overlapsHome = (angle: number): boolean => signedAngle(angle) > 2.08 && signedAngle(angle) < 2.81;
    // Reserve the upper-left home button and separate nearly parallel axes.
    // Only the labels move aside; each stem still starts on its projected axis.
    for (const direction of directions) {
      const preferred = overlapsHome(direction) ? (direction < 2.445 ? 2.08 : 2.81) : direction;
      const candidates = [preferred];
      for (let step = 1; step <= 9; step += 1) candidates.push(preferred - step * 0.36, preferred + step * 0.36);
      angles.push(candidates.find(angle => !overlapsHome(angle) && angles.every(other => Math.abs(signedAngle(angle - other)) >= 0.36 - 1e-6)) ?? preferred);
    }
    const extent = VIEW_CUBE_CAMERA_DISTANCE * Math.tan(VIEW_CUBE_FIELD_OF_VIEW * Math.PI / 360);
    const positions = guide.geometry.getAttribute('position');
    for (const [index, { sprite }] of axisLabels.entries()) {
      const x = Math.cos(angles[index]), y = Math.sin(angles[index]);
      sprite.position.set(x * LABEL_RADIUS * extent, y * LABEL_RADIUS * extent, -VIEW_CUBE_CAMERA_DISTANCE).applyMatrix4(camera.matrixWorld);
      const from = new THREE.Vector2(Math.cos(directions[index]), Math.sin(directions[index])).multiplyScalar(0.69 * extent);
      const to = new THREE.Vector2(x, y).multiplyScalar(0.76 * extent);
      const width = new THREE.Vector2(-(to.y - from.y), to.x - from.x).normalize().multiplyScalar(GUIDE_WIDTH / 2);
      const ends = [from, from, to, from, to, to];
      const across = [1, -1, -1, 1, -1, 1];
      for (let vertex = 0; vertex < 6; vertex += 1) {
        const point = new THREE.Vector3(
          ends[vertex].x + width.x * across[vertex],
          ends[vertex].y + width.y * across[vertex],
          -VIEW_CUBE_CAMERA_DISTANCE,
        ).applyMatrix4(camera.matrixWorld);
        positions.setXYZ(positions.count - 18 + index * 6 + vertex, point.x, point.y, point.z);
      }
    }
    if (positions instanceof THREE.BufferAttribute) {
      positions.clearUpdateRanges();
      positions.addUpdateRange((positions.count - 18) * 3, 18 * 3);
    }
    positions.needsUpdate = true;
    // The camera-facing stems move, so stale culling bounds must not discard them.
    guide.frustumCulled = false;
  }

  function applySize(pixels: number): void {
    const pixelRatio = Math.min(globalThis.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    const size = Math.max(Math.round(pixels), 1);
    if (size === lastSize && pixelRatio === lastPixelRatio) return;
    lastSize = size;
    lastPixelRatio = pixelRatio;
    // Set density and dimensions together: setPixelRatio would resize once itself.
    renderer.setDrawingBufferSize(size, size, pixelRatio);
    lastAzimuth = Number.NaN;
  }
  applySize(sizePixels);

  function applyThemeColors(colors: ThemeColors): void {
    const previousMap = material.map;
    material.map = createCubeTexture(colors);
    material.needsUpdate = true;
    previousMap?.dispose();
    guide.geometry.dispose();
    guide.geometry = guideGeometry(colors);
    for (const [index, { label, sprite }] of axisLabels.entries()) {
      const previous = sprite.material.map;
      sprite.material.map = createAxisTexture(label, [colors.axisX, colors.axisY, colors.axisZ][index]);
      sprite.material.needsUpdate = true;
      previous?.dispose();
    }
    highlightMaterial.color.setHex(colors.selected);
    outlineMaterial.color.setHex(colors.hovered);
    lastAzimuth = Number.NaN;
  }
  applyThemeColors(DEFAULT_THEME_COLORS);

  return {
    render(orbit, highlighted, pressed = false): void {
      const key = regionKey(highlighted);
      if (orbit.azimuth === lastAzimuth && orbit.elevation === lastElevation && key === lastRegionKey && pressed === lastPressed) return;
      const orientationChanged = orbit.azimuth !== lastAzimuth || orbit.elevation !== lastElevation;
      lastAzimuth = orbit.azimuth;
      lastElevation = orbit.elevation;
      lastRegionKey = key;
      lastPressed = pressed;
      const region = regions.get(key);
      highlight.visible = region !== undefined;
      outline.visible = region !== undefined;
      if (region !== undefined) {
        highlight.geometry = region.surface;
        outline.geometry = region.outline;
        highlightMaterial.opacity = pressed ? 0.52 : 0.3;
      }
      camera.position.set(...cameraPosition({ ...orbit, distance: VIEW_CUBE_CAMERA_DISTANCE, target: [0, 0, 0] }));
      camera.up.copy(UP_AXIS);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      if (orientationChanged) placeAxisLabels();
      renderer.render(scene, camera);
    },
    pick(normalizedX, normalizedY): ViewCubeRegion | null {
      pointer.set(normalizedX, normalizedY);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(pickCube, false).at(0);
      return hit === undefined ? null : regionFromLocalPoint([hit.point.x, hit.point.y, hit.point.z]);
    },
    resize: applySize,
    setThemeColors: applyThemeColors,
    dispose(): void {
      cubeGeometry.dispose();
      material.map?.dispose();
      material.dispose();
      pickGeometry.dispose();
      pickMaterial.dispose();
      guide.geometry.dispose();
      guideMaterial.dispose();
      for (const { sprite } of axisLabels) {
        sprite.material.map?.dispose();
        sprite.material.dispose();
      }
      for (const { surface, outline: border } of regions.values()) {
        surface.dispose();
        border.dispose();
      }
      emptyGeometry.dispose();
      highlightMaterial.dispose();
      outlineMaterial.dispose();
      renderer.dispose();
    },
  };
}
