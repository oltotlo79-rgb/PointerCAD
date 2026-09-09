import { describe, expect, it } from 'vitest';
import { cameraPosition, HOME_ORBIT, pan, viewDirection, zoom } from './cameraMath.js';
import { createQuadCameraState, resetQuadCamera, updateQuadCamera } from './quadCamera.js';

describe('4分割カメラの独立性と正投影(FR-113)', () => {
  it.each([
    { id: 'top' as const, direction: [0, 0, -1] },
    { id: 'front' as const, direction: [0, 1, 0] },
    { id: 'right' as const, direction: [-1, 0, 0] },
  ])('$idは既定の面を正面から見る', ({ id, direction }) => {
    const state = createQuadCameraState({ ...HOME_ORBIT, target: [10, 20, 30], distance: 50 });
    viewDirection(state.orbits[id]).forEach((value, index) => expect(value).toBeCloseTo(direction[index], 12));
    expect(Math.hypot(...cameraPosition(state.orbits[id]).map((value, index) => value - [10, 20, 30][index]))).toBeCloseTo(50, 12);
  });
  it('等角は前・右・上を見せ、単一画面の注視点と拡大率を引き継ぐ', () => {
    const focus = { ...HOME_ORBIT, azimuth: 0, elevation: 0, target: [10, 20, 30] as const, distance: 100, zoom: 2 };
    const state = createQuadCameraState(focus);
    expect(state.active).toBe('isometric');
    const direction = viewDirection(state.orbits.isometric);
    expect(direction[0]).toBeLessThan(0); expect(direction[1]).toBeGreaterThan(0); expect(direction[2]).toBeLessThan(0);
    expect(state.orbits.isometric.target).toEqual(focus.target); expect(state.orbits.isometric.zoom).toBe(2);
    expect(focus.azimuth).toBe(0);
  });
  it('平面の右ドラッグはX、上ドラッグはYに平行移動する', () => {
    const top = createQuadCameraState(HOME_ORBIT).orbits.top;
    const movedX = pan(top, 30, 0, 450), movedY = pan(top, 0, -30, 450);
    expect(movedX.target[0]).toBeLessThan(0); expect(movedX.target[1]).toBeCloseTo(0, 12);
    expect(movedY.target[1]).toBeLessThan(0); expect(movedY.target[2]).toBeCloseTo(0, 12);
  });
  it.each(['top', 'front', 'right'] as const)('%sを動かしても他の3区画と元のカメラを変更しない', (id) => {
    const state = createQuadCameraState(HOME_ORBIT);
    const updated = updateQuadCamera(state, id, zoom(pan(state.orbits[id], 20, 30, 450), 100));
    expect(updated.orbits[id].distance).not.toBe(state.orbits[id].distance);
    expect(updated.orbits[id].target).not.toEqual(state.orbits[id].target);
    expect(updated.orbits.isometric).toBe(state.orbits.isometric);
    expect(state.orbits[id].target).toEqual([0, 0, 0]);
    expect(viewDirection(updated.orbits[id])).toEqual(viewDirection(state.orbits[id]));
  });
  it('正投影へ斜めの方向を渡しても面の向きは変えない', () => {
    const state = createQuadCameraState(HOME_ORBIT), next = updateQuadCamera(state, 'front', HOME_ORBIT);
    expect(viewDirection(next.orbits.front)[1]).toBeCloseTo(1, 12);
  });
  it('ホームは選んだ区画だけを戻す', () => {
    const state = createQuadCameraState(HOME_ORBIT);
    const changed = updateQuadCamera({ ...state, active: 'top' }, 'top', { ...state.orbits.top, distance: 400, target: [10, 20, 0] });
    const reset = resetQuadCamera(changed);
    expect(reset.orbits.top).toEqual(state.orbits.top);
    expect(reset.orbits.isometric).toBe(changed.orbits.isometric);
    expect(reset.active).toBe('top');
  });
  it.each([NaN, Infinity, 0, -1])('無効な距離%sでカメラを壊さない', (distance) => {
    const state = createQuadCameraState(HOME_ORBIT);
    expect(updateQuadCamera(state, 'top', { ...state.orbits.top, distance })).toBe(state);
  });
});
