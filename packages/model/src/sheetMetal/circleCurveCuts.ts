/** 板金の長穴先端と輪郭の交差。円弧/楕円/スプラインを折線へ置き換えない。 */
import { arcPointAt, ellipsePointAt } from '../sketch/intersectionMath.js';
import type { ResolvedCurve } from '../sketch/types.js';
import { addVec3, crossVec3, dotVec3, lengthVec3, scaleVec3, subVec3, type Vec3 } from '../sketch/vec3.js';
import { bernsteinRoots, bernsteinValue, multiplyBernstein } from './bernsteinRoots.js';
import { sheetBezierSpans } from './bezierSpans.js';
import type { SheetGeometryResult } from './panelGeometry.js';

interface RationalSpan { readonly poles: readonly Vec3[]; readonly weights: readonly number[]; readonly parameter: (at: number) => number }
function spans(curve: ResolvedCurve): readonly RationalSpan[] | null {
  if (curve.kind === 'segment') return [{ poles: [curve.from, curve.to], weights: [1, 1], parameter: (at) => at }];
  if (curve.kind === 'spline') return sheetBezierSpans(curve)?.map((span) => ({ poles: span.poles, weights: [1, 1, 1, 1],
    parameter: (at: number) => span.from + (span.to - span.from) * at })) ?? null;
  const sweep = curve.endAngle - curve.startAngle, count = Math.ceil(Math.abs(sweep) / (Math.PI / 2));
  if (count < 1 || count > 4 || !Number.isFinite(sweep)) return null;
  const major = curve.kind === 'arc' ? curve.xAxis : curve.majorAxis, minor = crossVec3(curve.normal, major);
  const a = curve.kind === 'arc' ? curve.radius : curve.majorRadius, b = curve.kind === 'arc' ? curve.radius : curve.minorRadius;
  const pointAt = (angle: number) => curve.kind === 'arc' ? arcPointAt(curve, angle) : ellipsePointAt(curve, angle);
  return Array.from({ length: count }, (_, i): RationalSpan => {
    const from = curve.startAngle + sweep * i / count, to = curve.startAngle + sweep * (i + 1) / count;
    const weight = Math.cos((to - from) / 2), weights = [1, weight, 1];
    const poles = [pointAt(from), addVec3(curve.center, scaleVec3(subVec3(pointAt((from + to) / 2), curve.center), 1 / weight)), pointAt(to)];
    return { poles, weights, parameter: (at) => {
      const denominator = bernsteinValue(weights, at);
      const x = bernsteinValue(poles.map((point, index) => dotVec3(subVec3(point, curve.center), major) / a * weights[index]), at) / denominator;
      const y = bernsteinValue(poles.map((point, index) => dotVec3(subVec3(point, curve.center), minor) / b * weights[index]), at) / denominator;
      const theta = Math.atan2(y, x), delta = Math.atan2(Math.sin(theta - from), Math.cos(theta - from));
      return (from + delta - curve.startAngle) / sweep;
    } };
  });
}

export function sheetCurveCircleCuts(curve: ResolvedCurve, center: Vec3, radius: number, normal: Vec3): SheetGeometryResult<readonly number[]> {
  if (![...center, radius, ...normal].every(Number.isFinite) || radius <= 1e-7 || Math.abs(lengthVec3(normal) - 1) > 1e-10)
    return { ok: false, message: '切欠きの円の位置・半径・平面を確認してください。' };
  if (curve.kind === 'arc' && lengthVec3(subVec3(curve.center, center)) <= 1e-7 && Math.abs(curve.radius - radius) <= 1e-7)
    return { ok: false, message: '切欠きの円と輪郭が重なっています。位置か寸法を変更してください。' };
  const pieces = spans(curve); if (pieces === null) return { ok: false, message: '切欠きと交差する輪郭の形を解決できません。' };
  const result: number[] = [];
  for (const span of pieces) {
    const relative = span.poles.map((point, i) => scaleVec3(subVec3(point, center), span.weights[i] / radius));
    if (span.poles.some((point) => Math.abs(dotVec3(subVec3(point, center), normal)) > 1e-7))
      return { ok: false, message: '切欠きと輪郭を同じ平面に置いてください。' };
    const components = [0, 1, 2].map((axis) => relative.map((point) => point[axis]));
    const squares = components.map((component) => multiplyBernstein(component, component)), weights = multiplyBernstein(span.weights, span.weights);
    const polynomial = weights.map((value, i) => squares[0][i] + squares[1][i] + squares[2][i] - value);
    const roots = bernsteinRoots(polynomial);
    if (roots === null) return { ok: false, message: '切欠きの円と輪郭が重なっています。位置か寸法を変更してください。' };
    result.push(...roots.map(span.parameter));
  }
  return { ok: true, value: result.filter((value) => value >= -1e-12 && value <= 1 + 1e-12).map((value) => Math.max(0, Math.min(1, value)))
    .sort((a, b) => a - b).filter((value, i, sorted) => i === 0 || value - sorted[i - 1] > 16 * Number.EPSILON) };
}
