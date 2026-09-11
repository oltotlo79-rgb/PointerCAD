import { describe, expect, it } from 'vitest';
import { toProjectionResult } from '../kernelBridge.js';
import { WORK_PLANES } from '../sketch/planeMath.js';
import type { ResolvedCurve } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { classifySheetOutline } from './flatOutline.js';
import { sheetLoopSignedArea } from './panelGeometry.js';
import { sheetFlatBendLines } from './flatBendLines.js';
import { sheetFlatDxfEntities } from './flatDxf.js';
import type { SheetFlatGeometry } from './unfoldSheetBody.js';

function rectangle(x: number, y: number, width: number, height: number): ResolvedCurve[] {
  const points: Vec3[] = [[x,y,0], [x+width,y,0], [x+width,y+height,0], [x,y+height,0]];
  return points.map((from, i) => ({ kind: 'segment', featureId: `edge${i}`, from, to: points[(i+1)%4] }));
}
describe('展開の切断輪郭と曲げ線', () => {
  it('同じ向きの外周/穴/穴の中の島を入れ子で分類し、DXFの切断層へ分ける', () => {
    const result = classifySheetOutline([...rectangle(0,0,20,20), ...rectangle(3,3,14,14), ...rectangle(6,6,4,4)]);
    if (!result.ok) throw new Error(result.message);
    expect(result.value.map((loop) => loop.kind)).toEqual(['outer', 'hole', 'outer']);
    expect(result.value.map((loop) => sheetLoopSignedArea(loop.curves, [0,0,1]))).toEqual([400,-196,16]);
    const dxf = sheetFlatDxfEntities({ loops: result.value, toleranceMm: 0.001 }, []);
    if (!dxf.ok) throw new Error(dxf.message);
    expect(dxf.value.filter((entity) => entity.layer === 'CUT_OUTER')).toHaveLength(8);
    expect(dxf.value.filter((entity) => entity.layer === 'CUT_HOLES')).toHaveLength(4);
  });
  it('穴で分かれる正負の曲げ線を材料の区間だけへ切り、ゼロ角は出さない', () => {
    const panel = { id: 'bend', normal: [0,0,1] as const, outer: rectangle(0,0,20,6), holes: [rectangle(8,1,4,4)] };
    const flat: SheetFlatGeometry = { thickness: 2, fixedPanelId: 'base', panels: [], joins: [], bends: [90,-90,0].map((angle) => ({
      id: `bend${angle}`, panel, from: [0,3,0], to: [20,3,0], angle, radius: 3, allowance: 6,
    })) };
    const lines = sheetFlatBendLines(flat); if (!lines.ok) throw new Error(lines.message);
    expect(lines.value.map((line) => [line.from[0], line.to[0], line.direction])).toEqual([
      [0,8,'up'], [12,20,'up'], [0,8,'down'], [12,20,'down'],
    ]);
    const dxf = sheetFlatDxfEntities({ loops: [], toleranceMm: 0.001 }, lines.value);
    if (!dxf.ok) throw new Error(dxf.message);
    expect(dxf.value.map((line) => line.layer)).toEqual(['BEND_UP','BEND_UP','BEND_DOWN','BEND_DOWN']);
  });
  it('精密断面の折線を補間し直さず、閉じた弦とdouble座標のまま橋から受け取る', () => {
    const coordinates = [[10_000_000.125,0], [10_000_000.25,1], [10_000_000.375,0]] as const;
    const request = { featureId: 'flat', bodyKey: 'key', source: null, plane: WORK_PLANES.xy };
    const outcome = { results: [{ id: 'flat', curves: [{ kind: 'polyline', points: coordinates, closed: true } as const] }], failures: [] };
    const result = toProjectionResult([{ ...request, curveToleranceMm: 0.001 }], outcome);
    expect(result.failures).toEqual([]);
    expect(result.results[0].curves).toHaveLength(3);
    expect(result.results[0].curves[2]).toMatchObject({ kind: 'segment', from: [10_000_000.375,0,0], to: [10_000_000.125,0,0] });
    expect(toProjectionResult([request], outcome).results[0].curves[0].kind).toBe('spline');
  });
});
