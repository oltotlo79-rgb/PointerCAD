/** 固定面と明示継ぎ目だけを文書へ保存する。表示状態・導出形状は含めない。 */
import type { PartDocument } from '../part/types.js';
import type { SheetGeometryResult } from './panelGeometry.js';
import type { ResolvedSheetBody } from './resolveSheetGeometry.js';
import type { SheetUnfoldDefinition } from './types.js';
import { unfoldSheetBody } from './unfoldSheetBody.js';
import { resolveSheetSeams } from './seamConnections.js';

export function setSheetUnfoldDefinition(document: PartDocument, body: ResolvedSheetBody,
  definition: SheetUnfoldDefinition): SheetGeometryResult<PartDocument> {
  if (!document.solids.some((feature) => feature.id === definition.sourceFeatureId
    && (feature.kind === 'sheetBase' || feature.kind === 'sheetFlange' || feature.kind === 'sheetBend' || feature.kind === 'sheetRelief')))
    return { ok: false, message: '展開元の板金が見つかりません。元の部品を確認してください。' };
  const flat = unfoldSheetBody(body, definition.fixedPanelId, definition.seamConnectionIds);
  if (!flat.ok) return flat;
  const mapped = resolveSheetSeams(body, definition.seamConnectionIds); if (!mapped.ok) return mapped;
  const seams = mapped.value;
  const previous = document.sheetUnfolds.find((item) => item.sourceFeatureId === definition.sourceFeatureId);
  if (previous?.fixedPanelId === definition.fixedPanelId && previous.seamConnectionIds.length === seams.length
    && previous.seamConnectionIds.every((id, index) => id === seams[index])) return { ok: true, value: document };
  const next: SheetUnfoldDefinition = { sourceFeatureId: definition.sourceFeatureId, fixedPanelId: definition.fixedPanelId, seamConnectionIds: seams };
  return { ok: true, value: { ...document, sheetUnfolds: previous === undefined ? [...document.sheetUnfolds, next]
    : document.sheetUnfolds.map((item) => item === previous ? next : item) } };
}
