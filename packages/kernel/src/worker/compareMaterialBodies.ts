import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations } from '../occt/allocations.js';
import { unionShapes } from '../occt/booleanOp.js';
import { compareMaterialRegions, MaterialComparisonCancelled, MaterialComparisonInputError,
  type MaterialComparison } from '../occt/compareMaterialRegions.js';
import type { CachedSolid, SolidCancelToken } from './recomputeSolids.js';
import { materialComparisonFailure, MaterialComparisonRejection, MAX_MATERIAL_COMPARISON_SOLIDS_PER_SIDE,
  reportMaterialComparisonFaults, type MaterialComparisonFailure, type MaterialComparisonFault,
  type ReportMaterialComparisonFaults } from './materialComparisonDiagnostic.js';

export type MaterialComparisonOutcome =
  | { readonly kind: 'compared'; readonly result: MaterialComparison }
  | { readonly kind: 'cancelled' }
  | MaterialComparisonFailure;

/** 形のリースはAPI側で確保する。ここでは借用した各版の全ボディを1つの材料集合へする。 */
export async function compareMaterialBodies(
  oc: OpenCascadeInstance, before: readonly CachedSolid[], after: readonly CachedSolid[], shouldCancel?: SolidCancelToken,
  reportFaults: ReportMaterialComparisonFaults = reportMaterialComparisonFaults,
): Promise<MaterialComparisonOutcome> {
  const allocations = createAllocations();
  const faults: MaterialComparisonFault[] = [];
  let outcome: MaterialComparisonOutcome;
  async function checkpoint(): Promise<void> {
    if (await shouldCancel?.()) throw new MaterialComparisonCancelled();
  }
  async function joined(bodies: readonly CachedSolid[]): Promise<TopoDS_Shape | null> {
    await checkpoint();
    if (bodies.length > MAX_MATERIAL_COMPARISON_SOLIDS_PER_SIDE) throw new MaterialComparisonRejection('solidLimit');
    if (bodies.length === 0) return null;
    for (const body of bodies) {
      if (body.shape.IsNull() || body.mesh.bodyKind !== 'solid') throw new MaterialComparisonRejection('requiresSolid');
    }
    if (bodies.length === 1) return bodies[0].shape;
    // 重なったボディの体積を二重に数えず、離れた全成分も同じ材料集合へ含める。
    const result = allocations.keep(unionShapes(oc, bodies.map(body => body.shape)));
    await checkpoint();
    return result.shape;
  }
  try {
    const beforeShape = await joined(before), afterShape = await joined(after);
    await checkpoint();
    const result = compareMaterialRegions(oc, beforeShape, afterShape);
    await checkpoint(); outcome = { kind: 'compared', result };
  } catch (error) {
    if (error instanceof MaterialComparisonCancelled) outcome = { kind: 'cancelled' };
    else if (error instanceof MaterialComparisonRejection) outcome = materialComparisonFailure(error.diagnostic);
    else if (error instanceof MaterialComparisonInputError) outcome = materialComparisonFailure(error.reason);
    else {
      faults.push({ stage: 'compare bodies', cause: error });
      outcome = materialComparisonFailure('internal');
    }
  } finally {
    try { allocations.release(); }
    catch (error) { faults.push({ stage: 'release joined shapes', cause: error }); }
  }
  if (faults.length > 0) {
    reportFaults(faults, outcome.kind === 'failed' ? outcome.diagnostic ?? 'failed' : outcome.kind);
    return materialComparisonFailure('internal');
  }
  return outcome;
}
