import { describe, expect, it } from 'vitest';
import type { ResolvedCurve } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { clipSheetPanel } from './clipSheetPanel.js';
import { sheetLoopSignedArea, type SheetPanelGeometry } from './panelGeometry.js';

function polygon(points: readonly Vec3[]): readonly ResolvedCurve[] {
  return points.map((from, i) => ({ kind: 'segment', featureId: `edge-${i}`, from, to: points[(i + 1) % points.length] }));
}
const outer = polygon([[0, 0, 0], [20, 0, 0], [20, 10, 0], [0, 10, 0]]);
const circle: ResolvedCurve = { kind: 'arc', featureId: 'hole', center: [10, 5, 0], radius: 2, normal: [0, 0, 1], xAxis: [1, 0, 0], startAngle: 0, endAngle: 2 * Math.PI };
const panel: SheetPanelGeometry = { id: 'panel', normal: [0, 0, 1], outer, holes: [[circle]] };
describe('穴を含む板金パネルの接線分割', () => {
  it('円穴を横切る分割は穴を半円の切欠きへつなぎ、両側の面積を保つ', () => {
    for (const side of [-1, 1] as const) {
      const result = clipSheetPanel(panel, { origin: [10, 0, 0], normal: [1, 0, 0] }, side, 'bend');
      if (!result.ok) throw new Error(result.message);
      expect(result.value).toHaveLength(1); expect(result.value[0].kind).toBe('outer');
      expect(sheetLoopSignedArea(result.value[0].curves, panel.normal)).toBeCloseTo(100 - 2 * Math.PI, 9);
      expect(result.value[0].curves.some((curve) => curve.kind === 'arc' && curve.radius === 2)).toBe(true);
    }
    expect(panel.holes[0][0]).toBe(circle);
  });
  it('穴の外を通る分割では穴を残し、接線・範囲外で架空の面を作らない', () => {
    const result = clipSheetPanel(panel, { origin: [15, 0, 0], normal: [1, 0, 0] }, -1, 'bend');
    if (!result.ok) throw new Error(result.message);
    expect(result.value.map((loop) => loop.kind).sort()).toEqual(['hole', 'outer']);
    expect(result.value.reduce((area, loop) => area + sheetLoopSignedArea(loop.curves, panel.normal), 0)).toBeCloseTo(150 - 4 * Math.PI, 9);
    for (const x of [-1, 0]) expect(clipSheetPanel(panel, { origin: [x, 0, 0], normal: [1, 0, 0] }, -1, 'cut')).toEqual({ ok: true, value: [] });
  });
  it('凹形状が二つへ分かれたら二つの外周を返し、間に材料を足さない', () => {
    const concave = { ...panel, holes: [], outer: polygon([[0, 0, 0], [20, 0, 0], [20, 20, 0], [15, 20, 0],
      [15, 5, 0], [5, 5, 0], [5, 20, 0], [0, 20, 0]]) };
    const result = clipSheetPanel(concave, { origin: [0, 10, 0], normal: [0, 1, 0] }, 1, 'bend');
    if (!result.ok) throw new Error(result.message);
    expect(result.value).toHaveLength(2);
    for (const loop of result.value) { expect(loop.kind).toBe('outer'); expect(sheetLoopSignedArea(loop.curves, panel.normal)).toBeCloseTo(50, 9); }
  });
  it('同じ平面の切断線として成立しない向きは拒否する', () => {
    expect(clipSheetPanel(panel, { origin: [0, 0, 0], normal: [0, 0, 1] }, -1, 'cut').ok).toBe(false);
  });
});
