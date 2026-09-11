/** 板金展開の入力参照。任意の実行時プロパティを図面へ混ぜない。 */
import type { DrawingSheetFlatReference } from '@pointercad/model';
import { isRecord, isUnknownArray } from './guards.js';

export function isDrawingFlatReference(value: unknown): value is DrawingSheetFlatReference {
  if (!isRecord(value)) return false;
  for (const key of ['partId', 'sourceFeatureId', 'fixedPanelId']) if (typeof value[key] !== 'string' || value[key].length === 0) return false;
  const seams = value['seamConnectionIds'];
  return isUnknownArray(seams) && seams.every((id) => typeof id === 'string' && id.length > 0) && new Set(seams).size === seams.length;
}

export function cleanDrawingFlatReference(reference: DrawingSheetFlatReference): DrawingSheetFlatReference {
  return { partId: reference.partId, sourceFeatureId: reference.sourceFeatureId, fixedPanelId: reference.fixedPanelId,
    seamConnectionIds: [...reference.seamConnectionIds] };
}
