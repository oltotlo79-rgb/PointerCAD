import { describe, expect, it } from 'vitest';

import {
  computedNormal, DEFAULT_WORK_PLANE_ID, degreesToRadians, directionInPlane,
  distanceToPlane, planeToWorld, polarOffset, projectOntoPlane, radiansToDegrees,
  WORK_PLANE_IDS, WORK_PLANES, worldToPlane,
} from './planeMath.js';

describe('作図面(要件§4.3、§0.3)', () => {
  it('既定は XY 平面で、3 面すべてが右手系(U × V = N)', () => {
    expect(DEFAULT_WORK_PLANE_ID).toBe('xy');
    for (const id of WORK_PLANE_IDS) {
      expect(computedNormal(WORK_PLANES[id]), id).toEqual(WORK_PLANES[id].normal);
    }
  });

  it('平面座標とワールド座標を往復できる', () => {
    expect(planeToWorld(WORK_PLANES.xy, 3, 4)).toEqual([3, 4, 0]);
    expect(planeToWorld(WORK_PLANES.xz, 3, 4)).toEqual([3, 0, 4]);
    expect(planeToWorld(WORK_PLANES.yz, 3, 4)).toEqual([0, 3, 4]);
    expect(worldToPlane(WORK_PLANES.xz, [3, 7, 5])).toEqual([3, 5]);
  });

  it('平面へ落とすと法線方向の成分が消える', () => {
    // XZ 平面の法線は (0,-1,0)。(3,7,5) の法線成分は -7 なので、引くと Y が 0 になる。
    expect(projectOntoPlane(WORK_PLANES.xz, [3, 7, 5])).toEqual([3, 0, 5]);
    expect(distanceToPlane(WORK_PLANES.xz, [3, 7, 5])).toBe(7);
    expect(distanceToPlane(WORK_PLANES.xy, [3, 7, 0])).toBe(0);
  });

  it('度とラジアンの換算', () => {
    expect(degreesToRadians(180)).toBe(Math.PI);
    expect(radiansToDegrees(Math.PI / 2)).toBe(90);
  });

  it('極座標のずれ(FR-303)', () => {
    // 角度 0・仰角 0 は第1軸そのもの。
    expect(polarOffset(WORK_PLANES.xy, 10, 0, 0)[0]).toBeCloseTo(10, 12);
    // 角度 90 度は第2軸。cos(π/2) は厳密な 0 にならないので許容誤差で見る。
    const quarter = polarOffset(WORK_PLANES.xy, 10, 90, 0);
    expect(quarter[0]).toBeCloseTo(0, 12);
    expect(quarter[1]).toBeCloseTo(10, 12);
    // 角度 45 度: 10・cos45° = 10 / √2 = 7.0710678118654755
    const diagonal = polarOffset(WORK_PLANES.xy, 10, 45, 0);
    expect(diagonal[0]).toBeCloseTo(7.0710678118654755, 9);
    expect(diagonal[1]).toBeCloseTo(7.0710678118654755, 9);
    // 仰角 30 度: 水平成分 10・cos30° = 8.660254037844387、法線成分 10・sin30° = 5
    const lifted = polarOffset(WORK_PLANES.xy, 10, 0, 30);
    expect(lifted[0]).toBeCloseTo(8.660254037844387, 9);
    expect(lifted[2]).toBeCloseTo(5, 12);
    // YZ 平面では第2軸が +Z なので、角度 90 度は Z 方向へ伸びる。
    expect(polarOffset(WORK_PLANES.yz, 10, 90, 0)[2]).toBeCloseTo(10, 12);
  });

  it('平面内の向き(円弧の端点を求めるのに使う)', () => {
    expect(directionInPlane(WORK_PLANES.xy, 0)[0]).toBeCloseTo(1, 12);
    expect(directionInPlane(WORK_PLANES.xy, 90)[1]).toBeCloseTo(1, 12);
    expect(directionInPlane(WORK_PLANES.xz, 90)[2]).toBeCloseTo(1, 12);
  });
});
