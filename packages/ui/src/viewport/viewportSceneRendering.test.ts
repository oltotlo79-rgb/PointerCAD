import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { cameraPosition, HOME_ORBIT, orthographicFrustumHeight, type OrbitState } from './cameraMath.js';
import {
  configureViewportCamera, createViewportCameras, KEY_LIGHT_INTENSITY, logicalQuadPanes, placeKeyLight,
} from './viewportSceneRendering.js';

describe('Scene のカメラ 2 台と主光源', () => {
  it('カメラは Z 上で作り、平行投影は視点の後ろも写す', () => {
    const cameras = createViewportCameras();
    expect(cameras.perspective.up.toArray()).toEqual([0, 0, 1]);
    expect(cameras.orthographic.up.toArray()).toEqual([0, 0, 1]);
    expect([cameras.perspective.near, cameras.perspective.far]).toEqual([0.05, 200_000]);
    expect([cameras.orthographic.near, cameras.orthographic.far]).toEqual([-200_000, 200_000]);
    expect(KEY_LIGHT_INTENSITY).toBe(0.8);
  });

  it('主光源は視点の右上前方に置き、仰角は上限で止める', () => {
    const light = new THREE.DirectionalLight();
    // 仰角 1.5 + 主光源の仰角のずれ 0.5 = 2.0 は上限 1.2 を超えるので 1.2 で止まる。方位は 0 + 0.55。
    placeKeyLight(light, { ...HOME_ORBIT, azimuth: 0, elevation: 1.5 });
    const elevation = 1.2, azimuth = 0.55;
    expect(light.position.x).toBeCloseTo(Math.cos(elevation) * Math.cos(azimuth), 12);
    expect(light.position.y).toBeCloseTo(Math.cos(elevation) * Math.sin(azimuth), 12);
    expect(light.position.z).toBeCloseTo(Math.sin(elevation), 12);
    // 仰角 -2.0 + 0.5 = -1.5 は下限 -1.2 を下回るので -1.2 で止まる。
    placeKeyLight(light, { ...HOME_ORBIT, azimuth: 0, elevation: -2.0 });
    expect(light.position.z).toBeCloseTo(Math.sin(-1.2), 12);
    light.dispose();
  });

  it('投影の切替では同じ 2 台を使い回し、平行投影は透視と見た目の大きさを揃える', () => {
    const cameras = createViewportCameras();
    const rectangle = { x: 0, y: 0, width: 300, height: 100 };
    const orbit: OrbitState = { ...HOME_ORBIT, zoom: 2, up: [0, 1, 0] };
    const perspective = configureViewportCamera(cameras, orbit, 'perspective', rectangle);
    expect(perspective).toBe(cameras.perspective);
    expect(cameras.perspective.aspect).toBe(3);
    expect(perspective.zoom).toBe(2);
    expect(perspective.up.toArray()).toEqual([0, 1, 0]);
    expect(perspective.position.toArray()).toEqual([...cameraPosition(orbit)]);

    const orthographic = configureViewportCamera(cameras, HOME_ORBIT, 'orthographic', rectangle);
    expect(orthographic).toBe(cameras.orthographic);
    const height = orthographicFrustumHeight(HOME_ORBIT.distance);
    expect([cameras.orthographic.top, cameras.orthographic.bottom]).toEqual([height / 2, -height / 2]);
    expect([cameras.orthographic.left, cameras.orthographic.right]).toEqual([(-height * 3) / 2, (height * 3) / 2]);
    // up を持たない視点は Z 上へ戻る。
    expect(orthographic.up.toArray()).toEqual([0, 0, 1]);
    expect(orthographic.zoom).toBe(1);
  });
});

describe('4 区画の論理座標', () => {
  it('描画バッファの画素を画素比で割り、大きさ 0 の区画は描かない', () => {
    const panes = logicalQuadPanes(2, 1440, 900, 'perspective');
    expect(panes.map(pane => pane.id)).toEqual(['top', 'isometric', 'front', 'right']);
    expect(panes[1]?.rectangle).toEqual({ x: 360, y: 0, width: 360, height: 225 });
    expect(panes[2]?.scissor).toEqual({ x: 0, y: 0, width: 360, height: 225 });
    const narrow = logicalQuadPanes(1, 1, 1, 'perspective');
    expect(narrow.length).toBeLessThan(4);
    expect(narrow.every(pane => pane.rectangle.width > 0 && pane.rectangle.height > 0)).toBe(true);
  });
});
