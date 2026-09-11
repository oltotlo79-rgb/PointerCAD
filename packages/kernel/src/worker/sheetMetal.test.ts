import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadOcctForNode } from '../occt/loadOcct.node.js';
import { measureVolume } from '../occt/solidMesh.js';
import type { CurveSpec, SheetFlangeStepSpec, SolidStepRequest } from '../types.js';
import { recomputeSolids, type CachedSolid } from './recomputeSolids.js';
import { createShapeCache } from './shapeCache.js';

let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await loadOcctForNode(); });
const profile: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 0, 0], to: [50, 0, 0] }, { kind: 'segment', from: [50, 0, 0], to: [50, 30, 0] },
  { kind: 'segment', from: [50, 30, 0], to: [0, 30, 0] }, { kind: 'segment', from: [0, 30, 0], to: [0, 0, 0] },
];
const base: SolidStepRequest = { id: 'sheet', key: 'base-t2', label: '基板', visible: false,
  step: { kind: 'sheetBase', outer: profile, holes: [], thickness: 2, reversed: false } };
const flangeSpec: SheetFlangeStepSpec = { kind: 'sheetFlange', targetKey: base.key, flanges: [{ kind: 'rectangle', thickness: 2, radius: 3, width: 50, secondLength: 20, angle: 90,
  frame: { origin: [0, 30, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1] } }] };
const flange: SolidStepRequest = { id: 'flange', key: 'flange-base-t2-20', label: 'フランジ', visible: true, step: flangeSpec };

describe('P10 Workerの板金段・キャッシュ・失敗保全', () => {
  it('基板からフランジを生成し、再計算・Undo相当の表示変更では同じ形を再利用する', async () => {
    const cache = createShapeCache<CachedSolid>();
    try {
      const first = await recomputeSolids({ oc, cache }, { generation: 1, steps: [base, flange] });
      expect(first.failures).toEqual([]);
      expect(first.bodies).toHaveLength(1);
      expect(first.bodies[0].volume).toBeCloseTo(5000 + 200 * Math.PI, 7);
      const repeated = await recomputeSolids({ oc, cache }, { generation: 2, steps: [base, flange] });
      expect(repeated.cacheHits).toBe(2); expect(repeated.failures).toEqual([]);
      const undo = await recomputeSolids({ oc, cache }, { generation: 3, steps: [{ ...base, visible: true }] });
      expect(undo.cacheHits).toBe(1); expect(undo.bodies[0].volume).toBeCloseTo(3000, 8);
      const redo = await recomputeSolids({ oc, cache }, { generation: 4, steps: [base, flange] });
      expect(redo.failures).toEqual([]); expect(redo.cacheHits).toBe(2);
    } finally { cache.clear(); }
    expect(cache.size).toBe(0);
  });
  it('食込みで失敗しても上流の形を破壊せず、新世代の正常な段を再計算できる', async () => {
    const cache = createShapeCache<CachedSolid>();
    try {
      const input = flangeSpec.flanges[0];
      const bad: SolidStepRequest = { ...flange, key: 'overlap', step: { ...flangeSpec, flanges: [{ ...input, frame: { ...input.frame, origin: [0, 29, 0] } }] } };
      const failed = await recomputeSolids({ oc, cache }, { generation: 5, steps: [base, bad] });
      expect(failed.failures).toHaveLength(1); expect(cache.has(bad.key)).toBe(false);
      const preserved = cache.get(base.key);
      expect(preserved).toBeDefined();
      if (preserved === undefined) throw new Error('上流基板が失われました');
      expect(measureVolume(oc, preserved.shape)).toBeCloseTo(3000, 8);
      const recovered = await recomputeSolids({ oc, cache }, { generation: 6, steps: [base, flange] });
      expect(recovered.failures).toEqual([]); expect(recovered.bodies[0].volume).toBeCloseTo(5000 + 200 * Math.PI, 7);
    } finally { cache.clear(); }
  });
});
