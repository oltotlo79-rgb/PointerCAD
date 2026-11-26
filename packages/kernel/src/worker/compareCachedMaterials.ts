import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { compareMaterialBodies, type MaterialComparisonOutcome } from './compareMaterialBodies.js';
import { materialComparisonFailure, MAX_MATERIAL_COMPARISON_SOLIDS_PER_SIDE,
  reportMaterialComparisonFaults, type MaterialComparisonFault } from './materialComparisonDiagnostic.js';
import type { CachedSolid, SolidCancelToken } from './recomputeSolids.js';
import type { AcquiringShapeCache, AcquireToken } from './shapeCache.js';

export interface MaterialComparisonRequest {
  readonly beforeKeys: readonly string[];
  readonly afterKeys: readonly string[];
}
function keyArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function validKeys(items: readonly unknown[]): items is readonly string[] {
  for (const item of items) if (typeof item !== 'string' || item.length === 0 || item.length > 4096) return false;
  return true;
}

/** awaitする前に貸出保護と実物の写しを確定し、同じ鍵の更新で入力を入れ替えない。 */
export async function compareCachedMaterials(
  request: unknown, cache: AcquiringShapeCache<CachedSolid>, loadOcct: () => Promise<OpenCascadeInstance>,
  shouldCancel?: SolidCancelToken,
): Promise<MaterialComparisonOutcome> {
  if (typeof request !== 'object' || request === null || !('beforeKeys' in request) || !('afterKeys' in request)
    || !keyArray(request.beforeKeys) || !keyArray(request.afterKeys)) return materialComparisonFailure('invalidRequest');
  const { beforeKeys: before, afterKeys: after } = request;
  if (before.length > MAX_MATERIAL_COMPARISON_SOLIDS_PER_SIDE || after.length > MAX_MATERIAL_COMPARISON_SOLIDS_PER_SIDE) {
    return materialComparisonFailure('solidLimit');
  }
  if (!validKeys(before) || !validKeys(after)) return materialComparisonFailure('invalidRequest');
  const beforeKeys = [...new Set(before)], afterKeys = [...new Set(after)];
  const keys = [...new Set([...beforeKeys, ...afterKeys])];
  const faults: MaterialComparisonFault[] = [];
  let stage = 'acquire cache', precedingBodyOutcome: string | undefined;
  let token: AcquireToken | undefined, result: MaterialComparisonOutcome;
  try {
    token = cache.acquire(keys);
    stage = 'snapshot cache';
    const bodies = new Map<string, CachedSolid>();
    for (const key of keys) {
      const body = cache.get(key);
      if (body === undefined) break;
      bodies.set(key, body);
    }
    if (bodies.size !== keys.length) result = materialComparisonFailure('expired');
    else {
      stage = 'check cancellation';
      if (await shouldCancel?.()) result = { kind: 'cancelled' };
      else {
        stage = 'load OCCT';
        const oc = await loadOcct();
        stage = 'compare cached bodies';
        const select = (source: readonly string[]): CachedSolid[] => source.map(key => {
          const body = bodies.get(key);
          if (body === undefined) throw new Error('Material comparison snapshot lost a body');
          return body;
        });
        result = await compareMaterialBodies(oc, select(beforeKeys), select(afterKeys), shouldCancel, (bodyFaults, preceding) => {
          precedingBodyOutcome = preceding;
          faults.push(...bodyFaults);
        });
      }
    }
  } catch (error) {
    faults.push({ stage, cause: error });
    result = materialComparisonFailure('internal');
  } finally {
    if (token !== undefined) {
      try { cache.release(token); }
      catch (error) { faults.push({ stage: 'release cache', cause: error }); }
    }
  }
  if (faults.length > 0) {
    reportMaterialComparisonFaults(faults, precedingBodyOutcome ?? (result.kind === 'failed' ? result.diagnostic ?? 'failed' : result.kind));
    return materialComparisonFailure('internal');
  }
  return result;
}
