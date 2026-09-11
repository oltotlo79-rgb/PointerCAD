import { exactExpressionValueFromNumber as n } from '@pointercad/expression';
import { createKernelApi } from '@pointercad/kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, type AssemblyKernelBridge } from '../kernelBridge.js';
import type { ResolvedCurve, ResolvedSegment } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { connectLineBendRegions } from './connectLineBendRegions.js';
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
    for (const panel of body.panels) {
      const flat = unfoldSheetBody(body, panel.id, []); if (!flat.ok) throw new Error(flat.message);
      expect(flat.value.bends).toHaveLength(2); expect(flat.value.joins).toHaveLength(1);
      expect(flat.value.bends.filter((bend) => bend.extraPanelId !== undefined)).toHaveLength(1);
      const id = `split-bend-flat-${panel.id}`;
      try {
        const result = await recomputeSheetFlat(body, { sourceFeatureId: 'bend', fixedPanelId: panel.id, seamConnectionIds: [] }, bridge, { partId: id, generation: 1 });
        if (!result.ok) throw new Error(result.message);
        expect(result.body.volume).toBeCloseTo(2400 - 32 * Math.PI, 5);
      } finally { await bridge.releasePart(id); }
    }
  });
});
