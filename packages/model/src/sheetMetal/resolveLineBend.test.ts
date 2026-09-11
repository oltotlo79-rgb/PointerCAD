import { exactExpressionValueFromNumber as n } from '@pointercad/expression';
import { createKernelApi } from '@pointercad/kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, type AssemblyKernelBridge } from '../kernelBridge.js';
import type { ResolvedCurve, ResolvedSegment } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { availableSheetBoundaryEdges } from './availableBoundaryEdges.js';
import { recomputeSheetFlat } from './recomputeSheetFlat.js';
import { resolveSheetLineBend } from './resolveLineBend.js';
import { resolveRectangularFlange, type ResolvedSheetBody } from './resolveSheetGeometry.js';
import { sheetShapeKey } from './shapeKey.js';
import type { SheetBendFeature, SheetFlangeFeature } from './types.js';
import { unfoldSheetBody } from './unfoldSheetBody.js';

let bridge: AssemblyKernelBridge;
beforeAll(async () => { await loadOcctForNode(); bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode)); }, 180_000);
function source(points: readonly Vec3[]): ResolvedSheetBody {
  const outer: readonly ResolvedCurve[] = points.map((from, i) => ({ kind: 'segment', featureId: `edge-${i}`, from, to: points[(i + 1) % points.length] }));
  return { rootFeatureId: 'base', rule: { thickness: n(2), innerRadius: n(3), kFactor: n(0.4) },
    panels: [{ id: 'base', normal: [0, 0, 1], outer, holes: [] }], bends: [] };
}
const line: ResolvedSegment = { kind: 'segment', featureId: 'axis', from: [0, 10, 0], to: [20, 10, 0] };
const bend: SheetBendFeature = { kind: 'sheetBend', id: 'bend', name: '指定線曲げ', suppressed: false,
  targetFeatureId: 'base', panelId: 'base', line: { sketchId: 'sketch', lineFeatureId: 'axis' }, fixedSide: 'right',
  angle: n(90), rule: { innerRadius: null, kFactor: null } };
const u: readonly Vec3[] = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [15, 20, 0], [15, 10, 0], [5, 10, 0], [5, 20, 0], [0, 20, 0]];
const h: readonly Vec3[] = [[0, 0, 0], [5, 0, 0], [5, 8, 0], [15, 8, 0], [15, 0, 0], [20, 0, 0],
  [20, 20, 0], [15, 20, 0], [15, 12, 0], [5, 12, 0], [5, 20, 0], [0, 20, 0]];
const fixtures = [{ name: 'U', points: u, area: 300, panels: 3, folded: 600 + 3 * Math.PI },
  { name: 'H', points: h, area: 240, panels: 4, folded: 480 + 2 * Math.PI + 80 / 19 }].flatMap((fixture) =>
  [-90, 90].flatMap((angle) => (['left', 'right'] as const).map((fixedSide) => ({ ...fixture, angle, fixedSide }))));
const flatFixtures = fixtures.flatMap((fixture) => Array.from({ length: fixture.panels },
  (_, panelIndex) => ({ ...fixture, panelIndex })));

describe('指定線曲げの実材料とパネル接続の同時導出', () => {
  it.each(fixtures)(
    '$name形・$angle度・$fixedSide固定の曲げが全パネルと実材料を保持する', async (fixture) => {
        const { angle, fixedSide } = fixture;
        const original = source(fixture.points), before = JSON.stringify(original);
        const result = resolveSheetLineBend({ ...bend, angle: n(angle), fixedSide }, original, () => line);
        if (!result.ok) throw new Error(result.message);
        const { plan, body } = result.value, id = `regions-${fixture.name}-${angle}-${fixedSide}`;
        expect(body.panels).toHaveLength(fixture.panels); expect(plan.kind).toBe('sheetBody');
        if (plan.kind !== 'sheetBody') throw new Error('body plan required');
        expect(plan.bends).toHaveLength(1);
        try {
          const solid = await bridge.recomputeSolids([{ featureId: id, name: id, plan, key: sheetShapeKey(plan), visible: true }], { partId: id, generation: 1 });
          expect(solid.failures).toEqual([]); expect(solid.bodies).toHaveLength(1);
          expect(solid.bodies[0].volume).toBeCloseTo(fixture.folded, 5);
          expect(JSON.stringify(original)).toBe(before);
        } finally { await bridge.releasePart(id); }
    });

  // 1回のOCCT再計算を1ケースとし、全固定面を同じ制限時間で個別に検証する。
  it.each(flatFixtures)(
    '$name形・$angle度・$fixedSide固定・固定面$panelIndexから材料を一度だけ保持して再展開する', async (fixture) => {
      const original = source(fixture.points), before = JSON.stringify(original);
      const result = resolveSheetLineBend({ ...bend, angle: n(fixture.angle), fixedSide: fixture.fixedSide }, original, () => line);
      if (!result.ok) throw new Error(result.message);
      const body = result.value.body;
      expect(body.panels).toHaveLength(fixture.panels);
      const panel = body.panels[fixture.panelIndex];
      if (panel === undefined) throw new Error('検証対象の固定面が必要です');
      const flat = unfoldSheetBody(body, panel.id, []); if (!flat.ok) throw new Error(flat.message);
      expect(flat.value.bends.filter((item) => item.panel !== null)).toHaveLength(1);
      const id = `flat-regions-${fixture.name}-${fixture.angle}-${fixture.fixedSide}-${fixture.panelIndex}`;
      try {
        const unfolded = await recomputeSheetFlat(body, { sourceFeatureId: 'bend', fixedPanelId: panel.id, seamConnectionIds: [] }, bridge,
          { partId: id, generation: 1 });
        if (!unfolded.ok) throw new Error(unfolded.message);
        expect(unfolded.body.volume).toBeCloseTo(fixture.area * 2, 5);
        expect(JSON.stringify(original)).toBe(before);
      } finally { await bridge.releasePart(id); }
    });

  it('移動側にある既存フランジの枝も移動し、固定側の枝を保ち、再展開の長さを変えない', async () => {
    const original = source([[0, 0, 0], [20, 0, 0], [20, 30, 0], [0, 30, 0]]);
    const available = availableSheetBoundaryEdges(original, 'base'); if (!available.ok) throw new Error(available.message);
    const edges = available.value.filter((edge) => edge.from[1] === edge.to[1]);
    const flange: SheetFlangeFeature & { readonly profile: null } = { kind: 'sheetFlange', id: 'flanges', name: '両端フランジ', suppressed: false,
      targetFeatureId: 'base', edges: edges.map((edge) => ({ panelId: 'base', boundaryId: edge.id })), profile: null,
      length: n(5), angle: n(90), startOffset: n(0), endOffset: n(0), lengthBasis: 'tangent', rule: { innerRadius: null, kFactor: null } };
    const existing = resolveRectangularFlange(flange, original, 'original'); if (!existing.ok) throw new Error(existing.message);
    const result = resolveSheetLineBend(bend, existing.value.body, () => line); if (!result.ok) throw new Error(result.message);
    const prior = existing.value.body, after = result.value.body;
    const bottom = prior.bends.find((item) => item.frame.origin[1] === 0), top = prior.bends.find((item) => item.frame.origin[1] === 30);
    if (bottom === undefined || top === undefined) throw new Error('both branches required');
    expect(after.panels.find((panel) => panel.id === bottom.childPanelId)).toBe(prior.panels.find((panel) => panel.id === bottom.childPanelId));
    expect(after.panels.find((panel) => panel.id === top.childPanelId)?.normal).not.toEqual(prior.panels.find((panel) => panel.id === top.childPanelId)?.normal);
    for (const panel of after.panels) {
      const id = `branches-${panel.id}`;
      try {
        const flat = await recomputeSheetFlat(after, { sourceFeatureId: 'bend', fixedPanelId: panel.id, seamConnectionIds: [] }, bridge, { partId: id, generation: 1 });
        if (!flat.ok) throw new Error(flat.message);
        expect(flat.body.volume).toBeCloseTo(1600 + 152 * Math.PI, 5);
      } finally { await bridge.releasePart(id); }
    }
    expect(resolveSheetLineBend(bend, prior, () => ({ ...line, from: [10, 0, 0], to: [10, 30, 0] })).ok).toBe(false);
  });
});
