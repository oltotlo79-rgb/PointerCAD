import type { Point2 } from '../types.js';
import { clipCurves, type ClipCurve } from './clipRegion.js';

export interface BreakSpec { readonly axis: 'u' | 'v'; readonly from: number; readonly to: number; readonly keepGap: number }
export interface BreakLine { readonly points: readonly Point2[]; readonly amplitudeMm: 2; readonly spacingMm: 4 }
export type BreakResult = { readonly ok: true; readonly curves: readonly ClipCurve[]; readonly breakLines: readonly [BreakLine, BreakLine] }
  | { readonly ok: false; readonly message: string };

function coordinate(point: Point2, axis: 'u' | 'v'): number { return point[axis === 'u' ? 0 : 1]; }
function moved(point: Point2, spec: BreakSpec): Point2 {
  const index = spec.axis === 'u' ? 0 : 1; const result: [number, number] = [point[0], point[1]];
  if (result[index] >= spec.to) result[index] -= (spec.to - spec.from) - spec.keepGap;
  return result;
}
function zigzag(axis: 'u' | 'v', at: number, low: number, high: number): BreakLine {
  const points: Point2[] = [];
  const steps = Math.max(1, Math.ceil((high - low) / 4));
  for (let index = 0; index <= steps; index += 1) {
    const across = low + ((high - low) * index) / steps; const wave = index % 2 === 0 ? -2 : 2;
    points.push(axis === 'u' ? [at + wave, across] : [across, at + wave]);
  }
  return { points, amplitudeMm: 2, spacingMm: 4 };
}

export function applyBreak(curves: readonly ClipCurve[], specs: BreakSpec | readonly BreakSpec[]): BreakResult {
  if (!('axis' in specs)) {
    if (specs.length !== 1 || specs[0] === undefined) return { ok: false, message: '破断区間は1つだけ指定してください。' };
    return applyBreak(curves, specs[0]);
  }
  const spec = specs;
  if (![spec.from, spec.to, spec.keepGap].every(Number.isFinite) || !(spec.to > spec.from) || spec.keepGap < 0 || spec.keepGap >= spec.to - spec.from) return { ok: false, message: '破断区間を正しく指定してください。' };
  const allPoints = curves.flatMap((curve) => curve.kind === 'segment' ? [curve.from, curve.to] : curve.kind === 'polyline' ? curve.points : [
    [curve.center[0] - curve.radius, curve.center[1] - curve.radius] as Point2, [curve.center[0] + curve.radius, curve.center[1] + curve.radius] as Point2,
  ]);
  const values = allPoints.map((point) => coordinate(point, spec.axis));
  if (values.length === 0 || spec.to <= Math.min(...values) || spec.from >= Math.max(...values)) {
    const emptyLine = zigzag(spec.axis, spec.from, 0, 0);
    return { ok: true, curves, breakLines: [emptyLine, emptyLine] };
  }
  const perpendicular = allPoints.map((point) => coordinate(point, spec.axis === 'u' ? 'v' : 'u'));
  const low = Math.min(...perpendicular); const high = Math.max(...perpendicular);
  const region = (from: number, to: number) => ({
    kind: 'polygon' as const,
    points: [[from, low - 1], [to, low - 1], [to, high + 1], [from, high + 1]]
      .map(([along, across]): Point2 => spec.axis === 'u' ? [along, across] : [across, along]),
  });
  const before = region(Math.min(...values) - 1, spec.from);
  const after = region(spec.to, Math.max(...values) + 1);
  const shift = (curve: ClipCurve): ClipCurve => {
    if (curve.kind === 'segment') return { ...curve, from: moved(curve.from, spec), to: moved(curve.to, spec) };
    if (curve.kind === 'polyline') return { ...curve, points: curve.points.map((point) => moved(point, spec)) };
    // The arc center can lie inside the removed strip; the entire retained fragment moves together.
    const amount = spec.to - spec.from - spec.keepGap;
    const center: Point2 = spec.axis === 'u' ? [curve.center[0] - amount, curve.center[1]] : [curve.center[0], curve.center[1] - amount];
    return { ...curve, center };
  };
  const mapped = curves.flatMap((curve) => [...clipCurves([curve], before), ...clipCurves([curve], after).map(shift)]);
  return { ok: true, curves: mapped, breakLines: [zigzag(spec.axis, spec.from, low, high), zigzag(spec.axis, spec.from + spec.keepGap, low, high)] };
}
