import { expressionValueFromNumber } from '@pointercad/expression';
import type { SegmentSpec, SheetMetalRecognizedPanel, SheetMetalRecognizedRim } from '@pointercad/kernel';
import { describe, expect, it } from 'vitest';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import type { Vec3 } from '../sketch/vec3.js';
import { flangeEndFrame, sheetBoundaryEdges, sheetTangentFrame } from './panelGeometry.js';
import { convertedReferenceLost, planSheetConvert } from './planSheetConvert.js';
import { resolveSheetConvert } from './resolveSheetConvert.js';
import { resolveRectangularFlange, type ResolvedSheetBody } from './resolveSheetGeometry.js';
import type { RecognizedSheet, SheetConvertOrigins } from './sheetConvertIdentity.js';
import type { SheetConvertFeature, SheetFlangeFeature } from './types.js';
import { unfoldSheetBody } from './unfoldSheetBody.js';

// 計算部の L 板(sheetMetal.test.ts と同じ寸法)を基準の面 z=0 から読んだ時の答えを、手で組んだ物。
// 基板 50×30・板厚 2(z=0..2)、y=30 の縁に内半径 3・90 度・長さ 20 のフランジ(始点側の面 y=35、z=5..25)。
const reference: SubShapeRef = { bodyFeatureId: 'plate', index: 4,
  fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1500, position: [25, 15, 0], axis: [0, 0, -1], radius: null } };
const feature: SheetConvertFeature = { kind: 'sheetConvert', id: 'convert-1', name: '板金へ変換', suppressed: false, sourceFeatureId: 'plate',
  referenceFace: reference, rule: { innerRadius: expressionValueFromNumber(1), kFactor: expressionValueFromNumber(0.4) } };
const segment = (edgeIndex: number, from: Vec3, to: Vec3): SheetMetalRecognizedRim => ({ edgeIndex, curve: { kind: 'segment', from, to } });
function loop(indices: readonly number[], points: readonly Vec3[]): SheetMetalRecognizedRim[] {
  return points.map((point, i) => segment(indices[i], point, points[(i + 1) % points.length]));
}
const base: SheetMetalRecognizedPanel = { faceIndex: 4, oppositeFaceIndex: 9, inward: [0, 0, 1],
  outer: loop([0, 1, 2, 3], [[0, 0, 0], [50, 0, 0], [50, 30, 0], [0, 30, 0]]), holes: [] };
const flange: SheetMetalRecognizedPanel = { faceIndex: 7, oppositeFaceIndex: 8, inward: [0, -1, 0],
  outer: loop([10, 11, 12, 13], [[0, 35, 5], [0, 35, 25], [50, 35, 25], [50, 35, 5]]), holes: [] };
const sheet: RecognizedSheet = { ok: true, thickness: 2, panels: [base, flange], bends: [{ fromFaceIndex: 4, toFaceIndex: 7,
  innerFaceIndex: 5, outerFaceIndex: 6, radius: 3, width: 50, angleDegrees: 90, axis: [1, 0, 0], axisOrigin: [0, 30, 5],
  fromTangent: { kind: 'segment', from: [0, 30, 0], to: [50, 30, 0] }, toTangent: { kind: 'segment', from: [0, 35, 5], to: [50, 35, 5] } }] };
const NONE: SheetConvertOrigins = { face: () => null, edge: () => null };

function converted(input: RecognizedSheet, origins: SheetConvertOrigins = NONE) {
  const result = resolveSheetConvert(feature, input, origins);
  if (!result.ok) throw new Error(`変換できませんでした: ${result.reason}`);
  return result;
}
function boundaryIds(result: ReturnType<typeof converted>): string[] {
  return result.body.panels.flatMap(panel => {
    const edges = sheetBoundaryEdges(panel);
    return edges.ok ? edges.value.map(edge => `${panel.id} ${edge.id}`) : [];
  }).sort();
}
function expectClosePoints(actual: readonly Vec3[], expected: readonly Vec3[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((point, i) => point.forEach((value, j) => expect(value).toBeCloseTo(expected[i][j], 9)));
}
/** 先頭の板を固定して展開した板の外形全体の、短い辺と長い辺の長さ(子の板が親に重なると長い辺が縮む)。 */
function flatExtents(body: ResolvedSheetBody): readonly [number, number] {
  const flat = unfoldSheetBody(body, body.panels[0].id, []);
  if (!flat.ok) throw new Error(flat.message);
  const points = flat.value.panels.flatMap(panel => panel.outer.flatMap(curve => curve.kind === 'segment' ? [curve.from, curve.to] : []));
  const size = (axis: 0 | 1): number => Math.max(...points.map(point => point[axis])) - Math.min(...points.map(point => point[axis]));
  const [short, long] = [size(0), size(1)].sort((a, b) => a - b);
  return [short, long];
}

describe('M-08 認識した板金を ResolvedSheetBody へ写す', () => {
  it('曲げの座標がフランジの接線の座標と同じになり、展開の曲げ代が (内半径＋K×板厚)×角度になる', () => {
    const { body, plan } = converted(sheet);
    expect(body.converted).toBe(true);
    expect(body.rule.thickness.value).toBe(2);
    expect(body.panels.map(panel => panel.id)).toEqual([JSON.stringify(['sheet-panel', 'convert-1', 'n:0']),
      JSON.stringify(['sheet-panel', 'convert-1', 'n:1'])]);
    expect(body.panels.map(panel => panel.normal)).toEqual([[0, 0, 1], [0, -1, 0]]);
    const edge = sheetBoundaryEdges(body.panels[0]);
    const tangentEdge = edge.ok ? edge.value.find(item => item.from[1] === 30 && item.to[1] === 30) : undefined;
    if (tangentEdge === undefined) throw new Error('y=30 の縁がありません');
    const tangent = sheetTangentFrame(body.panels[0], tangentEdge.id, 0, 0);
    if (!tangent.ok) throw new Error(tangent.message);
    const [bend] = body.bends;
    expect(bend.frame).toEqual(tangent.value.frame);
    expect(bend.width).toBe(50);
    expect([bend.angle, bend.radius, bend.kFactor]).toEqual([90, 3, 0.4]);
    expect(bend.allowance).toBeCloseTo(1.9 * Math.PI, 12);
    expect([bend.parentPanelId, bend.childPanelId]).toEqual(body.panels.map(panel => panel.id));
    const end = flangeEndFrame(bend.frame, 2, 3, 90);
    if (!end.ok) throw new Error(end.message);
    end.value.origin.forEach((value, i) => expect(value).toBeCloseTo(bend.childEdge.from[i], 12));
    // 同じ縁へフランジの道具で内半径 3・90 度・長さ 20 の曲げを作った時と、座標・縁の向き・曲げ代が同じ(展開が同じ置き方をする)。
    const tool = resolveRectangularFlange({ kind: 'sheetFlange', id: 'flange-1', name: 'フランジ', suppressed: false, targetFeatureId: 'sheet-base',
      edges: [{ panelId: body.panels[0].id, boundaryId: tangentEdge.id }], length: expressionValueFromNumber(20), angle: expressionValueFromNumber(90),
      startOffset: expressionValueFromNumber(0), endOffset: expressionValueFromNumber(0), lengthBasis: 'tangent',
      rule: { innerRadius: expressionValueFromNumber(3), kFactor: null }, profile: null },
    { rootFeatureId: 'sheet-base', rule: body.rule, panels: [body.panels[0]], bends: [] }, 'sheet-base-key');
    if (!tool.ok) throw new Error(tool.message);
    const [made] = tool.value.body.bends;
    expect(bend.frame).toEqual(made.frame);
    expect(bend.parentEdge).toEqual(made.parentEdge);
    expectClosePoints([bend.childEdge.from, bend.childEdge.to], [made.childEdge.from, made.childEdge.to]);
    expect(bend.allowance).toBeCloseTo(made.allowance, 12);
    expect(plan.panels).toHaveLength(2);
    expect(plan.bends).toEqual([{ kind: 'rectangle', thickness: 2, radius: 3, angle: 90, frame: bend.frame, width: 50 }]);
  });

  it('基準の板を固定して展開すると、フランジが曲げ代 1.9π だけ離れて平らに並ぶ(長さ 30＋1.9π＋20)', () => {
    const { body } = converted(sheet);
    const flat = unfoldSheetBody(body, body.panels[0].id, []);
    if (!flat.ok) throw new Error(flat.message);
    const ys = (index: number): number[] => flat.value.panels[index].outer.flatMap(curve => curve.kind === 'segment' ? [curve.from[1], curve.to[1]] : []);
    const zs = flat.value.panels.flatMap(panel => panel.outer.flatMap(curve => curve.kind === 'segment' ? [curve.from[2], curve.to[2]] : []));
    expect(flat.value.panels).toHaveLength(2);
    expect(Math.max(...ys(0))).toBeCloseTo(30, 9);
    expect(Math.min(...ys(1))).toBeCloseTo(30 + 1.9 * Math.PI, 9);
    expect(Math.max(...ys(1))).toBeCloseTo(50 + 1.9 * Math.PI, 9);
    zs.forEach(z => expect(z).toBeCloseTo(0, 9));
  });

  it('板・曲げ・辺の並びと面・辺の番号を入れ替えても、板・縁・曲げの id は同じ', () => {
    const before = converted(sheet);
    const rotate = <T>(items: readonly T[], by: number): T[] => items.map((_item, i) => items[(i + by) % items.length]);
    const renumber = (rim: SheetMetalRecognizedRim): SheetMetalRecognizedRim => ({ ...rim, edgeIndex: rim.edgeIndex + 100 });
    const shuffled: RecognizedSheet = { ...sheet,
      panels: [{ ...flange, faceIndex: 17, outer: rotate(flange.outer, 2).map(renumber) }, { ...base, faceIndex: 14, outer: rotate(base.outer, 3).map(renumber) }],
      bends: sheet.bends.map(bend => ({ ...bend, fromFaceIndex: 14, toFaceIndex: 17,
        fromTangent: { kind: 'segment', from: bend.fromTangent.to, to: bend.fromTangent.from } })) };
    const after = converted(shuffled);
    expect(after.body.panels.map(panel => panel.id)).toEqual(before.body.panels.map(panel => panel.id));
    expect(boundaryIds(after)).toEqual(boundaryIds(before));
    // 接線の向きを逆にした入力でも、曲げの座標と縁の向きは同じ(向きは resolveSheetConvert.ts の bendContact の 1 か所で決める)。
    expect(after.body.bends.map(bend => [bend.id, bend.frame, bend.parentEdge, bend.childEdge]))
      .toEqual(before.body.bends.map(bend => [bend.id, bend.frame, bend.parentEdge, bend.childEdge]));
  });

  it('親と子を入れ替えた入力(フランジの面を基準に読んだ答え)でも、展開の大きさは 50 × (30＋1.9π＋20) で同じ', () => {
    // 同じ L 板を、フランジの始点側の面 y=35 から読んだ答え。曲げはフランジ → 基板で、軸の向きは -x(認識の接線は軸の向きに並ぶ)。
    const swapped: RecognizedSheet = { ok: true, thickness: 2, panels: [flange, base], bends: [{ fromFaceIndex: 7, toFaceIndex: 4,
      innerFaceIndex: 5, outerFaceIndex: 6, radius: 3, width: 50, angleDegrees: 90, axis: [-1, 0, 0], axisOrigin: [0, 30, 5],
      fromTangent: { kind: 'segment', from: [50, 35, 5], to: [0, 35, 5] }, toTangent: { kind: 'segment', from: [50, 30, 0], to: [0, 30, 0] } }] };
    const extents = [converted(sheet), converted(swapped)].map(({ body }) => flatExtents(body));
    for (const [short, long] of extents) {
      expect(short).toBeCloseTo(50, 9);
      expect(long).toBeCloseTo(30 + 1.9 * Math.PI + 20, 9);
    }
  });

  it('起源があれば起源で id を作り、元の編集で起源が合わなくなった縁を参照する後段は sourceChanged の対象になる', () => {
    const origins = (tag: string): SheetConvertOrigins => ({ face: index => `${tag}-face-${index}`, edge: index => `${tag}-edge-${index}` });
    const first = converted(sheet, origins('v1'));
    expect(first.body.panels[0].id).toBe(JSON.stringify(['sheet-panel', 'convert-1', 'o:v1-face-4']));
    const edges = sheetBoundaryEdges(first.body.panels[0]);
    if (!edges.ok) throw new Error(edges.message);
    const target: SheetFlangeFeature = { kind: 'sheetFlange', id: 'flange-1', name: 'フランジ', suppressed: false, targetFeatureId: 'convert-1',
      edges: [{ panelId: first.body.panels[0].id, boundaryId: edges.value[0].id }], length: expressionValueFromNumber(10),
      angle: expressionValueFromNumber(90), startOffset: expressionValueFromNumber(0), endOffset: expressionValueFromNumber(0),
      lengthBasis: 'tangent', rule: { innerRadius: null, kFactor: null }, profile: null };
    expect(convertedReferenceLost(target, first.body)).toBe(false);
    expect(convertedReferenceLost(target, converted(sheet, origins('v2')).body)).toBe(true);
    expect(convertedReferenceLost(target, { rootFeatureId: 'sheet-base-1', rule: first.body.rule, panels: [], bends: [] })).toBe(false);
    expect(convertedReferenceLost({ ...target, edges: [{ panelId: first.body.panels[0].id, boundaryId: 'missing' }] }, first.body)).toBe(true);
  });

  it('つながらない板・同じ板へ 2 本の曲げ・K 係数の範囲外を、それぞれの理由で断る', () => {
    expect(resolveSheetConvert(feature, { ...sheet, bends: [] }, NONE)).toEqual({ ok: false, reason: 'unsupportedConnection' });
    expect(resolveSheetConvert(feature, { ...sheet, bends: [sheet.bends[0], sheet.bends[0]] }, NONE)).toEqual({ ok: false, reason: 'unsupportedConnection' });
    expect(resolveSheetConvert({ ...feature, rule: { ...feature.rule, kFactor: expressionValueFromNumber(0.7) } }, sheet, NONE))
      .toEqual({ ok: false, reason: 'invalidRule' });
    const offTangent: SegmentSpec = { kind: 'segment', from: [0, 29, 0], to: [50, 29, 0] };
    expect(resolveSheetConvert(feature, { ...sheet, bends: [{ ...sheet.bends[0], fromTangent: offTangent }] }, NONE))
      .toEqual({ ok: false, reason: 'unsupportedBend' });
  });

  it('答えの無い行は依頼を返し、消費済み・元が無い・答えられない・読めないを理由の符号で返す', () => {
    const keys = new Map([['plate', 'key-plate']]);
    expect(planSheetConvert(feature, keys, new Set(), undefined)).toEqual({ ok: false, reason: 'pending',
      request: { id: 'convert-1', bodyKey: 'key-plate', face: reference } });
    expect(planSheetConvert(feature, keys, new Set(['plate']), undefined)).toEqual({ ok: false, reason: 'consumed' });
    expect(planSheetConvert(feature, new Map(), new Set(), undefined)).toEqual({ ok: false, reason: 'missingSource' });
    expect(planSheetConvert(feature, keys, new Set(), () => ({ reply: { id: 'convert-1', kind: 'unavailable', code: 'workerBroken' }, origins: NONE })))
      .toEqual({ ok: false, reason: 'workerBroken' });
    expect(planSheetConvert(feature, keys, new Set(), () => ({ reply: { id: 'convert-1', kind: 'recognized',
      recognition: { ok: false, reason: 'cutAcrossBend' } }, origins: NONE }))).toEqual({ ok: false, reason: 'cutAcrossBend' });
    const done = planSheetConvert(feature, keys, new Set(), () => ({ reply: { id: 'convert-1', kind: 'recognized', recognition: sheet }, origins: NONE }));
    expect(done.ok && done.body.panels.length).toBe(2);
  });
});
