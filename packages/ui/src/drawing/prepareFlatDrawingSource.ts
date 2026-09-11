/** 元の板金履歴から展開を計算し、図面が使い終わるまで実形状の所有先を維持する。 */
import { IDENTITY_PLACEMENT, recomputeSheetFlat, sheetFlatReferenceIssue, resolveSheetFlatOutline, sheetFlatBendLines,
  type DrawingSheetFlatReference, type DrawingSourceResolution, type KernelBridge, type PartDocument,
  type PartRecomputeResult, type SheetFlatGeometry } from '@pointercad/model';

export async function prepareFlatDrawingSource(document: PartDocument, reference: DrawingSheetFlatReference, sourceRef: string,
  computed: PartRecomputeResult, bridge: Pick<KernelBridge, 'recomputeSolids' | 'sectionSketchCurves'>, partId: string, shouldCancel: () => boolean):
  Promise<{ readonly result: DrawingSourceResolution; readonly geometry: SheetFlatGeometry }> {
  const issue = sheetFlatReferenceIssue(document, reference); if (issue !== null) throw new Error(issue);
  const sheet = computed.sheetMetalBodies?.get(reference.sourceFeatureId);
  if (sheet === undefined) throw new Error('展開図の元になる板金が表示されていません。抑制と後続の加工を確認してください。');
  const flat = await recomputeSheetFlat(sheet, reference, bridge, { partId, generation: 1, shouldCancel });
  if (!flat.ok) throw new Error(flat.message);
  if (shouldCancel()) throw new Error('展開図の更新を中止しました。');
  const outline = await resolveSheetFlatOutline(bridge, flat.bodyKey, flat.geometry.thickness, shouldCancel);
  if (!outline.ok) throw new Error(outline.message);
  const bends = sheetFlatBendLines(flat.geometry); if (!bends.ok) throw new Error(bends.message);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const positions = flat.body.mesh.positions;
  for (let i = 0; i < positions.length; i += 3) for (let axis = 0; axis < 3; axis++) {
    const value = positions[i + axis]; if (!Number.isFinite(value)) throw new Error('展開図の座標が不正です。');
    min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
  }
  if (!min.every(Number.isFinite)) throw new Error('展開図の形状がありません。');
  return { geometry: flat.geometry, result: { bodyIds: [flat.bodyKey],
    sheetFlat: { geometry: flat.geometry, outline: outline.value, bends: bends.value },
    dimensionInstances: [{ sourceRef, bodyId: flat.bodyKey, body: flat.body, placement: IDENTITY_PLACEMENT }],
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] } };
}
