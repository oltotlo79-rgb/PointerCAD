/** FR-334/436: all function formats require a finite, explicit XYZ clipping box in mm. */
import type { Vec3 } from '../sketch/vec3.js';

export const FUNCTION_PLOT_AXES = ['X', 'Y', 'Z'] as const;
export type FunctionPlotAxis = typeof FUNCTION_PLOT_AXES[number];
export interface FunctionPlotInterval { readonly min: number; readonly max: number }
export type FunctionPlotBoundsData = Readonly<Record<FunctionPlotAxis, FunctionPlotInterval>>;
export interface FunctionPlotBoundsIssue {
  readonly axis: FunctionPlotAxis;
  readonly field: 'min' | 'max' | 'range';
  readonly reason: 'required' | 'not-finite-real' | 'order' | 'unrepresentable-span';
}
export type FunctionPlotBoundsResult =
  | { readonly ok: true; readonly bounds: FunctionPlotBounds }
  | { readonly ok: false; readonly issues: readonly FunctionPlotBoundsIssue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The private constructor prevents callers from treating an unchecked DTO as a validated box.
 * Worker/JSON transfers use toJSON() and must run read() again at the receiving boundary.
 * T/U/V domains and a fixed plane coordinate are intentionally absent from this contract.
 */
export class FunctionPlotBounds {
  private constructor(private readonly limits: FunctionPlotBoundsData) { Object.freeze(this); }

  static read(input: unknown): FunctionPlotBoundsResult {
    const issues: FunctionPlotBoundsIssue[] = [];
    const readAxis = (axis: FunctionPlotAxis): FunctionPlotInterval | null => {
      const candidate: unknown = isRecord(input) ? input[axis] : undefined;
      const readEnd = (field: 'min' | 'max'): number | null => {
        const value: unknown = isRecord(candidate) ? candidate[field] : undefined;
        if (value === undefined || value === null || value === '') {
          issues.push({ axis, field, reason: 'required' });
          return null;
        }
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          issues.push({ axis, field, reason: 'not-finite-real' });
          return null;
        }
        return value;
      };
      const min = readEnd('min'), max = readEnd('max');
      if (min === null || max === null) return null;
      if (min >= max) { issues.push({ axis, field: 'range', reason: 'order' }); return null; }
      if (!Number.isFinite(max - min)) {
        issues.push({ axis, field: 'range', reason: 'unrepresentable-span' });
        return null;
      }
      return Object.freeze({ min, max });
    };
    const X = readAxis('X'), Y = readAxis('Y'), Z = readAxis('Z');
    if (X === null || Y === null || Z === null) return { ok: false, issues };
    return { ok: true, bounds: new FunctionPlotBounds(Object.freeze({ X, Y, Z })) };
  }

  interval(axis: FunctionPlotAxis): FunctionPlotInterval { return this.limits[axis]; }

  /** Inclusive boundaries; no coordinate clamping that would move a point off the function. */
  contains(point: Vec3): boolean {
    return FUNCTION_PLOT_AXES.every((axis, index) => {
      const value = point[index], interval = this.limits[axis];
      return Number.isFinite(value) && value >= interval.min && value <= interval.max;
    });
  }

  toJSON(): FunctionPlotBoundsData { return this.limits; }
}
