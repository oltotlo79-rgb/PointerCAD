/** 接続済みの境界を親側・子側とも除く。作成画面とモデルの確定で同じ判定を使う。 */
import { crossVec3, dotVec3, lengthVec3, scaleVec3, subVec3, type Vec3 } from '../sketch/vec3.js';
import { sheetBoundaryEdges, type SheetBoundaryEdge, type SheetGeometryResult } from './panelGeometry.js';
import type { ResolvedSheetBody } from './resolveSheetGeometry.js';

function overlaps(edge: SheetBoundaryEdge, attached: { readonly from: Vec3; readonly to: Vec3 }): boolean {
  const vector = subVec3(edge.to, edge.from), length = lengthVec3(vector);
  if (length <= 1e-7) return false;
  const axis = scaleVec3(vector, 1 / length);
  const from = subVec3(attached.from, edge.from), to = subVec3(attached.to, edge.from);
  if (lengthVec3(crossVec3(from, axis)) > 1e-7 || lengthVec3(crossVec3(to, axis)) > 1e-7) return false;
  const a = dotVec3(from, axis), b = dotVec3(to, axis);
  return Math.min(length, Math.max(a, b)) - Math.max(0, Math.min(a, b)) > 1e-7;
}

export function availableSheetBoundaryEdges(body: ResolvedSheetBody, panelId: string): SheetGeometryResult<readonly SheetBoundaryEdge[]> {
  const panel = body.panels.find((item) => item.id === panelId);
  if (panel === undefined) return { ok: false, message: '板金のパネルが見つかりません。縁を選び直してください。' };
  const edges = sheetBoundaryEdges(panel); if (!edges.ok) return edges;
  const attached = body.bends.flatMap((bend) => bend.parentPanelId === panelId ? bend.parentContacts ?? [bend.parentEdge]
    : bend.childPanelId === panelId ? bend.childContacts ?? [bend.childEdge] : []);
  return { ok: true, value: edges.value.filter((edge) => !attached.some((boundary) => overlaps(edge, boundary))) };
}
