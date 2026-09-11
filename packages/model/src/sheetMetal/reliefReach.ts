/** 工具が接続境界へ達するかを判定する。展開上で重なった無関係な枝へ加工を伝えない。 */
import { curvePointAt } from '../sketch/intersectionMath.js';
import type { ResolvedSegment } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { sheetLoopContains } from './groupClippedPanels.js';
import type { SheetGeometryResult } from './panelGeometry.js';
import { reliefBoundaryParameter, reliefIntersections, type ReliefBoundary } from './reliefIntersections.js';

export function reliefReachesContact(tool: readonly ReliefBoundary[], contacts: readonly { readonly from: Vec3; readonly to: Vec3 }[]): SheetGeometryResult<boolean> {
  for (const edge of contacts) {
    const segment: ResolvedSegment = { kind: 'segment', featureId: 'contact', ...edge }, cuts = [0, 1];
    for (const curve of tool) {
      const result = reliefIntersections(segment, curve, [0, 0, 1]); if (!result.ok) return result;
      cuts.push(...result.value.map((hit) => hit.source));
    }
    const ordered = [...new Set(cuts)].sort((a, b) => a - b);
    for (let i = 1; i < ordered.length; i++) {
      const midpoint = curvePointAt(segment, (ordered[i - 1] + ordered[i]) / 2);
      const inside = sheetLoopContains(tool, midpoint, [1, 0, 0], [0, 1, 0]); if (!inside.ok) return inside;
      if (inside.value || tool.some((curve) => reliefBoundaryParameter(curve, midpoint) !== null)) return { ok: true, value: true };
    }
  }
  return { ok: true, value: false };
}
