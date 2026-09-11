/** 展開をパネル単位の段に分け、変わらない板や曲げ帯をWorkerで再利用する。 */
import type { ResolvedSolidStep } from '../part/resolvePart.js';
import type { SheetGeometryResult, SheetPanelGeometry } from './panelGeometry.js';
import type { SheetBasePlan, SheetJoinPlan } from './resolveSheetGeometry.js';
import { sheetShapeKey } from './shapeKey.js';
import type { SheetFlatGeometry } from './unfoldSheetBody.js';

export function createSheetFlatSteps(sourceFeatureId: string, flat: SheetFlatGeometry): SheetGeometryResult<readonly ResolvedSolidStep[]> {
  const panels = new Map(flat.panels.map((panel) => [panel.id, panel])), bends = new Map(flat.bends.map((bend) => [bend.id, bend]));
  const fixed = panels.get(flat.fixedPanelId);
  if (fixed === undefined || panels.size !== flat.panels.length || bends.size !== flat.bends.length)
    return { ok: false, message: '展開の固定面またはパネルの識別子を確認してください。' };
  const steps: ResolvedSolidStep[] = [];
  function plate(panel: SheetPanelGeometry, label: string): ResolvedSolidStep {
    const plan: SheetBasePlan = { kind: 'sheetBase', outer: panel.outer, holes: panel.holes, normal: [0, 0, 1], thickness: flat.thickness, reversed: false };
    const step = { featureId: JSON.stringify(['sheet-flat-panel', sourceFeatureId, panel.id]), name: label, key: sheetShapeKey(plan), plan, visible: false };
    steps.push(step); return step;
  }
  let current = plate(fixed, '展開の固定パネル');
  const visited = new Set([fixed.id]), joined = new Set<string>();
  const join = (panel: SheetPanelGeometry, name: string) => {
    const tool = plate(panel, name);
    const plan: SheetJoinPlan = { kind: 'sheetJoin', targetKey: current.key, toolKey: tool.key };
    current = { featureId: JSON.stringify(['sheet-flat-join', sourceFeatureId, panel.id]), name, key: sheetShapeKey(plan), plan, visible: false };
    steps.push(current);
  };
  for (const [index, connection] of flat.joins.entries()) {
    const child = panels.get(connection.childPanelId), bend = bends.get(connection.connectionId);
    if (!visited.has(connection.parentPanelId) || visited.has(connection.childPanelId) || child === undefined || bend === undefined
      || bend.seamPanelId !== undefined || bend.extraPanelId !== undefined || joined.has(bend.id))
      return { ok: false, message: '展開のパネルの接続順または重複を確認してください。' };
    if (bend.panel !== null) join(bend.panel, `展開の曲げ帯 ${index + 1}`);
    join(child, `展開のパネル ${index + 2}`);
    visited.add(child.id); joined.add(bend.id);
  }
  for (const bend of flat.bends) {
    const panelId = bend.seamPanelId ?? bend.extraPanelId;
    if (panelId === undefined) continue;
    if (!visited.has(panelId) || joined.has(bend.id)) return { ok: false, message: '追加する曲げ帯の接続先を確認してください。' };
    if (bend.panel !== null) join(bend.panel, `追加の曲げ帯 ${joined.size + 1}`);
    joined.add(bend.id);
  }
  if (visited.size !== panels.size || joined.size !== bends.size)
    return { ok: false, message: '展開に接続していないパネルまたは曲げ帯があります。' };
  steps[steps.length - 1] = { ...current, featureId: sourceFeatureId, name: '板金の展開', visible: true };
  return { ok: true, value: steps };
}
