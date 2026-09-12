import { exactExpressionValueFromNumber as n } from '@pointercad/expression';
import { createKernelApi } from '@pointercad/kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, type AssemblyKernelBridge } from '../kernelBridge.js';
import type { ResolvedCurve } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { sheetBoundaryEdges } from './panelGeometry.js';
import { recomputeSheetFlat } from './recomputeSheetFlat.js';
import { resolveRectangularFlange, type ResolvedSheetBody } from './resolveSheetGeometry.js';
import { resolveSheetRelief } from './resolveSheetRelief.js';
import { sheetShapeKey } from './shapeKey.js';
import type { SheetReliefFeature } from './types.js';
import { resolveSheetFlatOutline } from './flatOutline.js';
import { sheetLoopSignedArea } from './panelGeometry.js';
import { sheetFlatBendLines } from './flatBendLines.js';

let bridge: AssemblyKernelBridge;
beforeAll(async () => { await loadOcctForNode(); bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode)); }, 180_000);
function fixture(angle: number) {
  const points: readonly Vec3[] = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0]];
  const outer: readonly ResolvedCurve[] = points.map((from, i) => ({ kind: 'segment', featureId: `base-${i}`, from, to: points[(i + 1) % 4] }));
  const source: ResolvedSheetBody = { rootFeatureId: 'base', rule: { thickness: n(2), innerRadius: n(3), kFactor: n(0.4) },
    panels: [{ id: 'base', normal: [0, 0, 1], outer, holes: [] }], bends: [] };
  const edges = sheetBoundaryEdges(source.panels[0]); if (!edges.ok) throw new Error(edges.message);
  const top = edges.value.find((edge) => edge.from[1] === 20 && edge.to[1] === 20);
  const right = edges.value.find((edge) => edge.from[0] === 20 && edge.to[0] === 20);
  if (top === undefined || right === undefined) throw new Error('required boundary');
  const flange = resolveRectangularFlange({ kind: 'sheetFlange', id: 'flange', name: 'L板', suppressed: false, targetFeatureId: 'base',
    edges: [{ panelId: 'base', boundaryId: top.id }], length: n(10), angle: n(angle), startOffset: n(0), endOffset: n(0),
    lengthBasis: 'tangent', profile: null, rule: { innerRadius: null, kFactor: null } }, source, 'source');
  if (!flange.ok) throw new Error(flange.message);
  const feature: SheetReliefFeature = { kind: 'sheetRelief', id: 'relief', name: '曲げリリーフ', suppressed: false, targetFeatureId: 'flange',
    boundary: { panelId: 'base', boundaryId: right.id }, position: n(20), width: n(4), depth: n(5), shape: 'rectangle' };
  return { body: flange.value.body, feature, base: source, occupied: top.id };
}

describe('円筒帯をまたぐリリーフの再構築と再展開', () => {
  const cases = [-90, 90].flatMap((angle) => (['rectangle', 'slot'] as const).map((shape) => ({ angle, shape })));
  const flatCases = cases.flatMap(({ angle, shape }) => {
    const source = fixture(angle), result = resolveSheetRelief({ ...source.feature, shape }, source.body);
    if (!result.ok) throw new Error(result.message);
    return result.value.body.panels.map(panel => ({ angle, shape, fixedPanelId: panel.id }));
  });
  it.each(cases)(
    '$angle度の$shapeが基板と曲げ帯を同じ輪郭で切り、曲げ形状の材料を保つ', async ({ angle, shape }) => {
      const source = fixture(angle), before = JSON.stringify(source.body), feature = { ...source.feature, shape };
      const result = resolveSheetRelief(feature, source.body); if (!result.ok) throw new Error(result.message);
      const { plan } = result.value, id = `relief-${shape}-${angle}`;
      const removedFolded = shape === 'rectangle' ? 20 + 400 / 19 : 78 * (6 + Math.PI) / 19;
      try {
        const folded = await bridge.recomputeSolids([{ featureId: id, name: id, plan, key: sheetShapeKey(plan), visible: true }], { partId: id, generation: 1 });
        expect(folded.failures).toEqual([]); expect(folded.bodies).toHaveLength(1);
        expect(folded.bodies[0].volume).toBeCloseTo(1200 + 80 * Math.PI - removedFolded, 5);
        expect(JSON.stringify(source.body)).toBe(before);
      } finally { await bridge.releasePart(id); }
    });
  it.each(flatCases)('$angle度の$shapeを$fixedPanelIdで固定して展開し、体積・輪郭・曲げ方向を保つ', async ({ angle, shape, fixedPanelId }) => {
    const source = fixture(angle), before = JSON.stringify(source.body);
    const result = resolveSheetRelief({ ...source.feature, shape }, source.body); if (!result.ok) throw new Error(result.message);
    const id = `relief-flat-${shape}-${angle}-${fixedPanelId}`;
    const removedFlat = shape === 'rectangle' ? 40 : 24 + 4 * Math.PI;
    try {
      const flat = await recomputeSheetFlat(result.value.body, { sourceFeatureId: id, fixedPanelId, seamConnectionIds: [] }, bridge, { partId: id, generation: 1 });
      if (!flat.ok) throw new Error(flat.message);
      expect(flat.body.volume).toBeCloseTo(1200 + 76 * Math.PI - removedFlat, 5);
      const outline = await resolveSheetFlatOutline(bridge, flat.bodyKey, flat.geometry.thickness);
      if (!outline.ok) throw new Error(outline.message);
      const area = outline.value.loops.reduce((sum, loop) => sum + sheetLoopSignedArea(loop.curves, [0, 0, 1]), 0);
      expect(area).toBeCloseTo((1200 + 76 * Math.PI - removedFlat) / 2, 5);
      expect(outline.value.loops).toHaveLength(1);
      const lines = sheetFlatBendLines(flat.geometry); if (!lines.ok) throw new Error(lines.message);
      expect(lines.value.length).toBeGreaterThan(0);
      expect(lines.value.every((line) => line.direction === (angle > 0 ? 'up' : 'down'))).toBe(true);
      expect(JSON.stringify(source.body)).toBe(before);
    } finally { await bridge.releasePart(id); }
  });
  it.each([0, 90])('%s度の曲げ全幅を横断する切欠きが子パネルまで届き、0度の接続も保持する', async (angle) => {
    const source = fixture(angle), result = resolveSheetRelief({ ...source.feature, width: n(20) }, source.body);
    if (!result.ok) throw new Error(result.message);
    const { plan, body } = result.value, id = `through-${angle}`;
    try {
      const folded = await bridge.recomputeSolids([{ featureId: id, name: id, plan, key: sheetShapeKey(plan), visible: true }], { partId: id, generation: 1 });
      expect(folded.failures).toEqual([]); expect(folded.bodies[0].volume).toBeCloseTo(angle === 0 ? 1000 : 1000 + 79 * Math.PI, 5);
      const flat = await recomputeSheetFlat(body, { sourceFeatureId: id, fixedPanelId: body.panels[1].id, seamConnectionIds: [] }, bridge, { partId: id, generation: 2 });
      if (!flat.ok) throw new Error(flat.message);
      expect(flat.body.volume).toBeCloseTo(angle === 0 ? 1000 : 1000 + 76 * Math.PI, 5);
    } finally { await bridge.releasePart(id); }
  });
  it('入口の占有・不正寸法・材料分離を断り、元の板金を変えない', () => {
    const source = fixture(90), before = JSON.stringify(source.body);
    for (const feature of [{ ...source.feature, depth: n(0) }, { ...source.feature, position: n(21) },
      { ...source.feature, shape: 'slot' as const, width: n(20), depth: n(2) },
      { ...source.feature, boundary: { ...source.feature.boundary, boundaryId: source.occupied } }])
      expect(resolveSheetRelief(feature, source.body).ok).toBe(false);
    const separated = resolveSheetRelief({ ...source.feature, targetFeatureId: 'base', position: n(10), width: n(4), depth: n(25) }, source.base);
    expect(separated.ok).toBe(false); expect(JSON.stringify(source.body)).toBe(before);
  });
});
