import { createKernelApi } from '@pointercad/kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, type AssemblyKernelBridge } from '../kernelBridge.js';
import type { ResolvedCurve } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import type { SheetPanelGeometry, SheetTangentFrame } from './panelGeometry.js';
import type { ReliefBoundary } from './reliefIntersections.js';
import type { SheetBasePlan } from './resolveSheetGeometry.js';
import { rigidSheetCurve } from './rigidCurve.js';
import { sheetShapeKey } from './shapeKey.js';
import { subtractSheetRelief } from './subtractSheetRelief.js';

let bridge: AssemblyKernelBridge;
beforeAll(async () => { await loadOcctForNode(); bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode)); }, 180_000);
function polygon(points: readonly Vec3[]): readonly ReliefBoundary[] {
  return points.map((from, i) => ({ kind: 'segment', featureId: `edge-${i}`, from, to: points[(i + 1) % points.length] }));
}
const source: SheetPanelGeometry = { id: 'source', normal: [0, 0, 1], outer: polygon([[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0]]), holes: [] };
const rectangle = polygon([[8, -2, 0], [12, -2, 0], [12, 6, 0], [8, 6, 0]]);
const slot: readonly ReliefBoundary[] = [
  { kind: 'segment', featureId: 'bottom', from: [8, -2, 0], to: [12, -2, 0] },
  { kind: 'segment', featureId: 'right', from: [12, -2, 0], to: [12, 4, 0] },
  { kind: 'arc', featureId: 'tip', center: [10, 4, 0], normal: [0, 0, 1], xAxis: [1, 0, 0], radius: 2, startAngle: 0, endAngle: Math.PI },
  { kind: 'segment', featureId: 'left', from: [8, 4, 0], to: [8, -2, 0] },
];
const hole: ResolvedCurve = { kind: 'arc', featureId: 'hole', center: [10, 7, 0], normal: [0, 0, 1], xAxis: [1, 0, 0], radius: 2, startAngle: 0, endAngle: 2 * Math.PI };
const frames: readonly SheetTangentFrame[] = [
  { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1] },
  { origin: [10, 20, 30], xAxis: [0, 1, 0], yAxis: [0, 0, 1], normal: [1, 0, 0] },
];
async function volume(panel: SheetPanelGeometry, id: string): Promise<number> {
  const plan: SheetBasePlan = { kind: 'sheetBase', outer: panel.outer, holes: panel.holes, normal: panel.normal, thickness: 2, reversed: false };
  try {
    const result = await bridge.recomputeSolids([{ featureId: id, name: id, key: sheetShapeKey(plan), plan, visible: true }], { partId: id, generation: 1 });
    expect(result.failures).toEqual([]); expect(result.bodies).toHaveLength(1); return result.bodies[0].volume;
  } finally { await bridge.releasePart(id); }
}

describe('矩形・長穴の切欠きの解析曲線と実材料', () => {
  it.each([{ name: 'rectangle', tool: rectangle, panel: source, expected: 752 },
    { name: 'slot', tool: slot, panel: source, expected: 768 - 4 * Math.PI },
    { name: 'slot-through-hole', tool: slot, panel: { ...source, holes: [[hole]] },
      expected: 2 * (384 - 6 * Math.PI + 8 * Math.acos(3 / 4) - 1.5 * Math.sqrt(7)) }].flatMap((fixture) => frames.map((frame, index) => ({ ...fixture, frame, index }))))(
    '$name / 平面$index の切欠きと穴の合流を独立体積で検算する', async (fixture) => {
      const map = (curve: ResolvedCurve) => rigidSheetCurve(curve, frames[0], fixture.frame);
      const panel = { ...fixture.panel, normal: fixture.frame.normal, outer: fixture.panel.outer.map(map), holes: fixture.panel.holes.map((loop) => loop.map(map)) };
      const tool = fixture.tool.map((curve): ReliefBoundary => { const mapped = map(curve); if (mapped.kind !== 'segment' && mapped.kind !== 'arc') throw new Error('relief curve'); return mapped; });
      const before = JSON.stringify(panel), result = subtractSheetRelief(panel, tool, `relief-${fixture.name}`);
      if (!result.ok) throw new Error(result.message);
      expect(result.value).toHaveLength(1); expect(result.value[0].holes).toEqual([]);
      if (fixture.name !== 'rectangle') expect(result.value[0].outer.some((curve) => curve.kind === 'arc')).toBe(true);
      expect(await volume(result.value[0], `${fixture.name}-${fixture.index}`)).toBeCloseTo(fixture.expected, 5);
      expect(JSON.stringify(panel)).toBe(before);
    });
  it.each(['circle', 'ellipse'] as const)('%sの曲面外周を矩形で切っても曲線を保つ', async (kind) => {
    const curve: ResolvedCurve = kind === 'circle' ? { ...hole, featureId: 'outer', center: [10, 10, 0], radius: 10 }
      : { kind: 'ellipse', featureId: 'outer', center: [10, 5, 0], normal: [0, 0, 1], majorAxis: [1, 0, 0], majorRadius: 10, minorRadius: 5, startAngle: 0, endAngle: 2 * Math.PI };
    const depth = kind === 'circle' ? 5 : 3, panel = { ...source, outer: [curve] };
    const tool = polygon([[9, -2, 0], [11, -2, 0], [11, depth, 0], [9, depth, 0]]);
    const result = subtractSheetRelief(panel, tool, `outer-${kind}`); if (!result.ok) throw new Error(result.message);
    expect(result.value).toHaveLength(1); expect(result.value[0].outer.some((piece) => piece.kind === curve.kind)).toBe(true);
    const expected = kind === 'circle' ? 100 * Math.PI + 10 - Math.sqrt(99) - 100 * Math.asin(0.1)
      : 50 * Math.PI + 4 - Math.sqrt(99) / 2 - 50 * Math.asin(0.1);
    expect(await volume(result.value[0], `outer-${kind}`)).toBeCloseTo(expected * 2, 5);
  });
  it('工具が外にあれば同じ面を返し、全面除去と材料の分割を空配列/別領域で表す', () => {
    const outside = subtractSheetRelief(source, polygon([[30, 0, 0], [40, 0, 0], [40, 10, 0], [30, 10, 0]]), 'outside');
    expect(outside.ok && outside.value[0] === source).toBe(true);
    const all = subtractSheetRelief(source, polygon([[-1, -1, 0], [21, -1, 0], [21, 21, 0], [-1, 21, 0]]), 'all');
    expect(all).toEqual({ ok: true, value: [] });
    const divided = subtractSheetRelief(source, polygon([[9, -1, 0], [11, -1, 0], [11, 21, 0], [9, 21, 0]]), 'divided');
    if (!divided.ok) throw new Error(divided.message); expect(divided.value).toHaveLength(2);
  });
});
