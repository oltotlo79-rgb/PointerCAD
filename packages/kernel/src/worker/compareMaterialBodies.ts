import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations } from '../occt/allocations.js';
import { unionShapes } from '../occt/booleanOp.js';
import { compareMaterialRegions, MaterialComparisonCancelled, type MaterialComparison } from '../occt/compareMaterialRegions.js';
import type { CachedSolid, SolidCancelToken } from './recomputeSolids.js';

export type MaterialComparisonOutcome =
  | { readonly kind: 'compared'; readonly result: MaterialComparison }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string };

/** 形のリースはAPI側で確保する。ここでは借用した各版の全ボディを1つの材料集合へする。 */
export async function compareMaterialBodies(
  oc: OpenCascadeInstance, before: readonly CachedSolid[], after: readonly CachedSolid[], shouldCancel?: SolidCancelToken,
): Promise<MaterialComparisonOutcome> {
  const allocations = createAllocations();
  let outcome: MaterialComparisonOutcome;
  async function checkpoint(): Promise<void> {
    if (await shouldCancel?.()) throw new MaterialComparisonCancelled();
  }
  async function joined(bodies: readonly CachedSolid[]): Promise<TopoDS_Shape | null> {
    await checkpoint();
    if (bodies.length > 1024) throw new Error('比較する立体が多すぎます。部品を分けて比較してください。');
    if (bodies.length === 0) return null;
    for (const body of bodies) {
      if (body.shape.IsNull() || body.mesh.bodyKind !== 'solid') throw new Error('形の比較は閉じた立体を対象にしています。');
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
    outcome = error instanceof MaterialComparisonCancelled ? { kind: 'cancelled' }
      : { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
  try { allocations.release(); } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    outcome = { kind: 'failed', message: `${outcome.kind === 'failed' ? outcome.message + '\n' : ''}比較に使った形を片付けられませんでした。${detail}` };
  }
  return outcome;
}
