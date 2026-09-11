/** 展開輪郭を円筒面の(u=角度,v=軸方向mm)へ厳密に写す。 */
import type { Handle_Geom2d_Curve, OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import type { CurveSpec, Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';
import { bsplineDataForSpline, type BSplineData } from './makeSplineEdge.js';

interface WeightedCurve extends BSplineData { readonly weights?: readonly number[] }
export interface CylinderProfileCurve {
  readonly curve: Handle_Geom2d_Curve;
  /** 有限直線の端はEdge構築へ渡す。TrimmedCurveの重複所有を作らない。 */
  readonly bounds?: readonly [number, number];
}
function conicSpans(curve: Extract<CurveSpec, { kind: 'arc' | 'ellipse' }>): readonly WeightedCurve[] {
  const major = curve.kind === 'arc' ? curve.xAxis : curve.majorAxis, n = curve.normal;
  const minor: Vec3Tuple = [n[1] * major[2] - n[2] * major[1], n[2] * major[0] - n[0] * major[2], n[0] * major[1] - n[1] * major[0]];
  const a = curve.kind === 'arc' ? curve.radius : curve.majorRadius, b = curve.kind === 'arc' ? curve.radius : curve.minorRadius;
  const start = curve.startAngle ?? 0, sweep = (curve.endAngle ?? 2 * Math.PI) - start;
  if (![...curve.center, ...major, ...minor, a, b, start, sweep].every(Number.isFinite)
    || Math.min(a, b) <= 1e-7 || Math.abs(sweep) <= 1e-12 || Math.abs(sweep) > 2 * Math.PI + 1e-9)
    throw new Error('円筒へ写す円弧・楕円の半径と角度を確認してください。');
  const count = Math.ceil(Math.abs(sweep) / (Math.PI / 2)), result: WeightedCurve[] = [];
  const point = (angle: number, weight = 1): Vec3Tuple => [
    curve.center[0] + (a * Math.cos(angle) * major[0] + b * Math.sin(angle) * minor[0]) / weight,
    curve.center[1] + (a * Math.cos(angle) * major[1] + b * Math.sin(angle) * minor[1]) / weight,
    curve.center[2] + (a * Math.cos(angle) * major[2] + b * Math.sin(angle) * minor[2]) / weight,
  ];
  for (let i = 0; i < count; i++) {
    const from = start + sweep * i / count, to = start + sweep * (i + 1) / count, weight = Math.cos((to - from) / 2);
    result.push({ poles: [point(from), point((from + to) / 2, weight), point(to)], weights: [1, weight, 1],
      knots: [0, 1], multiplicities: [3, 3], degree: 2, periodic: false });
  }
  return result;
}

/** 線・円弧・楕円・スプラインの種類を近似折線へ落とさず、UVのNURBSに変換する。 */
export function cylinderProfileCurves(
  oc: OpenCascadeInstance, curve: CurveSpec, neutralRadius: number, direction: -1 | 1, keep: Allocations['keep'],
): readonly CylinderProfileCurve[] {
  if (curve.kind === 'segment') {
    if (![...curve.from, ...curve.to].every(Number.isFinite) || Math.abs(curve.from[2]) > 1e-7 || Math.abs(curve.to[2]) > 1e-7)
      throw new Error('曲げ輪郭は展開面の上へ置いてください。');
    // UVの直線をBSplineに変換すると、円筒の母線・円弧まで近似曲線となる。
    // 有限な直線のまま渡し、軸平行の切欠きは厳密な円と直線を保持する。
    const from = keep(new oc.gp_Pnt2d_3(curve.from[1] / neutralRadius, direction * curve.from[0]));
    const du = (curve.to[1]-curve.from[1]) / neutralRadius, dv = direction * (curve.to[0]-curve.from[0]);
    const length = Math.hypot(du,dv);
    if (!Number.isFinite(length) || length <= 0) throw new Error('曲げ輪郭の線分が短すぎます。');
    // makeHelixEdgeと同じ所有方法。有限範囲はEdgeの引数にし、借用した曲線を解放しない。
    const along = keep(new oc.gp_Dir2d_4(du,dv)), line = keep(new oc.Geom2d_Line_3(from,along));
    const lineHandle = keep(new oc.Handle_Geom2d_Curve_2(line));
    return [{ curve: lineHandle, bounds: [0,length] }];
  }
  const data: readonly WeightedCurve[] = curve.kind === 'spline' ? [bsplineDataForSpline(curve)] : conicSpans(curve);
  return data.map((span) => {
    const poles = keep(new oc.TColgp_Array1OfPnt2d_2(1, span.poles.length));
    for (const [i, point] of span.poles.entries()) {
      if (!point.every(Number.isFinite) || Math.abs(point[2]) > 1e-7) throw new Error('曲げ輪郭は展開面の上へ置いてください。');
      poles.SetValue(i + 1, keep(new oc.gp_Pnt2d_3(point[1] / neutralRadius, direction * point[0])));
    }
    const knots = keep(new oc.TColStd_Array1OfReal_2(1, span.knots.length));
    const mult = keep(new oc.TColStd_Array1OfInteger_2(1, span.multiplicities.length));
    span.knots.forEach((value, i) => knots.SetValue(i + 1, value));
    span.multiplicities.forEach((value, i) => mult.SetValue(i + 1, value));
    if (span.weights === undefined) {
      const spline = keep(new oc.Geom2d_BSplineCurve_1(poles, knots, mult, span.degree, span.periodic));
      return { curve: keep(new oc.Handle_Geom2d_Curve_2(spline)) };
    }
    const weights = keep(new oc.TColStd_Array1OfReal_2(1, span.weights.length));
    span.weights.forEach((value, i) => weights.SetValue(i + 1, value));
    const spline = keep(new oc.Geom2d_BSplineCurve_2(poles, weights, knots, mult, span.degree, span.periodic));
    return { curve: keep(new oc.Handle_Geom2d_Curve_2(spline)) };
  });
}
