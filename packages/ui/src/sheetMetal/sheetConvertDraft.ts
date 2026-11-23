/** 立体を板金へ変える行(M-08)の下書き: 選んだ平らな面から元の立体と基準の面を決め、確定の候補の文書を作る。 */
import { appendSolid, createSheetConvertFeature, replaceSolid, type PartDocument, type SheetConvertFeature,
  type SolidBody, type SubShapeRef } from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';
import { parseSubShapeId, subShapeRefOf } from '../solid/subShapeSelection.js';

export type SheetConvertFace = { readonly ok: true; readonly sourceFeatureId: string; readonly face: SubShapeRef }
  | { readonly ok: false; readonly messageKey: MessageKey };

/**
 * 選択の中の最初の面。平らでない面・起源を引けない面は断る(基準の面は板の表か裏の平らな面)。
 * `excludedFeatureId`(編集中の変換の行)の板の面は拾わない(自分を元の立体にしない)。
 */
export function selectedConvertFace(selection: readonly string[], bodies: readonly SolidBody[], excludedFeatureId?: string): SheetConvertFace {
  for (const id of selection) {
    const parsed = parseSubShapeId(id);
    if (parsed?.kind !== 'face' || parsed.bodyFeatureId === excludedFeatureId) continue;
    const body = bodies.find(item => item.featureId === parsed.bodyFeatureId);
    const face = body?.faces.find(item => item.index === parsed.index);
    if (body === undefined || face === undefined) continue;
    if (face.surfaceKind !== 'plane') return { ok: false, messageKey: 'sheetMetal.convertNotPlanar' };
    // 起源のある形は起源つき、読み込んだ形のように起源の無い形は指紋だけの参照(加工の参照と同じ作り方)。
    const reference = subShapeRefOf(bodies, id);
    return reference === null ? { ok: false, messageKey: 'sheetMetal.convertNeedFace' } : { ok: true, sourceFeatureId: body.featureId, face: reference };
  }
  return { ok: false, messageKey: 'sheetMetal.convertNeedFace' };
}

/** 新しく作る時は文書の末尾へ足し、編集の時は同じ id の行を差し替える(内半径・K 係数の式は draft の値)。 */
export function sheetConvertCandidate(document: PartDocument, face: Extract<SheetConvertFace, { ok: true }>, draft: SheetConvertFeature['rule'],
  editing?: SheetConvertFeature): { readonly ok: true; readonly document: PartDocument; readonly feature: SheetConvertFeature } {
  const feature: SheetConvertFeature = editing === undefined
    ? { ...createSheetConvertFeature(document, face.sourceFeatureId, face.face), rule: draft }
    : { ...editing, sourceFeatureId: face.sourceFeatureId, referenceFace: face.face, rule: draft };
  return { ok: true, document: editing === undefined ? appendSolid(document, feature) : replaceSolid(document, editing.id, feature), feature };
}
