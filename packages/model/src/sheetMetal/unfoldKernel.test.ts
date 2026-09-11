import { exactExpressionValueFromNumber as n } from '@pointercad/expression';
import { createKernelApi } from '@pointercad/kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, type AssemblyKernelBridge, type DrawingKernelBridge } from '../kernelBridge.js';
import type { ResolvedSolidStep } from '../part/resolvePart.js';
import type { ResolvedCurve } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { createSheetFlatSteps } from './flatSteps.js';
import { resolveRectangularFlange, type SheetBasePlan, type ResolvedSheetBody } from './resolveSheetGeometry.js';
import { sheetShapeKey } from './shapeKey.js';
import { unfoldSheetBody } from './unfoldSheetBody.js';
import { recomputeSheetFlat } from './recomputeSheetFlat.js';
import { closedSheetLoop } from './testing/closedSheetLoop.js';
import { resolveSheetFlatOutline } from './flatOutline.js';
import { sheetLoopSignedArea } from './panelGeometry.js';

let bridge: AssemblyKernelBridge & DrawingKernelBridge;
let api: ReturnType<typeof createKernelApi>;
beforeAll(async () => { await loadOcctForNode(); api = createKernelApi(loadOcctForNode); bridge = createDirectKernelBridge(api); }, 180_000);
function fixture(k = 0.4, angle = 90) {
  const points: readonly Vec3[] = [[0, 0, 0], [20, 0, 0], [20, 50, 0], [0, 50, 0]];
  const outer: ResolvedCurve[] = points.map((from, i) => ({ kind: 'segment', featureId: `side${i}`, from, to: points[(i + 1) % 4] }));
  const plan: SheetBasePlan = { kind: 'sheetBase', outer, holes: [], normal: [0, 0, 1], thickness: 2, reversed: false };
  const source: ResolvedSheetBody = { rootFeatureId: 'base', rule: { thickness: n(2), innerRadius: n(3), kFactor: n(k) }, bends: [],
    panels: [{ id: 'base-panel', normal: [0, 0, 1], outer, holes: [] }] };
  const base = { featureId: 'base', name: '基板', key: sheetShapeKey(plan), plan, visible: false };
  const result = resolveRectangularFlange({ kind: 'sheetFlange', id: 'flange', name: 'U曲げ', suppressed: false, targetFeatureId: 'base',
    edges: [0, 2].map((i) => ({ panelId: 'base-panel', boundaryId: JSON.stringify(['sheet-edge', `side${i}`, 0]) })),
    length: n(30), angle: n(angle), startOffset: n(0), endOffset: n(0), lengthBasis: 'tangent', profile: null,
    rule: { innerRadius: null, kFactor: null } }, source, base.key);
  if (!result.ok) throw new Error(result.message);
  const flange = { featureId: 'flange', name: 'U曲げ', key: sheetShapeKey(result.value.plan), plan: result.value.plan, visible: true };
  return { body: result.value.body, foldedSteps: [base, flange] };
}
function flatSteps(body: ResolvedSheetBody, fixed = 'base-panel') {
  const flat = unfoldSheetBody(body, fixed, []); if (!flat.ok) throw new Error(flat.message);
  const steps = createSheetFlatSteps('flat', flat.value); if (!steps.ok) throw new Error(steps.message);
  return steps.value;
}

describe('P10 展開を正規の橋と実OCCTで生成する', () => {
  it('閉周回の継ぎ目の曲げ帯を落とさず、4平面+4曲げの展開体積になる', async () => {
    const body = closedSheetLoop(), definition = { sourceFeatureId: 'tube', fixedPanelId: 'wall-2', seamConnectionIds: ['corner-1'] };
    try {
      const result = await recomputeSheetFlat(body, definition, bridge, { partId: 'closed-sheet-loop', generation: 1 });
      if (!result.ok) throw new Error(result.message);
      expect(result.body.volume).toBeCloseTo(3200 + 304 * Math.PI, 6);
    } finally { await bridge.releasePart('closed-sheet-loop'); }
  });
  it('表示用の計算入口も実形状を返し、中止では途中の平板を表示結果にしない', async () => {
    const { body } = fixture(), definition = { sourceFeatureId: 'sheet-flat-ui', fixedPanelId: 'base-panel', seamConnectionIds: [] };
    try {
      const result = await recomputeSheetFlat(body, definition, bridge, { partId: 'flat-ui', generation: 1 });
      if (!result.ok) throw new Error(result.message);
      expect(result.body.featureId).toBe(definition.sourceFeatureId);
      expect(result.body.volume).toBeCloseTo(4400 + 152 * Math.PI, 6);
      const outline = await resolveSheetFlatOutline(bridge, result.bodyKey, 2);
      if (!outline.ok) throw new Error(outline.message);
      expect(outline.value.loops).toHaveLength(1);
      const curves = outline.value.loops[0].curves;
      expect(sheetLoopSignedArea(curves, [0, 0, 1])).toBeCloseTo(2200 + 76 * Math.PI, 6);
      const yMin = -30 - 1.9 * Math.PI, yMax = 80 + 1.9 * Math.PI;
      for (const curve of curves) {
        if (curve.kind !== 'segment') throw new Error('矩形の外周以外が出ました');
        const [x1,y1] = curve.from, [x2,y2] = curve.to;
        const exterior = (Math.abs(x1) < 1e-7 && Math.abs(x2) < 1e-7) || (Math.abs(x1 - 20) < 1e-7 && Math.abs(x2 - 20) < 1e-7)
          || (Math.abs(y1 - yMin) < 1e-7 && Math.abs(y2 - yMin) < 1e-7) || (Math.abs(y1 - yMax) < 1e-7 && Math.abs(y2 - yMax) < 1e-7);
        expect(exterior, '曲げの内側の接線は切断線へ出さない').toBe(true);
      }
      const projected = await bridge.hiddenLineViews({ bodyIds: [result.bodyKey], views: [{ id: 'manufacturing',
        origin: [0,0,0], normal: [0,0,1], xDir: [1,0,0], includeHidden: false, mode: 'precise' }] });
      expect(projected.cancelled).toBe(false); expect(projected.failures).toEqual([]);
      expect(projected.views[0].visible).toHaveLength(4);
      for (const { curve } of projected.views[0].visible) {
        if (curve.kind !== 'segment') throw new Error('製作図の矩形輪郭は4本の直線です');
        const [x1,y1] = curve.from, [x2,y2] = curve.to;
        expect((Math.abs(x1) < 1e-7 && Math.abs(x2) < 1e-7) || (Math.abs(x1 - 20) < 1e-7 && Math.abs(x2 - 20) < 1e-7)
          || (Math.abs(y1 - yMin) < 1e-7 && Math.abs(y2 - yMin) < 1e-7) || (Math.abs(y1 - yMax) < 1e-7 && Math.abs(y2 - yMax) < 1e-7),
          '図面にも曲げ帯の接線を切断線として出さない').toBe(true);
      }
      const cancelled = await recomputeSheetFlat(body, definition, bridge, { partId: 'flat-ui', generation: 2, shouldCancel: () => true });
      expect(cancelled).toMatchObject({ ok: false, cancelled: true });
    } finally { await bridge.releasePart('flat-ui'); }
  });
  it.each([90, -90, 0])('%d°のU板を1立体の平板へ開き、独立体積・全キャッシュ再利用・所有解放を満たす', async (angle) => {
    const item = fixture(0.4, angle), partId = `sheet-flat-${angle}`, foldedId = `${partId}-folded`;
    try {
      const folded = await bridge.recomputeSolids(item.foldedSteps, { partId: foldedId, generation: 1 });
      expect(folded.failures).toEqual([]); expect(folded.bodies).toHaveLength(1);
      expect(folded.bodies[0].volume).toBeCloseTo(angle === 0 ? 4400 : 4400 + 160 * Math.PI, 7);
      const retained = (await api.getShapeCacheStats()).protectedKeyCount;
      const steps = flatSteps(item.body);
      const result = await bridge.recomputeSolids(steps, { partId, generation: 1 });
      expect(result.failures).toEqual([]); expect(result.bodies).toHaveLength(1);
      expect(result.bodies[0].volume).toBeCloseTo(angle === 0 ? 4400 : 4877.52208334565, 7);
      const positions = result.bodies[0].mesh.positions;
      const z = Array.from(positions).filter((_, index) => index % 3 === 2);
      expect(Math.min(...z)).toBeCloseTo(0, 6); expect(Math.max(...z)).toBeCloseTo(2, 6);
      const again = await bridge.recomputeSolids(steps, { partId, generation: 2 });
      expect(again.failures).toEqual([]); expect(again.cacheHits).toBe(steps.length);
      await bridge.releasePart(partId);
      // releasePartは所有保護を返す。共有LRUに残る形の消失とは区別して検査する。
      expect((await api.getShapeCacheStats()).protectedKeyCount).toBe(retained);
      expect((await bridge.checkShapeAvailability(foldedId, [item.foldedSteps[1].key])).missingKeys).toEqual([]);
    } finally { await bridge.releasePart(partId); await bridge.releasePart(foldedId); }
  });
  it('50回の展開文書の開始・終了で所有保護が基準へ戻る', async () => {
    const steps = flatSteps(fixture().body), before = (await api.getShapeCacheStats()).protectedKeyCount;
    for (let index = 0; index < 50; index++) {
      const partId = `sheet-flat-lifetime-${index}`;
      try {
        const result = await bridge.recomputeSolids(steps, { partId, generation: 1 });
        expect(result.failures).toEqual([]); expect(result.bodies).toHaveLength(1);
        expect((await api.getShapeCacheStats()).protectedKeyCount).toBeGreaterThan(before);
      } finally { await bridge.releasePart(partId); }
      expect((await api.getShapeCacheStats()).protectedKeyCount).toBe(before);
    }
  });
  it('Kだけの編集では折曲げ2段を再利用し、展開固定パネルも再計算しない', async () => {
    const first = fixture(), second = fixture(0.3), id = 'sheet-flat-k';
    try {
      await bridge.recomputeSolids(first.foldedSteps, { partId: `${id}-folded`, generation: 1 });
      const folded = await bridge.recomputeSolids(second.foldedSteps, { partId: `${id}-folded`, generation: 2 });
      expect(folded.failures).toEqual([]); expect(folded.cacheHits).toBe(2);
      const initial = flatSteps(first.body), changed = flatSteps(second.body);
      expect(initial[0].key).toBe(changed[0].key);
      const a = await bridge.recomputeSolids(initial, { partId: id, generation: 1 }); expect(a.failures).toEqual([]);
      const b = await bridge.recomputeSolids(changed, { partId: id, generation: 2 }); expect(b.failures).toEqual([]);
      expect(b.cacheHits).toBe(1); expect(b.bodies[0].volume).toBeCloseTo(4400 + 144 * Math.PI, 7);
    } finally { await bridge.releasePart(id); await bridge.releasePart(`${id}-folded`); }
  });
  it('重なったパネルの結合を拒否して元板を保全し、正常な次世代へ復帰する', async () => {
    const steps = flatSteps(fixture().body), first = steps[0], id = 'sheet-flat-overlap';
    const plan = { kind: 'sheetJoin' as const, targetKey: first.key, toolKey: first.key };
    const bad: ResolvedSolidStep = { featureId: 'bad', name: '重複板', plan, key: sheetShapeKey(plan), visible: true };
    try {
      const result = await bridge.recomputeSolids([first, bad], { partId: id, generation: 1 });
      expect(result.failures).toHaveLength(1); expect(result.failures[0].message).toContain('重なって');
      const source = await bridge.recomputeSolids([{ ...first, visible: true }], { partId: id, generation: 2 });
      expect(source.failures).toEqual([]); expect(source.cacheHits).toBe(1); expect(source.bodies[0].volume).toBeCloseTo(2000, 8);
      const recovered = await bridge.recomputeSolids(steps, { partId: id, generation: 3 });
      expect(recovered.failures).toEqual([]); expect(recovered.bodies[0].volume).toBeCloseTo(4877.52208334565, 7);
    } finally { await bridge.releasePart(id); }
  });
});
