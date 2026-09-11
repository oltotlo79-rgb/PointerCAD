import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CurveSpec, SheetBaseStepSpec, SheetFlangeStepSpec, SolidStepSpec } from '../types.js';
import { loadOcctForNode } from '../occt/loadOcct.node.js';
import { measureMassProperties } from '../occt/measureShape.js';
import { isValidShape, measureVolume } from '../occt/solidMesh.js';
import { createSheetBodyReuse } from './sheetBodyReuse.js';
import { createShapeCache } from './shapeCache.js';
import { recomputeSolids, type CachedSolid } from './recomputeSolids.js';

let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await loadOcctForNode(); });
function base(x = 0, holeX = 10, radius = 2): SheetBaseStepSpec {
  const corners = [[x,0,0], [x+50,0,0], [x+50,30,0], [x,30,0]] as const;
  const outer: CurveSpec[] = corners.map((from,i) => ({ kind: 'segment', from, to: corners[(i+1)%4] }));
  return { kind: 'sheetBase', outer, holes: [[{ kind: 'arc', center: [x+holeX,10,0], radius,
    normal: [0,0,1], xAxis: [1,0,0], startAngle: 0, endAngle: 2*Math.PI }]], thickness: 2, reversed: false };
}
const request = (id: string, step: SolidStepSpec) => ({ id, key: id, label: id, visible: true, step });
function flange(key: string, x = 0, radius = 3): SheetFlangeStepSpec {
  return { kind: 'sheetFlange', targetKey: key, flanges: [{ kind: 'rectangle', thickness: 2, radius, width: 50, secondLength: 20, angle: 90,
    frame: { origin: [x,30,0], xAxis: [1,0,0], yAxis: [0,1,0], normal: [0,0,1] } }] };
}

describe('板金の平行移動再利用の境界と所有権', () => {
  it.each(['sheetBase','sheetBody'] as const)('%sは穴を含む厳密な同形だけを複製し、元のcache解放後も独立して残る', async (kind) => {
    const spec = (x: number, holeX = 10, radius = 2): SolidStepSpec => kind === 'sheetBase' ? base(x,holeX,radius)
      : { kind: 'sheetBody', panels: [base(x,holeX,radius)], bends: [] };
    const cache = createShapeCache<CachedSolid>(), reuse = createSheetBodyReuse(oc, cache);
    try {
      const input = spec(0), result = await recomputeSolids({ oc, cache }, { generation: 1, steps: [request('original', input)] });
      expect(result.failures).toEqual([]); reuse.remember(input, 'original');
      expect(reuse.copy(spec(100,12))).toBeNull(); expect(reuse.copy(spec(100,10,3))).toBeNull();
      const clone = reuse.copy(spec(100)); if (clone === null) throw new Error('平行移動した同形を再利用できません');
      try {
        expect(cache.delete('original')).toBe(true);
        expect(reuse.copy(spec(200))).toBeNull();
        expect(isValidShape(oc, clone.shape)).toBe(true);
        expect(measureVolume(oc, clone.shape)).toBeCloseTo(3000-8*Math.PI, 7);
        const properties = measureMassProperties(oc, clone.shape);
        const expectedX = 100 + (1500*25-4*Math.PI*10)/(1500-4*Math.PI);
        expect(properties.centreOfMass[0]).toBeCloseTo(expectedX, 7);
      } finally { clone.delete(); }
    } finally { cache.clear(); }
  });
  it('フランジは上流の穴と半径の違いを区別し、位置だけ異なる同じ履歴を複製する', async () => {
    const cache = createShapeCache<CachedSolid>(), reuse = createSheetBodyReuse(oc, cache);
    const first = base(), second = base(100), changed = base(200,12), bent = flange('first');
    try {
      const result = await recomputeSolids({ oc, cache }, { generation: 1, steps: [request('first',first), request('bent',bent), request('second',second), request('changed',changed)] });
      expect(result.failures).toEqual([]);
      for (const [key, input] of [['first',first], ['bent',bent], ['second',second], ['changed',changed]] as const) reuse.remember(input,key);
      expect(reuse.copy(flange('changed',200))).toBeNull();
      expect(reuse.copy(flange('second',100,4))).toBeNull();
      expect(reuse.copy(flange('missing',100))).toBeNull();
      const clone = reuse.copy(flange('second',100)); if (clone === null) throw new Error('同じフランジが必要です');
      try {
        cache.clear();
        expect(isValidShape(oc, clone.shape)).toBe(true);
        expect(measureVolume(oc, clone.shape)).toBeCloseTo(5000+192*Math.PI, 7);
      } finally { clone.delete(); }
    } finally { cache.clear(); }
  });
  it('非有限値・板厚・反転・微小な寸法差を一致と扱わず、別の再計算へ候補を持ち越さない', async () => {
    const cache = createShapeCache<CachedSolid>(), reuse = createSheetBodyReuse(oc, cache), input = base();
    try {
      await recomputeSolids({ oc, cache }, { generation: 1, steps: [request('input',input)] }); reuse.remember(input,'input');
      for (const thickness of [NaN, Infinity, 2+1e-10]) expect(reuse.copy({ ...base(100), thickness })).toBeNull();
      expect(reuse.copy({ ...base(100), reversed: true })).toBeNull();
      expect(createSheetBodyReuse(oc, cache).copy(base(100))).toBeNull();
    } finally { cache.clear(); }
  });
});
