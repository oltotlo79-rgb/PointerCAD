import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeSheetMetalBase } from './makeSheetMetalBase.js';
import { joinSheetMetalShapes } from './sheetMetalJoin.js';
import { measureVolume, isValidShape } from './solidMesh.js';
import { unifySheetFlat } from './unifySheetFlat.js';
import { createAllocations } from './allocations.js';
import type { CurveSpec, Vec3Tuple } from '../types.js';

let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await loadOcctForNode(); });
function rectangle(x: number, width: number): CurveSpec[] {
  const points: Vec3Tuple[] = [[x,0,0], [x+width,0,0], [x+width,30,0], [x,30,0]];
  return points.map((from, i) => ({ kind: 'segment', from, to: points[(i+1)%4] }));
}
function faceCount(shape: TopoDS_Shape): number {
  const map = new oc.TopTools_IndexedMapOfShape_1();
  try {
    oc.TopExp.MapShapes_2(shape, map, true, true);
    let count = 0;
    for (let i = 1; i <= map.Size(); i++) {
      const item = map.FindKey(i);
      try { if (item.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_FACE) count++; }
      finally { item.delete(); }
    }
    return count;
  }
  finally { map.delete(); }
}

describe('展開板の内部境界を除いた製作形状', () => {
  it('三つの平板を継いでも六面の一枚板になり、解放後も元の板と体積を保つ', () => {
    for (let cycle = 0; cycle < 3; cycle++) {
      const { keep, release } = createAllocations();
      try {
        const first = keep(makeSheetMetalBase(oc, { outer: rectangle(0,20), holes: [], normal: [0,0,1], thickness: 2, reversed: false }));
        const middle = keep(makeSheetMetalBase(oc, { outer: rectangle(20,5.969026041821), holes: [], normal: [0,0,1], thickness: 2, reversed: false }));
        const last = keep(makeSheetMetalBase(oc, { outer: rectangle(25.969026041821,20), holes: [], normal: [0,0,1], thickness: 2, reversed: false }));
        const joined = keep(joinSheetMetalShapes(oc, first.shape, middle.shape, 'flat'));
        const result = keep(joinSheetMetalShapes(oc, joined.shape, last.shape, 'flat'));
        expect(faceCount(result.shape)).toBe(6); expect(isValidShape(oc, result.shape)).toBe(true);
        expect(measureVolume(oc, result.shape)).toBeCloseTo(60 * 45.969026041821, 7);
        result.delete(); joined.delete();
        expect(faceCount(first.shape)).toBe(6); expect(measureVolume(oc, first.shape)).toBeCloseTo(1200, 7);
      } finally { release(); release(); }
    }
  });
  it('円穴を消さず、体積変化を拒否して再実行できる', () => {
    const { keep, release } = createAllocations();
    try {
      const hole: CurveSpec = { kind: 'arc', center: [10,15,0], normal: [0,0,1], xAxis: [1,0,0], radius: 2, startAngle: 0, endAngle: 2 * Math.PI };
      const first = keep(makeSheetMetalBase(oc, { outer: rectangle(0,20), holes: [[hole]], normal: [0,0,1], thickness: 2, reversed: false }));
      const last = keep(makeSheetMetalBase(oc, { outer: rectangle(20,20), holes: [], normal: [0,0,1], thickness: 2, reversed: false }));
      expect(() => unifySheetFlat(oc, first.shape, 1200)).toThrow('体積が変わり');
      const joined = keep(joinSheetMetalShapes(oc, first.shape, last.shape, 'flat'));
      expect(measureVolume(oc, joined.shape)).toBeCloseTo(2400 - 8 * Math.PI, 7);
      expect(faceCount(joined.shape)).toBe(7);
      joined.delete();
      expect(measureVolume(oc, first.shape)).toBeCloseTo(1200 - 8 * Math.PI, 7);
    } finally { release(); }
  });
});
