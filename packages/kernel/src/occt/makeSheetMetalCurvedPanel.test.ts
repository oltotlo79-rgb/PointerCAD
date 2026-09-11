import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CurveSpec, Vec3Tuple } from '../types.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeSheetMetalCurvedPanel } from './makeSheetMetalCurvedPanel.js';
import { isValidShape, measureVolume } from './solidMesh.js';

let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await loadOcctForNode(); });
const frame = { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1] } as const;
const length = 3.8 * Math.PI / 2;
function loop(points: readonly Vec3Tuple[]): readonly CurveSpec[] {
  return points.map((from, i) => ({ kind: 'segment', from, to: points[(i + 1) % points.length] }));
}
const outer = loop([[0, 0, 0], [20, 0, 0], [20, length, 0], [0, length, 0]]);
describe('穴や斜辺を保持した円筒曲げの実形状', () => {
  it.each([90, -90])('角度%sで円筒帯・穴・切欠き・斜辺を正しい体積で生成する', (angle) => {
    const circle: CurveSpec = { kind: 'arc', center: [10, length / 2, 0], normal: [0, 0, 1], xAxis: [1, 0, 0], radius: 1, startAngle: 0, endAngle: -2 * Math.PI };
    const ellipse: CurveSpec = { kind: 'ellipse', center: [10, length / 2, 0], normal: [0, 0, 1], majorAxis: [1, 0, 0],
      majorRadius: 2, minorRadius: 1, startAngle: 0, endAngle: -2 * Math.PI };
    const spline: CurveSpec = { kind: 'spline', mode: 'control', closed: true, points: [[8, 4, 0], [12, 4, 0], [12, 2, 0], [8, 2, 0]] };
    const notch: readonly CurveSpec[] = [
      { kind: 'segment', from: [0, 0, 0], to: [9, 0, 0] },
      { ...circle, center: [10, 0, 0], startAngle: Math.PI, endAngle: 0 },
      { kind: 'segment', from: [11, 0, 0], to: [20, 0, 0] },
      ...outer.slice(1),
    ];
    const cases = [
      { outer, holes: [], area: 20 * length },
      { outer, holes: [[circle]], area: 20 * length - Math.PI },
      { outer, holes: [[ellipse]], area: 20 * length - 2 * Math.PI },
      { outer, holes: [[spline]], area: 20 * length - 8 * 61 / 90 },
      { outer: notch, holes: [], area: 20 * length - Math.PI / 2 },
      { outer: loop([[0, 0, 0], [20, 0, 0], [15, length, 0], [5, length, 0]]), holes: [], area: 15 * length },
    ];
    for (const test of cases) {
      const handle = makeSheetMetalCurvedPanel(oc, { ...test, frame, radius: 3, thickness: 2, neutralRadius: 3.8, angle });
      try {
        expect(isValidShape(oc, handle.shape)).toBe(true);
        // 円筒の厚み積分: ∫R..R+t r dr / 中立半径 = t*(R+t/2)/(R+Kt)。
        expect(measureVolume(oc, handle.shape)).toBeCloseTo(test.area * 2 * 4 / 3.8, 5);
      } finally { handle.delete(); }
    }
  });
  it('範囲外・接する穴・不正な入力の後にも同じ形を作れ、解放を繰り返せる', () => {
    const input = { frame, outer, holes: [], radius: 3, thickness: 2, neutralRadius: 3.8, angle: 90 } as const;
    const bad = [
      { ...input, neutralRadius: Infinity }, { ...input, neutralRadius: 4.1 }, { ...input, angle: 180 },
      { ...input, outer: loop([[0, 0, 0], [20, 0, 0], [20, length + 1, 0], [0, length + 1, 0]]) },
      { ...input, holes: [loop([[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]])] },
    ];
    for (const value of bad) expect(() => makeSheetMetalCurvedPanel(oc, value)).toThrow();
    for (let i = 0; i < 3; i++) {
      const handle = makeSheetMetalCurvedPanel(oc, input);
      try { expect(measureVolume(oc, handle.shape)).toBeCloseTo(80 * Math.PI, 5); }
      finally { handle.delete(); }
      expect(() => handle.delete()).not.toThrow();
    }
  });
});
