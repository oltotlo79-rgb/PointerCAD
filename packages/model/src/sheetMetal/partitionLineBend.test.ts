import { describe, expect, it } from 'vitest';
import type { ResolvedCurve, ResolvedSegment } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { sheetLoopSignedArea, type SheetPanelGeometry } from './panelGeometry.js';
import { partitionSheetLineBend } from './partitionLineBend.js';
import { framePoint } from './rigidCurve.js';

function polygon(points: readonly Vec3[]): readonly ResolvedCurve[] {
  return points.map((from, i) => ({ kind: 'segment', featureId: `edge-${i}`, from, to: points[(i + 1) % points.length] }));
}
const input = { thickness: 2, radius: 3, kFactor: 0.4, angle: 90 };
const line: ResolvedSegment = { kind: 'segment', featureId: 'line', from: [0, 10, 0], to: [20, 10, 0] };
const circle = (x: number, y: number): ResolvedCurve => ({ kind: 'arc', featureId: `hole-${x}`, center: [x, y, 0], radius: 1,
  normal: [0, 0, 1], xAxis: [1, 0, 0], startAngle: 0, endAngle: 2 * Math.PI });
const panel: SheetPanelGeometry = { id: 'source', normal: [0, 0, 1], holes: [],
  outer: polygon([[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0]]) };
const area = (panels: readonly SheetPanelGeometry[]) => panels.reduce((sum, item) => sum + sheetLoopSignedArea(item.outer, item.normal)
  + item.holes.reduce((removed, hole) => removed + sheetLoopSignedArea(hole, item.normal), 0), 0);

describe('指定線での曲げに使う固定面・曲げ帯・移動面の分割', () => {
  it.each(['left', 'right'] as const)('%s側を固定し、指定線を中立長の中央に保つ', (side) => {
    const result = partitionSheetLineBend(panel, line, side, input, 'bend'); if (!result.ok) throw new Error(result.message);
    const value = result.value, allowance = 1.9 * Math.PI;
    expect(value.fixed).toHaveLength(1); expect(value.moving).toHaveLength(1); expect(value.bands).toHaveLength(1);
    expect(area(value.fixed)).toBeCloseTo(20 * (10 - allowance / 2), 8);
    expect(area(value.bands)).toBeCloseTo(20 * allowance, 8);
    expect(area(value.fixed) + area(value.flatMoving) + area(value.bands)).toBeCloseTo(400, 8);
    expect(area(value.moving)).toBeCloseTo(area(value.flatMoving), 8);
    const center = framePoint(line.from, value.frame, { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1] });
    expect(center[1]).toBeCloseTo(allowance / 2, 9);
    expect(panel.holes).toEqual([]);
  });
  it('U字の2本の腕はそれぞれの穴を持つ2面/2曲げ帯となり、隙間を埋めない', () => {
    const concave = { ...panel, holes: [[circle(2.5, 17)], [circle(17.5, 17)]],
      outer: polygon([[0, 0, 0], [20, 0, 0], [20, 20, 0], [15, 20, 0], [15, 5, 0], [5, 5, 0], [5, 20, 0], [0, 20, 0]]) };
    const result = partitionSheetLineBend(concave, line, 'right', input, 'bend'); if (!result.ok) throw new Error(result.message);
    expect(result.value.fixed).toHaveLength(1); expect(result.value.moving).toHaveLength(2); expect(result.value.bands).toHaveLength(2);
    expect(result.value.moving.map((item) => item.holes.length)).toEqual([1, 1]);
    expect(area(result.value.fixed) + area(result.value.flatMoving) + area(result.value.bands)).toBeCloseTo(250 - 2 * Math.PI, 8);
  });
  it('0度は元パネルを保ち、平面外・片側消失・退化した線を拒否する', () => {
    const zero = partitionSheetLineBend(panel, line, 'right', { ...input, angle: 0 }, 'bend');
    if (!zero.ok) throw new Error(zero.message);
    expect(zero.value.fixed[0]).toBe(panel); expect(zero.value.bands).toEqual([]);
    for (const invalid of [{ ...line, to: line.from }, { ...line, from: [0, 1, 0], to: [20, 1, 0] },
      { ...line, from: [0, 10, 1] }, { ...line, to: [20, 10, 1] }] satisfies readonly ResolvedSegment[])
      expect(partitionSheetLineBend(panel, invalid, 'right', input, 'bend').ok).toBe(false);
  });
});
