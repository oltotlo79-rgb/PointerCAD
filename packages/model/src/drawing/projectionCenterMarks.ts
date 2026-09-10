import { createCenterMarks, type CenterMark, type CenterMarkSource, type DrawingView, type Point2 } from '@pointercad/drawing';
import type { DrawingProjectionCurve, ResolvedDrawingCurve } from './resolveDrawing.js';

/** 元の辺・輪郭の識別を使い、用紙に投影した円と円柱の側線から中心線を作る。 */
export function projectionCenterMarks(view: DrawingView, visible: readonly DrawingProjectionCurve[], toPaper: (point: Point2) => Point2, scale: number,
  cylinderFaceIds: ReadonlySet<string> = new Set()): readonly ResolvedDrawingCurve[] {
  return projectionCenterMarkGroups(view, visible, toPaper, scale, cylinderFaceIds)
    .flatMap((mark) => mark.lines.map((line) => ({ kind: 'segment' as const, ...line })));
}

export function projectionCenterMarkGroups(view: DrawingView, visible: readonly DrawingProjectionCurve[], toPaper: (point: Point2) => Point2, scale: number,
  cylinderFaceIds: ReadonlySet<string> = new Set()): readonly CenterMark[] {
  const sources = new Map<string, CenterMarkSource>();
  const sides = new Map<string, Extract<ResolvedDrawingCurve, { kind: 'segment' }>[]>();
  for (const item of visible) {
    const p = item.provenance, curve = item.curve;
    const key = JSON.stringify([p.bodyId, p.occurrenceId ?? null, p.kind, p.edgeIndex ?? p.faceIndex]);
    if (curve.kind === 'arc' && Math.abs(curve.endAngle - curve.startAngle) >= Math.PI * 2 - 1e-7) {
      sources.set(key, { id: key, kind: 'circle', center: toPaper(curve.center), radius: curve.radius * scale });
    } else if (curve.kind === 'segment' && p.kind === 'silhouette' && cylinderFaceIds.has(key)) {
      const lines = sides.get(key) ?? []; lines.push(curve); sides.set(key, lines);
    }
  }
  for (const [id, lines] of sides) {
    if (lines.length !== 2) continue;
    const [a, b] = lines, ax = a.to[0] - a.from[0], ay = a.to[1] - a.from[1], bx = b.to[0] - b.from[0], by = b.to[1] - b.from[1];
    const lengthA = Math.hypot(ax, ay), lengthB = Math.hypot(bx, by);
    if (lengthA < 1e-9 || lengthB < 1e-9 || Math.abs(ax * by - ay * bx) > 1e-7 * lengthA * lengthB) continue;
    const start = ax * bx + ay * by >= 0 ? b.from : b.to, end = start === b.from ? b.to : b.from;
    const middle = (x: Point2, y: Point2): Point2 => toPaper([(x[0] + y[0]) / 2, (x[1] + y[1]) / 2]);
    sources.set(id, { id, kind: 'cylinderSide', from: middle(a.from, start), to: middle(a.to, end) });
  }
  return createCenterMarks(view, [...sources.values()]) ?? [];
}
