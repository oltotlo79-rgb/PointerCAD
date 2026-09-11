/** 導出済みの板金パネルと曲げ帯を、正規Workerの再構築入力へ変換する。 */
import { resolveSheetRule } from './featureInputs.js';
import type { SheetGeometryResult } from './panelGeometry.js';
import type { ResolvedSheetBody, SheetBodyPlan } from './resolveSheetGeometry.js';

export function resolvedSheetBodyPlan(body: ResolvedSheetBody): SheetGeometryResult<SheetBodyPlan> {
  const rule = resolveSheetRule(body.rule); if (!rule.ok) return rule;
  const thickness = rule.rule.thickness;
  const materials = new Set<string>();
  return { ok: true, value: { kind: 'sheetBody',
    panels: body.panels.map((panel) => ({ kind: 'sheetBase', thickness, reversed: false, normal: panel.normal, outer: panel.outer, holes: panel.holes })),
    bends: body.bends.filter((bend) => {
      const id = bend.materialId ?? bend.id;
      if (bend.angle === 0 || materials.has(id)) return false;
      materials.add(id); return true;
    }).map((bend) => {
      const common = { thickness, radius: bend.radius, angle: bend.angle, frame: bend.frame };
      return bend.flatProfile === undefined ? { ...common, kind: 'rectangle', width: bend.width }
        : { ...common, kind: 'profile', neutralRadius: bend.radius + thickness * bend.kFactor,
          outer: bend.flatProfile.outer, holes: bend.flatProfile.holes };
    }) } };
}
