/** Persistent function definitions keep source expressions; sampled coordinates are derived. */
import type { ExpressionValue, StoredMathExpression } from '@pointercad/expression';
import type { FunctionPlotAxis } from './functionPlotBounds.js';

export const FUNCTION_DEFINITION_FORMAT = 'pointercad-function/1' as const;
export interface FunctionInputRange { readonly min: ExpressionValue; readonly max: ExpressionValue }
export type FunctionCoordinateRanges = Readonly<Record<FunctionPlotAxis, FunctionInputRange>>;
export type FunctionCoordinates = Readonly<Record<FunctionPlotAxis, StoredMathExpression>>;
export type CoordinateCurveFormula =
  | { readonly kind: 'coordinate-curve'; readonly independent: 'X'; readonly outputs: Readonly<Pick<FunctionCoordinates, 'Y' | 'Z'>> }
  | { readonly kind: 'coordinate-curve'; readonly independent: 'Y'; readonly outputs: Readonly<Pick<FunctionCoordinates, 'X' | 'Z'>> }
  | { readonly kind: 'coordinate-curve'; readonly independent: 'Z'; readonly outputs: Readonly<Pick<FunctionCoordinates, 'X' | 'Y'>> };
export type FunctionFormula =
  | CoordinateCurveFormula
  | { readonly kind: 'parametric-curve'; readonly outputs: FunctionCoordinates; readonly T: FunctionInputRange }
  | { readonly kind: 'implicit-curve'; readonly expression: StoredMathExpression;
      readonly fixedAxis: FunctionPlotAxis; readonly fixedCoordinate: ExpressionValue }
  | { readonly kind: 'coordinate-surface'; readonly output: FunctionPlotAxis; readonly expression: StoredMathExpression }
  | { readonly kind: 'parametric-surface'; readonly outputs: FunctionCoordinates;
      readonly U: FunctionInputRange; readonly V: FunctionInputRange }
  | { readonly kind: 'implicit-surface'; readonly expression: StoredMathExpression };

export interface FunctionDefinition {
  readonly format: typeof FUNCTION_DEFINITION_FORMAT;
  /** All six world-coordinate endpoints in mm, for every formula kind. Never inferred from T/U/V. */
  readonly bounds: FunctionCoordinateRanges;
  readonly formula: FunctionFormula;
  /** Geometric chord error requested in mm; numerical estimators are separately identified as estimates. */
  readonly tolerance: ExpressionValue;
}
