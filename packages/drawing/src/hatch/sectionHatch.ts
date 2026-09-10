import type { Point2 } from '../types.js';
import type { ClipCurve } from '../layout/clipRegion.js';
import { checkedHatchArea, MAX_HATCH_POINTS, type HatchSegment } from './hatchArea.js';
import { hatchStyle } from './hatchStyle.js';

const JOIN_TOLERANCE = 1e-7;
const DEFLECTION_MM = 0.01;
function curvePoints(curve: ClipCurve, remainingPoints: number): readonly Point2[] {
  if (curve.kind === 'segment') return [curve.from, curve.to];
  if (curve.kind === 'polyline') {
    if (curve.points.length + (curve.closed ? 1 : 0) > remainingPoints) return [];
    return curve.closed && curve.points.length > 0 ? [...curve.points, curve.points[0]] : curve.points;
  }
  const sweep = curve.endAngle - curve.startAngle;
  if (!curve.center.every(Number.isFinite) || !Number.isFinite(curve.startAngle) || !Number.isFinite(curve.radius)
      || curve.radius <= 0 || !Number.isFinite(sweep) || Math.abs(sweep) > 2 * Math.PI + 1e-9) return [];
  const maxAngle = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - DEFLECTION_MM / curve.radius)));
  const steps = Math.max(3, Math.ceil(Math.abs(sweep) / Math.max(1e-8, maxAngle)));
  if (!Number.isSafeInteger(steps) || steps + 1 > remainingPoints) return [];
  return Array.from({ length: steps + 1 }, (_, index): Point2 => {
    const angle = curve.startAngle + sweep * index / steps;
    return [curve.center[0] + curve.radius * Math.cos(angle), curve.center[1] + curve.radius * Math.sin(angle)];
  });
}

/** 順序・向きが異なる切り口の線を閉じた輪郭へつなぐ。開いた線を勝手に閉じない。 */
export function sectionBoundaryLoops(curves: readonly ClipCurve[]): readonly (readonly Point2[])[] | null {
  if (curves.length > MAX_HATCH_POINTS / 2) return null;
  let pointCount = 0;
  const nodes: Point2[] = [], buckets = new Map<string, number[]>();
  const node = (point: Point2): number => {
    const x = Math.floor(point[0] / JOIN_TOLERANCE), y = Math.floor(point[1] / JOIN_TOLERANCE);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const id of buckets.get(`${x + dx},${y + dy}`) ?? []) {
        if (Math.hypot(nodes[id][0] - point[0], nodes[id][1] - point[1]) <= JOIN_TOLERANCE) return id;
      }
    }
    const id = nodes.length, key = `${x},${y}`; nodes.push(point);
    const entries = buckets.get(key) ?? []; entries.push(id); buckets.set(key, entries); return id;
  };
  const edges: { readonly from: number; readonly to: number; readonly points: readonly Point2[] }[] = [];
  const links = new Map<number, number[]>(), loops: Point2[][] = [];
  for (const curve of curves) {
    const points = curvePoints(curve, MAX_HATCH_POINTS - pointCount); pointCount += points.length;
    if (points.length < 2 || pointCount > MAX_HATCH_POINTS || points.some((point) => !point.every(Number.isFinite))) return null;
    const from = node(points[0]), to = node(points[points.length - 1]);
    if (from === to) { if (points.length > 3) loops.push(points.slice(0, -1)); continue; }
    const id = edges.length; edges.push({ from, to, points });
    for (const end of [from, to]) { const adjacent = links.get(end) ?? []; adjacent.push(id); links.set(end, adjacent); }
  }
  if ([...links.values()].some((adjacent) => adjacent.length !== 2)) return null;
  const pending = new Set(edges.map((_, index) => index));
  while (pending.size > 0) {
    const first = pending.values().next().value; if (first === undefined) break;
    const start = edges[first].from; let current = start; const loop: Point2[] = [];
    do {
      const id = links.get(current)?.find((edge) => pending.has(edge)); if (id === undefined) return null;
      pending.delete(id); const edge = edges[id], forward = edge.from === current;
      const points = forward ? edge.points : [...edge.points].reverse();
      for (let index = 0; index < points.length - 1; index++) loop.push(points[index]);
      current = forward ? edge.to : edge.from;
    } while (current !== start);
    if (loop.length < 3) return null; loops.push(loop);
  }
  return loops;
}

/** 用紙mmで作るため、拡大図でも線幅とハッチの間隔を拡大しない。 */
export function sectionHatch(curves: readonly ClipCurve[], componentIndex = 0): readonly HatchSegment[] | null {
  const loops = sectionBoundaryLoops(curves);
  if (loops === null) return null;
  const result = checkedHatchArea({ loops, ...hatchStyle(componentIndex) });
  return result.ok ? result.segments : null;
}
