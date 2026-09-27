/** G1 comparison of current geometry. These transient dimensions are never persisted. */
import type { ResolvedCurve, ResolvedSegment } from '../sketch/types.js';
import { addVec3, crossVec3, distanceVec3, dotVec3, lengthVec3, scaleVec3, subVec3, type Vec3 } from '../sketch/vec3.js';
import { validateMathGeometryTolerance } from './mathGeometryDefinitions.js';
import type { MathGeometryTolerance } from './mathGeometryTypes.js';

export type MathGeometryComparisonShape =
  | { readonly kind: 'segment'; readonly length: number }
  | { readonly kind: 'circular'; readonly radius: number; readonly sweep: number }
  | { readonly kind: 'polygon'; readonly curves: readonly ResolvedCurve[] };

type Problem = { readonly ok: false; readonly reason: 'unsupported' | 'failed-geometry' | 'invalid-request'; readonly message: string };
type Result<T> = { readonly ok: true; readonly value: T } | Problem;
const unsupported = (message: string): Problem => ({ ok: false, reason: 'unsupported', message });
const invalidGeometry = (): Problem => ({ ok: false, reason: 'failed-geometry', message: '合同・相似を比べる図形の寸法を正しく取得できませんでした。' });
const degenerate = (): Problem => unsupported('比べる幅以下の長さや退化した図形では合同・相似を判定できません。');
const finite = (point: Vec3): boolean => point.every(Number.isFinite);

interface Polygon {
  /** Edge i leaves vertex i; turn i is at vertex i, retaining the sign of a concave corner. */
  readonly lengths: readonly number[];
  readonly turns: readonly number[];
  readonly perimeter: number;
}

/** A unique single loop. Curves may arrive in either direction or in a different storage order. */
function orderedSegments(segments: readonly ResolvedSegment[], width: number): Result<readonly ResolvedSegment[]> {
  const ordered: ResolvedSegment[] = [segments[0]], remaining = new Set(segments.slice(1));
  if (new Set(segments).size !== segments.length) return unsupported('同じ辺が重複した輪郭は比べられません。');
  let tip = segments[0].to;
  while (remaining.size > 0) {
    let next: ResolvedSegment | undefined, reversed = false;
    for (const segment of remaining) {
      const forward = distanceVec3(tip, segment.from) <= width;
      const backward = distanceVec3(tip, segment.to) <= width;
      if (!forward && !backward) continue;
      if (next !== undefined || (forward && backward)) {
        return unsupported('枝分かれした輪郭では合同・相似を判定できません。');
      }
      next = segment;
      reversed = backward;
    }
    if (next === undefined) return unsupported('閉じた1つの多角形でない輪郭は比べられません。');
    remaining.delete(next);
    const directed = reversed ? { ...next, from: next.to, to: next.from } : next;
    ordered.push(directed);
    tip = directed.to;
  }
  return distanceVec3(tip, ordered[0].from) <= width ? { ok: true, value: ordered }
    : unsupported('閉じた1つの多角形でない輪郭は比べられません。');
}

function distanceToSegment(point: Vec3, from: Vec3, to: Vec3): number {
  const direction = subVec3(to, from), length = lengthVec3(direction);
  const unit = scaleVec3(direction, 1 / length);
  const along = Math.max(0, Math.min(length, dotVec3(subVec3(point, from), unit)));
  return distanceVec3(point, addVec3(from, scaleVec3(unit, along)));
}

/** Coordinates have been translated and scaled, so cross products do not square large world coordinates. */
function edgesTouch(a: Vec3, b: Vec3, c: Vec3, d: Vec3, normal: Vec3, width: number): boolean {
  const side = (from: Vec3, to: Vec3, point: Vec3): number => dotVec3(crossVec3(subVec3(to, from), subVec3(point, from)), normal);
  const opposite = (x: number, y: number): boolean => (x < 0 && y > 0) || (x > 0 && y < 0);
  if (opposite(side(a, b, c), side(a, b, d)) && opposite(side(c, d, a), side(c, d, b))) return true;
  return Math.min(distanceToSegment(a, c, d), distanceToSegment(b, c, d),
    distanceToSegment(c, a, b), distanceToSegment(d, a, b)) <= width;
}

function polygon(curves: readonly ResolvedCurve[], tolerance: MathGeometryTolerance): Result<Polygon> {
  const segments = curves.filter((curve): curve is ResolvedSegment => curve.kind === 'segment');
  if (segments.length !== curves.length || segments.length < 3) {
    return unsupported('多角形の比較には3本以上の線分で閉じた輪郭が必要です。');
  }
  const lengths = segments.map(segment => distanceVec3(segment.from, segment.to));
  if (segments.some(segment => !finite(segment.from) || !finite(segment.to)) || !lengths.every(Number.isFinite)) return invalidGeometry();
  if (lengths.some(length => length <= tolerance.linearMm)) return degenerate();
  const loop = orderedSegments(segments, tolerance.linearMm);
  if (!loop.ok) return loop;
  const ordered = loop.value, origin = ordered[0].from;
  const scale = lengths.reduce((largest, length) => Math.max(largest, length), 0);
  const local = (point: Vec3): Vec3 => {
    const delta = subVec3(point, origin);
    return [delta[0] / scale, delta[1] / scale, delta[2] / scale];
  };
  const starts = ordered.map(segment => local(segment.from)), ends = ordered.map(segment => local(segment.to));
  if (![...starts, ...ends].every(finite)) return invalidGeometry();
  const area = starts.reduce<Vec3>((sum, start, index) => addVec3(sum, crossVec3(start, ends[index])), [0, 0, 0]);
  const areaLength = lengthVec3(area), width = tolerance.linearMm / scale;
  if (!Number.isFinite(areaLength)) return invalidGeometry();
  if (areaLength <= width * width) return degenerate();
  const normal = scaleVec3(area, 1 / areaLength);
  if ([...starts, ...ends].some(point => Math.abs(dotVec3(point, normal)) > width)) {
    return unsupported('同じ平面にない輪郭では多角形の合同・相似を判定できません。');
  }
  for (let i = 0; i < starts.length; i += 1) {
    for (let j = i + 2; j < starts.length; j += 1) {
      if (i === 0 && j === starts.length - 1) continue;
      if (edgesTouch(starts[i], ends[i], starts[j], ends[j], normal, width)) {
        return unsupported('交差したり重なったりする輪郭では多角形の合同・相似を判定できません。');
      }
    }
  }
  const orderedLengths = ordered.map(segment => distanceVec3(segment.from, segment.to));
  const directions = ordered.map((segment, index): Vec3 => {
    const delta = subVec3(segment.to, segment.from), length = orderedLengths[index];
    return [delta[0] / length, delta[1] / length, delta[2] / length];
  });
  const turns = directions.map((outgoing, index) => {
    const incoming = directions[(index + directions.length - 1) % directions.length];
    return Math.atan2(dotVec3(crossVec3(incoming, outgoing), normal), dotVec3(incoming, outgoing));
  });
  if (turns.some(turn => Math.abs(turn) === Math.PI)) return degenerate();
  const perimeter = orderedLengths.reduce((sum, length) => sum + length, 0);
  return Number.isFinite(perimeter) ? { ok: true, value: { lengths: orderedLengths, turns, perimeter } } : invalidGeometry();
}

function comparePolygons(first: Polygon, second: Polygon, similar: boolean, tolerance: MathGeometryTolerance): boolean {
  const count = first.lengths.length;
  // Enlarge the smaller perimeter. The same mm comparison survives swapping the two arguments.
  const perimeter = Math.max(first.perimeter, second.perimeter);
  const scaled = (length: number, source: Polygon): number => similar && source.perimeter < perimeter
    ? (length / source.perimeter) * perimeter : length;
  for (let start = 0; start < count; start += 1) {
    for (const direction of [1, -1]) {
      let matches = true;
      for (let i = 0; i < count; i += 1) {
        const vertex = (start + direction * i + count) % count;
        const edge = direction === 1 ? vertex : (vertex + count - 1) % count;
        if (Math.abs(first.turns[i] - second.turns[vertex]) > tolerance.angularRadians
          || Math.abs(scaled(first.lengths[i], first) - scaled(second.lengths[edge], second)) > tolerance.linearMm) {
          matches = false;
          break;
        }
      }
      if (matches) return true;
    }
  }
  return false;
}

/** Pure G1 comparison; false is reserved for valid comparable shapes outside the requested widths. */
export function compareMathGeometryCongruence(kind: 'congruent' | 'similar', first: MathGeometryComparisonShape,
  second: MathGeometryComparisonShape, tolerance: MathGeometryTolerance): Result<boolean> {
  if (validateMathGeometryTolerance(tolerance) !== null) {
    return { ok: false, reason: 'invalid-request', message: '合同・相似の比べる幅を確認してください。' };
  }
  if (first.kind === 'segment' && second.kind === 'segment') {
    if (![first.length, second.length].every(Number.isFinite) || first.length < 0 || second.length < 0) return invalidGeometry();
    if (Math.min(first.length, second.length) <= tolerance.linearMm) return degenerate();
    return { ok: true, value: kind === 'similar' || Math.abs(first.length - second.length) <= tolerance.linearMm };
  }
  if (first.kind === 'circular' && second.kind === 'circular') {
    if (![first.radius, second.radius, first.sweep, second.sweep].every(Number.isFinite)
      || Math.min(first.radius, second.radius, first.sweep, second.sweep) < 0) return invalidGeometry();
    if (Math.min(first.radius, second.radius) <= tolerance.linearMm || Math.min(first.sweep, second.sweep) === 0) return degenerate();
    return { ok: true, value: Math.abs(first.sweep - second.sweep) <= tolerance.angularRadians
      && (kind === 'similar' || Math.abs(first.radius - second.radius) <= tolerance.linearMm) };
  }
  if (first.kind === 'polygon' && second.kind === 'polygon') {
    const a = polygon(first.curves, tolerance), b = polygon(second.curves, tolerance);
    if (!a.ok) return a;
    if (!b.ok) return b;
    if (a.value.lengths.length !== b.value.lengths.length) return unsupported('辺の数が違う多角形どうしは比べられません。');
    return { ok: true, value: comparePolygons(a.value, b.value, kind === 'similar', tolerance) };
  }
  return unsupported('線分どうし、円弧・円どうし、または同じ辺数の多角形どうしを選んでください。');
}
