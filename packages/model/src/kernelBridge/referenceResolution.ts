/** 保存した指紋の候補を、採用可能・消失・曖昧へ分ける共通の判定。 */
import { resolveSubShapeCandidates } from '@pointercad/kernel';
import { fingerprintKeyText } from '../geometry/subShapeRef.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import type { OriginLookup } from '../geometry/subShapeOrigin.js';
import type { SolidBody } from './solidContracts.js';
import { resolveCurrentOrigin } from './createSubShapeReference.js';
import { subShapeMatchCandidates, type SubShapeMatchCandidate } from './subShapeMatching.js';

/** 既存の公開名を保持。採点・しきい値・曖昧さ判定の正本はkernel。 */
export { SUB_SHAPE_AMBIGUITY_MARGIN } from '@pointercad/kernel';

interface ReferenceResolutionBase {
  readonly originalReference: SubShapeRef;
  readonly candidates: readonly SubShapeMatchCandidate[];
}

export type SubShapeReferenceResolution = ReferenceResolutionBase & (
  | { readonly status: 'matched'; readonly match: SubShapeMatchCandidate }
  | { readonly status: 'missing'; readonly reason?: Extract<OriginLookup, { status: 'missing' }>['reason'] }
  | { readonly status: 'ambiguous'; readonly reason?: Extract<OriginLookup, { status: 'ambiguous' }>['reason'] }
);

/**
 * 1つの現在のボディ内だけで照合する。曖昧な候補を番号・列挙順で採用せず、元参照を保持する。
 * 文書は更新しない。明示的な選び直しは、利用側が確認した新しい参照を文書へ保存する。
 */
export function resolveSubShapeReference(body: SolidBody, reference: SubShapeRef): SubShapeReferenceResolution {
  if (reference.origin !== undefined) {
    const lookup = resolveCurrentOrigin(body, reference);
    const candidates = subShapeMatchCandidates(body, reference);
    if (lookup.status === 'ambiguous') return { status: 'ambiguous', reason: lookup.reason,
      originalReference: reference, candidates };
    if (lookup.status !== 'matched' || candidates.length !== 1) {
      return { status: 'missing', reason: lookup.status === 'missing' ? lookup.reason : 'history-missing',
        originalReference: reference, candidates: [] };
    }
    return { status: 'matched', originalReference: reference, candidates, match: candidates[0] };
  }
  return { originalReference: reference, ...resolveSubShapeCandidates(subShapeMatchCandidates(body, reference)) };
}

/**
 * 明示的な部品差替え専用。呼び出し側が新しい部品だけのbodyを渡す。
 * 同じfeatureIdが存在すればそのbody群だけを照合し、見つからなくても他のbodyへ逃がさない。
 * featureId自体が新しくなる差替えでは全bodyを集約し、同点・近点を一括して断る。
 */
export function resolveReplacementSubShapeReference(bodies: readonly SolidBody[], reference: SubShapeRef): SubShapeReferenceResolution {
  if (reference.origin !== undefined) {
    const preferred = bodies.filter(body => body.featureId === reference.bodyFeatureId);
    if (preferred.length > 1) return { status: 'ambiguous', originalReference: reference, candidates: [] };
    return preferred.length === 1 ? resolveSubShapeReference(preferred[0], reference)
      : { status: 'missing', originalReference: reference, candidates: [] };
  }
  const preferred = bodies.filter((body) => body.featureId === reference.bodyFeatureId);
  const applicable = preferred.length > 0 ? preferred : bodies;
  const candidates = applicable.flatMap((body) => subShapeMatchCandidates(body,
    body.featureId === reference.bodyFeatureId ? reference : { ...reference, bodyFeatureId: body.featureId }));
  return { originalReference: reference, ...resolveSubShapeCandidates(candidates) };
}

/** 1回の解決処理内で同じbody/指紋の候補を共有する。次の再計算へキャッシュを持ち越さない。 */
export function createSubShapeReferenceResolver(): typeof resolveSubShapeReference {
  const byBody = new WeakMap<SolidBody, Map<string, SubShapeReferenceResolution>>();
  return (body, reference) => {
    let results = byBody.get(body);
    if (results === undefined) { results = new Map(); byBody.set(body, results); }
    const key = fingerprintKeyText(reference), cached = results.get(key);
    if (cached !== undefined) return cached.originalReference === reference ? cached : { ...cached, originalReference: reference };
    const resolution = resolveSubShapeReference(body, reference);
    results.set(key, resolution);
    return resolution;
  };
}
