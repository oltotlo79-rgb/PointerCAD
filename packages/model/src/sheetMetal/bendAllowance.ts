/** 曲げの中立面長と内外寸の換算（P10-2）。 */
export interface SheetBendInput {
  /** mm */ readonly thickness: number;
  /** mm、内側 */ readonly radius: number;
  /** 中立面までの厚み比、無次元 */ readonly kFactor: number;
  /** 平板からの曲げ量、符号は右手系、degree */ readonly angle: number;
}
export interface SheetBendMetrics {
  readonly bendAllowance: number;
  readonly bendDeduction: number;
  readonly outerSetback: number;
  readonly innerSetback: number;
  readonly neutralRadius: number;
}
export type SheetBendError = 'nonFinite' | 'thickness' | 'radius' | 'kFactor' | 'angle' | 'legTooShort';
export type SheetBendResult = { readonly ok: true; readonly metrics: SheetBendMetrics }
  | { readonly ok: false; readonly error: SheetBendError };

/** 展開長の契約。形状体積の評価にK係数を使わない。 */
export function sheetBendMetrics(input: SheetBendInput): SheetBendResult {
  const { thickness: t, radius: r, kFactor: k, angle } = input;
  if (![t, r, k, angle].every(Number.isFinite)) return { ok: false, error: 'nonFinite' };
  if (t <= 0) return { ok: false, error: 'thickness' };
  if (r <= 0) return { ok: false, error: 'radius' };
  if (k < 0 || k > 0.5) return { ok: false, error: 'kFactor' };
  if (Math.abs(angle) >= 180) return { ok: false, error: 'angle' };
  const radians = Math.abs(angle) * Math.PI / 180, neutralRadius = r + k * t;
  const bendAllowance = radians * neutralRadius, tangent = Math.tan(radians / 2);
  const outerSetback = (r + t) * tangent, innerSetback = r * tangent;
  const bendDeduction = 2 * outerSetback - bendAllowance;
  if (![bendAllowance, bendDeduction, outerSetback, innerSetback, neutralRadius].every(Number.isFinite)) return { ok: false, error: 'nonFinite' };
  return { ok: true, metrics: { bendAllowance, bendDeduction, outerSetback, innerSetback, neutralRadius } };
}

/** 外/内の仮想交点からの寸法と接線直線長を、曖昧な自動推定なしで変換する。 */
export function sheetStraightLength(length: number, basis: 'tangent' | 'outer' | 'inner', metrics: SheetBendMetrics): number | null {
  if (!Number.isFinite(length) || length <= 0) return null;
  const setback = basis === 'outer' ? metrics.outerSetback : basis === 'inner' ? metrics.innerSetback : 0;
  const straight = length - setback;
  return Number.isFinite(straight) && straight > 0 ? straight : null;
}

export function sheetDevelopedLength(input: SheetBendInput, first: number, second: number, basis: 'tangent' | 'outer' | 'inner'):
  { readonly ok: true; readonly length: number; readonly straightLengths: readonly [number, number]; readonly metrics: SheetBendMetrics }
  | { readonly ok: false; readonly error: SheetBendError } {
  const result = sheetBendMetrics(input); if (!result.ok) return result;
  const a = sheetStraightLength(first, basis, result.metrics), b = sheetStraightLength(second, basis, result.metrics);
  if (a === null || b === null) return { ok: false, error: 'legTooShort' };
  const length = a + b + result.metrics.bendAllowance;
  if (!Number.isFinite(length)) return { ok: false, error: 'nonFinite' };
  return { ok: true, length, straightLengths: [a, b], metrics: result.metrics };
}
