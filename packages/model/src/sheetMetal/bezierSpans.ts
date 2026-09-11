/** 3次以下のBスプラインを各節点区間の厳密なBezier極へ変換する。折線化・再近似をしない。 */
import { splineCurveData, splinePointAt } from '../sketch/splineMath.js';
import type { ResolvedSpline } from '../sketch/types.js';
import { addVec3, lerpVec3, scaleVec3, subVec3, type Vec3 } from '../sketch/vec3.js';

export type CubicPoles = readonly [Vec3, Vec3, Vec3, Vec3];
export interface SheetBezierSpan { readonly poles: CubicPoles; readonly from: number; readonly to: number }
export function sheetBezierSpans(curve: ResolvedSpline): readonly SheetBezierSpan[] | null {
  const data = splineCurveData(curve); if (data === null) return null;
  const start = data.knots[0], end = data.periodic ? data.knots[data.poles.length] : data.knots[data.knots.length - 1];
  if (!Number.isFinite(end - start) || end <= start) return null;
  const spans: SheetBezierSpan[] = [];
  for (let i = 1; i < data.knots.length; i++) {
    const from = (data.knots[i - 1] - start) / (end - start), to = (data.knots[i] - start) / (end - start);
    if (from < 0 || to > 1 || to <= from) continue;
    const p0 = splinePointAt(data, from), p3 = splinePointAt(data, to), delta = subVec3(p3, p0);
    const a = subVec3(scaleVec3(subVec3(splinePointAt(data, from + (to - from) / 3), p0), 27), delta);
    const b = subVec3(scaleVec3(subVec3(splinePointAt(data, from + (to - from) * 2 / 3), p0), 27), scaleVec3(delta, 8));
    const poles: CubicPoles = [p0, addVec3(p0, scaleVec3(subVec3(scaleVec3(a, 2), b), 1 / 18)),
      addVec3(p0, scaleVec3(subVec3(scaleVec3(b, 2), a), 1 / 18)), p3];
    if (!poles.every((point) => point.every(Number.isFinite))) return null;
    spans.push({ poles, from, to });
  }
  return spans.length === 0 ? null : spans;
}

/** de Casteljauで形を保ったまま区間を切る。両端も元曲線上の点になる。 */
export function splitSheetBezier(poles: CubicPoles, at: number): readonly [CubicPoles, CubicPoles] {
  const a = lerpVec3(poles[0], poles[1], at), b = lerpVec3(poles[1], poles[2], at), c = lerpVec3(poles[2], poles[3], at);
  const d = lerpVec3(a, b, at), e = lerpVec3(b, c, at), point = lerpVec3(d, e, at);
  return [[poles[0], a, d, point], [point, e, c, poles[3]]];
}
export function trimSheetBezier(poles: CubicPoles, from: number, to: number): CubicPoles {
  const prefix = to === 1 ? poles : splitSheetBezier(poles, to)[0];
  return from === 0 ? prefix : splitSheetBezier(prefix, from / to)[1];
}

/** 極を平面へ射影した3次式。導関数で単調区間に分け、接する根も見落とさない。 */
export function sheetBezierPlaneRoots(values: readonly [number, number, number, number]): readonly number[] {
  const magnitude = Math.max(...values.map(Math.abs));
  if (magnitude === 0 || !Number.isFinite(magnitude)) return [];
  const [p0, p1, p2, p3] = values.map((value) => value / magnitude);
  const c0 = p0, c1 = 3 * (p1 - p0), c2 = 3 * (p0 - 2 * p1 + p2), c3 = -p0 + 3 * p1 - 3 * p2 + p3;
  const evaluate = (t: number) => ((c3 * t + c2) * t + c1) * t + c0;
  const cuts = [0, 1], a = 3 * c3, b = 2 * c2, c = c1;
  if (Math.abs(a) < 1e-15) { if (Math.abs(b) >= 1e-15) cuts.push(-c / b); }
  else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(discriminant));
      if (q === 0) cuts.push(-b / (2 * a)); else cuts.push(q / a, c / q);
    }
  }
  const ordered = [...new Set(cuts.filter((t) => t >= 0 && t <= 1))].sort((x, y) => x - y), roots: number[] = [];
  for (const cut of ordered) if (Math.abs(evaluate(cut)) <= 2e-14) roots.push(cut);
  for (let i = 1; i < ordered.length; i++) {
    let left = ordered[i - 1], right = ordered[i], leftValue = evaluate(left);
    if (leftValue * evaluate(right) >= 0) continue;
    for (let iteration = 0; iteration < 60; iteration++) {
      const middle = (left + right) / 2, value = evaluate(middle);
      if (value === 0) { left = middle; right = middle; break; }
      if (Math.sign(value) === Math.sign(leftValue)) { left = middle; leftValue = value; } else right = middle;
    }
    roots.push((left + right) / 2);
  }
  return [...new Set(roots)].filter((t) => t > 1e-12 && t < 1 - 1e-12).sort((x, y) => x - y);
}
