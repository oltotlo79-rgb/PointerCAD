/** 形状キャッシュの立体を板金として読む照会(M-08)。Worker の窓口 `recognizeSheetMetal` の中身。 */
import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { pickFaceIndex } from '../occt/pickSubShape.js';
import { recognizeSheetMetal } from '../occt/recognizeSheetMetal.js';
import type { SheetMetalRecognitionOutcome, SheetMetalRecognitionRequest } from '../types.js';
import type { CachedSolid } from './recomputeSolids.js';
import type { ShapeCache } from './shapeCache.js';

type Results = SheetMetalRecognitionOutcome['results'][number][];
type Failures = SheetMetalRecognitionOutcome['failures'][number][];

/**
 * 鍵の形を貸し出しで守った中で呼ぶ(窓口の `withAcquiredKeys`)。形はキャッシュの持ち物なので手放さない。
 * 基準の面は指紋で選び直し(`pickFaceIndex`。加工と同じ選び方)、合う面が無ければ `sourceChanged` を返す。
 */
export async function recognizeCachedSheetMetal(request: SheetMetalRecognitionRequest,
  cache: Pick<ShapeCache<CachedSolid>, 'get'>, loadOcct: () => Promise<OpenCascadeInstance>): Promise<SheetMetalRecognitionOutcome> {
  const oc = await loadOcct();
  const results: Results = [], failures: Failures = [];
  for (const item of request.items) {
    const cached = cache.get(item.shapeKey);
    if (cached === undefined) {
      failures.push({ id: item.id, code: 'missingBody' });
      continue;
    }
    const faceIndex = pickFaceIndex(oc, cached.shape, cached.mesh, item.face);
    results.push({ id: item.id, recognition: faceIndex === null
      ? { ok: false, reason: 'sourceChanged' } : recognizeSheetMetal(oc, cached.shape, faceIndex) });
  }
  return { results, failures };
}
