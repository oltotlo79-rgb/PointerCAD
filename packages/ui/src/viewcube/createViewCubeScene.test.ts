import { readFileSync } from 'node:fs';

import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HOME_ORBIT, MAX_ELEVATION, type OrbitState } from '../viewport/cameraMath.js';
import { DEFAULT_THEME_COLORS, themeColorsFrom } from '../viewport/themeColors.js';
import { createViewCubeScene } from './createViewCubeScene.js';
import { CUBE_FACES, FACE_FONT, FACE_TEXTURE_SIZE, VIEW_CUBE_FONT_FAMILY } from './faceTexture.js';
import { VIEW_CUBE_CAMERA_DISTANCE, VIEW_CUBE_FIELD_OF_VIEW } from './viewCubeCamera.js';

const renderer = vi.hoisted(() => ({
  render: vi.fn<(scene: THREE.Scene, camera: THREE.PerspectiveCamera) => void>(),
  setDrawingBufferSize: vi.fn(), dispose: vi.fn(),
}));
vi.mock('three', async importOriginal => ({
  ...await importOriginal<typeof import('three')>(),
  WebGLRenderer: class {
    render = renderer.render;
    setDrawingBufferSize = renderer.setDrawingBufferSize;
    dispose = renderer.dispose;
    setClearAlpha(): void { /* no GPU in unit tests */ }
  },
}));

const gradients: { offset: number; color: string }[][] = [];
const context = {
  fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 1,
  font: '', textAlign: '', textBaseline: '',
  fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn<(text: string, x: number, y: number) => void>(),
  createLinearGradient: () => {
    const stops: { offset: number; color: string }[] = [];
    gradients.push(stops);
    return { addColorStop: (offset: number, color: string) => { stops.push({ offset, color }); } };
  },
};

function themeRead(theme: string): (token: string) => string {
  const shell = readFileSync(new URL('../shell/appShell.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const scoped = readFileSync(new URL('./viewCube.css', import.meta.url), 'utf8');
  const block = (css: string, selector: string): string => {
    const start = css.indexOf(selector);
    if (start < 0) throw new Error(`Missing palette: ${selector}`);
    return css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  };
  const tokens = [block(shell, `[data-theme="${theme}"]`), block(scoped, '.pcad-viewcube-control {')];
  if (theme !== 'dark') tokens.push(block(scoped, `[data-theme='${theme}'] .pcad-viewcube-control`));
  return token => tokens.join(';').split(';').filter(line => line.trim().startsWith(`${token}:`)).at(-1)?.split(':').slice(1).join(':').trim() ?? '';
}

function palette(theme: string): ReturnType<typeof themeColorsFrom> {
  return themeColorsFrom(themeRead(theme));
}

function latestFrame(): { scene: THREE.Scene; camera: THREE.PerspectiveCamera } {
  const call = renderer.render.mock.calls.at(-1);
  if (call === undefined) throw new Error('Expected a submitted cube frame');
  return { scene: call[0], camera: call[1] };
}

beforeEach(() => {
  vi.clearAllMocks();
  gradients.length = 0;
  vi.stubGlobal('devicePixelRatio', 1.5);
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => context }) });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('view cube scene', () => {
  it('uses the shared projection regardless of the main camera distance and target', () => {
    const scene = createViewCubeScene(document.createElement('canvas'), 144);
    scene.render({ ...HOME_ORBIT, distance: 300, target: [3, 4, 5] }, null);
    const { camera } = latestFrame();
    expect(camera.fov).toBe(VIEW_CUBE_FIELD_OF_VIEW);
    expect(camera.position.length()).toBeCloseTo(VIEW_CUBE_CAMERA_DISTANCE, 12);
    scene.dispose();
  });

  it('raycasts all 26 unchanged targets, with decorative compass excluded', () => {
    const scene = createViewCubeScene(document.createElement('canvas'), 144);
    let count = 0;
    for (const x of [-1, 0, 1] as const) {
      for (const y of [-1, 0, 1] as const) {
        for (const z of [-1, 0, 1] as const) {
          if (x === 0 && y === 0 && z === 0) continue;
          const region = { x, y, z };
          const orbit: OrbitState = { ...HOME_ORBIT, azimuth: Math.atan2(y, x),
            elevation: Math.max(-MAX_ELEVATION, Math.min(MAX_ELEVATION, Math.atan2(z, Math.hypot(x, y)))) };
          scene.render(orbit, null);
          const projected = new THREE.Vector3(x, y, z).project(latestFrame().camera);
          expect(scene.pick(projected.x, projected.y)).toEqual(region);
          count += 1;
        }
      }
    }
    expect(count).toBe(26);
    scene.render(HOME_ORBIT, null);
    const compass = new THREE.Vector3(1.42, 0, -1.3).project(latestFrame().camera);
    expect(scene.pick(compass.x, compass.y)).toBeNull();
    scene.dispose();
  });

  it('uses five objects at rest and seven on hover, and does not redraw equal state', () => {
    const scene = createViewCubeScene(document.createElement('canvas'), 144);
    scene.render(HOME_ORBIT, null);
    expect(latestFrame().scene.children.filter(child => child.visible)).toHaveLength(5);
    scene.render({ ...HOME_ORBIT, distance: 300, target: [3, 4, 5] }, null);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    const front = { x: 0, y: -1, z: 0 } as const;
    scene.render(HOME_ORBIT, front);
    expect(latestFrame().scene.children.filter(child => child.visible)).toHaveLength(7);
    scene.render(HOME_ORBIT, { ...front });
    expect(renderer.render).toHaveBeenCalledTimes(2);
    scene.render(HOME_ORBIT, front, true);
    expect(renderer.render).toHaveBeenCalledTimes(3);
    const highlighted = latestFrame().scene.children.find(child => child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial && child.material.transparent);
    expect(highlighted).toBeInstanceOf(THREE.Mesh);
    if (!(highlighted instanceof THREE.Mesh) || !(highlighted.material instanceof THREE.MeshBasicMaterial)) throw new Error('Missing highlight');
    expect(highlighted.material.opacity).toBe(0.52);
    scene.render(HOME_ORBIT, null);
    expect(latestFrame().scene.children.filter(child => child.visible)).toHaveLength(5);
    scene.dispose();
  });

  it('keeps a sharp 150% buffer and caps density at two without an idle render', () => {
    const scene = createViewCubeScene(document.createElement('canvas'), 216);
    expect(renderer.setDrawingBufferSize).toHaveBeenLastCalledWith(216, 216, 1.5);
    scene.render(HOME_ORBIT, null);
    scene.resize(216);
    scene.render(HOME_ORBIT, null);
    expect(renderer.setDrawingBufferSize).toHaveBeenCalledTimes(1);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    vi.stubGlobal('devicePixelRatio', 3);
    scene.resize(216);
    expect(renderer.setDrawingBufferSize).toHaveBeenLastCalledWith(216, 216, 2);
    expect(renderer.setDrawingBufferSize).toHaveBeenCalledTimes(2);
    scene.render(HOME_ORBIT, null);
    expect(renderer.render).toHaveBeenCalledTimes(2);
    scene.dispose();
  });

  it('keeps the cube, compass and axis labels within the canvas while orbiting', () => {
    const scene = createViewCubeScene(document.createElement('canvas'), 144);
    for (let azimuth = -Math.PI; azimuth < Math.PI; azimuth += Math.PI / 4) {
      for (const elevation of [-MAX_ELEVATION, -Math.PI / 4, 0, Math.PI / 4, MAX_ELEVATION]) {
        scene.render({ ...HOME_ORBIT, azimuth, elevation }, null);
        const { scene: world, camera } = latestFrame();
        world.updateMatrixWorld(true);
        for (const child of world.children) {
          if (!child.visible) continue;
          if (child instanceof THREE.Sprite) {
            const center = child.position.clone().project(camera);
            const depth = -child.position.clone().applyMatrix4(camera.matrixWorldInverse).z;
            const halfSize = child.scale.x / 2 / (depth * Math.tan(camera.fov * Math.PI / 360));
            expect(Math.abs(center.x) + halfSize).toBeLessThan(1);
            expect(Math.abs(center.y) + halfSize).toBeLessThan(1);
          } else if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
            const geometry: unknown = child.geometry;
            if (!(geometry instanceof THREE.BufferGeometry)) throw new Error('Expected buffer geometry');
            const positions: unknown = geometry.getAttribute('position');
            if (!(positions instanceof THREE.BufferAttribute) && !(positions instanceof THREE.InterleavedBufferAttribute)) {
              throw new Error('Expected position attribute');
            }
            for (let index = 0; index < positions.count; index += 1) {
              const point = new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(child.matrixWorld).project(camera);
              expect(Math.abs(point.x)).toBeLessThan(1);
              expect(Math.abs(point.y)).toBeLessThan(1);
            }
          }
        }
      }
    }
    scene.dispose();
  });

  it('draws all six resource labels with the app font stack at 256px per face', () => {
    const scene = createViewCubeScene(document.createElement('canvas'), 144);
    expect(context.fillText.mock.calls.map(call => call[0])).toEqual(['右', '左', '上', '下', '前', '後', 'X', 'Y', 'Z']);
    expect(CUBE_FACES).toHaveLength(6);
    // The cube must not start a separate download of the 4.5 MB drawing font at startup.
    const shell = readFileSync(new URL('../shell/appShell.css', import.meta.url), 'utf8');
    expect(shell).toContain(`--pcad-font: ${VIEW_CUBE_FONT_FAMILY};`);
    expect(FACE_FONT).toBe(`600 96px ${VIEW_CUBE_FONT_FAMILY}`);
    expect(context.font).toBe(`600 42px ${VIEW_CUBE_FONT_FAMILY}`);
    const scoped = readFileSync(new URL('./viewCube.css', import.meta.url), 'utf8');
    expect(scoped).not.toMatch(/@font-face|NotoSansJP|url\(/u);
    expect(FACE_TEXTURE_SIZE).toBe(256);
    scene.render(HOME_ORBIT, null);
    const cube = latestFrame().scene.children[0];
    if (!(cube instanceof THREE.Mesh) || !(cube.material instanceof THREE.MeshBasicMaterial)) throw new Error('Missing cube');
    expect(cube.material.map?.flipY).toBe(true);
    expect(cube.material.map?.generateMipmaps).toBe(false);
    scene.dispose();
  });

  it('keeps all three axis labels separate and outside the pick surface in every tested orientation', () => {
    const scene = createViewCubeScene(document.createElement('canvas'), 216);
    for (let azimuth = -Math.PI; azimuth < Math.PI; azimuth += Math.PI / 8) {
      for (const elevation of [-MAX_ELEVATION, -Math.PI / 4, 0, HOME_ORBIT.elevation, Math.PI / 4, MAX_ELEVATION]) {
        scene.render({ ...HOME_ORBIT, azimuth, elevation }, null);
        const { scene: world, camera } = latestFrame();
        const sprites = world.children.filter(child => child instanceof THREE.Sprite);
        expect(sprites).toHaveLength(3);
        const centers = sprites.map(sprite => sprite.position.clone().project(camera));
        for (const [index, sprite] of sprites.entries()) {
          const center = centers[index];
          expect(scene.pick(center.x, center.y)).toBeNull();
          expect(sprite.material.depthTest).toBe(false);
          const halfSize = sprite.scale.x / (2 * VIEW_CUBE_CAMERA_DISTANCE * Math.tan(camera.fov * Math.PI / 360));
          for (const x of [-halfSize, halfSize]) {
            for (const y of [-halfSize, halfSize]) expect(scene.pick(center.x + x, center.y + y)).toBeNull();
          }
          // Account for the real 26px home button at (8px, 16px) in a 144px control.
          const left = (center.x - halfSize + 1) * 72, right = (center.x + halfSize + 1) * 72;
          const top = (1 - center.y - halfSize) * 72, bottom = (1 - center.y + halfSize) * 72;
          expect(right <= 8 || left >= 34 || bottom <= 16 || top >= 42).toBe(true);
          for (const other of centers.slice(index + 1)) expect(center.distanceTo(other)).toBeGreaterThan(0.2);
        }
      }
    }
    scene.dispose();
  });

  it.each(['dark', 'light', 'darkModern', 'lightModern', 'modern'])('keeps %s face gradients subdued with readable text', theme => {
    const colors = palette(theme);
    const scene = createViewCubeScene(document.createElement('canvas'), 216);
    scene.setThemeColors(colors);
    const luminance = (color: THREE.Color): number => 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
    const textLight = luminance(new THREE.Color(colors.viewCubeText));
    for (const stops of gradients.slice(-7, -1)) {
      for (const { color } of stops) {
        const faceLight = luminance(new THREE.Color(color));
        expect((textLight + 0.05) / (faceLight + 0.05)).toBeGreaterThanOrEqual(4.5);
        expect(faceLight).toBeLessThan(0.22);
      }
    }
    const read = themeRead(theme);
    for (const token of ['--pcad-viewport-top', '--pcad-viewport-bottom']) {
      const background = luminance(new THREE.Color(read(token)));
      for (const color of [colors.axisX, colors.axisY, colors.axisZ, colors.viewCubeEdge]) {
        const foreground = luminance(new THREE.Color(color));
        expect((Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05)).toBeGreaterThanOrEqual(3);
      }
    }
    scene.dispose();
  });

  it.each(['dark', 'light', 'darkModern', 'lightModern', 'modern'])('refreshes %s palette and disposes the superseded resources', theme => {
    const colors = palette(theme);
    const scene = createViewCubeScene(document.createElement('canvas'), 144);
    scene.render(HOME_ORBIT, null);
    const cube = latestFrame().scene.children[0];
    if (!(cube instanceof THREE.Mesh) || !(cube.material instanceof THREE.MeshBasicMaterial) || cube.material.map === null) throw new Error('Missing cube material');
    const disposed = vi.fn();
    cube.material.map.addEventListener('dispose', disposed);
    scene.setThemeColors(colors);
    expect(disposed).toHaveBeenCalledTimes(1);
    scene.render(HOME_ORBIT, { x: 1, y: -1, z: 1 });
    expect(renderer.render).toHaveBeenCalledTimes(2);
    const highlight = latestFrame().scene.children.find(child => child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial && child.material.transparent);
    if (!(highlight instanceof THREE.Mesh) || !(highlight.material instanceof THREE.MeshBasicMaterial)) throw new Error('Missing highlight');
    expect(highlight.material.color.getHex()).toBe(colors.selected);
    const sprites = latestFrame().scene.children.filter(child => child instanceof THREE.Sprite);
    expect(sprites).toHaveLength(3);
    for (const sprite of sprites) {
      expect(sprite.material.map?.generateMipmaps).toBe(false);
      expect(sprite.material.map?.minFilter).toBe(THREE.LinearFilter);
    }
    expect(colors.viewCubeText).not.toBe(colors.viewCubeFaceFront);
    const map = cube.material.map;
    expect(map).not.toBeNull();
    const finalDisposed = vi.fn();
    map?.addEventListener('dispose', finalDisposed);
    scene.dispose();
    expect(finalDisposed).toHaveBeenCalledTimes(1);
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
  });

  it('invalidates the same view when the font atlas or theme is refreshed', () => {
    const scene = createViewCubeScene(document.createElement('canvas'), 144);
    scene.render(HOME_ORBIT, null);
    scene.setThemeColors(DEFAULT_THEME_COLORS);
    scene.render(HOME_ORBIT, null);
    expect(renderer.render).toHaveBeenCalledTimes(2);
    scene.dispose();
  });
});
