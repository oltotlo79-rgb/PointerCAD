import { describe, expect, it } from 'vitest';

import {
  baseWorkPlane, computedNormal, DEFAULT_WORK_PLANE_ID, degreesToRadians, directionInPlane,
  distanceToPlane, isBaseWorkPlaneId, planeAxesFor, planeToWorld, polarOffset, projectOntoPlane,
  radiansToDegrees, tiltedDirection, WORK_PLANE_IDS, WORK_PLANES, WORLD_AXIS_DIRECTIONS,
  worldToPlane,
} from './planeMath.js';
import { crossVec3, type Vec3 } from './vec3.js';

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

describe('任意の作業平面への拡張(FR-328、タスク9)', () => {
  it('基準の 3 面だけが基準扱いで、任意平面の id は基準ではない', () => {
    for (const id of WORK_PLANE_IDS) {
      expect(isBaseWorkPlaneId(id), id).toBe(true);
      expect(baseWorkPlane(id), id).toBe(WORK_PLANES[id]);
    }
    expect(isBaseWorkPlaneId('referencePlane-1')).toBe(false);
    expect(baseWorkPlane('referencePlane-1')).toBeNull();
    // 3D スケッチ(FR-330、タスク10)の予約語も基準の 3 面ではない。
    expect(baseWorkPlane('free')).toBeNull();
  });

  it('法線から作る第1軸・第2軸は右手系(U × V = N)で、同じ法線からは常に同じ組', () => {
    const normals: readonly Vec3[] = [
      [0, 0, 1],
      [0, 1, 0],
      [1, 0, 0],
      [1, 1, 1],
    ];
    for (const normal of normals) {
      const axes = planeAxesFor(normal);
      const again = planeAxesFor(normal);
      expect(axes.axisU, String(normal)).toEqual(again.axisU);
      const computed = crossVec3(axes.axisU, axes.axisV);
      const length = Math.hypot(normal[0], normal[1], normal[2]);
      expect(computed[0]).toBeCloseTo(normal[0] / length, 12);
      expect(computed[1]).toBeCloseTo(normal[1] / length, 12);
      expect(computed[2]).toBeCloseTo(normal[2] / length, 12);
    }
  });

  it('第1軸の手掛かりを渡すと、その向き(法線に垂直な成分)が第1軸になる', () => {
    const axes = planeAxesFor([0, 0, 1], [1, 0, 0]);
    expect(axes.axisU[0]).toBeCloseTo(1, 12);
    expect(axes.axisV[1]).toBeCloseTo(1, 12);
    // 手掛かりが法線と平行なら使えないので、補助ベクトルの方式へ戻る。
    const fallback = planeAxesFor([0, 0, 1], [0, 0, 5]);
    expect(fallback.axisU).toEqual(planeAxesFor([0, 0, 1]).axisU);
  });

  it('傾き 0 は軸そのまま、傾き 30 度は方位角 0 の第1軸へ sin30 だけ倒れる', () => {
    // Z 軸に対する方位角 0 の第1軸は planeAxesFor のとおり (0,-1,0)(穴・ばねと同じ規約)。
    expect(tiltedDirection([0, 0, 1], 0, 0)).toEqual([0, 0, 1]);
    const tilted = tiltedDirection([0, 0, 1], degreesToRadians(30), 0);
    expect(tilted[0]).toBeCloseTo(0, 12);
    expect(tilted[1]).toBeCloseTo(-0.5, 12);
    expect(tilted[2]).toBeCloseTo(0.8660254037844387, 12);
  });

  it('ワールドの軸の向きは X / Y / Z の単位ベクトル', () => {
    expect(WORLD_AXIS_DIRECTIONS.x).toEqual([1, 0, 0]);
    expect(WORLD_AXIS_DIRECTIONS.y).toEqual([0, 1, 0]);
    expect(WORLD_AXIS_DIRECTIONS.z).toEqual([0, 0, 1]);
  });
});
