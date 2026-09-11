import { expectWithinBudget } from '@pointercad/test-utils';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import type { CurveSpec, ThruSectionSpec } from '../types.js';
import { createAllocations } from './allocations.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { faceTables, onlyFaceQuery, sectionNormalAngles, splineLoft, splineSection } from './loftSurfaceTestSupport.js';
import { makePlanarFace } from './makePlanarFace.js';
import { makeThruSections, sectionWireFromFace } from './makeThruSections.js';
import { isValidShape, measureArea, measureVolume } from './solidMesh.js';

let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);

describe('P11b スプライン断面とロフト自身の平滑化', () => {
  it.each([false, true])('辺数の異なる閉断面 split=%s でも独立積分の体積14000になる', (split) => {
    const shape = makeThruSections(oc, splineLoft({ sections: [
      { kind: 'curves', curves: splineSection(0) }, { kind: 'curves', curves: splineSection(100, 2, split) },
    ] }));
    try {
      expect(isValidShape(oc, shape.shape)).toBe(true);
      // 相似断面: 60 × 100 × (1² + 1×2 + 2²) / 3。
      expect(measureVolume(oc, shape.shape)).toBeCloseTo(14000, 5);
    } finally { shape.delete(); }
  });

  it.each([1, -1])('ねじれ%sが形に効き、曲線配列を変えない', (twist) => {
    const sections: readonly ThruSectionSpec[] = [0, 100].map((z) => ({ kind: 'curves', curves: splineSection(z) }));
    const before = JSON.stringify(sections), ordinary = makeThruSections(oc, splineLoft({ sections }));
    const rotated = makeThruSections(oc, splineLoft({ sections, twist }));
    try {
      expect(measureVolume(oc, ordinary.shape)).toBeCloseTo(6000, 6);
      expect(isValidShape(oc, rotated.shape)).toBe(true);
      expect(measureVolume(oc, rotated.shape)).toBeGreaterThan(0);
      expect(measureVolume(oc, rotated.shape)).not.toBeCloseTo(6000, 2);
      expect(JSON.stringify(sections)).toBe(before);
    } finally { rotated.delete(); ordinary.delete(); }
  });

  it.each([false, true])('保護された面のwire経路 smooth=%s の後も元の面を押し出せる', (smooth) => {
    const { keep, release } = createAllocations();
    try {
      const original = keep(makePlanarFace(oc, splineSection(0))).face;
      const query = onlyFaceQuery(oc, original), tables = faceTables(oc, original);
      const area = measureArea(oc, original);
      const wire = sectionWireFromFace(oc, original, tables, query, keep);
      const built = keep(makeThruSections(oc, splineLoft({ smooth, sections: [
        { kind: 'faceQuery', targetKey: 'borrowed-spline', query }, { kind: 'curves', curves: splineSection(100, 2, true) },
      ] }), {}, new Map([[0, wire]])));
      expect(measureVolume(oc, built.shape)).toBeCloseTo(14000, 4);
      expect(measureArea(oc, original)).toBe(area);
      expect(faceTables(oc, original)).toEqual(tables);
      const prism = keep(new oc.BRepPrimAPI_MakePrism_1(original, keep(new oc.gp_Vec_4(0, 0, 10)), true, true));
      const again = keep(prism.Shape());
      expect(isValidShape(oc, again)).toBe(true);
      expect(measureVolume(oc, again)).toBeCloseTo(600, 5);
    } finally { release(); }
  });

  it('穴があるスプライン面は穴を黙って埋めず断り、後で元の穴を押し出せる', () => {
    const { keep, release } = createAllocations();
    try {
      const outer = keep(makePlanarFace(oc, splineSection(0))).face;
      const holeCurves: readonly CurveSpec[] = [{ kind: 'arc', center: [3, 5, 0], radius: 1,
        normal: [0, 0, 1], xAxis: [1, 0, 0], startAngle: 0, endAngle: 2 * Math.PI }];
      const inner = keep(makePlanarFace(oc, holeCurves)).face;
      const hole = keep(oc.BRepTools.OuterWire(inner)); hole.Reverse();
      const maker = keep(new oc.BRepBuilderAPI_MakeFace_22(outer, hole));
      expect(maker.IsDone()).toBe(true);
      const original = keep(maker.Face()), query = onlyFaceQuery(oc, original), tables = faceTables(oc, original);
      expect(measureArea(oc, original)).toBeCloseTo(60 - Math.PI, 6);
      expect(() => sectionWireFromFace(oc, original, tables, query, keep)).toThrow('穴のある面はつなぐ断面に使えません。穴のない輪郭を選んでください。');
      const prism = keep(new oc.BRepPrimAPI_MakePrism_1(original, keep(new oc.gp_Vec_4(0, 0, 10)), true, true));
      const again = keep(prism.Shape());
      expect(isValidShape(oc, again)).toBe(true);
      expect(measureVolume(oc, again)).toBeCloseTo(10 * (60 - Math.PI), 5);
    } finally { release(); }
  });

  it('4断面の平滑化は形に効き、z20/60の両側の法線差が0.01度未満', () => {
    const { keep, release } = createAllocations();
    try {
      const sections: readonly ThruSectionSpec[] = [[0, 1], [20, 2], [60, 1.5], [100, 1]]
        .map(([z, scale]) => ({ kind: 'curves', curves: splineSection(z, scale) }));
      const old = keep(makeThruSections(oc, splineLoft({ sections })));
      const start = performance.now(), smooth = keep(makeThruSections(oc, splineLoft({ sections, smooth: true })));
      const elapsed = performance.now() - start;
      expectWithinBudget(elapsed, 500, 'P11b 4断面のなめらかなロフト');
      expect(isValidShape(oc, smooth.shape)).toBe(true);
      expect(measureVolume(oc, smooth.shape)).not.toBeCloseTo(measureVolume(oc, old.shape), 2);
      const angles = sectionNormalAngles(oc, smooth.shape, keep);
      expect(angles.length).toBeGreaterThanOrEqual(2);
      expect(Math.max(...angles)).toBeLessThan(0.01);
      console.log(`P11b ロフト: 通常${measureVolume(oc, old.shape)} / 平滑化${measureVolume(oc, smooth.shape)}mm³、法線角最大${Math.max(...angles)}度、${elapsed}ms/500`);
    } finally { release(); }
  });

  it('罫線面では平滑化を呼ばず、オフへ戻せば同じ形に戻る', () => {
    const spy = vi.spyOn(oc.BRepOffsetAPI_ThruSections.prototype, 'SetSmoothing');
    const { keep, release } = createAllocations();
    try {
      const original = keep(makeThruSections(oc, splineLoft({ ruled: true })));
      const ignored = keep(makeThruSections(oc, splineLoft({ ruled: true, smooth: true })));
      expect(spy).not.toHaveBeenCalled();
      expect(measureVolume(oc, ignored.shape)).toBe(measureVolume(oc, original.shape));
      const first = keep(makeThruSections(oc, splineLoft()));
      keep(makeThruSections(oc, splineLoft({ smooth: true })));
      const restored = keep(makeThruSections(oc, splineLoft()));
      expect(measureVolume(oc, restored.shape)).toBe(measureVolume(oc, first.shape));
    } finally { release(); spy.mockRestore(); }
  });
});
