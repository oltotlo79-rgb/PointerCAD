import { describe, expect, it } from 'vitest';
import { createDefaultNamedViews, type CameraSnapshot } from '@pointercad/model';
import { HOME_ORBIT, pan, cameraPosition } from './cameraMath.js';
import { namedCameraFromOrbit, orbitFromNamedCamera } from './namedCamera.js';

describe('保存視点と実カメラの変換(FR-113)', () => {
  it.each(createDefaultNamedViews())('$nameの位置・注視点・上向き・投影・倍率を保つ', (camera) => {
    const orbit = orbitFromNamedCamera(camera);
    expect(orbit).not.toBeNull();
    if (orbit === null) throw new Error('Expected camera');
    const restored = namedCameraFromOrbit(orbit, camera.projection);
    restored.position.forEach((value, index) => expect(value).toBeCloseTo(camera.position[index], 10));
    expect(restored).toMatchObject({ target: camera.target, up: camera.up, zoom: camera.zoom, projection: camera.projection });
  });
  it('既存のホームカメラはZ上・倍率1として保存する', () => {
    expect(namedCameraFromOrbit(HOME_ORBIT, 'perspective')).toEqual({
      position: cameraPosition(HOME_ORBIT), target: [0, 0, 0], up: [0, 0, 1], projection: 'perspective', zoom: 1,
    });
  });
  it('真上を選んでも微小角へのクランプで向きを変えない', () => {
    const camera = createDefaultNamedViews()[1];
    expect(orbitFromNamedCamera(camera)?.elevation).toBe(Math.PI / 2);
  });
  it('斜めの上向き・平行投影・3倍のカメラも戻る', () => {
    const camera: CameraSnapshot = { position: [10, 20, 30], target: [5, 6, 7], up: [1, 1, 0], projection: 'orthographic', zoom: 3 };
    const orbit = orbitFromNamedCamera(camera);
    if (orbit === null) throw new Error('Expected camera');
    expect(namedCameraFromOrbit(orbit, camera.projection)).toMatchObject({ up: [1, 1, 0], zoom: 3 });
    cameraPosition(orbit).forEach((value, i) => expect(value).toBeCloseTo(camera.position[i], 12));
  });
  it('平面図のドラッグは画面上方向=Yとして移動する', () => {
    const orbit = orbitFromNamedCamera(createDefaultNamedViews()[1]);
    if (orbit === null) throw new Error('Expected camera');
    const moved = pan(orbit, 0, 10, 500);
    expect(moved.target[1]).toBeGreaterThan(0);
    expect(moved.target[0]).toBeCloseTo(0, 12);
    expect(moved.target[2]).toBeCloseTo(0, 12);
  });
  it('ズーム3倍のパン移動量は画面と同じく3分の1になる', () => {
    const first = pan(HOME_ORBIT, 30, 20, 500);
    const second = pan({ ...HOME_ORBIT, zoom: 3 }, 30, 20, 500);
    first.target.forEach((value, i) => expect(second.target[i]).toBeCloseTo(value / 3, 12));
  });
  it.each([0, -1, NaN, Infinity])('不正な倍率%sをカメラへ渡さない', (zoom) => {
    expect(orbitFromNamedCamera({ ...createDefaultNamedViews()[0], zoom })).toBeNull();
  });
});
