import { dotVec3, crossVec3, type Vec3 } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import * as drag from './dragComponent.js';

describe('P7-18 B01/B08: camera面と掴んだ差', () => {
  it.each<Vec3>([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, -2, 3]])(
    '法線%sの開始面を右手系の有限直交基底にする', (x, y, z) => {
      const origin: Vec3 = [10, 20, 30], normal: Vec3 = [x, y, z];
      const before = structuredClone({ origin, normal });
      const plane = drag.componentDragPlane(origin, normal);
      expect(plane).not.toBeNull();
      if (plane === null) throw new Error('valid plane required');
      expect(plane.origin).toEqual(origin);
      expect(Math.abs(Math.hypot(...plane.axisU) - 1)).toBeLessThan(1e-14);
      expect(Math.abs(Math.hypot(...plane.axisV) - 1)).toBeLessThan(1e-14);
      expect(Math.abs(dotVec3(plane.axisU, plane.axisV))).toBeLessThan(1e-14);
      const rightHand = crossVec3(plane.axisU, plane.axisV);
      expect(Math.hypot(...rightHand.map((n, i) => n - plane.normal[i]))).toBeLessThan(1e-14);
      expect({ origin, normal }).toEqual(before);
    });
  it.each([NaN, Infinity, -Infinity])('非有限%sを含む原点/法線を拒否する', (bad) => {
    expect(drag.componentDragPlane([bad, 0, 0], [0, 0, 1])).toBeNull();
    expect(drag.componentDragPlane([0, 0, 0], [0, bad, 1])).toBeNull();
  });
  it('零法線と疎配列を恒等面へ置換しない', () => {
    const hole: Vec3 = [0, 0, 1];
    Reflect.deleteProperty(hole, 0);
    expect(drag.componentDragPlane([0, 0, 0], [0, 0, 0])).toBeNull();
    expect(drag.componentDragPlane(hole, [0, 0, 1])).toBeNull();
  });
  it.each<Vec3>([[15, 24, 30], [12, 14, 40], [-9, -12, -13]])('原点と掴み位置の差を保って%sへ追従する', (x, y, z) => {
    const origin: Vec3 = [10, 20, 30], grab: Vec3 = [12, 23, 30], pointer: Vec3 = [x, y, z];
    expect(drag.componentDragTarget(origin, grab, pointer)).toEqual([10 + x - 12, 20 + y - 23, z]);
    expect(drag.componentDragTarget(origin, grab, grab)).toEqual(origin);
  });
  it('1e8の位置でも差を先に引き、微小移動を途中で消さない', () => {
    expect(drag.componentDragTarget([0, 0, 0], [1e8, 0, 0], [1e8 + 1e-5, 0, 0]))
      .toEqual([1e8 + 1e-5 - 1e8, 0, 0]);
  });
  it.each([NaN, Infinity, -Infinity])('pointerの%sを最大値や0へ直さず拒否する', (bad) => {
    expect(drag.componentDragTarget([0, 0, 0], [0, 0, 0], [bad, 0, 0])).toBeNull();
  });
  it('有限値同士の差のoverflowも拒否する', () => {
    expect(drag.componentDragTarget([0, 0, 0], [-1e308, 0, 0], [1e308, 0, 0])).toBeNull();
  });
});
