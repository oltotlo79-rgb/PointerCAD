import { describe, expect, it } from 'vitest';
import { loadOcctForNode } from '../occt/loadOcct.node.js';
import type { CurveSpec, SheetFlangeStepSpec, SolidBodyMesh, SolidFaceInfo, SolidStepRequest, SubShapeQuery } from '../types.js';
import { createKernelApi } from './kernelApi.js';
import { recognizeCachedSheetMetal } from './recognizeCachedSheetMetal.js';
import { recomputeSolids, type CachedSolid } from './recomputeSolids.js';
import { createShapeCache } from './shapeCache.js';

// 50×30 の基板(板厚 2)の y=30 の縁に、内半径 3・長さ 20・90 度のフランジ(sheetMetal.test.ts と同じ寸法)。
const profile: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 0, 0], to: [50, 0, 0] }, { kind: 'segment', from: [50, 0, 0], to: [50, 30, 0] },
  { kind: 'segment', from: [50, 30, 0], to: [0, 30, 0] }, { kind: 'segment', from: [0, 30, 0], to: [0, 0, 0] },
];
const base: SolidStepRequest = { id: 'sheet', key: 'recognize-base-t2', label: '基板', visible: false,
  step: { kind: 'sheetBase', outer: profile, holes: [], thickness: 2, reversed: false } };
const flangeSpec: SheetFlangeStepSpec = { kind: 'sheetFlange', targetKey: base.key, flanges: [{ kind: 'rectangle', thickness: 2, radius: 3,
  width: 50, secondLength: 20, angle: 90, frame: { origin: [0, 30, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1] } }] };
const flange: SolidStepRequest = { id: 'flange', key: 'recognize-flange-t2', label: 'フランジ', visible: true, step: flangeSpec };
type FaceQuery = Extract<SubShapeQuery, { kind: 'face' }>;

function queryOf(face: SolidFaceInfo): FaceQuery {
  return { kind: 'face', index: face.index, surfaceKind: face.surfaceKind, area: face.area,
    position: face.centroid, axis: face.axis, radius: face.radius };
}
/** 面積のいちばん大きい平らな面(基板の表か裏)。番号の決め打ちはしない。 */
function largestPlane(body: SolidBodyMesh): SolidFaceInfo {
  const planes = body.faces.filter(face => face.surfaceKind === 'plane');
  return planes.reduce((best, face) => face.area > best.area ? face : best);
}
function bodyOf(bodies: readonly SolidBodyMesh[], id: string): SolidBodyMesh {
  const body = bodies.find(item => item.id === id);
  if (body === undefined) throw new Error(`${id} の形がありません`);
  return body;
}

describe('M-08 覚えてある立体を板金として読む照会', () => {
  it('窓口から、段の鍵と基準の面の指紋で L 板の板厚・板 2 枚・内半径 3 の 90 度の曲げを読み、1 件の不足では残りを止めない', async () => {
    const api = createKernelApi(loadOcctForNode);
    const built = await api.recomputeSolids({ partId: 'recognize-sheet', generation: 1, steps: [base, flange] });
    expect(built.failures).toEqual([]);
    const body = bodyOf(built.bodies, flange.id);
    expect(body.volume).toBeCloseTo(5000 + 200 * Math.PI, 7);
    const reference = queryOf(largestPlane(body));
    const outcome = await api.recognizeSheetMetal({ items: [
      { id: 'missing', shapeKey: 'recognize-no-such-key', face: reference },
      { id: 'l-plate', shapeKey: flange.key, face: reference },
    ] });
    expect(outcome.failures).toEqual([{ id: 'missing', code: 'missingBody' }]);
    expect(outcome.results.map(result => result.id)).toEqual(['l-plate']);
    const recognition = outcome.results[0].recognition;
    if (!recognition.ok) throw new Error(`読めませんでした: ${recognition.reason}`);
    expect(recognition.thickness).toBeCloseTo(2, 9);
    expect(recognition.panels).toHaveLength(2);
    expect(recognition.panels[0].faceIndex).toBe(reference.index);
    expect(recognition.bends).toHaveLength(1);
    const [bend] = recognition.bends;
    expect(bend.radius).toBeCloseTo(3, 9);
    expect(bend.width).toBeCloseTo(50, 9);
    expect(Math.abs(bend.angleDegrees)).toBeCloseTo(90, 9);
    expect(recognition.panels.map(panel => panel.faceIndex)).toEqual([bend.fromFaceIndex, bend.toFaceIndex]);
  });

  it('指紋に合う面が無ければ sourceChanged、平らでない基準の面は ambiguousPair を返し、キャッシュの形を手放さない', async () => {
    const oc = await loadOcctForNode();
    const cache = createShapeCache<CachedSolid>();
    try {
      const built = await recomputeSolids({ oc, cache }, { generation: 1, steps: [base, flange] });
      expect(built.failures).toEqual([]);
      const body = bodyOf(built.bodies, flange.id);
      const cylinder = body.faces.find(face => face.surfaceKind === 'cylinder');
      if (cylinder === undefined) throw new Error('曲げの円筒の面がありません');
      const gone: FaceQuery = { ...queryOf(largestPlane(body)), surfaceKind: 'sphere', axis: null, radius: 7 };
      const outcome = await recognizeCachedSheetMetal({ items: [
        { id: 'gone', shapeKey: flange.key, face: gone },
        { id: 'curved', shapeKey: flange.key, face: queryOf(cylinder) },
      ] }, cache, () => Promise.resolve(oc));
      expect(outcome).toEqual({ failures: [], results: [
        { id: 'gone', recognition: { ok: false, reason: 'sourceChanged' } },
        { id: 'curved', recognition: { ok: false, reason: 'ambiguousPair' } },
      ] });
      const again = await recomputeSolids({ oc, cache }, { generation: 2, steps: [base, flange] });
      expect(again.cacheHits).toBe(2);
      expect(bodyOf(again.bodies, flange.id).volume).toBeCloseTo(5000 + 200 * Math.PI, 7);
    } finally { cache.clear(); }
  });
});
