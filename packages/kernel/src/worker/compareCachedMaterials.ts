import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { compareMaterialBodies, type MaterialComparisonOutcome } from './compareMaterialBodies.js';
import type { CachedSolid, SolidCancelToken } from './recomputeSolids.js';
import type { AcquiringShapeCache, AcquireToken } from './shapeCache.js';

export interface MaterialComparisonRequest {
  readonly beforeKeys: readonly string[];
  readonly afterKeys: readonly string[];
}
function validRequest(value: unknown): value is MaterialComparisonRequest {
  if (typeof value !== 'object' || value === null || !('beforeKeys' in value) || !('afterKeys' in value)) return false;
  const keys = (items: unknown): boolean => Array.isArray(items) && items.length <= 1024
    && items.every(item => typeof item === 'string' && item.length > 0 && item.length <= 4096);
  return keys(value.beforeKeys) && keys(value.afterKeys);
}

/** awaitする前に貸出保護と実物の写しを確定し、同じ鍵の更新で入力を入れ替えない。 */
export async function compareCachedMaterials(
  request: unknown, cache: AcquiringShapeCache<CachedSolid>, loadOcct: () => Promise<OpenCascadeInstance>,
  shouldCancel?: SolidCancelToken,
): Promise<MaterialComparisonOutcome> {
  if (!validRequest(request)) return { kind: 'failed', message: '比較する立体の指定が正しくありません。' };
  const beforeKeys = [...new Set(request.beforeKeys)], afterKeys = [...new Set(request.afterKeys)];
  const keys = [...new Set([...beforeKeys, ...afterKeys])];
  let token: AcquireToken | undefined, result: MaterialComparisonOutcome;
  try {
    token = cache.acquire(keys);
    const bodies = new Map<string, CachedSolid>();
    for (const key of keys) {
      const body = cache.get(key);
      if (body === undefined) throw new Error('比較する立体が見つかりません。形を再計算してください。');
      bodies.set(key, body);
    }
    const select = (source: readonly string[]): CachedSolid[] => source.map(key => {
      const body = bodies.get(key);
      if (body === undefined) throw new Error('比較する立体が見つかりません。');
      return body;
    });
    if (await shouldCancel?.()) result = { kind: 'cancelled' };
    else result = await compareMaterialBodies(await loadOcct(), select(beforeKeys), select(afterKeys), shouldCancel);
  } catch (error) {
    result = { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
  if (token !== undefined) try { cache.release(token); } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    result = { kind: 'failed', message: `${result.kind === 'failed' ? result.message + '\n' : ''}比較中の立体を返せませんでした。${detail}` };
  }
  return result;
}
