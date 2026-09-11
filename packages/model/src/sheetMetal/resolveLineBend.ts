/** 指定線曲げの入力を、既存の枝を含む実形状と展開可能な接続へ同時に解決する。 */
import type { SketchLineRef } from '../part/featureReferences.js';
import type { ResolvedSegment } from '../sketch/types.js';
import { resolvedSheetBodyPlan } from './bodyPlan.js';
import { connectLineBendRegions } from './connectLineBendRegions.js';
import { resolveSheetRule } from './featureInputs.js';
import type { SheetGeometryResult } from './panelGeometry.js';
import { partitionSheetLineBend } from './partitionLineBend.js';
import { rebaseSheetBranches } from './rebaseSheetBranches.js';
import type { ResolvedSheetBody, SheetGeometryPlan } from './resolveSheetGeometry.js';
import type { SheetBendFeature } from './types.js';

export type SheetLineResolver = (reference: SketchLineRef) => ResolvedSegment | undefined;
export function resolveSheetLineBend(feature: SheetBendFeature, source: ResolvedSheetBody, line: SheetLineResolver): SheetGeometryResult<SheetGeometryPlan> {
  const rule = resolveSheetRule(source.rule, feature.rule); if (!rule.ok) return rule;
  const panel = source.panels.find((item) => item.id === feature.panelId), axis = line(feature.line);
  if (panel === undefined || axis === undefined) return { ok: false, message: '曲げる板金パネルと指定線を選び直してください。' };
  const partition = partitionSheetLineBend(panel, axis, feature.fixedSide, { ...rule.rule, angle: feature.angle.value }, feature.id);
  if (!partition.ok) return partition;
  const connected = connectLineBendRegions(partition.value, feature.id); if (!connected.ok) return connected;
  const rebased = rebaseSheetBranches(source, panel.id, partition.value); if (!rebased.ok) return rebased;
  const body = { ...rebased.value, bends: [...rebased.value.bends, ...connected.value] };
  const plan = resolvedSheetBodyPlan(body);
  return plan.ok ? { ok: true, value: { plan: plan.value, body } } : plan;
}
