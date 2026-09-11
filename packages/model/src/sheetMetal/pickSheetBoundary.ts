/** 実B-repの上面・下面の直線を、保存可能な同じパネル境界へ照合する。 */
import { addVec3, distanceVec3, scaleVec3, type Vec3 } from '../sketch/vec3.js';
import { availableSheetBoundaryEdges } from './availableBoundaryEdges.js';
import { resolveSheetRule } from './featureInputs.js';
import type { ResolvedSheetBody } from './resolveSheetGeometry.js';
import type { SheetPanelBoundaryRef } from './types.js';

export function pickSheetBoundary(body: ResolvedSheetBody, from: Vec3, to: Vec3): readonly SheetPanelBoundaryRef[] {
  if (![...from, ...to].every(Number.isFinite) || distanceVec3(from, to) <= 1e-7) return [];
  const rule = resolveSheetRule(body.rule); if (!rule.ok) return [];
  const matches: SheetPanelBoundaryRef[] = [];
  const same = (a: Vec3, b: Vec3) => (distanceVec3(from, a) <= 1e-7 && distanceVec3(to, b) <= 1e-7)
    || (distanceVec3(to, a) <= 1e-7 && distanceVec3(from, b) <= 1e-7);
  for (const panel of body.panels) {
    const available = availableSheetBoundaryEdges(body, panel.id); if (!available.ok) continue;
    const offset = scaleVec3(panel.normal, rule.rule.thickness);
    for (const edge of available.value) {
      if (same(edge.from, edge.to) || same(addVec3(edge.from, offset), addVec3(edge.to, offset)))
        matches.push({ panelId: panel.id, boundaryId: edge.id });
    }
  }
  return matches;
}
