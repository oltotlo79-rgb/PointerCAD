import { beforeAll, describe, expect, it } from 'vitest';
import type { CurveSpec, ExtrudeStepSpec, Vec3Tuple } from '../types.js';
import { createAllocations } from './allocations.js';
import { booleanOp } from './booleanOp.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makePlanarFace } from './makePlanarFace.js';
import { makeExtrudeSolid } from './makeSolidSweep.js';
import { boundingBoxOf, boundingBoxRange } from './placeBodies.js';
import { buildSolidBodyMesh, measureArea } from './solidMesh.js';
import { tessellate } from './tessellate.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); });
const corners: readonly Vec3Tuple[] = [[0, 0, 0], [60, 0, 0], [60, 40, 0], [0, 40, 0]];
const outer: readonly CurveSpec[] = corners.map((from, index) => ({ kind: 'segment', from, to: corners[(index + 1) % 4] }));
function circle(x = 30, radius = 5, z = 0, clockwise = false): readonly CurveSpec[] {
  return [{ kind: 'arc', center: [x, 20, z], normal: [0, 0, 1], xAxis: [1, 0, 0], radius,
    startAngle: clockwise ? 2 * Math.PI : 0, endAngle: clockwise ? 0 : 2 * Math.PI }];
}
function expectRelative(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(1, Math.abs(expected)) * 1e-9);
}

describe('穴を持つ平面', () => {
  it.each([false, true])('穴の向き%jでも面積は外周から穴を引いた値になる', clockwise => {
    const handle = makePlanarFace(oc, outer, {}, undefined, undefined, [circle(30, 5, 0, clockwise)]);
    try {
      expectRelative(measureArea(oc, handle.face), 2400 - 25 * Math.PI);
      expect(handle.boundaryEdgeCount).toBe(5);
      expect(handle.boundaryPositions.length).toBeGreaterThan(24);
      const mesh = tessellate(oc, handle.face);
      // 穴の中心を覆う三角形がない。面積とは独立に、表示用の分割も確かめる。
      for (let i = 0; i < mesh.indices.length; i += 3) {
        const points = [0, 1, 2].map(offset => {
          const index = mesh.indices[i + offset] * 3;
          return [mesh.positions[index] - 30, mesh.positions[index + 1] - 20];
        });
        const signs = points.map(([x, y], index) => x * points[(index + 1) % 3][1] - y * points[(index + 1) % 3][0]);
        expect(signs.every(value => value > 0) || signs.every(value => value < 0)).toBe(false);
      }
    } finally { handle.delete(); }
  });

  it.each([
    ['外周への接触', [circle(5)], /穴1.*接/],
    ['外周からのはみ出し', [circle(70)], /穴1.*外/],
    ['外周との交差', [circle(2)], /穴1/],
    ['穴どうしの重なり', [circle(25), circle(30)], /穴2/],
    ['穴の入れ子', [circle(30, 10), circle(30)], /穴2/],
    ['別の平面', [circle(30, 5, 1)], /穴1.*平面/],
    ['開いた穴', [[{ kind: 'segment', from: [10, 10, 0], to: [20, 10, 0] }]], /閉じ/],
  ] satisfies readonly (readonly [string, readonly (readonly CurveSpec[])[], RegExp])[])('%sを断る', (_, holes, message) => {
    expect(() => makePlanarFace(oc, outer, {}, undefined, undefined, holes).delete()).toThrow(message);
  });

  it('穴がない呼び出しの面積と境界は変わらない', () => {
    const { keep, release } = createAllocations();
    try {
      const legacy = keep(makePlanarFace(oc, outer));
      const empty = keep(makePlanarFace(oc, outer, {}, undefined, undefined, []));
      expectRelative(measureArea(oc, empty.face), 2400);
      expect(empty.boundaryPositions).toEqual(legacy.boundaryPositions);
      expect(empty.boundaryEdgeCount).toBe(legacy.boundaryEdgeCount);
    } finally { release(); }
  });

  it('離れた2つの穴を持つ面の面積は穴の和だけ減る', () => {
    const handle = makePlanarFace(oc, outer, {}, undefined, undefined, [circle(20, 5), circle(40, 3)]);
    try { expectRelative(measureArea(oc, handle.face), 2400 - 34 * Math.PI); }
    finally { handle.delete(); }
  });

  it('穴つきの押し出しを結合と切り抜きの材料にしても穴を保つ', () => {
    const { keep, release } = createAllocations();
    try {
      const spec: ExtrudeStepSpec = { kind: 'extrude', profile: outer, direction: [0, 0, 1], distance: 8 };
      const full = keep(makeExtrudeSolid(oc, spec));
      const bottom = keep(makeExtrudeSolid(oc, { ...spec, distance: 4 }));
      const holed = keep(makeExtrudeSolid(oc, { ...spec, holes: [circle()] }));
      const joined = keep(booleanOp(oc, 'union', bottom.shape, holed.shape));
      const cut = keep(booleanOp(oc, 'subtract', full.shape, holed.shape));
      expectRelative(joined.volume, 2400 * 8 - 25 * Math.PI * 4);
      expectRelative(cut.volume, 25 * Math.PI * 8);
    } finally { release(); }
  });

  it('1回の押し出しと貫く切り抜きで体積・面の数・各面積・境界箱が一致する', () => {
    const { keep, release } = createAllocations();
    try {
      const spec: ExtrudeStepSpec = { kind: 'extrude', profile: outer, direction: [0, 0, 1], distance: 8 };
      const target = keep(makeExtrudeSolid(oc, spec));
      const tool = keep(makeExtrudeSolid(oc, { ...spec, profile: circle() }, {}, { end: { kind: 'throughTarget' }, target: target.shape }));
      const cut = keep(booleanOp(oc, 'subtract', target.shape, tool.shape));
      const withHoles = { ...spec, holes: [circle()] };
      const direct = keep(makeExtrudeSolid(oc, withHoles));
      const first = buildSolidBodyMesh(oc, 'direct', direct.shape), second = buildSolidBodyMesh(oc, 'cut', cut.shape);
      expectRelative(first.volume, (2400 - 25 * Math.PI) * 8);
      expectRelative(first.volume, second.volume);
      expect(first.faceCount).toBe(second.faceCount);
      const firstAreas = first.faces.map(face => face.area).sort((a, b) => a - b);
      const secondAreas = second.faces.map(face => face.area).sort((a, b) => a - b);
      firstAreas.forEach((area, index) => expectRelative(area, secondAreas[index]));
      const firstBounds = boundingBoxRange(keep(boundingBoxOf(oc, direct.shape)).box);
      const secondBounds = boundingBoxRange(keep(boundingBoxOf(oc, cut.shape)).box);
      firstBounds.min.forEach((value, index) => expectRelative(value, secondBounds.min[index]));
      firstBounds.max.forEach((value, index) => expectRelative(value, secondBounds.max[index]));
    } finally { release(); }
  });
});
