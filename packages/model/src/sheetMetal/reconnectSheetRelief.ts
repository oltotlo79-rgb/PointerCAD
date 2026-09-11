/** 切欠きで変わった接触区間と面の分割を曲げグラフへ反映する。 */
import type { ResolvedCurve } from '../sketch/types.js';
import { addVec3, scaleVec3 } from '../sketch/vec3.js';
import { sheetBendMetrics } from './bendAllowance.js';
import { connectLineBendRegions, sheetTangentIntervals } from './connectLineBendRegions.js';
import type { SheetReliefCuts } from './cutSheetGraph.js';
import { resolveSheetRule } from './featureInputs.js';
import { flangeEndFrame, type SheetGeometryResult, type SheetPanelGeometry } from './panelGeometry.js';
import type { ResolvedSheetBend, ResolvedSheetBody } from './resolveSheetGeometry.js';
import { rigidSheetCurve } from './rigidCurve.js';
import { composeSheetConnectionAliases } from './seamConnections.js';

function zeroConnections(bend: ResolvedSheetBend, parents: readonly SheetPanelGeometry[], children: readonly SheetPanelGeometry[], featureId: string): readonly ResolvedSheetBend[] {
  const result: ResolvedSheetBend[] = [], point = (x: number) => addVec3(bend.frame.origin, scaleVec3(bend.frame.xAxis, x));
  for (const parent of parents) for (const child of children) {
    const first = sheetTangentIntervals(parent.outer, bend.frame, 0), second = sheetTangentIntervals(child.outer, bend.frame, 0);
    for (const a of first) for (const b of second) {
      const low = Math.max(0, a.low, b.low), high = Math.min(bend.width, a.high, b.high); if (high - low <= 1e-7) continue;
      const parentEdge = { from: point(high), to: point(low) }, childEdge = { from: point(low), to: point(high) };
      result.push({ ...bend, id: JSON.stringify([featureId, bend.id, parent.id, child.id, result.length]), parallelGroupId: bend.parallelGroupId ?? bend.id,
        parentPanelId: parent.id, childPanelId: child.id, width: high - low, frame: { ...bend.frame, origin: point(low) },
        parentEdge, childEdge, parentContacts: [parentEdge], childContacts: [childEdge] });
    }
  }
  return result;
}

export function reconnectSheetRelief(source: ResolvedSheetBody, cuts: SheetReliefCuts, featureId: string): SheetGeometryResult<ResolvedSheetBody> {
  const rule = resolveSheetRule(source.rule); if (!rule.ok) return rule;
  const original = new Map(source.panels.map((panel) => [panel.id, panel]));
  const regions = (id: string): readonly SheetPanelGeometry[] => {
    const changed = cuts.panels.get(id), panel = original.get(id);
    return changed ?? (panel === undefined ? [] : [panel]);
  };
  const panels = source.panels.flatMap((panel) => regions(panel.id)), bends: ResolvedSheetBend[] = [], visited = new Set<string>();
  const changes = new Map<string, readonly string[]>();
  const append = (aliases: readonly ResolvedSheetBend[], connections: readonly ResolvedSheetBend[]) => {
    bends.push(...connections);
    for (const alias of aliases) {
      const parents = new Set(regions(alias.parentPanelId).map((panel) => panel.id));
      const children = new Set(regions(alias.childPanelId).map((panel) => panel.id));
      changes.set(alias.id, connections.filter((item) => parents.has(item.parentPanelId) && children.has(item.childPanelId)).map((item) => item.id));
    }
  };
  for (const bend of source.bends) {
    const material = bend.materialId ?? bend.id; if (visited.has(material)) continue; visited.add(material);
    const aliases = source.bends.filter((item) => (item.materialId ?? item.id) === material);
    const parentIds = [...new Set(aliases.map((item) => item.parentPanelId))], childIds = [...new Set(aliases.map((item) => item.childPanelId))];
    if (!cuts.bands.has(material) && ![...parentIds, ...childIds].some((id) => cuts.panels.has(id))) { bends.push(...aliases); continue; }
    const parents = parentIds.flatMap(regions), children = childIds.flatMap(regions);
    if (bend.angle === 0) {
      for (const alias of aliases) append([alias], zeroConnections(alias, regions(alias.parentPanelId), regions(alias.childPanelId), featureId));
      continue;
    }
    const input = { thickness: rule.rule.thickness, radius: bend.radius, kFactor: bend.kFactor, angle: bend.angle };
    const metrics = sheetBendMetrics(input); if (!metrics.ok) return { ok: false, message: '切欠きの曲げ条件を確認してください。' };
    const end = flangeEndFrame(bend.frame, input.thickness, input.radius, input.angle); if (!end.ok) return end;
    const movingSource = { ...bend.frame, origin: addVec3(bend.frame.origin, scaleVec3(bend.frame.yAxis, bend.allowance)) };
    const points = [[0, 0, 0], [bend.width, 0, 0], [bend.width, bend.allowance, 0], [0, bend.allowance, 0]] as const;
    const outer: readonly ResolvedCurve[] = points.map((from, i) => ({ kind: 'segment', featureId: `${material}:${i}`, from, to: points[(i + 1) % 4] }));
    const bands = cuts.bands.get(material) ?? [{ id: material, normal: [0, 0, 1] as const, ...(bend.flatProfile ?? { outer, holes: [] }) }];
    const map = (curve: ResolvedCurve) => rigidSheetCurve(curve, end.value, movingSource);
    const connection = connectLineBendRegions({ rule: input, fixed: parents, moving: children,
      flatMoving: children.map((panel) => ({ ...panel, normal: movingSource.normal, outer: panel.outer.map(map), holes: panel.holes.map((loop) => loop.map(map)) })),
      bands, frame: bend.frame, movingSource, movingTarget: end.value, metrics: metrics.metrics }, JSON.stringify([featureId, material]), false);
    if (!connection.ok) return connection;
    append(aliases, connection.value.map((item) => ({ ...item, parallelGroupId: bend.parallelGroupId ?? bend.id })));
  }
  return panels.length === 0 ? { ok: false, message: '切欠きによって平面パネルの材料がすべて無くなります。幅か深さを小さくしてください。' }
    : { ok: true, value: { ...source, panels, bends, connectionAliases: composeSheetConnectionAliases(source, changes) } };
}
