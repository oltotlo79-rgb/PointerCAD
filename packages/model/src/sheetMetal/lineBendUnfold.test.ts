import { exactExpressionValueFromNumber as n } from '@pointercad/expression';
import { createKernelApi } from '@pointercad/kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, type AssemblyKernelBridge } from '../kernelBridge.js';
import type { ResolvedCurve, ResolvedSegment } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { connectLineBendRegions } from './connectLineBendRegions.js';
import { resolveSheetFlatOutline } from './flatOutline.js';

import { partitionSheetLineBend } from './partitionLineBend.js';
import { recomputeSheetFlat } from './recomputeSheetFlat.js';
import type { ResolvedSheetBody } from './resolveSheetGeometry.js';
import { unfoldSheetBody } from './unfoldSheetBody.js';

let bridge: AssemblyKernelBridge;
beforeAll(async () => { await loadOcctForNode(); bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode)); }, 180_000);
function fixture() {
  const points: readonly Vec3[] = [[0, 0, 0], [40, 0, 0], [40, 30, 0], [0, 30, 0]];
  const outer: readonly ResolvedCurve[] = points.map((from, i) => ({ kind: 'segment', featureId: `edge-${i}`, from, to: points[(i + 1) % 4] }));
  const hole: ResolvedCurve = { kind: 'arc', featureId: 'hole', radius: 4, center: [20, 15, 0], normal: [0, 0, 1], xAxis: [1, 0, 0], startAngle: 0, endAngle: 2 * Math.PI };
  const line: ResolvedSegment = { kind: 'segment', featureId: 'line', from: [0, 15, 0], to: [40, 15, 0] };
  const result = partitionSheetLineBend({ id: 'base', normal: [0, 0, 1], outer, holes: [[hole]] }, line, 'right',
    { thickness: 2, radius: 3, kFactor: 0.4, angle: 90 }, 'bend');
  if (!result.ok) throw new Error(result.message);
  const value = result.value, parent = value.fixed[0], child = value.moving[0];
  expect(value.fixed).toHaveLength(1); expect(value.moving).toHaveLength(1); expect(value.bands).toHaveLength(2);
  const connected = connectLineBendRegions(value, 'bend'); if (!connected.ok) throw new Error(connected.message);
  const body: ResolvedSheetBody = { rootFeatureId: 'base', rule: { thickness: n(2), innerRadius: n(3), kFactor: n(0.4) },
    panels: [parent, child], bends: connected.value };
  return body;
}
describe('穴によって二つへ分かれた同じ曲げの再展開', () => {
  it('両固定面で追加の継ぎ目を要求せず、全ての帯と元の円穴の体積を保つ', async () => {
    const body = fixture();
    const bodyBefore = JSON.stringify(body);
    for (const panel of body.panels) {
      const flat = unfoldSheetBody(body, panel.id, []); if (!flat.ok) throw new Error(flat.message);
      expect(flat.value.bends).toHaveLength(2); expect(flat.value.joins).toHaveLength(1);
      expect(flat.value.bends.filter((bend) => bend.extraPanelId !== undefined)).toHaveLength(1);
      const id = `split-bend-flat-${panel.id}`;
      try {
        const result = await recomputeSheetFlat(body, { sourceFeatureId: 'bend', fixedPanelId: panel.id, seamConnectionIds: [] }, bridge, { partId: id, generation: 1 });
        if (!result.ok) throw new Error(result.message);
        expect(result.body.volume).toBeCloseTo(2400 - 32 * Math.PI, 5);
        const expected = 2 * (40 * 30 - Math.PI * 4 ** 2);
        expect(Math.abs(result.body.volume - expected) / expected).toBeLessThanOrEqual(1e-9);
        const outline = await resolveSheetFlatOutline(bridge, result.bodyKey, 2); if (!outline.ok) throw new Error(outline.message);
        expect(outline.value.loops).toHaveLength(2);
        const outer = outline.value.loops.find((loop) => loop.kind === 'outer');
        const hole = outline.value.loops.find((loop) => loop.kind === 'hole');
        if (outer === undefined || hole === undefined) throw new Error('外周と円穴が必要です');
        expect(outer.curves).toHaveLength(4);
        const lengths = outer.curves.map((curve) => {
          if (curve.kind !== 'segment') throw new Error('矩形の直線が必要です');
          return Math.hypot(...curve.to.map((value, i) => value - curve.from[i]));
        }).sort((a, b) => a - b);
        for (const [i, expectedLength] of [30, 30, 40, 40].entries())
          expect(Math.abs(lengths[i] - expectedLength)).toBeLessThanOrEqual(0.01);
        let swept = 0;
        for (const curve of hole.curves) {
          if (curve.kind !== 'arc') throw new Error('円穴の円弧が必要です');
          expect(Math.abs(curve.radius - 4)).toBeLessThanOrEqual(0.01);
          swept += Math.abs(curve.endAngle - curve.startAngle);
          const distances = outer.curves.map((edge) => {
            if (edge.kind !== 'segment') throw new Error('矩形の直線が必要です');
            const dx = edge.to[0] - edge.from[0], dy = edge.to[1] - edge.from[1];
            return Math.abs(dx * (curve.center[1] - edge.from[1]) - dy * (curve.center[0] - edge.from[0])) / Math.hypot(dx, dy);
          }).sort((a, b) => a - b);
          for (const [i, distance] of [15, 15, 20, 20].entries()) expect(Math.abs(distances[i] - distance)).toBeLessThanOrEqual(0.01);
        }
        expect(Math.abs(swept - 2 * Math.PI) * 4).toBeLessThanOrEqual(0.01);
        expect(JSON.stringify(body)).toBe(bodyBefore);

      } finally { await bridge.releasePart(id); }
    }
  });
});
