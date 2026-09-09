import type { DimensionKind, DimensionMeasurement } from '@pointercad/drawing';
import type { ResolvedDimensionTarget } from './dimensionTarget.js';

export interface SuggestedDimensionKind {
  readonly kind: DimensionKind;
  readonly measurement: DimensionMeasurement;
}

/** 選択の順によらず同じ寸法を推奨し、対応しない組を暗黙に別対象へ置き換えない(P8-26)。 */
export function suggestDimensionKind(
  targets: readonly ResolvedDimensionTarget[], requested?: 'arcLength',
): SuggestedDimensionKind | null {
  const first = targets[0];
  if (first === undefined) return null;
  if (targets.length === 1) {
    if (requested === 'arcLength') return first.kind === 'arc' || first.kind === 'circle' ? { kind: 'arcLength', measurement: 'radius' } : null;
    if (first.kind === 'line') return { kind: 'length', measurement: 'trueDistance' };
    if (first.kind === 'circle') return { kind: 'diameter', measurement: 'radius' };
    if (first.kind === 'arc') return { kind: 'radius', measurement: 'radius' };
    if (first.kind === 'sphere') return { kind: 'sphereDiameter', measurement: 'radius' };
    return null;
  }
  if (targets.length !== 2 || requested !== undefined) return null;
  const second = targets[1];
  if (first.kind === 'point' && second.kind === 'point') return { kind: 'length', measurement: 'trueDistance' };
  if (first.kind === 'line' && second.kind === 'line') {
    const a = first.to.map((value, index) => value - first.from[index]);
    const b = second.to.map((value, index) => value - second.from[index]);
    const length = Math.hypot(...a) * Math.hypot(...b);
    if (length <= 0 || !Number.isFinite(length)) return null;
    const cosine = Math.abs(a.reduce((sum, value, index) => sum + value * b[index], 0) / length);
    return 1 - cosine <= 1e-7 ? { kind: 'length', measurement: 'trueDistance' } : { kind: 'angle', measurement: 'angle' };
  }
  return null;
}
