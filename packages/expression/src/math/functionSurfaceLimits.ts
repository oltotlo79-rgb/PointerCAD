/** Numeric sampler ceilings. The CAD caller can request smaller budgets before work begins. */
export const FUNCTION_SURFACE_LIMITS = Object.freeze({maximumSamples:200_000,maximumCells:400_000,maximumTriangles:200_000,maximumDepth:24});
export interface FunctionSurfaceBudget {
  readonly maximumSamples: number; readonly maximumCells: number; readonly maximumTriangles: number; readonly maximumDepth: number;
}
