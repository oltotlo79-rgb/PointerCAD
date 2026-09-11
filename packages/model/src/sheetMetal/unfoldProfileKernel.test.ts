import { createKernelApi } from '@pointercad/kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, type AssemblyKernelBridge } from '../kernelBridge.js';
import type { ResolvedCurve } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { resolvedSheetBodyPlan } from './bodyPlan.js';
import { recomputeSheetFlat } from './recomputeSheetFlat.js';
import { sheetShapeKey } from './shapeKey.js';
import { closedSheetLoop } from './testing/closedSheetLoop.js';
import { unfoldSheetBody } from './unfoldSheetBody.js';
import { resolveSheetFlatOutline } from './flatOutline.js';
import { buildSheetFlatHoleSchedule } from './flatHoleSchedule.js';
import { sheetFlatBendLines } from './flatBendLines.js';

let bridge: AssemblyKernelBridge;
beforeAll(async () => { await loadOcctForNode(); bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode)); }, 180_000);
function fixture() {
  const source = closedSheetLoop(), first = source.bends[0];
  const points: readonly Vec3[] = [[0, 0, 0], [20, 0, 0], [20, first.allowance, 0], [0, first.allowance, 0]];
  const outer: readonly ResolvedCurve[] = points.map((from, i) => ({ kind: 'segment', featureId: `band-${i}`, from, to: points[(i + 1) % 4] }));
  const circle: ResolvedCurve = { kind: 'arc', featureId: 'bend-hole', center: [10, first.allowance / 2, 0],
    radius: 1, normal: [0, 0, 1], xAxis: [1, 0, 0], startAngle: 0, endAngle: -2 * Math.PI };
  return { ...source, bends: [{ ...first, flatProfile: { outer, holes: [[circle]] } }, ...source.bends.slice(1)] };
}
describe('円筒上の穴を折曲げ・展開・継ぎ目で失わない', () => {
  it('曲げ帯に穴のある角筒を1立体に再構築し、厚み積分の独立体積に一致する', async () => {
    const body = fixture(), result = resolvedSheetBodyPlan(body); if (!result.ok) throw new Error(result.message);
    const plan = result.value, id = 'curved-hole-folded';
    try {
      const value = await bridge.recomputeSolids([{ featureId: id, name: '穴付き角筒', plan, key: sheetShapeKey(plan), visible: true }], { partId: id, generation: 1 });
      expect(value.failures).toEqual([]); expect(value.bodies).toHaveLength(1);
      expect(value.bodies[0].volume).toBeCloseTo(3200 + 320 * Math.PI - 2 * Math.PI * 4 / 3.8, 5);
    } finally { await bridge.releasePart(id); }
  });
  it.each([['wall-0', 'corner-0'], ['wall-2', 'corner-0'], ['wall-0', 'corner-2'], ['wall-2', 'corner-2']])(
    '固定面%s・継ぎ目%sでも穴の種類と展開体積を保つ', async (fixedPanelId, seam) => {
      const body = fixture(), id = `curved-hole-${fixedPanelId}-${seam}`;
      const flat = unfoldSheetBody(body, fixedPanelId, [seam]); if (!flat.ok) throw new Error(flat.message);
      const holeBand = flat.value.bends.find((bend) => bend.id === 'corner-0');
      expect(holeBand?.panel?.holes[0][0]).toMatchObject({ kind: 'arc', radius: 1 });
      try {
        const result = await recomputeSheetFlat(body, { sourceFeatureId: 'tube', fixedPanelId, seamConnectionIds: [seam] }, bridge, { partId: id, generation: 1 });
        if (!result.ok) throw new Error(result.message);
        expect(result.body.volume).toBeCloseTo(3200 + 302 * Math.PI, 5);
        const outline = await resolveSheetFlatOutline(bridge, result.bodyKey, 2);
        if (!outline.ok) throw new Error(outline.message);
        expect(outline.value.loops.filter((loop) => loop.kind === 'hole')).toHaveLength(1);
        const schedule = buildSheetFlatHoleSchedule(outline.value, { datum: [0,0,0], x: [1,0,0], y: [0,1,0] });
        if (!schedule.ok) throw new Error(schedule.reason);
        expect(schedule.rows).toHaveLength(1); expect(schedule.rows[0].diameter).toBeCloseTo(2, 7);
        const hole = holeBand?.panel?.holes[0][0]; if (hole?.kind !== 'arc') throw new Error('展開円穴が必要です');
        for (const [axis, value] of hole.center.entries()) expect(schedule.rows[0].center[axis]).toBeCloseTo(value, 6);
        const lines = sheetFlatBendLines(result.geometry); if (!lines.ok) throw new Error(lines.message);
        const length = lines.value.filter((line) => line.bendId === 'corner-0')
          .reduce((sum, line) => sum + Math.hypot(...line.from.map((value, axis) => value - line.to[axis])), 0);
        expect(length).toBeCloseTo(18, 7);
      } finally { await bridge.releasePart(id); }
    });
});
