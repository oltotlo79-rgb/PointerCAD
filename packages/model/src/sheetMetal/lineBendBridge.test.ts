import { createKernelApi } from '@pointercad/kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, type AssemblyKernelBridge } from '../kernelBridge.js';
import type { ResolvedSolidStep } from '../part/resolvePart.js';
import type { ResolvedCurve, ResolvedSegment } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { sheetLineBendPlan } from './lineBendPlan.js';
import type { SheetPanelGeometry } from './panelGeometry.js';
import { partitionSheetLineBend } from './partitionLineBend.js';
import { sheetShapeKey } from './shapeKey.js';

let api: ReturnType<typeof createKernelApi>, bridge: AssemblyKernelBridge;
beforeAll(async () => { await loadOcctForNode(); api = createKernelApi(loadOcctForNode); bridge = createDirectKernelBridge(api); }, 180_000);
function polygon(points: readonly Vec3[]): readonly ResolvedCurve[] {
  return points.map((from, i) => ({ kind: 'segment', featureId: `edge-${i}`, from, to: points[(i + 1) % points.length] }));
}
const circle = (x: number): ResolvedCurve => ({ kind: 'arc', featureId: `hole-${x}`, center: [x, 17, 0], radius: 1,
  normal: [0, 0, 1], xAxis: [1, 0, 0], startAngle: 0, endAngle: 2 * Math.PI });
const panel: SheetPanelGeometry = { id: 'source', normal: [0, 0, 1], holes: [[circle(2.5)], [circle(17.5)]],
  outer: polygon([[0, 0, 0], [20, 0, 0], [20, 20, 0], [15, 20, 0], [15, 5, 0], [5, 5, 0], [5, 20, 0], [0, 20, 0]]) };
const line: ResolvedSegment = { kind: 'segment', featureId: 'line', from: [0, 10, 0], to: [20, 10, 0] };
function step(angle: number, side: 'left' | 'right'): ResolvedSolidStep {
  const result = partitionSheetLineBend(panel, line, side, { thickness: 2, radius: 3, kFactor: 0.4, angle }, 'bend');
  if (!result.ok) throw new Error(result.message);
  const plan = sheetLineBendPlan(result.value);
  return { featureId: 'bend', name: '指定線曲げ', plan, key: sheetShapeKey(plan), visible: true };
}

describe('指定線曲げの正規Worker境界と形状所有権', () => {
  it.each([90, -90])('%d度・左右固定のU字を1立体へ戻し、全体キャッシュと所有保護を使える', async (angle) => {
    for (const side of ['left', 'right'] as const) {
      const id = `line-bend-${angle}-${side}`, request = step(angle, side), before = (await api.getShapeCacheStats()).protectedKeyCount;
      try {
        const result = await bridge.recomputeSolids([request], { partId: id, generation: 1 });
        expect(result.failures).toEqual([]); expect(result.bodies).toHaveLength(1);
        // U外周250、穴2π、板厚2。幅合計10の曲げ帯で中立半径3.8→肉厚中央4の差が2π。
        expect(result.bodies[0].volume).toBeCloseTo(500 - 2 * Math.PI, 5);
        const again = await bridge.recomputeSolids([request], { partId: id, generation: 2 });
        expect(again.failures).toEqual([]); expect(again.cacheHits).toBe(1);
        const cancelled = await bridge.recomputeSolids([request], { partId: id, generation: 3, shouldCancel: () => true });
        expect(cancelled).toMatchObject({ cancelled: true });
      } finally { await bridge.releasePart(id); }
      expect((await api.getShapeCacheStats()).protectedKeyCount).toBe(before);
    }
  });
  it('重なった材料の再構築を拒否し、既存の正常形状を次世代で再利用できる', async () => {
    const original = step(90, 'right'); if (original.plan.kind !== 'sheetBody') throw new Error('板金の再構築段が必要です');
    const plan = { ...original.plan, panels: [...original.plan.panels, original.plan.panels[0]] };
    const bad = { ...original, plan, key: sheetShapeKey(plan) }, id = 'line-bend-overlap';
    try {
      expect((await bridge.recomputeSolids([original], { partId: id, generation: 1 })).failures).toEqual([]);
      const result = await bridge.recomputeSolids([bad], { partId: id, generation: 2 });
      expect(result.failures).toHaveLength(1); expect(result.failures[0].message).toContain('重なる');
      const recovered = await bridge.recomputeSolids([original], { partId: id, generation: 3 });
      expect(recovered.failures).toEqual([]); expect(recovered.cacheHits).toBe(1);
      expect(recovered.bodies[0].volume).toBeCloseTo(500 - 2 * Math.PI, 5);
    } finally { await bridge.releasePart(id); }
  });
});
