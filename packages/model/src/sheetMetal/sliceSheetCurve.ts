/** 分割後も元の解析曲線の種類を保つ。スプラインは節点区間の厳密なBezier曲線へ分ける。 */
import { curvePointAt } from '../sketch/intersectionMath.js';
import type { ResolvedCurve } from '../sketch/types.js';
import { sheetBezierSpans, trimSheetBezier } from './bezierSpans.js';
import type { SheetGeometryResult } from './panelGeometry.js';

export function sliceSheetCurve(curve: ResolvedCurve, from: number, to: number): SheetGeometryResult<readonly ResolvedCurve[]> {
  if (![from, to].every(Number.isFinite) || from < 0 || to > 1 || from >= to)
    return { ok: false, message: '切欠きで分ける輪郭の区間を確認してください。' };
  if (from === 0 && to === 1) return { ok: true, value: [curve] };
  if (curve.kind === 'segment') return { ok: true, value: [{ ...curve, from: curvePointAt(curve, from), to: curvePointAt(curve, to) }] };
  if (curve.kind !== 'spline') {
    const sweep = curve.endAngle - curve.startAngle;
    return { ok: true, value: [{ ...curve, startAngle: curve.startAngle + sweep * from, endAngle: curve.startAngle + sweep * to }] };
  }
  const spans = sheetBezierSpans(curve); if (spans === null) return { ok: false, message: '切欠きと交差するスプラインを解決できません。' };
  return { ok: true, value: spans.flatMap((span): readonly ResolvedCurve[] => {
    const a = Math.max(from, span.from), b = Math.min(to, span.to); if (b <= a) return [];
    return [{ kind: 'spline', featureId: curve.featureId, mode: 'control', closed: false,
      points: trimSheetBezier(span.poles, (a - span.from) / (span.to - span.from), (b - span.from) / (span.to - span.from)) }];
  }) };
}
