import type { InkBounds, SemanticTextMetrics } from '../render/types.js';
import type { DrawingExpressionValue, Point2 } from '../types.js';
import type { DimensionTolerance } from './types.js';
import { dimensionDecimals, dimensionNumberText, signedDimensionNumberText } from './numberText.js';

export type ResolvedDimensionTolerance =
  | { readonly kind: 'symmetric'; readonly value: number }
  | { readonly kind: 'deviation'; readonly upper: number; readonly lower: number };

/** 式の再評価はmodelの責務。ここは式を失わず、その最新評価値を読む。 */
function toleranceNumber(value: number | DrawingExpressionValue): number {
  return typeof value === 'number' ? value : value.value;
}

export function resolveDimensionTolerance(tolerance: DimensionTolerance): ResolvedDimensionTolerance | null {
  if (tolerance.kind === 'symmetric') {
    const value = toleranceNumber(tolerance.value);
    return Number.isFinite(value) && value >= 0 ? { kind: 'symmetric', value } : null;
  }
  const upper = toleranceNumber(tolerance.upper);
  const lower = toleranceNumber(tolerance.lower);
  return Number.isFinite(upper) && Number.isFinite(lower) && upper >= lower
    ? { kind: 'deviation', upper, lower } : null;
}

/** 上下偏差の高さ比はP8 §2.12の慣用値。JISの規定値としては要確認。 */
export const TOLERANCE_TEXT_HEIGHT_RATIO = 0.7;

export interface ToleranceTextRun {
  readonly text: string;
  /** 左揃え・alphabetic baselineの紙上位置。 */
  readonly position: Point2;
  readonly metrics: SemanticTextMetrics;
}

export interface ToleranceTextLayout {
  readonly runs: readonly ToleranceTextRun[];
  readonly inkBounds: InkBounds;
  readonly advanceMm: number;
}

export type MeasureDimensionText = (text: string, sizeMm: number) => SemanticTextMetrics | null;

function validMetrics(metrics: SemanticTextMetrics | null): metrics is SemanticTextMetrics {
  if (metrics === null) return false;
  const bounds = metrics.inkBounds;
  return [metrics.advanceMm, metrics.sizeMm, bounds.left, bounds.bottom, bounds.right, bounds.top].every(Number.isFinite)
    && metrics.advanceMm >= 0 && metrics.sizeMm > 0 && bounds.left <= bounds.right && bounds.bottom <= bounds.top;
}

function runBounds(run: ToleranceTextRun): InkBounds {
  const { left, bottom, right, top } = run.metrics.inkBounds;
  return { left: left + run.position[0], bottom: bottom + run.position[1],
    right: right + run.position[0], top: top + run.position[1] };
}

/** 寸法値+公差の実測字体による配置。未読込時に文字数で幅を推測しない。 */
export function layoutDimensionTolerance(input: {
  readonly mainText: string;
  readonly suffix?: string;
  readonly reference?: boolean;
  readonly tolerance: DimensionTolerance;
  readonly sizeMm: number;
  readonly decimals?: number;
  readonly measure: MeasureDimensionText;
}): ToleranceTextLayout | null {
  const tolerance = resolveDimensionTolerance(input.tolerance);
  if (tolerance === null || !Number.isFinite(input.sizeMm) || input.sizeMm <= 0) return null;
  const decimals = dimensionDecimals(input.decimals);
  const mainText = `${input.reference === true ? '(' : ''}${input.mainText}`;
  const suffixText = `${input.suffix ?? ''}${input.reference === true ? ')' : ''}`;
  if (tolerance.kind === 'symmetric') {
    const text = `${mainText}±${dimensionNumberText(tolerance.value, decimals)}${suffixText}`;
    const metrics = input.measure(text, input.sizeMm);
    return validMetrics(metrics)
      ? { runs: [{ text, metrics, position: [0, 0] }], inkBounds: metrics.inkBounds, advanceMm: metrics.advanceMm }
      : null;
  }
  const main = input.measure(mainText, input.sizeMm);
  const upperText = signedDimensionNumberText(tolerance.upper, decimals);
  const lowerText = signedDimensionNumberText(tolerance.lower, decimals);
  const smallSize = input.sizeMm * TOLERANCE_TEXT_HEIGHT_RATIO;
  const upper = input.measure(upperText, smallSize);
  const lower = input.measure(lowerText, smallSize);
  if (!validMetrics(main) || !validMetrics(upper) || !validMetrics(lower)) return null;
  // 墨の範囲から2段を組み、その中心を寸法値の墨の中央へ揃える。
  const gap = input.sizeMm * 0.1;
  const totalHeight = upper.inkBounds.top - upper.inkBounds.bottom + gap + lower.inkBounds.top - lower.inkBounds.bottom;
  const bottom = (main.inkBounds.top + main.inkBounds.bottom - totalHeight) / 2;
  const lowerBaseline = bottom - lower.inkBounds.bottom;
  const upperBaseline = bottom + lower.inkBounds.top - lower.inkBounds.bottom + gap - upper.inkBounds.bottom;
  const x = Math.max(main.advanceMm, main.inkBounds.right) + gap - Math.min(upper.inkBounds.left, lower.inkBounds.left);
  const runs: ToleranceTextRun[] = [
    { text: mainText, position: [0, 0], metrics: main },
    { text: upperText, position: [x, upperBaseline], metrics: upper },
    { text: lowerText, position: [x, lowerBaseline], metrics: lower },
  ];
  let advanceMm = Math.max(main.advanceMm, x + upper.advanceMm, x + lower.advanceMm);
  if (suffixText !== '') {
    const suffix = input.measure(suffixText, input.sizeMm);
    if (!validMetrics(suffix)) return null;
    const suffixX = Math.max(advanceMm, x + upper.inkBounds.right, x + lower.inkBounds.right) + gap - Math.min(0, suffix.inkBounds.left);
    runs.push({ text: suffixText, position: [suffixX, 0], metrics: suffix });
    advanceMm = suffixX + suffix.advanceMm;
  }
  const bounds = runs.map(runBounds);
  return { runs, advanceMm,
    inkBounds: { left: Math.min(...bounds.map((item) => item.left)), bottom: Math.min(...bounds.map((item) => item.bottom)),
      right: Math.max(...bounds.map((item) => item.right)), top: Math.max(...bounds.map((item) => item.top)) } };
}
