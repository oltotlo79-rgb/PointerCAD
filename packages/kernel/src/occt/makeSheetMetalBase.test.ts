import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CurveSpec, Vec3Tuple } from '../types.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeSheetMetalBase } from './makeSheetMetalBase.js';
import { measureMassProperties } from './measureShape.js';
import { boundingBoxOf, boundingBoxRange } from './placeBodies.js';
import { isValidShape, measureVolume } from './solidMesh.js';

let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await loadOcctForNode(); });
function rectangle(x: number, y: number, width: number, height: number, z = 0): readonly CurveSpec[] {
  const points: readonly Vec3Tuple[] = [[x, y, z], [x + width, y, z], [x + width, y + height, z], [x, y + height, z]];
  return points.map((from, index) => ({ kind: 'segment', from, to: points[(index + 1) % points.length] }));
}
const circle = (x: number, y: number, radius: number): readonly CurveSpec[] => [
  { kind: 'arc', center: [x, y, 0], normal: [0, 0, 1], xAxis: [1, 0, 0], radius, startAngle: 0, endAngle: 2 * Math.PI },
];
const outer = rectangle(0, 0, 50, 30);

describe('穴付き板金基板の実OCCT形状（P10-4）', () => {
  it.each([false, true])('反転%sで円穴・矩形穴を保持し、厚みと面積からの体積に一致する', (reversed) => {
    const handle = makeSheetMetalBase(oc, { outer, holes: [circle(10, 10, 2), rectangle(25, 10, 5, 6)], thickness: 2, reversed });
    try {
      expect(isValidShape(oc, handle.shape)).toBe(true);
      expect(measureVolume(oc, handle.shape)).toBeCloseTo(2 * (1500 - 4 * Math.PI - 30), 7);
      const bounds = boundingBoxOf(oc, handle.shape);
      try {
        const range = boundingBoxRange(bounds.box);
        expect(range.min[2]).toBeCloseTo(reversed ? -2 : 0, 6);
        expect(range.max[2]).toBeCloseTo(reversed ? 0 : 2, 6);
      } finally { bounds.delete(); }
    } finally { handle.delete(); }
    expect(() => handle.delete()).not.toThrow();
  });
  it('穴なし、凹形外周、任意の作業平面でも同じ厚みを作る', () => {
    const points: readonly Vec3Tuple[] = [[0, 0, 0], [0, 20, 0], [0, 20, 10], [0, 10, 10], [0, 10, 20], [0, 0, 20]];
    const profile: readonly CurveSpec[] = points.map((from, index) => ({ kind: 'segment', from, to: points[(index + 1) % points.length] }));
    const handle = makeSheetMetalBase(oc, { outer: profile, holes: [], thickness: 2, reversed: false });
    try {
      expect(measureVolume(oc, handle.shape)).toBeCloseTo(600, 8);
      const box = boundingBoxOf(oc, handle.shape);
      try { const range = boundingBoxRange(box.box); expect(range.max[0] - range.min[0]).toBeCloseTo(2, 6); }
      finally { box.delete(); }
    } finally { handle.delete(); }
  });
  it('周期3次スプラインの穴を、節点ごとの手積分と同じ体積で測る', () => {
    // 一辺10の正方形4極の周期3次曲線。各節点区間をGreenの公式で
    // 積分すると面積は(61/90)*10²。板厚2なら除去体積は1220/9。
    const spline: CurveSpec = { kind: 'spline', mode: 'control', closed: true,
      points: [[5, 5, 0], [15, 5, 0], [15, 15, 0], [5, 15, 0]] };
    const tool = makeSheetMetalBase(oc, { outer: [spline], holes: [], thickness: 2, reversed: false });
    const board = makeSheetMetalBase(oc, { outer, holes: [[spline]], thickness: 2, reversed: false });
    try {
      expect(measureVolume(oc, tool.shape)).toBeCloseTo(1220 / 9, 7);
      expect(measureVolume(oc, board.shape)).toBeCloseTo(3000 - 1220 / 9, 7);
      const measured = measureMassProperties(oc, tool.shape);
      expect(measured.volume).toBeCloseTo(1220 / 9, 7);
      for (const [i, value] of [10, 10, 1].entries()) expect(measured.centreOfMass[i]).toBeCloseTo(value, 7);
    } finally { board.delete(); tool.delete(); }
  });
  it('外周をまたぐ穴、接する穴、重なる穴、別平面と板厚不正を断り、後から再生成できる', () => {
    const invalidHoles = [
      [circle(-10, 10, 2)], [circle(1, 10, 2)], [circle(2, 10, 2)],
      [circle(10, 10, 3), circle(12, 10, 3)], [circle(10, 10, 3), circle(16, 10, 3)],
      [circle(10, 10, 5), circle(10, 10, 2)], [rectangle(5, 5, 4, 4, 1)],
    ];
    for (const holes of invalidHoles) expect(() => makeSheetMetalBase(oc, { outer, holes, thickness: 2, reversed: false })).toThrow();
    for (const thickness of [0, -1, NaN, Infinity]) expect(() => makeSheetMetalBase(oc, { outer, holes: [], thickness, reversed: false })).toThrow();
    const valid = makeSheetMetalBase(oc, { outer, holes: [circle(10, 10, 2)], thickness: 2, reversed: false });
    try { expect(measureVolume(oc, valid.shape)).toBeCloseTo(3000 - 8 * Math.PI, 7); } finally { valid.delete(); }
  });
});
