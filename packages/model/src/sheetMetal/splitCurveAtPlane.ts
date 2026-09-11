/** 曲げの接線やリリーフの境界で曲線を分ける。座標標本を輪郭として保存しない。 */
import { curvePointAt } from '../sketch/intersectionMath.js';
import type { ResolvedCurve } from '../sketch/types.js';
import { crossVec3, dotVec3, lengthVec3, subVec3, type Vec3 } from '../sketch/vec3.js';
import { sheetBezierPlaneRoots, sheetBezierSpans, trimSheetBezier } from './bezierSpans.js';
import type { SheetGeometryResult } from './panelGeometry.js';

export interface SheetSplitPlane { readonly origin: Vec3; readonly normal: Vec3 }
export interface SheetCurvePiece {
  readonly curve: ResolvedCurve; readonly side: -1 | 0 | 1;
  /** 元の解決曲線に対する0〜1の区間。スプラインの節点区間もこの尺度を保つ。 */
  readonly from: number; readonly to: number;
}
const TOLERANCE_MM = 1e-7;
function sideOf(value: number): -1 | 0 | 1 { return Math.abs(value) <= TOLERANCE_MM ? 0 : value < 0 ? -1 : 1; }
function conicCuts(curve: Extract<ResolvedCurve, { kind: 'arc' | 'ellipse' }>, plane: SheetSplitPlane): readonly number[] {
  const major = curve.kind === 'arc' ? curve.xAxis : curve.majorAxis, minor = crossVec3(curve.normal, major);
  const a = dotVec3(major, plane.normal) * (curve.kind === 'arc' ? curve.radius : curve.majorRadius);
  const b = dotVec3(minor, plane.normal) * (curve.kind === 'arc' ? curve.radius : curve.minorRadius);
  const offset = dotVec3(subVec3(curve.center, plane.origin), plane.normal), amplitude = Math.hypot(a, b);
  if (amplitude === 0 || Math.abs(offset) > amplitude) return [];
  const phase = Math.atan2(b, a), angle = Math.acos(Math.max(-1, Math.min(1, -offset / amplitude)));
  const start = curve.startAngle, sweep = curve.endAngle - start, low = Math.min(start, curve.endAngle), high = Math.max(start, curve.endAngle);
  if (Math.abs(sweep) <= Number.EPSILON || Math.abs(sweep) > 2 * Math.PI + 1e-9) return [];
  const roots: number[] = [];
  for (const base of [phase - angle, phase + angle]) {
    const first = Math.ceil((low - base) / (2 * Math.PI)), last = Math.floor((high - base) / (2 * Math.PI));
    // 1周の解析曲線なので、巨大な角度入力でもループを増やさない。
    for (let period = 0; period <= Math.min(2, last - first); period++) {
      const t = (base + (first + period) * 2 * Math.PI - start) / sweep;
      if (t > 1e-12 && t < 1 - 1e-12) roots.push(t);
    }
  }
  return [...new Set(roots)].sort((x, y) => x - y);
}

export function splitSheetCurveAtPlane(curve: ResolvedCurve, plane: SheetSplitPlane): SheetGeometryResult<readonly SheetCurvePiece[]> {
  if (![...plane.origin, ...plane.normal].every(Number.isFinite) || Math.abs(lengthVec3(plane.normal) - 1) > 1e-10)
    return { ok: false, message: '輪郭を分ける面の位置と向きを確認してください。' };
  if (curve.kind === 'segment' && ![...curve.from, ...curve.to].every(Number.isFinite))
    return { ok: false, message: '曲げる線分に非有限の座標があります。' };
  if (curve.kind === 'arc' || curve.kind === 'ellipse') {
    const axis = curve.kind === 'arc' ? curve.xAxis : curve.majorAxis;
    const radii = curve.kind === 'arc' ? [curve.radius] : [curve.majorRadius, curve.minorRadius];
    const sweep = curve.endAngle - curve.startAngle;
    if (![...curve.center, ...curve.normal, ...axis, ...radii, curve.startAngle, curve.endAngle, sweep].every(Number.isFinite)
      || radii.some((radius) => radius <= TOLERANCE_MM) || Math.abs(sweep) <= Number.EPSILON || Math.abs(sweep) > 2 * Math.PI + 1e-9
      || Math.abs(lengthVec3(curve.normal) - 1) > 1e-10 || Math.abs(lengthVec3(axis) - 1) > 1e-10 || Math.abs(dotVec3(axis, curve.normal)) > 1e-10)
      return { ok: false, message: '曲げる円弧・楕円の半径と座標を確認してください。' };
  }
  const signed = (point: Vec3) => dotVec3(subVec3(point, plane.origin), plane.normal);
  const pieces: SheetCurvePiece[] = [];
  if (curve.kind === 'spline') {
    const spans = sheetBezierSpans(curve); if (spans === null) return { ok: false, message: '曲げるスプラインの形を解決できません。' };
    for (const span of spans) {
      const distances = span.poles.map(signed);
      if (!distances.every(Number.isFinite)) return { ok: false, message: '曲げる輪郭の座標が扱える範囲を超えています。' };
      const cuts = [0, ...sheetBezierPlaneRoots([distances[0], distances[1], distances[2], distances[3]]), 1];
      for (let i = 1; i < cuts.length; i++) {
        const from = cuts[i - 1], to = cuts[i]; if (to - from <= 1e-12) continue;
        const trimmed: ResolvedCurve = { kind: 'spline', featureId: curve.featureId, mode: 'control', closed: false, points: trimSheetBezier(span.poles, from, to) };
        pieces.push({ curve: trimmed, side: sideOf(signed(curvePointAt(trimmed, 0.5))), from: span.from + (span.to - span.from) * from,
          to: span.from + (span.to - span.from) * to });
      }
    }
  } else {
    const cuts = curve.kind === 'segment' ? (() => {
      const a = signed(curve.from), b = signed(curve.to), ratio = a / (a - b);
      return ratio > 1e-12 && ratio < 1 - 1e-12 ? [ratio] : [];
    })() : conicCuts(curve, plane);
    const ordered = [0, ...cuts, 1];
    for (let i = 1; i < ordered.length; i++) {
      const from = ordered[i - 1], to = ordered[i]; if (to - from <= 1e-12) continue;
      const trimmed: ResolvedCurve = curve.kind === 'segment'
        ? { ...curve, from: curvePointAt(curve, from), to: curvePointAt(curve, to) }
        : { ...curve, startAngle: curve.startAngle + (curve.endAngle - curve.startAngle) * from,
          endAngle: curve.startAngle + (curve.endAngle - curve.startAngle) * to };
      const distance = signed(curvePointAt(trimmed, 0.5));
      if (!Number.isFinite(distance)) return { ok: false, message: '曲げる輪郭に非有限の座標があります。' };
      pieces.push({ curve: trimmed, side: sideOf(distance), from, to });
    }
  }
  return { ok: true, value: pieces };
}
