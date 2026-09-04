import {
  crossVec3,
  distanceVec3,
  dotVec3,
  FREE_WORK_PLANE_ID,
  lengthVec3,
  planeToWorld,
  subVec3,
  type Vec3,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  coordinateModesFor,
  freeClickPlane,
  freeSketchToolRejection,
  picksSolidVertices,
} from './freeSketch.js';
import { SHAPE_TOOL_STEPS, type NumericInputToolId } from './numericInput.js';

/** ベクトルどうしの差の許容量。単位ベクトルの向きしか比べないので十分に小さくてよい。 */
const DIRECTION_TOLERANCE = 1e-12;

describe('3D スケッチで使える道具(FR-330、タスク14)', () => {
  it('作図面があるときは、どの道具も断らない', () => {
    const tools: readonly NumericInputToolId[] = [
      'point',
      'line',
      'arc',
      'pointArray',
      'face',
      'rectangle',
      'ellipse',
      'extrude',
    ];
    for (const tool of tools) {
      expect(freeSketchToolRejection('xy', tool), tool).toBeNull();
      expect(freeSketchToolRejection('referencePlane-1', tool), tool).toBeNull();
    }
  });

  it('3D スケッチで作れるのは点・線分・円弧・スプライン・面の 5 つ', () => {
    for (const tool of ['point', 'line', 'arc', 'spline', 'face', 'select'] as const) {
      expect(freeSketchToolRejection(FREE_WORK_PLANE_ID, tool), tool).toBeNull();
    }
  });

  it('作図面が要る図形の道具は理由を返す(NFR-UX-5)', () => {
    for (const tool of [
      'pointArray',
      'circle',
      'twoPointArc',
      'rectangle',
      'polygon',
      'slot',
      'ellipse',
    ] as const) {
      const reason = freeSketchToolRejection(FREE_WORK_PLANE_ID, tool);
      expect(reason, tool).not.toBeNull();
      expect(reason, tool).toContain('作図面を選んでから');
    }
  });

  it('新しい図形の道具は、断るか使えるかのどちらかに必ず割り振られている', () => {
    // 道具が増えたときに、ここで判断が抜けていることに気づけるようにする
    // (`SHAPE_TOOL_STEPS` が図形の道具の一覧の正本)。
    for (const tool of Object.keys(SHAPE_TOOL_STEPS)) {
      const reason = freeSketchToolRejection(FREE_WORK_PLANE_ID, tool as NumericInputToolId);
      // spline だけが 3D スケッチで使える図形の道具。
      expect(reason === null, tool).toBe(tool === 'spline');
    }
  });

  it('立体の頂点を押して点にできるのは、位置を 1 点ずつ押す 4 道具だけ', () => {
    for (const tool of ['point', 'line', 'arc', 'spline'] as const) {
      expect(picksSolidVertices(FREE_WORK_PLANE_ID, tool), tool).toBe(true);
    }
    for (const tool of ['select', 'face', 'rectangle', 'extrude'] as const) {
      expect(picksSolidVertices(FREE_WORK_PLANE_ID, tool), tool).toBe(false);
    }
    // 作図面があるときは、かき込む道具でも頂点は拾わない(押した場所が座標そのもの)。
    expect(picksSolidVertices('xy', 'point')).toBe(false);
  });
});

describe('座標の指定方法(§0.a-0.5)', () => {
  it('作図面があるときは 3 つとも選べる', () => {
    expect(coordinateModesFor('xy')).toEqual(['absolute', 'relative', 'polar']);
  });

  it('3D スケッチでは極座標を隠す(作図面の中の角度に基準が無いため)', () => {
    expect(coordinateModesFor(FREE_WORK_PLANE_ID)).toEqual(['absolute', 'relative']);
  });
});

describe('3D スケッチで押した場所に点を置く面(タスク14)', () => {
  /** 等角(斜め上)から見たときの視線。ホーム視点と同じ向き。 */
  const diagonal: Vec3 = [-0.5, -0.5, -Math.SQRT1_2];
  const base: Vec3 = [10, 20, 30];

  it('面は基準の点を通る', () => {
    const plane = freeClickPlane(base, diagonal);
    expect(plane.origin).toEqual(base);
    expect(plane.id).toBe(FREE_WORK_PLANE_ID);
  });

  it('法線はカメラを向く(視線の逆向きの単位ベクトル)', () => {
    const plane = freeClickPlane(base, diagonal);
    const expected = subVec3([0, 0, 0], diagonal);
    const unit: Vec3 = [
      expected[0] / lengthVec3(expected),
      expected[1] / lengthVec3(expected),
      expected[2] / lengthVec3(expected),
    ];
    expect(distanceVec3(plane.normal, unit)).toBeLessThan(DIRECTION_TOLERANCE);
    expect(lengthVec3(plane.normal)).toBeCloseTo(1, 12);
  });

  it('2 軸は法線と直交し、右手系になっている', () => {
    const plane = freeClickPlane(base, diagonal);
    expect(dotVec3(plane.axisU, plane.normal)).toBeCloseTo(0, 12);
    expect(dotVec3(plane.axisV, plane.normal)).toBeCloseTo(0, 12);
    expect(dotVec3(plane.axisU, plane.axisV)).toBeCloseTo(0, 12);
    expect(distanceVec3(crossVec3(plane.axisU, plane.axisV), plane.normal)).toBeLessThan(
      DIRECTION_TOLERANCE,
    );
  });

  it('面の上の点は、どこでも視線と垂直な向きに base から離れる', () => {
    const plane = freeClickPlane(base, diagonal);
    const onPlane = planeToWorld(plane, 5, -7);
    // 面の上の点と base を結ぶ向きは、視線と直交する(= 面が視線に正対している)。
    expect(dotVec3(subVec3(onPlane, base), diagonal)).toBeCloseTo(0, 12);
  });

  it('真上から見ているときは床と同じ向きの面になる(法線 +Z)', () => {
    const plane = freeClickPlane([0, 0, 0], [0, 0, -1]);
    expect(distanceVec3(plane.normal, [0, 0, 1])).toBeLessThan(DIRECTION_TOLERANCE);
  });

  it('視線が求まらないときは床と同じ向きの面へ落とす(0 除算を作らない)', () => {
    const plane = freeClickPlane(base, [0, 0, 0]);
    expect(plane.normal).toEqual([0, 0, 1]);
    expect(plane.origin).toEqual(base);
    expect(plane.id).toBe(FREE_WORK_PLANE_ID);
  });
});
