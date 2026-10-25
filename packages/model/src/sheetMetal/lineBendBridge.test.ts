import { createKernelApi } from '@pointercad/kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import { exactExpressionValueFromNumber as n } from '@pointercad/expression';
import { absoluteCoordinate, appendSolid, createEmptyPartDocument, createSheetBaseFeature, createSheetFlangeFeature,
  recomputePart, replaceSketch, resolvePart, sheetBoundaryEdges } from '../index.js';
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

describe('W05 actual material overlap and disconnected material boundaries', () => {
  it.each(['overlap', 'disconnected'] as const)('%s refuses with a reason, preserves the request and releases protected shapes', async (kind) => {
    const good = step(90, 'right');
    if (good.plan.kind !== 'sheetBody') throw new Error('Expected sheet body plan');
    const plan = kind === 'overlap' ? { ...good.plan, panels: [...good.plan.panels, good.plan.panels[0]] }
      : { ...good.plan, bends: [] };
    const bad = { ...good, plan, key: sheetShapeKey(plan) }, partId = `w05-${kind}`;
    const before = structuredClone({ panel, line, good, bad });
    const protectedBefore = (await api.getShapeCacheStats()).protectedKeyCount;
    try {
      const failed = await bridge.recomputeSolids([bad], { partId, generation: 1 });
      expect(failed.bodies).toEqual([]);
      expect(failed.failures).toHaveLength(1);
      expect(failed.failures[0]).toMatchObject({ featureId: 'bend' });
      expect(failed.failures[0].message).toBe(kind === 'overlap'
        ? '曲げた板金が重なるか、材料が失われています。角度・半径とリリーフを確認してください。'
        : '曲げた板金がつながっていません。指定線・接線と輪郭を確認してください。');
      expect({ panel, line, good, bad }).toEqual(before);
      const recovered = await bridge.recomputeSolids([good], { partId, generation: 2 });
      expect(recovered.failures).toEqual([]);
      expect(recovered.bodies).toHaveLength(1);
      expect(recovered.bodies[0].isValid).toBe(true);
      // Source area 20*20 - 10*15 - 2*pi, width 10, t=2, Ri=3, K=.4.
      const area = 250 - 2 * Math.PI, bandArea = 10 * Math.PI / 2 * 3.8;
      const volume = 2 * (area - bandArea) + 2 * bandArea * 4 / 3.8;
      expect(recovered.bodies[0].volume).toBeGreaterThan(0);
      expect(Math.abs(recovered.bodies[0].volume - volume) / volume).toBeLessThanOrEqual(1e-9);
      expect({ panel, line, good, bad }).toEqual(before);
    } finally { await bridge.releasePart(partId); }
    expect((await api.getShapeCacheStats()).protectedKeyCount).toBe(protectedBefore);
  });

  it.each(['overlap', 'disconnected'] as const)('%s also has a reason code at the public PartDocument operation', async (kind) => {
    const empty = createEmptyPartDocument(), sketch = empty.sketches[0];
    const drawn = replaceSketch(empty, { ...sketch, features: [
      { kind: 'rectangle', id: 'boundary', name: 'Boundary', planeId: 'xy', construction: false,
        corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(50, 30, 0) },
      { kind: 'face', id: 'face', name: 'Face', planeId: 'xy', boundary: [{ featureId: 'boundary' }], color: '#ffffff' },
    ] });
    const base = createSheetBaseFeature(drawn, { sketchId: sketch.id, faceFeatureId: 'face' });
    const document = appendSolid(drawn, base), panel = resolvePart(document).sheetMetalBodies?.get(base.id)?.panels[0];
    if (panel === undefined) throw new Error('Expected base panel');
    const edges = sheetBoundaryEdges(panel);
    if (!edges.ok) throw new Error(edges.message);
    const references = [edges.value[0], edges.value[2]].map((edge) => ({ panelId: panel.id, boundaryId: edge.id }));
    const feature = createSheetFlangeFeature(document, base.id, kind === 'overlap' ? references : [{ ...references[0], panelId: 'missing-panel' }]);
    const candidate = appendSolid(document, { ...feature, angle: n(179), length: n(40) });
    const before = structuredClone({ document, candidate, feature });
    try {
      const result = await recomputePart(candidate, bridge, { partId: document.id });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({ featureId: feature.id, code: kind === 'overlap' ? 'kernelFailed' : 'invalidValue',
        message: kind === 'overlap' ? 'フランジが既存の板に食い込んでいます。角度・長さ・端の位置を変更してください。'
          : 'フランジの元のパネルが見つかりません。板金の縁を選び直してください。' });
      expect(result.bodies.some((body) => body.featureId === feature.id)).toBe(false);
      expect({ document, candidate, feature }).toEqual(before);
      const valid = createSheetFlangeFeature(document, base.id, [references[0]]);
      const recovery = appendSolid(document, { ...valid, angle: n(90), length: n(10) });
      const recovered = await recomputePart(recovery, bridge, { partId: document.id });
      expect(recovered.errors).toEqual([]);
      expect(recovered.bodies).toHaveLength(1);
      expect(recovered.bodies[0].isValid).toBe(true);
      const expected = 1500 + 50 * 10 + 50 * 1.5 * Math.PI / 2;
      expect(recovered.bodies[0].volume).toBeGreaterThan(0);
      expect(Math.abs(recovered.bodies[0].volume - expected) / expected).toBeLessThanOrEqual(1e-9);
    } finally { await bridge.releasePart(document.id); }
  });
});

describe('指定線曲げの正規Worker境界と形状所有権', () => {
  it.each([90, -90])('%d度・左右固定のU字を1立体へ戻し、全体キャッシュと所有保護を使える', async (angle) => {
    for (const side of ['left', 'right'] as const) {
      const id = `line-bend-${angle}-${side}`, request = step(angle, side), before = (await api.getShapeCacheStats()).protectedKeyCount;
      const sourceBefore = JSON.stringify(panel), requestBefore = JSON.stringify(request);
      try {
        const result = await bridge.recomputeSolids([request], { partId: id, generation: 1 });
        expect(result.failures).toEqual([]); expect(result.bodies).toHaveLength(1);
        // U外周250、穴2π、板厚2。幅合計10の曲げ帯で中立半径3.8→肉厚中央4の差が2π。
        expect(result.bodies[0].volume).toBeCloseTo(500 - 2 * Math.PI, 5);
        const area = 20 * 20 - 10 * 15 - 2 * Math.PI, allowance = Math.PI / 2 * (3 + 0.4 * 2);
        const bandArea = 10 * allowance, expected = 2 * (area - bandArea) + 2 * bandArea * 4 / 3.8;
        expect(expected).toBeGreaterThan(0);
        expect(Math.abs(result.bodies[0].volume - expected) / expected).toBeLessThanOrEqual(1e-9);
        expect(result.failures.filter((failure) => failure.message.includes('重な'))).toHaveLength(0);
        expect(JSON.stringify(panel)).toBe(sourceBefore);
        expect(JSON.stringify(request)).toBe(requestBefore);

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
