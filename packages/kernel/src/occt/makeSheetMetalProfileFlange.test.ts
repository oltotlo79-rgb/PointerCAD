import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CurveSpec, Vec3Tuple } from '../types.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeSheetMetalBase } from './makeSheetMetalBase.js';
import type { SheetMetalBendFrame } from './makeSheetMetalBend.js';
import { makeSheetMetalFlanges } from './makeSheetMetalFlange.js';
import { makeSheetMetalProfileFlange } from './makeSheetMetalProfileFlange.js';
import { isValidShape, measureVolume } from './solidMesh.js';

let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await loadOcctForNode(); });
const frame: SheetMetalBendFrame = { origin: [0, 30, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1] };
const input = { frame, width: 50, thickness: 2, radius: 3, angle: 90 };
function polygon(points: readonly Vec3Tuple[]): readonly CurveSpec[] {
  return points.map((from, i) => ({ kind: 'segment', from, to: points[(i + 1) % points.length] }));
}
const baseProfile = polygon([[0, 0, 0], [50, 0, 0], [50, 30, 0], [0, 30, 0]]);
function profile(angle: number, withHole: boolean) {
  // 90/-90/0の独立した解析座標。製品の座標変換関数を期待値の生成に使わない。
  const origin: Vec3Tuple = angle === 90 ? [0, 35, 5] : angle === -90 ? [0, 33, -3] : [0, 30, 0];
  const point = (x: number, y: number): Vec3Tuple => angle === 0 ? [x, origin[1] + y, 0] : [x, origin[1], origin[2] + (angle > 0 ? y : -y)];
  const normal: Vec3Tuple = angle === 0 ? [0, 0, 1] : [0, angle > 0 ? -1 : 1, 0];
  const outer = polygon([point(0, 0), point(50, 0), point(40, 20), point(10, 20)]);
  const hole: CurveSpec = { kind: 'arc', center: point(25, 10), radius: 2, normal, xAxis: [1, 0, 0], startAngle: 0, endAngle: Math.PI * 2 };
  return { outer, holes: withHole ? [[hole]] : [] };
}

describe('P10-6 任意輪郭の実フランジ', () => {
  it.each([90, -90, 0])('台形と丸穴を%d°で接続し、独立計算した体積と元形状の保持を確認する', (angle) => {
    const base = makeSheetMetalBase(oc, { outer: baseProfile, holes: [], thickness: 2, reversed: false });
    try {
      for (const withHole of [false, true]) {
        const result = makeSheetMetalProfileFlange(oc, base.shape, { ...input, angle, ...profile(angle, withHole) });
        try {
          expect(isValidShape(oc, result.shape)).toBe(true);
          // 基板3000+台形(50+30)/2*20*2+円筒殻200π-円穴8π。
          expect(measureVolume(oc, result.shape)).toBeCloseTo(4600 + (angle === 0 ? 0 : 200 * Math.PI) - (withHole ? 8 * Math.PI : 0), 6);
          expect(measureVolume(oc, base.shape)).toBeCloseTo(3000, 8);
        } finally { result.delete(); }
        expect(() => result.delete()).not.toThrow();
      }
    } finally { base.delete(); }
  });
  it('任意平面へ剛体移動しても台形と穴の体積は変わらない', () => {
    const point = ([x, y, z]: Vec3Tuple): Vec3Tuple => [10 + z, 20 + x, 30 + y];
    const direction = ([x, y, z]: Vec3Tuple): Vec3Tuple => [z, x, y];
    const curve = (value: CurveSpec): CurveSpec => {
      switch (value.kind) {
        case 'segment': return { ...value, from: point(value.from), to: point(value.to) };
        case 'arc': return { ...value, center: point(value.center), normal: direction(value.normal), xAxis: direction(value.xAxis) };
        default: throw new Error('独立fixtureは線分と円だけです');
      }
    };
    const moved: SheetMetalBendFrame = { origin: point(frame.origin), xAxis: direction(frame.xAxis), yAxis: direction(frame.yAxis), normal: direction(frame.normal) };
    const shape = profile(90, true);
    const base = makeSheetMetalBase(oc, { outer: baseProfile.map(curve), holes: [], thickness: 2, reversed: false, normal: moved.normal });
    try {
      const result = makeSheetMetalProfileFlange(oc, base.shape, { ...input, frame: moved, outer: shape.outer.map(curve), holes: shape.holes.map((loop) => loop.map(curve)) });
      try { expect(measureVolume(oc, result.shape)).toBeCloseTo(4600 + 192 * Math.PI, 6); } finally { result.delete(); }
    } finally { base.delete(); }
  });
  it('矩形と任意輪郭を複数縁に作り、後段失敗でも借用元を壊さない', () => {
    const base = makeSheetMetalBase(oc, { outer: baseProfile, holes: [], thickness: 2, reversed: false });
    const rectangle = { kind: 'rectangle' as const, ...input, secondLength: 20,
      frame: { origin: [50, 0, 0], xAxis: [-1, 0, 0], yAxis: [0, -1, 0], normal: [0, 0, 1] } satisfies SheetMetalBendFrame };
    const arbitrary = { kind: 'profile' as const, ...input, ...profile(90, true) };
    try {
      const result = makeSheetMetalFlanges(oc, base.shape, [rectangle, arbitrary]);
      try { expect(measureVolume(oc, result.shape)).toBeCloseTo(6600 + 392 * Math.PI, 6); } finally { result.delete(); }
      expect(() => makeSheetMetalFlanges(oc, base.shape, [rectangle, { ...arbitrary, outer: [] }])).toThrow();
      expect(measureVolume(oc, base.shape)).toBeCloseTo(3000, 8);
      expect(() => makeSheetMetalProfileFlange(oc, base.shape, { ...arbitrary, thickness: Infinity })).toThrow();
    } finally { base.delete(); }
  });
});
