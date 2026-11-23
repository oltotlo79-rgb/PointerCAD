/** 立体を板金として読む照会(M-08)の、model と計算部の言葉の詰め替え。Worker の橋と直の橋が同じ道を通る。 */
import type { SheetMetalRecognition, SheetMetalRecognitionOutcome, SheetMetalRecognitionRequest } from '@pointercad/kernel';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { toSubShapeQuery } from './subShapeQuery.js';

/** 照会 1 件。立体は段の鍵、基準の面は保存した参照(指紋)で指す。 */
export interface SheetRecognitionRequestItem {
  readonly id: string;
  readonly bodyKey: string;
  readonly face: SubShapeRef;
}

/**
 * 照会 1 件の答え。`recognized` は読めた・読めなかった(理由の符号)のどちらか。
 * `unavailable` は答えられなかった時: 鍵の形が無い・Worker が壊れた・呼び出しが失敗した。
 */
export type SheetRecognitionReply =
  | { readonly id: string; readonly kind: 'recognized'; readonly recognition: SheetMetalRecognition }
  | { readonly id: string; readonly kind: 'unavailable'; readonly code: 'missingBody' | 'workerBroken' | 'rpcFailed' };

/** 依頼した 1 件ごとに同じ符号の `unavailable` を返す(壊れた Worker の断りなど)。 */
export function unavailableSheetReplies(requests: readonly SheetRecognitionRequestItem[],
  code: 'workerBroken' | 'rpcFailed'): readonly SheetRecognitionReply[] {
  return requests.map(request => ({ id: request.id, kind: 'unavailable', code }));
}

/**
 * 依頼を計算部の言葉へ詰め替えて `call` で頼み、依頼の順に答えを返す。投げない(失敗は `rpcFailed`)。
 * 面でない参照は頼まずに、計算部が平らでない基準の面に返すのと同じ `ambiguousPair` で答える。
 */
export async function askSheetRecognition(requests: readonly SheetRecognitionRequestItem[],
  call: (request: SheetMetalRecognitionRequest) => Promise<SheetMetalRecognitionOutcome>): Promise<readonly SheetRecognitionReply[]> {
  const items: SheetMetalRecognitionRequest['items'][number][] = [];
  for (const request of requests) {
    const face = toSubShapeQuery(request.face);
    if (face.kind === 'face') items.push({ id: request.id, shapeKey: request.bodyKey, face });
  }
  let outcome: SheetMetalRecognitionOutcome | undefined;
  if (items.length > 0) {
    try { outcome = await call({ items }); } catch { return unavailableSheetReplies(requests, 'rpcFailed'); }
  }
  const asked = new Set(items.map(item => item.id));
  const recognized = new Map((outcome?.results ?? []).map((result): [string, SheetMetalRecognition] => [result.id, result.recognition]));
  const missing = new Set((outcome?.failures ?? []).map(failure => failure.id));
  return requests.map((request): SheetRecognitionReply => {
    const recognition = recognized.get(request.id);
    if (recognition !== undefined) return { id: request.id, kind: 'recognized', recognition };
    if (!asked.has(request.id)) return { id: request.id, kind: 'recognized', recognition: { ok: false, reason: 'ambiguousPair' } };
    // 頼んだのに答えの無い 1 件は、鍵の形が無いと言われた時だけ missingBody にし、ほかは呼び出しの失敗と同じに扱う。
    return { id: request.id, kind: 'unavailable', code: missing.has(request.id) ? 'missingBody' : 'rpcFailed' };
  });
}
