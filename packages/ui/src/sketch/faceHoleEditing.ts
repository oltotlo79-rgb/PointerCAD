import type { SketchDocument } from '@pointercad/model';

/** 穴を持つ面の外周または穴を編集するか。未対応の編集とその予告が同じ条件で断る。 */
export function touchesHoledFace(document: SketchDocument, elementIds: readonly string[]): boolean {
  const ids = new Set(elementIds.map(id => id.split('#')[0]));
  return document.features.some(feature => feature.kind === 'face' && (feature.holes?.length ?? 0) > 0
    && [feature.boundary, ...(feature.holes ?? [])].some(loop => loop.some(ref => ids.has(ref.featureId))));
}
