/** 図面が板金のどの入力を展開するか。メッシュや派生座標は参照へ入れない。 */
import type { DrawingSheetFlatReference } from '@pointercad/drawing';
import type { PartDocument } from '../part/types.js';

export function sheetFlatReferenceIssue(document: PartDocument, reference: DrawingSheetFlatReference): string | null {
  if (reference.partId !== document.id) return '展開図の元部品が一致しません。元と同じ部品ファイルを選んでください。';
  const feature = document.solids.find((item) => item.id === reference.sourceFeatureId);
  if (feature === undefined || !['sheetBase', 'sheetFlange', 'sheetBend', 'sheetRelief'].includes(feature.kind))
    return '展開図の元になる板金フィーチャーが見つかりません。';
  if (reference.fixedPanelId.length === 0 || reference.seamConnectionIds.some((id) => id.length === 0)
    || new Set(reference.seamConnectionIds).size !== reference.seamConnectionIds.length)
    return '展開図の固定面か継ぎ目が不正です。';
  return null;
}
