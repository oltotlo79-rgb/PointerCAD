import { describe, expect, it } from 'vitest';

import type { SolidBody } from '../../kernelBridge.js';
import type { Vec3 } from '../../sketch/vec3.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import {
  lineEdge, planeFace, plainTee, TEE_BODIES, teeBodies, teeJoint, teeRequest, WELD_TEST_REVISIONS, weldTestBox, weldTestPlacement,
} from './filletWeld.testSupport.js';
import { planFilletWeld } from './planFilletWeld.js';
import type { FilletWeldPlan, FilletWeldRequest, WeldFrame } from './types.js';

const HALF = Math.SQRT1_2;

function expectVec(actual: Vec3, expected: Vec3): void {
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index] ?? Number.NaN, 9));
}

function expectFrame(frame: WeldFrame, expected: WeldFrame): void {
  expectVec(frame.origin, expected.origin);
  expectVec(frame.xAxis, expected.xAxis);
  expectVec(frame.yAxis, expected.yAxis);
  expectVec(frame.zAxis, expected.zAxis);
}

function planned(document: AssemblyDocument, request: FilletWeldRequest = teeRequest(), bodies = TEE_BODIES): FilletWeldPlan {
  const result = planFilletWeld(document, request, WELD_TEST_REVISIONS, bodies);
  if (!result.ok) throw new Error(JSON.stringify(result.rejections));
  return result.plan;
}

function codes(document: AssemblyDocument, request: FilletWeldRequest, revisions = WELD_TEST_REVISIONS, bodies = TEE_BODIES): string[] {
  const result = planFilletWeld(document, request, revisions, bodies);
  return result.ok ? [] : result.rejections.map((rejection) => rejection.code);
}

function withComponent(document: AssemblyDocument, id: string, change: (component: AssemblyComponent) => AssemblyComponent): AssemblyDocument {
  return { ...document, components: document.components.map((component) => (component.id === id ? change(component) : component)) };
}

/** 回転なしの T 継手の溶接線: 原点 (0,34,10)、脚 +Y(底板の上)・+Z(立板の側面)、線 +X。 */
const PLAIN_FRAME: WeldFrame = { origin: [0, 34, 10], xAxis: [0, 1, 0], yAxis: [0, 0, 1], zAxis: [1, 0, 0] };

describe('すみ肉溶接の計画', () => {
  it('T 継手の当たりから溶接線の座標系・合計長さ・公称体積を手で求めた値どおりに作る', () => {
    const plan = planned(plainTee());
    expectFrame(plan.frame, PLAIN_FRAME);
    expect([plan.weldId, plan.firstComponentId, plan.secondComponentId]).toEqual(['weld-1', 'component-1', 'component-2']);
    expect([plan.contactLength, plan.legOnSecond, plan.legOnFirst, plan.materialId]).toEqual([100, 6, 8, 'aluminum']);
    // 20 + 15 + 25 = 60 mm、断面 6×8/2 = 24 mm² → 1440 mm³。
    expect(plan.totalLength).toBe(60);
    expect(plan.nominalVolume).toBe(1440);
    expect(Object.keys(plan.sourceIdentities).sort()).toEqual(['component-1', 'component-2']);
    expect(plan.replacedComponentIds).toEqual([]);
  });

  it('組立全体を Z まわりに90°回して動かしても、同じだけ回して動かした座標系になる', () => {
    // 回転 (x,y,z)→(−y,x,z)、移動 (5,−7,3)。立板の位置 (0,26,10) → (−21,−7,13)。
    const turn = [0, 0, HALF, HALF] as const;
    const document = teeJoint(weldTestPlacement([-21, -7, 13], turn), weldTestPlacement([5, -7, 3], turn));
    expectFrame(planned(document).frame, { origin: [-29, -7, 13], xAxis: [-1, 0, 0], yAxis: [0, 0, 1], zAxis: [0, 1, 0] });
  });

  it('寝かせて作った立板を X まわりに90°起こして置いても、部品座標の選択を配置で写して同じ溶接線になる', () => {
    // 部品座標: 面 z=0(外向き −Z、重心 (50,25,0))、辺の中点 (50,0,0)。(x,y,z)→(x,−z,y) で起こす。
    const document = teeJoint(weldTestPlacement([0, 34, 10], [HALF, 0, 0, HALF]), weldTestPlacement([0, 0, 0]));
    const request = teeRequest({
      first: planeFace('component-1', 'standing', [50, 25, 0], [0, 0, -1]),
      edge: lineEdge([50, 0, 0], [1, 0, 0], 100),
    });
    // 寝かせた立板の形(x 0〜100、y 0〜50、z 0〜8)で、足元の当たりも部品座標へ写して確かめる。
    const flat = teeBodies({ standing: [weldTestBox([0, 0, 0], [100, 50, 8])] });
    expectFrame(planned(document, request, flat).frame, PLAIN_FRAME);
    // 立てた形のままのボディ(厚さ 8)では、写した足元(脚 9)が厚さ 8 の面からはみ出し、その端が横切るので断る。
    // 寝かせた形(幅 50)なら同じ脚でも載る。足元を部品座標へ写していることを、両方の向きで確かめる。
    expect(codes(document, { ...request, legOnFirst: 9 }, WELD_TEST_REVISIONS, flat)).toEqual([]);
    expect(codes(document, { ...request, legOnFirst: 9 }, WELD_TEST_REVISIONS, TEE_BODIES))
      .toEqual(['contactBoundaryCrossed', 'contactBoundaryCrossed', 'contactBoundaryCrossed']);
  });

  it('辺を逆向きに選んでも、溶接線の向きと始点は面の法線の外積で1つに決まる', () => {
    const plan = planned(plainTee(), teeRequest({ edge: lineEdge([50, 8, 0], [-1, 0, 0], 100) }));
    expectFrame(plan.frame, PLAIN_FRAME);
  });

  it('底板の下面に吊った立板(上下逆の T 継手)も、法線から向きを決めて置く', () => {
    // 立板を (0,26,−50) に置き、上の辺 (部品座標 (50,8,50)) を底板の下面 z=0(外向き −Z)に当てる。
    const document = teeJoint(weldTestPlacement([0, 26, -50]), weldTestPlacement([0, 0, 0]));
    const request = teeRequest({
      second: planeFace('component-2', 'base', [50, 30, 0], [0, 0, -1]),
      edge: lineEdge([50, 8, 50], [1, 0, 0], 100),
    });
    // z = (0,1,0)×(0,0,−1) = (−1,0,0)、始点 = 中点 (50,34,0) − 50·z。
    expectFrame(planned(document, request).frame, { origin: [100, 34, 0], xAxis: [0, 1, 0], yAxis: [0, 0, -1], zAxis: [-1, 0, 0] });
  });

  it('材質の指定が無い・知らない材質は、溶加材を仮定せずに断る', () => {
    expect(codes(plainTee(), teeRequest({ materialId: '' }))).toEqual(['materialRequired']);
    expect(codes(plainTee(), teeRequest({ materialId: '  ' }))).toEqual(['materialRequired']);
    expect(codes(plainTee(), teeRequest({ materialId: 'unobtainium' }))).toEqual(['unknownMaterial']);
  });

  it('脚長・辺の長さの 0・負・NaN を寸法の誤りとして断る', () => {
    const result = planFilletWeld(plainTee(), teeRequest({ legOnSecond: 0, legOnFirst: Number.NaN }), WELD_TEST_REVISIONS, TEE_BODIES);
    expect(result.ok ? [] : result.rejections.map((rejection) => [rejection.code, rejection.detail.name])).toEqual([
      ['invalidDimension', 'legOnSecond'], ['invalidDimension', 'legOnFirst'],
    ]);
    expect(codes(plainTee(), teeRequest({ legOnFirst: -1 }))).toEqual(['invalidDimension']);
    expect(codes(plainTee(), teeRequest({ edge: lineEdge([50, 8, 0], [1, 0, 0], 0) }))).toEqual(['invalidDimension']);
    expect(codes(plainTee(), teeRequest({ edge: lineEdge([50, 8, 0], [1, 0, 0], Number.NaN) }))).toEqual(['invalidDimension']);
  });

  it('同じ部品同士・無い部品・抑制した部品・置けない配置は断る', () => {
    expect(codes(plainTee(), teeRequest({ second: planeFace('component-1', 'standing', [50, 30, 10], [0, 0, 1]) })))
      .toEqual(['sameComponent']);
    expect(codes(plainTee(), teeRequest({ first: planeFace('component-9', 'standing', [50, 8, 25], [0, 1, 0]) })))
      .toEqual(['componentMissing']);
    const suppressed = withComponent(plainTee(), 'component-2', (component) => ({ ...component, suppressed: true }));
    expect(codes(suppressed, teeRequest())).toEqual(['componentSuppressed']);
    const broken = withComponent(plainTee(), 'component-1', (component) => ({
      ...component, placement: { ...component.placement, rotation: [0, 0, 0, 2] },
    }));
    expect(codes(broken, teeRequest())).toEqual(['invalidPlacement']);
  });

  it('選んだ後に部品の内容の版が変わった・版が分からない部品は、古い選択として断る', () => {
    expect(codes(plainTee(), teeRequest(), new Map([['standing', 'rev-s'], ['base', 'rev-b2']]))).toEqual(['staleSource']);
    expect(codes(plainTee(), teeRequest(), new Map([['standing', 'rev-s']]))).toEqual(['missingSourceRevision']);
  });

  it('平面でない面・直線でない辺・長さ0や長さ1でない向きを断る', () => {
    const curved = teeRequest();
    const cylinder: FilletWeldRequest = { ...curved, first: { ...curved.first, face: { ...curved.first.face, fingerprint: {
      kind: 'face', surfaceKind: 'cylinder', area: 100, position: [50, 8, 25], axis: [0, 1, 0], radius: 5 } } } };
    expect(codes(plainTee(), cylinder)).toEqual(['faceNotPlanar']);
    const arc: FilletWeldRequest = { ...curved, edge: { ...curved.edge, edge: { ...curved.edge.edge, fingerprint: {
      kind: 'edge', curveKind: 'circle', length: 100, position: [50, 8, 0], axis: [0, 1, 0], radius: 5 } } } };
    expect(codes(plainTee(), arc)).toEqual(['edgeNotStraight']);
    const zero = planFilletWeld(plainTee(), teeRequest({ first: planeFace('component-1', 'standing', [50, 8, 25], [0, 0, 0]) }), WELD_TEST_REVISIONS, TEE_BODIES);
    expect(zero.ok ? null : zero.rejections[0]).toEqual({ code: 'invalidVector', detail: { name: 'normal', componentId: 'component-1' } });
    expect(codes(plainTee(), teeRequest({ first: planeFace('component-1', 'standing', [50, 8, 25], [0, 2, 0]) })))
      .toEqual(['vectorNotNormalized']);
    expect(codes(plainTee(), teeRequest({ edge: lineEdge([50, 8, 0], [Number.NaN, 0, 0], 100) }))).toEqual(['invalidVector']);
    expect(codes(plainTee(), teeRequest({ edge: lineEdge([50, Number.NaN, 0], [1, 0, 0], 100) }))).toEqual(['invalidVector']);
  });

  it('平行に近く脚長に対して内角を決められない2面は、内角とこの脚長で扱える範囲を添えて断る', () => {
    // 内角 θ は cos θ = −(外向きの法線の内積)。立板の法線 (0,1,0) に対し、底板の法線 (0, cos0.5°, sin0.5°) は θ = 179.5°、
    // (0, −cos0.5°, sin0.5°) は θ = 0.5°。脚 6・8 mm の下限は sin θ ≥ 2 × 1e-9 × 8 / 1e-6 = 0.016(手で求めた値)。
    const rad = (degrees: number): number => degrees * Math.PI / 180;
    const minimum = Math.asin(0.016) * 180 / Math.PI;
    for (const [normal, expected] of [
      [[0, Math.cos(rad(0.5)), Math.sin(rad(0.5))], 179.5], [[0, -Math.cos(rad(0.5)), Math.sin(rad(0.5))], 0.5],
    ] as const) {
      const result = planFilletWeld(plainTee(), teeRequest({ second: planeFace('component-2', 'base', [50, 30, 10], normal) }), WELD_TEST_REVISIONS, TEE_BODIES);
      expect(result.ok ? [] : result.rejections.map((rejection) => rejection.code)).toEqual(['unsupportedJointAngle']);
      const detail = result.ok ? null : result.rejections[0]?.detail;
      expect(detail?.angleDegrees).toBeCloseTo(expected, 9);
      expect(detail?.minimumDegrees).toBeCloseTo(minimum, 12);
      expect(detail?.maximumDegrees).toBeCloseTo(180 - minimum, 12);
    }
    // 170° と 20° は脚 6・8 mm でも条件を満たすので角度では断らない(辺がその面に無いので当たりの確認で断る)。
    for (const normal of [[0, Math.cos(rad(10)), Math.sin(rad(10))], [0, -Math.cos(rad(20)), Math.sin(rad(20))]] as const) {
      const result = planFilletWeld(plainTee(), teeRequest({ second: planeFace('component-2', 'base', [50, 30, 10], normal) }), WELD_TEST_REVISIONS, TEE_BODIES);
      expect(result.ok ? [] : result.rejections.map((rejection) => rejection.code)).not.toContain('unsupportedJointAngle');
    }
    // 45° 傾けた面(内角 135°)は範囲の内なので角度では断らず、辺がその面に無いことで断る(当たりの確認は続く)。
    const tilted = planFilletWeld(plainTee(), teeRequest({ second: planeFace('component-2', 'base', [50, 30, 10], [0, HALF, HALF]) }), WELD_TEST_REVISIONS, TEE_BODIES);
    expect(tilted.ok ? [] : tilted.rejections.map((rejection) => rejection.code)).toEqual(['edgeNotOnSecondFace']);
  });

  it('辺が立板の面から外れている・板の間に隙間がある時は、離れた距離を添えて断る', () => {
    const offFirst = planFilletWeld(plainTee(), teeRequest({ edge: lineEdge([50, 9, 0], [1, 0, 0], 100) }), WELD_TEST_REVISIONS, TEE_BODIES);
    expect(offFirst.ok ? null : offFirst.rejections).toEqual([{ code: 'edgeNotOnFirstFace',
      detail: { first: 'component-1', second: 'component-2', distance: 1 } }]);
    // 底板を 1 mm 上げると、立板の下の辺は底板の上面から 1 mm 下になる。
    const gap = teeJoint(weldTestPlacement([0, 26, 10]), weldTestPlacement([0, 0, 1]));
    const offSecond = planFilletWeld(gap, teeRequest(), WELD_TEST_REVISIONS, TEE_BODIES);
    expect(offSecond.ok ? null : offSecond.rejections).toEqual([{ code: 'edgeNotOnSecondFace',
      detail: { first: 'component-1', second: 'component-2', distance: -1 } }]);
  });

  it('角に沿わない辺・凹側でない当たりを断る', () => {
    expect(codes(plainTee(), teeRequest({ edge: lineEdge([50, 8, 0], [0, 0, 1], 100) })))
      .toEqual(['edgeNotOnSecondFace', 'edgeNotAlongCorner']);
    const outside = planFilletWeld(plainTee(), teeRequest({ second: planeFace('component-2', 'base', [50, 30, 10], [0, 0, -1]) }), WELD_TEST_REVISIONS, TEE_BODIES);
    expect(outside.ok ? null : outside.rejections).toEqual([{ code: 'notConcaveCorner',
      detail: { first: 'component-1', second: 'component-2', rise: -25 } }]);
  });

  it('当たりの辺からはみ出す・重なるビードは、縮めたり詰めたりせずに断る', () => {
    expect(codes(plainTee(), teeRequest({ segments: [{ start: 90, length: 20 }] }))).toEqual(['segmentOutsideContact']);
    expect(codes(plainTee(), teeRequest({ segments: [{ start: 0, length: 30 }, { start: 20, length: 30 }] }))).toEqual(['segmentsOverlap']);
    expect(codes(plainTee(), teeRequest({ segments: [] }))).toEqual(['noSegments']);
  });

  it('脚長が大きすぎて公称体積が有限でない計画は、無限の質量の計画として通さない', () => {
    const result = planFilletWeld(plainTee(), teeRequest({ legOnSecond: 1e200, legOnFirst: 1e200 }), WELD_TEST_REVISIONS, TEE_BODIES);
    expect(result.ok ? [] : result.rejections.map((rejection) => [rejection.code, rejection.detail.name]))
      .toEqual([['invalidDimension', 'nominalVolume']]);
  });

  it('通った計画は、ビードごと・面ごとに足元を実際の面が覆った割合を証拠として持つ', () => {
    const plan = planned(plainTee());
    expect(plan.contact.map((item) => [item.segment, item.side, item.componentId])).toEqual([
      [0, 'first', 'component-1'], [1, 'first', 'component-1'], [2, 'first', 'component-1'],
      [0, 'second', 'component-2'], [1, 'second', 'component-2'], [2, 'second', 'component-2'],
    ]);
    plan.contact.forEach((item) => expect(item.coveredRatio).toBeCloseTo(1, 9));
  });

  it('断っても計画しても文書は変わらない', () => {
    const document = plainTee();
    const before = JSON.stringify(document);
    planFilletWeld(document, teeRequest(), WELD_TEST_REVISIONS, TEE_BODIES);
    planFilletWeld(document, teeRequest({ legOnFirst: -1 }), WELD_TEST_REVISIONS, TEE_BODIES);
    expect(JSON.stringify(document)).toBe(before);
  });
});

describe('ビードの足元が有限の実際の面に載るか', () => {
  /** 底板の形を置き換えた時の、2 つ目の面の側の断り(区間の番号と理由)。 */
  function secondSide(base: readonly SolidBody[] | null, request: FilletWeldRequest = teeRequest()): unknown[] {
    const result = planFilletWeld(plainTee(), request, WELD_TEST_REVISIONS, teeBodies({ base }));
    return result.ok ? [] : result.rejections.map((rejection) => [rejection.code, rejection.detail.segment, rejection.detail.side]);
  }

  it('ビードの下の穴は端点ではなく足元全体で見つけて断り、ビードの間の隙間の穴は許す', () => {
    // 1 本目のビード(x 10〜30)の足元 y 34〜40 の中に 10×3 の穴。区間の両端(x 10・30)は穴の外にある。
    expect(secondSide([weldTestBox([0, 0, 0], [100, 60, 10], { topHole: [15, 25, 35, 38] })]))
      .toEqual([['contactBoundaryCrossed', 0, 'second']]);
    // 1 本目と 2 本目の間(x 30〜40)の穴は、どのビードの足元にもかからない。
    expect(secondSide([weldTestBox([0, 0, 0], [100, 60, 10], { topHole: [32, 38, 35, 38] })])).toEqual([]);
  });

  it('脚より狭い面・辺から外れた面は、当たりの平面が同じでも断る', () => {
    // 底板の上面が y 37 まで(脚 6 の足元 y 34〜40 を覆えない)。
    expect(secondSide([weldTestBox([0, 0, 0], [100, 37, 10])])).toEqual([
      ['contactBoundaryCrossed', 0, 'second'], ['contactBoundaryCrossed', 1, 'second'], ['contactBoundaryCrossed', 2, 'second'],
    ]);
    // 底板が x 0〜50 だけ: 2 本目(x 40〜55)は面の端が横切り、3 本目(x 70〜95)は面に全く載らない。
    expect(secondSide([weldTestBox([0, 0, 0], [50, 60, 10])])).toEqual([
      ['contactBoundaryCrossed', 1, 'second'], ['contactNotCovered', 2, 'second'],
    ]);
  });

  it('円の穴の縁は解析の中心と半径で見る(表示用の分割に穴が無くても断る)', () => {
    const circle = { center: [20, 37, 10] as const, axis: [0, 0, 1] as const, radius: 1.5 };
    expect(secondSide([weldTestBox([0, 0, 0], [100, 60, 10], { topCircles: [circle] })])).toEqual([['contactBoundaryCrossed', 0, 'second']]);
    // 足元から離れた円(中心 y 50)は横切らない。
    expect(secondSide([weldTestBox([0, 0, 0], [100, 60, 10], { topCircles: [{ ...circle, center: [20, 50, 10] }] })])).toEqual([]);
  });

  it('局所の座標系で持つ表示の点も、部品座標へ戻して判定する', () => {
    expect(secondSide([weldTestBox([0, 0, 0], [100, 60, 10], { origin: [50, 30, 5] })])).toEqual([]);
  });

  it('部品の形が無い・面の三角形の番号が壊れている時は、当たりとみなさず断る', () => {
    expect(secondSide(null)).toEqual([['contactFaceUnavailable', undefined, 'second']]);
    const broken = { ...BASE_FOR_TESTS, faces: BASE_FOR_TESTS.faces.map((face) => ({ ...face, triangleOffset: 999 })) };
    expect(secondSide([broken])).toEqual([
      ['contactFaceUnavailable', 0, 'second'], ['contactFaceUnavailable', 1, 'second'], ['contactFaceUnavailable', 2, 'second'],
    ]);
  });
});

const BASE_FOR_TESTS = weldTestBox([0, 0, 0], [100, 60, 10]);
