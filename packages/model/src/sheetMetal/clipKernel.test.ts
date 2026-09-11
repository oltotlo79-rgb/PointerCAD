import { createKernelApi } from '@pointercad/kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, type AssemblyKernelBridge } from '../kernelBridge.js';
import type { ResolvedSolidStep } from '../part/resolvePart.js';
import type { ResolvedCurve } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { clipSheetPanel } from './clipSheetPanel.js';
import type { SheetPanelGeometry } from './panelGeometry.js';
import type { SheetBasePlan } from './resolveSheetGeometry.js';
import { rigidSheetCurve } from './rigidCurve.js';
import { sheetShapeKey } from './shapeKey.js';

let bridge: AssemblyKernelBridge;
beforeAll(async () => { await loadOcctForNode(); bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode)); }, 180_000);
const holes: readonly ResolvedCurve[] = [
  { kind: 'arc', featureId: 'hole', center: [10, 5, 0], radius: 2, normal: [0, 0, 1], xAxis: [1, 0, 0], startAngle: 0, endAngle: 2 * Math.PI },
  { kind: 'ellipse', featureId: 'hole', center: [10, 5, 0], majorRadius: 3, minorRadius: 2, normal: [0, 0, 1],
    majorAxis: [Math.SQRT1_2, Math.SQRT1_2, 0], startAngle: 0, endAngle: 2 * Math.PI },
  { kind: 'spline', featureId: 'hole', mode: 'control', closed: true, points: [[8, 4, 0], [10, 2, 0], [13, 4, 0], [12, 7, 0], [9, 8, 0], [7, 6, 0]] },
  { kind: 'spline', featureId: 'hole', mode: 'interpolate', closed: true, points: [[8, 4, 0], [10, 2, 0], [13, 4, 0], [12, 7, 0], [9, 8, 0], [7, 6, 0]] },
];
function step(panel: SheetPanelGeometry, id: string): ResolvedSolidStep {
  const plan: SheetBasePlan = { kind: 'sheetBase', outer: panel.outer, holes: panel.holes, normal: panel.normal, thickness: 2, reversed: false };
  return { featureId: id, name: id, plan, key: sheetShapeKey(plan), visible: true };
}
describe('円弧・楕円・スプラインの切断を実OCCTで検算する', () => {
  it.each(holes)('$kindの穴を切欠きへ分割しても実立体の合計体積を保つ', async (hole) => {
    const points: readonly Vec3[] = [[0, 0, 0], [20, 0, 0], [20, 10, 0], [0, 10, 0]];
    const outer: ResolvedCurve[] = points.map((from, i) => ({ kind: 'segment', featureId: `edge-${i}`, from, to: points[(i + 1) % 4] }));
    const from = { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1] } as const;
    const target = { origin: [10, 20, 30], xAxis: [0, 1, 0], yAxis: [0, 0, 1], normal: [1, 0, 0] } as const;
    const map = (curve: ResolvedCurve) => rigidSheetCurve(curve, from, target);
    const source: SheetPanelGeometry = { id: 'source', outer: outer.map(map), holes: [[map(hole)]], normal: target.normal };
    const steps = [step(source, 'original')];
    for (const side of [-1, 1] as const) {
      const result = clipSheetPanel(source, { origin: [10, 30, 30], normal: [0, 1, 0] }, side, `cut-${side}`);
      if (!result.ok) throw new Error(result.message);
      const boundaries = result.value.filter((loop) => loop.kind === 'outer'); expect(boundaries).toHaveLength(1);
      steps.push(step({ id: `half-${side}`, normal: source.normal, outer: boundaries[0].curves,
        holes: result.value.filter((loop) => loop.kind === 'hole').map((loop) => loop.curves) }, `half-${side}`));
    }
    const partId = `clip-${hole.kind}-${hole.kind === 'spline' ? hole.mode : 'analytic'}`;
    try {
      const result = await bridge.recomputeSolids(steps, { partId, generation: 1 });
      expect(result.failures).toEqual([]); expect(result.bodies).toHaveLength(3);
      const original = result.bodies.find((body) => body.featureId === 'original'); if (original === undefined) throw new Error('元の板が必要です');
      const sum = result.bodies.filter((body) => body.featureId !== 'original').reduce((volume, body) => volume + body.volume, 0);
      expect(sum).toBeCloseTo(original.volume, 6);
      if (hole.kind === 'arc') expect(original.volume).toBeCloseTo(400 - 8 * Math.PI, 6);
      if (hole.kind === 'ellipse') expect(original.volume).toBeCloseTo(400 - 12 * Math.PI, 6);
    } finally { await bridge.releasePart(partId); }
  });
});
