import { describe, expect, it } from 'vitest';
import type { ResolvedArc } from '../sketch/types.js';
import { buildSheetFlatHoleSchedule } from './flatHoleSchedule.js';
import type { SheetFlatOutline } from './flatOutline.js';

function circle(x: number, y: number, radius: number): ResolvedArc {
  return { kind: 'arc', featureId: `hole-${x}-${y}`, center: [x,y,0], normal: [0,0,1], xAxis: [1,0,0],
    radius, startAngle: 0, endAngle: -2*Math.PI };
}
const frame = { datum: [10,20,0], x: [1,0,0], y: [0,1,0] } as const;
describe('展開後の円穴表', () => {
  it('基準点からの展開座標と径グループを使い、帯境界で分割された円弧を一穴へ戻す', () => {
    const split = circle(30,25,2);
    const outline: SheetFlatOutline = { toleranceMm: 0.001, loops: [
      { kind: 'hole', curves: [circle(15,22,3)] },
      { kind: 'hole', curves: [{ ...split, endAngle: -Math.PI }, { ...split, startAngle: -Math.PI }] },
      { kind: 'hole', curves: [circle(20,25,2)] },
      { kind: 'outer', curves: [circle(0,0,100)] },
    ] };
    const result = buildSheetFlatHoleSchedule(outline, frame); if (!result.ok) throw new Error(result.reason);
    expect(result.rows.map((row) => [row.symbol,row.x,row.y,row.diameter,row.depth])).toEqual([
      ['A1',10,5,4,null], ['A2',20,5,4,null], ['B1',5,2,6,null],
    ]);
    expect(result.rows[1].center).toEqual([30,25,0]);
    const reverse = buildSheetFlatHoleSchedule(outline, { ...frame, y: [0,-1,0] });
    if (!reverse.ok) throw new Error(reverse.reason);
    expect(reverse.rows.map((row) => row.y)).toEqual([-5,-5,-2]);
  });
  it('円の一部や長穴を直径へ読み替えず、傾いた基準面も拒否する', () => {
    const outline: SheetFlatOutline = { toleranceMm: 0.001, loops: [{ kind: 'hole', curves: [{ ...circle(20,25,2), endAngle: -Math.PI }] }] };
    expect(buildSheetFlatHoleSchedule(outline, frame)).toEqual({ ok: true, rows: [] });
    expect(buildSheetFlatHoleSchedule(outline, { ...frame, y: [0,0,1] })).toEqual({ ok: false, reason: 'invalidFrame' });
  });
});
