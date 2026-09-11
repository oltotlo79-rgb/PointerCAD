/** 切欠きの定義から曲線・曲げグラフ・実形状の計算入力を同時に更新する。 */
import { availableSheetBoundaryEdges } from './availableBoundaryEdges.js';
import { resolvedSheetBodyPlan } from './bodyPlan.js';
import { cutSheetGraph } from './cutSheetGraph.js';
import type { SheetGeometryResult } from './panelGeometry.js';
import { reconnectSheetRelief } from './reconnectSheetRelief.js';
import { sheetReliefProfile } from './reliefProfile.js';
import type { ResolvedSheetBody, SheetGeometryPlan } from './resolveSheetGeometry.js';
import { framePoint } from './rigidCurve.js';
import type { SheetReliefFeature } from './types.js';
import { unfoldSheetBody } from './unfoldSheetBody.js';

export function resolveSheetRelief(feature: SheetReliefFeature, source: ResolvedSheetBody): SheetGeometryResult<SheetGeometryPlan> {
  const available = availableSheetBoundaryEdges(source, feature.boundary.panelId); if (!available.ok) return available;
  const edge = available.value.find((item) => item.id === feature.boundary.boundaryId);
  if (edge === undefined) return { ok: false, message: '切欠きの入口には曲げが付いていない外側の直線縁を選んでください。' };
  const flat = unfoldSheetBody(source, feature.boundary.panelId, feature.seamConnectionIds ?? []); if (!flat.ok) return flat;
  const placement = flat.value.panelPlacements?.get(feature.boundary.panelId);
  if (placement === undefined) return { ok: false, message: '切欠きの基準パネルの座標が見つかりません。' };
  const tool = sheetReliefProfile({ from: framePoint(edge.from, placement.source, placement.target), to: framePoint(edge.to, placement.source, placement.target) },
    [0, 0, 1], feature.position.value, feature.width.value, feature.depth.value, feature.shape, feature.id);
  if (!tool.ok) return tool;
  const cut = cutSheetGraph(source, flat.value, feature.boundary.panelId, tool.value, feature.id); if (!cut.ok) return cut;
  const body = reconnectSheetRelief(source, cut.value, feature.id); if (!body.ok) return body;
  const fixed = body.value.panels.some((panel) => panel.id === feature.boundary.panelId) ? feature.boundary.panelId : body.value.panels[0].id;
  const connected = unfoldSheetBody(body.value, fixed, feature.seamConnectionIds ?? []); if (!connected.ok) return connected;
  const plan = resolvedSheetBodyPlan(body.value);
  return plan.ok ? { ok: true, value: { body: body.value, plan: plan.value } } : plan;
}
