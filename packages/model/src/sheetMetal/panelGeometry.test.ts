import { describe, expect, it } from 'vitest';
import type { ResolvedCurve, ResolvedSegment } from '../sketch/types.js';
import { rectangularFlangePanel, sheetBoundaryEdges, sheetTangentFrame, type SheetPanelGeometry, type SheetTangentFrame } from './panelGeometry.js';

const outer: readonly ResolvedSegment[] = [
  { kind: 'segment', featureId: 'bottom', from: [0, 0, 0], to: [50, 0, 0] },
  { kind: 'segment', featureId: 'right', from: [50, 0, 0], to: [50, 30, 0] },
  { kind: 'segment', featureId: 'top', from: [50, 30, 0], to: [0, 30, 0] },
  { kind: 'segment', featureId: 'left', from: [0, 30, 0], to: [0, 0, 0] },
];
const panel: SheetPanelGeometry = { id: 'base', normal: [0, 0, 1], outer, holes: [] };
const topId = JSON.stringify(['sheet-edge', 'top', 0]);
const frame: SheetTangentFrame = { origin: [0, 30, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1] };
function close(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length); actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 10));
}

describe('P10 パネル境界の安定IDと正負曲げの接線', () => {
  it('線の入力方向が混ざっても同じ外向き・IDになり、端の切詰めは幅と原点だけへ反映する', () => {
    const flipped = outer.map((edge, index) => index % 2 === 0 ? { ...edge, from: edge.to, to: edge.from } : edge);
    expect(sheetBoundaryEdges({ ...panel, outer: flipped })).toEqual(sheetBoundaryEdges(panel));
    const tangent = sheetTangentFrame(panel, topId, 2, 3);
    expect(tangent.ok).toBe(true); if (!tangent.ok) throw new Error(tangent.message);
    close(tangent.value.frame.origin, [2, 30, 0]); close(tangent.value.frame.yAxis, [0, 1, 0]);
    expect(tangent.value.width).toBe(45);
    const longer = { ...panel, outer: outer.map((edge) => ({ ...edge, from: [edge.from[0] * 2, edge.from[1], edge.from[2]] as const,
      to: [edge.to[0] * 2, edge.to[1], edge.to[2]] as const })) };
    const resized = sheetTangentFrame(longer, topId, 2, 3);
    expect(resized.ok && resized.value.width).toBe(95);
  });
  it('法線を反転すると同じ縁の外向きは保ち、厚みの向きと幅方向だけ反転する', () => {
    const reversed = sheetTangentFrame({ ...panel, normal: [0, 0, -1] }, topId, 0, 0);
    expect(reversed.ok).toBe(true); if (!reversed.ok) throw new Error(reversed.message);
    close(reversed.value.frame.origin, [50, 30, 0]); close(reversed.value.frame.xAxis, [-1, 0, 0]);
    close(reversed.value.frame.yAxis, [0, 1, 0]); close(reversed.value.frame.normal, [0, 0, -1]);
  });
  it.each([
    { angle: 90, origin: [0, 35, 5], normal: [0, -1, 0], tip: [50, 35, 25] },
    { angle: -90, origin: [0, 33, -3], normal: [0, 1, 0], tip: [50, 33, -23] },
    { angle: 0, origin: [0, 30, 0], normal: [0, 0, 1], tip: [50, 50, 0] },
  ])('曲げ$angleの下側面と板厚法線が実OCCTのL板と一致する', ({ angle, origin, normal, tip }) => {
    const result = rectangularFlangePanel('flange', topId, frame, 50, 20, 2, 3, angle);
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.message);
    close(result.value.endFrame.origin, origin); close(result.value.panel.normal, normal);
    const last = result.value.panel.outer[1]; if (last.kind !== 'segment') throw new Error('矩形の線分が必要です');
    close(last.to, tip);
    const edges = sheetBoundaryEdges(result.value.panel); expect(edges.ok).toBe(true);
  });
  it('円弧と線分の輪郭は弧を直線化せず向きを判定し、円だけの輪郭には直線縁を捏造しない', () => {
    const arc: ResolvedCurve = { kind: 'arc', featureId: 'arc', center: [0, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0], radius: 5, startAngle: 0, endAngle: Math.PI };
    const half: SheetPanelGeometry = { ...panel, outer: [{ kind: 'segment', featureId: 'chord', from: [-5, 0, 0], to: [5, 0, 0] }, arc] };
    const tangent = sheetTangentFrame(half, JSON.stringify(['sheet-edge', 'chord', 0]), 0, 0);
    expect(tangent.ok).toBe(true); if (!tangent.ok) throw new Error(tangent.message);
    close(tangent.value.frame.yAxis, [0, -1, 0]); expect(tangent.value.width).toBe(10);
    expect(sheetBoundaryEdges({ ...panel, outer: [{ ...arc, endAngle: 2 * Math.PI }] })).toEqual({ ok: true, value: [] });
  });
  it('切詰めによる幅消失、未知縁、輪郭断絶、非直交の基準方向を拒否する', () => {
    expect(sheetTangentFrame(panel, topId, 25, 25).ok).toBe(false);
    expect(sheetTangentFrame(panel, 'gone', 0, 0).ok).toBe(false);
    expect(sheetBoundaryEdges({ ...panel, outer: outer.slice(0, 3) }).ok).toBe(false);
    expect(rectangularFlangePanel('flange', topId, { ...frame, normal: [0, 1, 0] }, 50, 20, 2, 3, 90).ok).toBe(false);
  });
});
