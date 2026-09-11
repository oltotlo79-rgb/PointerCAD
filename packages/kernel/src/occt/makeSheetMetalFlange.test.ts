import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CurveSpec, Vec3Tuple } from '../types.js';
import { booleanOp } from './booleanOp.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeSheetMetalBase } from './makeSheetMetalBase.js';
import { makeSheetMetalBendStrip, type SheetMetalBendFrame } from './makeSheetMetalBend.js';
import { makeSheetMetalFlange } from './makeSheetMetalFlange.js';
import { boundingBoxOf, boundingBoxRange } from './placeBodies.js';
import { isValidShape, measureVolume } from './solidMesh.js';

let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await loadOcctForNode(); });
const frame: SheetMetalBendFrame = { origin: [0, 30, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1] };
const rotated: SheetMetalBendFrame = { origin: [10, 20, 30], xAxis: [0, 1, 0], yAxis: [0, 0, 1], normal: [1, 0, 0] };
const input = { thickness: 2, radius: 3, width: 50, secondLength: 20, angle: 90, frame };
function solidCount(shape: TopoDS_Shape): number {
  const parts = new oc.TopTools_IndexedMapOfShape_1();
  try {
    oc.TopExp.MapShapes_2(shape, parts, true, true);
    let count = 0;
    for (let index = 1; index <= parts.Size(); index++) {
      if (parts.FindKey(index).ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SOLID) count++;
    }
    return count;
  } finally { parts.delete(); }
}
function baseProfile(f: SheetMetalBendFrame): readonly CurveSpec[] {
  const point = (x: number, y: number): Vec3Tuple => [
    f.origin[0] + f.xAxis[0] * x + f.yAxis[0] * y,
    f.origin[1] + f.xAxis[1] * x + f.yAxis[1] * y,
    f.origin[2] + f.xAxis[2] * x + f.yAxis[2] * y,
  ];
  const points = [point(0, -30), point(50, -30), point(50, 0), point(0, 0)];
  return points.map((from, index) => ({ kind: 'segment', from, to: points[(index + 1) % points.length] }));
}

describe('P10-6 基板との共有端面から作るフランジ', () => {
  it.each([90, -90, 45, -45, 0])('曲げ%dの基板とフランジを微小重なりなしで結合し、元基板は保持する', (angle) => {
    const base = makeSheetMetalBase(oc, { outer: baseProfile(frame), holes: [], thickness: 2, reversed: false });
    const bend = makeSheetMetalBendStrip(oc, { ...input, angle });
    try {
      expect(isValidShape(oc, bend.shape)).toBe(true);
      const joined = booleanOp(oc, 'union', base.shape, bend.shape);
      try {
        expect(isValidShape(oc, joined.shape)).toBe(true);
        expect(solidCount(joined.shape)).toBe(1);
        // 基板50*30*2 + フランジ50*20*2 + 円筒殻50*(5²-3²)/2*θ。
        expect(joined.volume).toBeCloseTo(5000 + 400 * Math.abs(angle) * Math.PI / 180, 7);
        expect(measureVolume(oc, base.shape)).toBeCloseTo(3000, 8);
        const box = boundingBoxOf(oc, joined.shape);
        try {
          const { min, max } = boundingBoxRange(box.box);
          expect(min[0]).toBeCloseTo(0, 6); expect(max[0]).toBeCloseTo(50, 6);
          expect(min[1]).toBeCloseTo(0, 6);
          if (angle > 0) expect(min[2]).toBeCloseTo(0, 6);
          else expect(max[2]).toBeCloseTo(2, 6);
        } finally { box.delete(); }
      } finally { joined.delete(); }
    } finally { bend.delete(); base.delete(); }
    expect(() => bend.delete()).not.toThrow();
  });
  it('向きと原点を変えても同じ体積と厚みで基板へ接続する', () => {
    const base = makeSheetMetalBase(oc, { outer: baseProfile(rotated), holes: [], thickness: 2, reversed: false });
    const bend = makeSheetMetalBendStrip(oc, { ...input, frame: rotated });
    try {
      const joined = booleanOp(oc, 'union', base.shape, bend.shape);
      try {
        expect(joined.volume).toBeCloseTo(5000 + 200 * Math.PI, 7);
        expect(solidCount(joined.shape)).toBe(1);
        const box = boundingBoxOf(oc, joined.shape);
        try {
          const { min, max } = boundingBoxRange(box.box);
          expect(min[0]).toBeCloseTo(10, 6); expect(max[0]).toBeCloseTo(35, 6);
          expect(min[1]).toBeCloseTo(20, 6); expect(max[1]).toBeCloseTo(70, 6);
          expect(min[2]).toBeCloseTo(0, 6); expect(max[2]).toBeCloseTo(35, 6);
        } finally { box.delete(); }
      } finally { joined.delete(); }
    } finally { bend.delete(); base.delete(); }
  });
  it('左手系・非直交・拡大基底・非有限値を断り、直後の生成が成功する', () => {
    for (const invalid of [
      { ...frame, xAxis: [2, 0, 0] as const }, { ...frame, yAxis: [1, 0, 0] as const },
      { ...frame, normal: [0, 0, -1] as const }, { ...frame, origin: [Infinity, 0, 0] as const },
    ]) expect(() => makeSheetMetalBendStrip(oc, { ...input, frame: invalid })).toThrow();
    expect(() => makeSheetMetalBendStrip(oc, { ...input, width: Number.MAX_VALUE })).toThrow();
    const bend = makeSheetMetalBendStrip(oc, input);
    try { expect(measureVolume(oc, bend.shape)).toBeCloseTo(2000 + 200 * Math.PI, 7); } finally { bend.delete(); }
  });
  it('二つの反対縁を続けて曲げるとU板になり、途中のL板も再利用できる', () => {
    const base = makeSheetMetalBase(oc, { outer: baseProfile(frame), holes: [], thickness: 2, reversed: false });
    try {
      const first = makeSheetMetalFlange(oc, base.shape, input);
      try {
        const second = makeSheetMetalFlange(oc, first.shape, { ...input,
          frame: { origin: [50, 0, 0], xAxis: [-1, 0, 0], yAxis: [0, -1, 0], normal: [0, 0, 1] } });
        try {
          expect(solidCount(second.shape)).toBe(1); expect(isValidShape(oc, second.shape)).toBe(true);
          expect(measureVolume(oc, second.shape)).toBeCloseTo(7000 + 400 * Math.PI, 6);
        } finally { second.delete(); }
        expect(measureVolume(oc, first.shape)).toBeCloseTo(5000 + 200 * Math.PI, 7);
      } finally { first.delete(); }
      expect(measureVolume(oc, base.shape)).toBeCloseTo(3000, 8);
    } finally { base.delete(); }
  });
  it('基板から離れた帯と食い込む帯を断り、同じ基板への正常な生成は成功する', () => {
    const base = makeSheetMetalBase(oc, { outer: baseProfile(frame), holes: [], thickness: 2, reversed: false });
    try {
      expect(() => makeSheetMetalFlange(oc, base.shape, { ...input, frame: { ...frame, origin: [0, 40, 0] } })).toThrow(/接続/);
      expect(() => makeSheetMetalFlange(oc, base.shape, { ...input, frame: { ...frame, origin: [0, 29, 0] } })).toThrow(/食い込/);
      expect(measureVolume(oc, base.shape)).toBeCloseTo(3000, 8);
      const valid = makeSheetMetalFlange(oc, base.shape, input);
      try { expect(solidCount(valid.shape)).toBe(1); } finally { valid.delete(); }
      expect(() => valid.delete()).not.toThrow();
    } finally { base.delete(); }
  });
});
