import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as builderModule from './buildBooleanShape.js';
import * as allocationModule from './allocations.js';
import { booleanOp } from './booleanOp.js';
import { compareMaterialRegions, MaterialComparisonCancelled } from './compareMaterialRegions.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';

describe('実立体の追加・削除・共通部分を比較し、元の形を保持する', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
  beforeAll(async () => { oc = await loadOcctForNode(); });
  afterEach(() => vi.restoreAllMocks());
  const closeVolume = (actual: number, expected: number): void => {
    expect(Math.abs(actual - expected) / expected).toBeLessThan(1e-6);
  };
  it('20mm箱の半径3mm貫通穴を、削除体積π×3²×20として独立に確かめる', () => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const before = keep(makeBox(oc, { dx: 20, dy: 20, dz: 20 }));
      const origin = keep(new oc.gp_Pnt_3(10, 10, -1)), direction = keep(new oc.gp_Dir_4(0, 0, 1));
      const axes = keep(new oc.gp_Ax2_3(origin, direction));
      const maker = keep(new oc.BRepPrimAPI_MakeCylinder_3(axes, 3, 22)), cutter = keep(maker.Shape());
      const after = keep(booleanOp(oc, 'subtract', before.shape, cutter));
      const result = compareMaterialRegions(oc, before.shape, after.shape), removedVolume = Math.PI * 3 ** 2 * 20;
      closeVolume(result.removed.volume, removedVolume); closeVolume(result.common.volume, 8000 - removedVolume);
      expect(result.added).toEqual({ kind: 'empty', volume: 0, mesh: null });
      expect(result.removed.mesh?.triangleCount).toBeGreaterThan(0);
      closeVolume(measureVolume(oc, before.shape), 8000); closeVolume(measureVolume(oc, after.shape), 8000 - removedVolume);
      expect(isValidShape(oc, before.shape) && isValidShape(oc, after.shape)).toBe(true);
      const reversed = compareMaterialRegions(oc, after.shape, before.shape);
      closeVolume(reversed.added.volume, removedVolume); expect(reversed.removed.kind).toBe('empty');
    } finally { release(); }
  });
  it('同じ形の比較は追加・削除が空となり、通常の立体作成では空結果を引き続き断る', () => {
    const box = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
    try {
      const result = compareMaterialRegions(oc, box.shape, box.shape);
      expect(result.added.kind).toBe('empty'); expect(result.removed.kind).toBe('empty'); closeVolume(result.common.volume, 8000);
      expect(() => booleanOp(oc, 'subtract', box.shape, box.shape)).toThrow('立体が残りませんでした');
    } finally { box.delete(); }
  });
  it('立体がない文書を片側に選べ、両側が空なら3領域とも空になる', () => {
    const box = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
    try {
      const added = compareMaterialRegions(oc, null, box.shape), removed = compareMaterialRegions(oc, box.shape, null);
      closeVolume(added.added.volume, 8000); closeVolume(removed.removed.volume, 8000);
      expect(added.common.kind).toBe('empty'); expect(removed.common.kind).toBe('empty');
      expect(compareMaterialRegions(oc, null, null)).toEqual({ added: { kind: 'empty', volume: 0, mesh: null },
        removed: { kind: 'empty', volume: 0, mesh: null }, common: { kind: 'empty', volume: 0, mesh: null }, beforeVolume: 0, afterVolume: 0 });
    } finally { box.delete(); }
  });
  it('同じ体積でも異なる縦横寸法の立体を変更なしと誤判定しない', () => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const before = keep(makeBox(oc, { dx: 20, dy: 20, dz: 20 })), after = keep(makeBox(oc, { dx: 40, dy: 10, dz: 20 }));
      const result = compareMaterialRegions(oc, before.shape, after.shape);
      closeVolume(result.beforeVolume, 8000); closeVolume(result.afterVolume, 8000);
      closeVolume(result.added.volume, 4000); closeVolume(result.removed.volume, 4000); closeVolume(result.common.volume, 4000);
    } finally { release(); }
  });
  it('実演算の後に失敗しても全ての一時所有を解放し、入力を次の比較に再利用できる', () => {
    const box = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
    const allocations = allocationModule.createAllocations, entries: { deletes: number }[] = [];
    vi.spyOn(allocationModule, 'createAllocations').mockImplementation(() => {
      const group = allocations();
      return { release: group.release, keep<T extends allocationModule.OcctDeletable>(item: T): T {
        const entry = { deletes: 0 }, original = item.delete.bind(item); entries.push(entry);
        item.delete = () => { entry.deletes++; original(); }; return group.keep(item);
      } };
    });
    const build = builderModule.buildBooleanShape;
    vi.spyOn(builderModule, 'buildBooleanShape').mockImplementationOnce((...args) => { build(...args); throw new Error('比較演算の故障'); });
    try {
      expect(() => compareMaterialRegions(oc, box.shape, box.shape)).toThrow('比較演算の故障');
      expect(entries.length).toBeGreaterThan(0); expect(entries.filter(entry => entry.deletes !== 1)).toEqual([]);
      expect(hasSolid(oc, box.shape)).toBe(true); closeVolume(measureVolume(oc, box.shape), 8000);
      expect(compareMaterialRegions(oc, box.shape, box.shape).removed.kind).toBe('empty');
    } finally { vi.restoreAllMocks(); box.delete(); }
  });
  it('中止した段より先のBooleanを開始せず、部分的な比較結果を成功として返さない', () => {
    const box = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
    const build = vi.spyOn(builderModule, 'buildBooleanShape'); let cancelled = false;
    try {
      expect(() => compareMaterialRegions(oc, box.shape, box.shape, { shouldCancel: () => cancelled,
        onPhase: phase => { if (phase === 'added') cancelled = true; } })).toThrow(MaterialComparisonCancelled);
      expect(build).toHaveBeenCalledTimes(1); closeVolume(measureVolume(oc, box.shape), 8000);
    } finally { box.delete(); }
  });
});
