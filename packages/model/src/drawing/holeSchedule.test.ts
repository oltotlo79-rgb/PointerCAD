import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument } from '../part/createPartDocument.js';
import { resolvePart } from '../part/resolvePart.js';
import type { HoleFeature, PartDocument } from '../part/types.js';
import { DEFAULT_WORK_PLANE_ID } from '../sketch/planeMath.js';
import type { Vec3 } from '../sketch/vec3.js';
import { buildHoleSchedule, type HoleScheduleContext, type HoleScheduleResult } from './holeSchedule.js';

const value = expressionValueFromNumber;
function fixture(diameters: readonly number[] = [12, 8, 8, 12, 8]): PartDocument {
  const base = createEmptyPartDocument();
  const sketch = base.sketches[0];
  const holes: HoleFeature[] = diameters.map((diameter, index) => ({
    id: `hole-${String(index)}`, name: 'hole', suppressed: false, kind: 'hole', targetFeatureId: `box-${String(index)}`,
    face: { bodyFeatureId: `box-${String(index)}`, index: 0, fingerprint: {
      kind: 'face', surfaceKind: 'plane', area: 100, position: [0, 0, 10], axis: [0, 0, 1], radius: null,
    } },
    centers: [{ sketchId: sketch.id, pointFeatureId: `point-${String(index)}` }],
    diameter: value(diameter), depth: { kind: 'through' }, tiltAngle: value(0), tiltAzimuth: value(0),
  }));
  return { ...base, solids: holes, sketches: [{ ...sketch, features: diameters.map((_, index) => ({
    id: `point-${String(index)}`, name: 'point', kind: 'point' as const, planeId: DEFAULT_WORK_PLANE_ID,
    at: { mode: 'absolute' as const, x: value(index * 10), y: value(index * 20), z: value(0) },
  })) }] };
}
function context(document: PartDocument, changes: Partial<HoleScheduleContext> = {}): HoleScheduleContext {
  return { sketches: resolvePart(document).sketches,
    resolvePlane: () => ({ origin: [0, 0, 10], normal: [0, 0, 1] }),
    frame: { datum: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0] }, ...changes };
}
function rows(result: HoleScheduleResult) {
  if (!result.ok) throw new Error(`${result.reason}: ${result.featureId ?? ''}`);
  return result.rows;
}
function changeHole(document: PartDocument, index: number, change: Partial<HoleFeature>): PartDocument {
  return { ...document, solids: document.solids.map((feature, i) => i === index ? { ...feature, ...change } as HoleFeature : feature) };
}

describe('穴フィーチャーから作る穴表(P8-56、FR-729)', () => {
  it('径の小さい順でφ8の3個をA、φ12の2個をBにする', () => {
    const document = fixture();
    const result = rows(buildHoleSchedule(document, context(document)));
    expect(result.map((row) => row.symbol)).toEqual(['A1', 'A2', 'A3', 'B1', 'B2']);
    expect(result.map((row) => row.diameter)).toEqual([8, 8, 8, 12, 12]);
  });
  it('原点基準では面上中心のXYをそのまま載せる', () => {
    const document = fixture([8, 8]);
    expect(rows(buildHoleSchedule(document, context(document))).map((row) => [row.x, row.y])).toEqual([[0, 0], [10, 20]]);
  });
  it('基準点10,10でXとYだけを10ずつ引く', () => {
    const document = fixture([8, 8]);
    const result = rows(buildHoleSchedule(document, context(document, { frame: { datum: [10, 10, 0], x: [1, 0, 0], y: [0, 1, 0] } })));
    expect(result.map((row) => [row.x, row.y])).toEqual([[-10, -10], [0, 10]]);
  });
  it('裏側の穴も省かず、同じXYでも前後の異なる穴を残す', () => {
    let document = fixture([8, 8]);
    document = changeHole(document, 1, { centers: [{ sketchId: document.sketches[0].id, pointFeatureId: 'point-0' }] });
    const result = rows(buildHoleSchedule(document, context(document, {
      resolvePlane: (id) => ({ origin: [0, 0, id === 'box-0' ? 10 : -10], normal: [0, 0, 1] }),
    })));
    expect(result).toHaveLength(2);
    expect(result.map((row) => row.center[2])).toEqual([-10, 10]);
  });
  it('傾いた面へ投影した実中心を使い、スケッチXYで代用しない', () => {
    const document = fixture([8]);
    const result = rows(buildHoleSchedule(document, context(document, {
      resolvePlane: () => ({ origin: [10, 0, 0], normal: [1, 0, 1] }),
    })));
    expect(result[0].x).toBeCloseTo(5, 12);
    expect(result[0].center[2]).toBeCloseTo(5, 12);
  });
  it('同じ径・同じ位置は1行にし、対応する全フィーチャーを保持する', () => {
    let document = fixture([8, 8]);
    document = changeHole(document, 1, { centers: [{ sketchId: document.sketches[0].id, pointFeatureId: 'point-0' }] });
    const result = rows(buildHoleSchedule(document, context(document)));
    expect(result).toHaveLength(1);
    expect(result[0].featureIds).toEqual(['hole-0', 'hole-1']);
  });
  it('同じ位置でも径が違えば別の行にする', () => {
    let document = fixture([8, 12]);
    document = changeHole(document, 1, { centers: [{ sketchId: document.sketches[0].id, pointFeatureId: 'point-0' }] });
    expect(rows(buildHoleSchedule(document, context(document)))).toHaveLength(2);
  });
  it('穴0個なら空の表、抑制された穴も載せない', () => {
    const empty = fixture([]);
    expect(rows(buildHoleSchedule(empty, context(empty)))).toEqual([]);
    const document = changeHole(fixture([8]), 0, { suppressed: true });
    expect(rows(buildHoleSchedule(document, context(document)))).toEqual([]);
  });
  it('止まり穴の深さを保存し、未解決を貫通へ変えない', () => {
    const document = changeHole(fixture([8]), 0, { depth: { kind: 'blind', depth: value(5) } });
    expect(rows(buildHoleSchedule(document, context(document)))[0].depth).toBe(5);
    const invalid = changeHole(document, 0, { depth: { kind: 'blind', depth: value(0) } });
    expect(buildHoleSchedule(invalid, context(invalid))).toMatchObject({ ok: false, reason: 'invalidValue' });
  });
  it('欠けた中心参照が混ざる場合は部分的な表で成功にしない', () => {
    const base = fixture([8]);
    const document = changeHole(base, 0, { centers: [
      { sketchId: base.sketches[0].id, pointFeatureId: 'point-0' },
      { sketchId: base.sketches[0].id, pointFeatureId: 'missing' },
    ] });
    expect(buildHoleSchedule(document, context(document))).toMatchObject({ ok: false, reason: 'missingCenter' });
  });
  it('面を解決できないと古い指紋へフォールバックせず断る', () => {
    const document = fixture([8]);
    expect(buildHoleSchedule(document, context(document, { resolvePlane: () => null }))).toMatchObject({ ok: false, reason: 'missingFace' });
  });
  it('27種類目はAAに進む', () => {
    const document = fixture(Array.from({ length: 27 }, (_, index) => index + 1));
    expect(rows(buildHoleSchedule(document, context(document)))[26].symbol).toBe('AA1');
  });
  it.each(([[0, 0, 0], [2, 0, 0], [NaN, 0, 0]] as readonly Vec3[]).map((x) => ({ x })))('正規直交でない表の座標軸$xを断る', ({ x }) => {
    const document = fixture([8]);
    expect(buildHoleSchedule(document, context(document, { frame: { datum: [0, 0, 0], x, y: [0, 1, 0] } }))).toEqual({ ok: false, reason: 'invalidFrame' });
  });
  it('同じ入力の2回で一致し、参照元の文書を変更しない', () => {
    const document = fixture();
    const before = JSON.stringify(document);
    expect(buildHoleSchedule(document, context(document))).toEqual(buildHoleSchedule(document, context(document)));
    expect(JSON.stringify(document)).toBe(before);
  });
});
