import { exactExpressionValueFromNumber as n } from '@pointercad/expression';
import { createKernelApi } from '@pointercad/kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAllocations } from '../../../kernel/src/occt/allocations.js';
import { buildBooleanShape } from '../../../kernel/src/occt/buildBooleanShape.js';
import { makeSheetMetalBase } from '../../../kernel/src/occt/makeSheetMetalBase.js';
import { makeSheetMetalBendBand } from '../../../kernel/src/occt/makeSheetMetalBend.js';
import type { SheetMetalBodyInput } from '../../../kernel/src/occt/makeSheetMetalBody.js';
import { makeSheetMetalCurvedPanel } from '../../../kernel/src/occt/makeSheetMetalCurvedPanel.js';
import { countSheetMetalSolids } from '../../../kernel/src/occt/sheetMetalJoin.js';

import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, type AssemblyKernelBridge } from '../kernelBridge.js';
import type { ResolvedCurve, ResolvedSegment } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { addVec3, distanceVec3, dotVec3, scaleVec3, subVec3 } from '../sketch/vec3.js';

import { availableSheetBoundaryEdges } from './availableBoundaryEdges.js';
import { recomputeSheetFlat } from './recomputeSheetFlat.js';
import { resolveSheetLineBend } from './resolveLineBend.js';
import { resolveRectangularFlange, type ResolvedSheetBody } from './resolveSheetGeometry.js';
import { sheetShapeKey } from './shapeKey.js';
import type { SheetBendFeature, SheetFlangeFeature } from './types.js';
import { unfoldSheetBody } from './unfoldSheetBody.js';

let bridge: AssemblyKernelBridge;
let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);

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

function expectNoMaterialOverlap(plan: SheetMetalBodyInput): void {
  const owned = createAllocations();
  try {
    const parts = plan.panels.map((panel) => owned.keep(makeSheetMetalBase(oc, panel)));
    for (const band of plan.bends) parts.push(owned.keep(band.kind === 'rectangle'
      ? makeSheetMetalBendBand(oc, band) : makeSheetMetalCurvedPanel(oc, band)));
    let overlapCount = 0;
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
      const pair = createAllocations();
      try {
        const range = pair.keep(new oc.Message_ProgressRange_1());
        const common = buildBooleanShape(oc, 'intersect', parts[i].shape, [parts[j].shape], range, pair);
        overlapCount += countSheetMetalSolids(oc, common);
      } finally { pair.release(); }
    }
    expect(overlapCount, '材料部材の共通ソリッド数').toBe(0);
  } finally { owned.release(); }
}

function expectConnectionPoints(body: ResolvedSheetBody): void {
  const pointDistance = (point: Vec3, curves: readonly ResolvedCurve[]): number => Math.min(...curves.flatMap((curve) => {
    if (curve.kind !== 'segment') return [];
    const vector = subVec3(curve.to, curve.from), lengthSquared = dotVec3(vector, vector);
    const ratio = Math.max(0, Math.min(1, dotVec3(subVec3(point, curve.from), vector) / lengthSquared));
    return [distanceVec3(point, addVec3(curve.from, scaleVec3(vector, ratio)))];
  }));
  for (const bend of body.bends) {
    const parent = body.panels.find((panel) => panel.id === bend.parentPanelId);
    const child = body.panels.find((panel) => panel.id === bend.childPanelId);
    if (parent === undefined || child === undefined) throw new Error('接続先が必要です');
    for (const [panel, contacts] of [[parent, bend.parentContacts ?? [bend.parentEdge]],
      [child, bend.childContacts ?? [bend.childEdge]]] as const) {
      expect(contacts.length).toBeGreaterThan(0);
      for (const contact of contacts) for (const point of [contact.from, contact.to])
        expect(pointDistance(point, panel.outer), '接続点から実パネル境界までの距離mm').toBeLessThanOrEqual(1e-6);
    }
  }
}

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
          // U: 帯下半分の幅20、上半分10。H: 両腕幅10と中央の10×4。
          const allowance = Math.PI / 2 * (3 + 0.4 * 2);
          const bandArea = fixture.name === 'U' ? 15 * allowance : 10 * allowance + 10 * 4;
          const expected = 2 * (fixture.area - bandArea) + 2 * bandArea * (3 + 2 / 2) / (3 + 0.4 * 2);
          expect(expected).toBeGreaterThan(0);
          expect(Math.abs(solid.bodies[0].volume - expected) / expected).toBeLessThanOrEqual(1e-9);
          expectConnectionPoints(body);
          expectNoMaterialOverlap(plan);

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
        expect(Math.abs(unfolded.body.volume - fixture.area * 2) / (fixture.area * 2)).toBeLessThanOrEqual(1e-9);

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
    const priorBefore = JSON.stringify(existing.value.body);
    const result = resolveSheetLineBend(bend, existing.value.body, () => line); if (!result.ok) throw new Error(result.message);
    const prior = existing.value.body, after = result.value.body;
    const bottom = prior.bends.find((item) => item.frame.origin[1] === 0), top = prior.bends.find((item) => item.frame.origin[1] === 30);
    if (bottom === undefined || top === undefined) throw new Error('both branches required');
    expect(after.panels.find((panel) => panel.id === bottom.childPanelId)).toBe(prior.panels.find((panel) => panel.id === bottom.childPanelId));
    expect(after.panels.find((panel) => panel.id === top.childPanelId)?.normal).not.toEqual(prior.panels.find((panel) => panel.id === top.childPanelId)?.normal);

    const foldedId = 'branches-folded-oracle', plan = result.value.plan;
    if (plan.kind !== 'sheetBody') throw new Error('body plan required');
    try {
      const folded = await bridge.recomputeSolids([{ featureId: foldedId, name: foldedId, plan, key: sheetShapeKey(plan), visible: true }],
        { partId: foldedId, generation: 1 });
      expect(folded.failures).toEqual([]); expect(folded.bodies).toHaveLength(1);
      // 基板20×30、両脚20×5、旧帯2本と指定線の新帯を一度ずつ数える。
      const allowance = Math.PI / 2 * (3 + 0.4 * 2), bandArea = 20 * allowance;
      const expected = 2 * (20 * 30 - bandArea + 2 * 20 * 5) + 3 * 20 * 2 * Math.PI / 2 * (3 + 2 / 2);
      expect(expected).toBeGreaterThan(0);
      expect(Math.abs(folded.bodies[0].volume - expected) / expected).toBeLessThanOrEqual(1e-9);
      expectConnectionPoints(after);
      expectNoMaterialOverlap(plan);
    } finally { await bridge.releasePart(foldedId); }
    for (const panel of after.panels) {
      const id = `branches-${panel.id}`;
      try {
        const flat = await recomputeSheetFlat(after, { sourceFeatureId: 'bend', fixedPanelId: panel.id, seamConnectionIds: [] }, bridge, { partId: id, generation: 1 });
        if (!flat.ok) throw new Error(flat.message);
        expect(flat.body.volume).toBeCloseTo(1600 + 152 * Math.PI, 5);
        const expected = 2 * (20 * 30 + 2 * 20 * 5 + 2 * 20 * Math.PI / 2 * (3 + 0.4 * 2));
        expect(Math.abs(flat.body.volume - expected) / expected).toBeLessThanOrEqual(1e-9);
        expect(JSON.stringify(prior)).toBe(priorBefore);

      } finally { await bridge.releasePart(id); }
    }
    expect(resolveSheetLineBend(bend, prior, () => ({ ...line, from: [10, 0, 0], to: [10, 30, 0] })).ok).toBe(false);
  });
});
