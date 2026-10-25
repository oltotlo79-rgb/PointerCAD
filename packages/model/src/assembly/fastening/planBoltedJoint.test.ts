import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { addComponent, createComponentFor, moveComponent, setComponentSuppressed, setFixed } from '../assemblyEdit.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import type { AssemblyDocument, Placement } from '../types.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { planBoltedJoint } from './planBoltedJoint.js';
import {
  boltThreadLength, globalUnverifiedLengthAvailability, selectBoltLength, threadChoiceFor,
  verifiedMainLengthAvailability,
} from './selectFastener.js';
import { findHexBolt } from '../standard/fasteners.js';
import type {
  BoltedJointPlan, BoltedJointPlanResult, BoltedJointRequest, BoltLengthAvailability, FasteningHoleSelection,
  FasteningHoleSpec,
} from './types.js';

/*
 * 期待値は計画の補助関数を使わず、板の厚さと寸法表の値から手で求めた座標・長さで書く。
 * 呼び長さの「確認済み」候補は検査用の入力であり、JIS の値ではない(出典欄にそう書く)。
 */

const M8_BOLT_KEY = 'JIS-B-1180:2014:M8:P1.25:annexJA';
const HALF = Math.SQRT1_2;
const REVISIONS = new Map([['plateA', 'rev-a'], ['plateB', 'rev-b']]);

function fixtureLengths(lengths: readonly number[]): BoltLengthAvailability[] {
  return [{ boltRowKey: M8_BOLT_KEY, lengths, basis: 'perDiameterEvidence', verified: true, source: 'test fixture (not a JIS value)' }];
}

function placement(position: Vec3, rotation: readonly [number, number, number, number] = [0, 0, 0, 1]): Placement {
  return { position: [expressionValueFromNumber(position[0]), expressionValueFromNumber(position[1]),
    expressionValueFromNumber(position[2])], rotation };
}

function assembly(a: Placement, b: Placement): AssemblyDocument {
  let document = createAssemblyDocument('組立1');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'plateA' }, { placement: a, partName: '板A' }));
  return addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'plateB' }, { placement: b, partName: '板B' }));
}

function selection(componentId: string, hole: FasteningHoleSpec, origin: Vec3, into: Vec3): FasteningHoleSelection {
  const partRef = componentId === 'component-1' ? 'plateA' : 'plateB';
  return {
    componentId, sourceKey: `part:${partRef}@${REVISIONS.get(partRef) ?? ''}`, holeFeatureId: 'hole-1',
    matingFace: { bodyFeatureId: 'extrude-1', index: 0, fingerprint: {
      kind: 'face', surfaceKind: 'plane', area: 100, position: origin, axis: into, radius: null } },
    hole, axisOrigin: origin, axisDirection: into, matingFaceNormal: [-into[0], -into[1], -into[2]],
  };
}

const CLEAR_A: FasteningHoleSpec = { kind: 'clearance', diameter: 9, length: 10 };
const CLEAR_B: FasteningHoleSpec = { kind: 'clearance', diameter: 9, length: 12 };
const BLIND_M8: FasteningHoleSpec = { kind: 'blindThreaded', nominal: 'M8', pitch: 1.25, usableThreadDepth: 16, drillDepth: 20 };

/** 板A は z=0 の面から −Z へ厚さ10、板B は z=0 の面から +Z へ。 */
function throughRequest(overrides: Partial<BoltedJointRequest> = {}): BoltedJointRequest {
  return {
    first: selection('component-1', CLEAR_A, [0, 0, 0], [0, 0, -1]),
    second: selection('component-2', CLEAR_B, [0, 0, 0], [0, 0, 1]),
    dimensionSeries: 'annexJA', explicitBolt: { nominal: 'M8', threadSeries: 'coarse' },
    minimumProtrusion: 0, headWashers: [], nutWashers: [], lengthAvailability: fixtureLengths([20, 25, 30, 35, 40]),
    ...overrides,
  };
}

const IDENTITY_DOC = assembly(placement([0, 0, 0]), placement([0, 0, 0]));

function planned(result: BoltedJointPlanResult): BoltedJointPlan {
  if (!result.ok) throw new Error(JSON.stringify(result.rejections));
  return result.plan;
}

function codes(result: BoltedJointPlanResult): string[] {
  return result.ok ? [] : result.rejections.map((rejection) => rejection.code);
}

function expectPosition(actual: Placement, expected: Vec3): void {
  actual.position.forEach((value, index) => expect(value.value).toBeCloseTo(expected[index] ?? NaN, 9));
}

function expectRotation(actual: Placement, expected: readonly number[]): void {
  actual.rotation.forEach((value, index) => expect(value).toBeCloseTo(expected[index] ?? NaN, 12));
}

describe('通し穴どうしの共締め', () => {
  it('ボルト・ナットの呼び・長さ・配置を板厚とナットの高さから決める', () => {
    const plan = planned(planBoltedJoint(IDENTITY_DOC, throughRequest(), REVISIONS));
    // 締め付け 10+12=22、附属書JA M8 ナット mMax 6.5、突き出し0 → 28.5 以上の最小 30。
    expect(plan.configuration).toBe('throughBoltWithNut');
    expect([plan.gripLength, plan.boltLength, plan.protrusion]).toEqual([22, 30, 1.5]);
    expect(plan.operations.map((op) => [op.role, op.catalog, op.size])).toEqual([
      ['bolt', 'hexBolt', 'M8'], ['nut', 'hexNut', 'M8']]);
    const [bolt, nut] = plan.operations;
    expect(bolt?.options).toEqual({ length: '30', dimensionSeries: 'annexJA', threadSeries: 'coarse' });
    expect(nut?.options).toEqual({ dimensionSeries: 'annexJA', threadSeries: 'coarse' });
    // 首下は板Aの外面 z=-10、ナットの座面は板Bの外面 z=12。どちらも +Z 向き。
    expectPosition(bolt?.placement ?? placement([NaN, NaN, NaN]), [0, 0, -10]);
    expectPosition(nut?.placement ?? placement([NaN, NaN, NaN]), [0, 0, 12]);
    expectRotation(bolt?.placement ?? placement([0, 0, 0]), [0, 0, 0, 1]);
    expect(plan.missingFacts).toEqual(['bearingFaceDiameter']);
    expect([plan.lengthBasis, plan.lengthVerified]).toEqual(['perDiameterEvidence', true]);
  });

  it('全径共通の未確認の長さ一覧は使えるが未確認として残す', () => {
    const plan = planned(planBoltedJoint(IDENTITY_DOC, throughRequest({
      lengthAvailability: [globalUnverifiedLengthAvailability(M8_BOLT_KEY)] }), REVISIONS));
    expect(plan.boltLength).toBe(30);
    expect(plan.lengthVerified).toBe(false);
    expect(plan.missingFacts).toContain('perDiameterLengthAvailability');
  });

  it('呼びを指定せず確認済みの根拠も無い時は穴径から推定しない', () => {
    const result = planBoltedJoint(IDENTITY_DOC, throughRequest({ explicitBolt: undefined, clearanceEvidence: [
      { nominal: 'M8', minimumHoleDiameter: 8.5, maximumHoleDiameter: 10, verified: false, source: 'unverified' }] }), REVISIONS);
    expect(codes(result)).toEqual(['boltSizeUnspecified']);
    const verified = planBoltedJoint(IDENTITY_DOC, throughRequest({ explicitBolt: undefined, clearanceEvidence: [
      { nominal: 'M8', minimumHoleDiameter: 8.5, maximumHoleDiameter: 10, verified: true, source: 'test fixture' }] }), REVISIONS);
    expect(planned(verified).nominal).toBe('M8');
  });

  it('すきま不足・座面より大きい穴・突き出し未指定を断る', () => {
    const tight = { kind: 'clearance', diameter: 8, length: 10 } as const;
    expect(codes(planBoltedJoint(IDENTITY_DOC, throughRequest({
      first: selection('component-1', tight, [0, 0, 0], [0, 0, -1]) }), REVISIONS))).toEqual(['insufficientClearance']);
    const wide = { kind: 'clearance', diameter: 13.5, length: 10 } as const;
    expect(codes(planBoltedJoint(IDENTITY_DOC, throughRequest({
      first: selection('component-1', wide, [0, 0, 0], [0, 0, -1]) }), REVISIONS))).toEqual(['holeLargerThanBearing']);
    expect(codes(planBoltedJoint(IDENTITY_DOC, throughRequest({ minimumProtrusion: undefined }), REVISIONS)))
      .toEqual(['protrusionRequired']);
  });

  it('附属書JA の 125mm を超える長さは区分ごとの b の根拠が無いので選ばず欠けた事実を示す', () => {
    const thick = { kind: 'clearance', diameter: 9, length: 110 } as const;
    const result = planBoltedJoint(IDENTITY_DOC, throughRequest({
      first: selection('component-1', thick, [0, 0, 0], [0, 0, -1]),
      lengthAvailability: [globalUnverifiedLengthAvailability(M8_BOLT_KEY)] }), REVISIONS);
    expect(result.ok ? null : result.rejections[0]?.detail.reason).toBe('threadLengthAbove125');
  });
});

describe('接触と軸の照合', () => {
  it('両方が固定で動かせない時は、隙間・食い込み・軸のずれ・同じ向きを断る', () => {
    // 1 つ目は置いた時に自動で固定される。2 つ目も固定にして、整列で動かせない状態にする。
    const bothFixed = setFixed(IDENTITY_DOC, 'component-2', true);
    const at = (z: number, x = 0): BoltedJointRequest => throughRequest({ second: selection('component-2', CLEAR_B, [x, 0, z], [0, 0, 1]) });
    expect(codes(planBoltedJoint(bothFixed, at(0.5), REVISIONS))).toEqual(['alignmentBlocked', 'facesNotInContact']);
    expect(codes(planBoltedJoint(bothFixed, at(-0.5), REVISIONS))).toEqual(['alignmentBlocked', 'facesOverlap']);
    expect(codes(planBoltedJoint(bothFixed, at(0, 0.1), REVISIONS))).toEqual(['alignmentBlocked', 'axesNotCoaxial']);
    expect(codes(planBoltedJoint(bothFixed, throughRequest({
      second: selection('component-2', CLEAR_B, [0, 0, 0], [0, 0, -1]) }), REVISIONS))).toEqual(['alignmentBlocked', 'axesNotOpposed']);
  });

  it('非有限・0・負の寸法、長さ0や長さ1でない軸、面と軸の食い違いを断る', () => {
    for (const diameter of [Number.NaN, Number.POSITIVE_INFINITY, 0, -9]) {
      expect(codes(planBoltedJoint(IDENTITY_DOC, throughRequest({ first: selection('component-1',
        { kind: 'clearance', diameter, length: 10 }, [0, 0, 0], [0, 0, -1]) }), REVISIONS))).toEqual(['invalidDimension']);
    }
    expect(codes(planBoltedJoint(IDENTITY_DOC, throughRequest({
      first: selection('component-1', CLEAR_A, [0, 0, 0], [0, 0, 0]) }), REVISIONS))).toEqual(['invalidAxis', 'invalidAxis']);
    expect(codes(planBoltedJoint(IDENTITY_DOC, throughRequest({
      first: selection('component-1', CLEAR_A, [0, 0, 0], [0, 0, -2]) }), REVISIONS))).toEqual(['axisNotNormalized', 'axisNotNormalized']);
    const mismatch = { ...selection('component-1', CLEAR_A, [0, 0, 0], [0, 0, -1]), matingFaceNormal: [1, 0, 0] as const };
    expect(codes(planBoltedJoint(IDENTITY_DOC, throughRequest({ first: mismatch }), REVISIONS))).toEqual(['faceAxisMismatch']);
  });

  it('出どころの変化・版の欠落・抑制・同じ部品を断る', () => {
    const stale = { ...selection('component-2', CLEAR_B, [0, 0, 0], [0, 0, 1]), sourceKey: 'part:plateB@old' };
    expect(codes(planBoltedJoint(IDENTITY_DOC, throughRequest({ second: stale }), REVISIONS))).toEqual(['staleSource']);
    expect(codes(planBoltedJoint(IDENTITY_DOC, throughRequest(), new Map([['plateA', 'rev-a']]))))
      .toEqual(['missingSourceRevision']);
    expect(codes(planBoltedJoint(setComponentSuppressed(IDENTITY_DOC, 'component-2', true), throughRequest(), REVISIONS)))
      .toEqual(['componentSuppressed']);
    expect(codes(planBoltedJoint(IDENTITY_DOC, throughRequest({
      second: selection('component-1', CLEAR_B, [0, 0, 0], [0, 0, 1]) }), REVISIONS))).toEqual(['sameComponent']);
  });
});

describe('ねじ穴への締結', () => {
  // 両方の板を X 軸まわり 90° に回し、板Aを (100,50,20) へ動かす。部品の +Z は組立の −Y になる。
  const ROT_X90 = [HALF, 0, 0, HALF] as const;
  const rotated = assembly(placement([100, 50, 20], ROT_X90), placement([105, 50, 25], ROT_X90));
  // 板A の部品座標 (5,5,0) は組立で (105,50,25)。板B の原点もそこに置いてある。
  const blindRequest = (overrides: Partial<BoltedJointRequest> = {}): BoltedJointRequest => ({
    first: selection('component-1', CLEAR_A, [5, 5, 0], [0, 0, -1]),
    second: selection('component-2', BLIND_M8, [0, 0, 0], [0, 0, 1]),
    dimensionSeries: 'annexJA', engagement: 12, blindBottomClearance: 2,
    headWashers: ['plainWasher'], nutWashers: [], lengthAvailability: fixtureLengths([20, 25, 30]),
    ...overrides,
  });

  it('回した組立でも座金・ボルトを軸の上へ置き、ナットは足さない', () => {
    const plan = planned(planBoltedJoint(rotated, blindRequest(), REVISIONS));
    // 締め付け 10+1.6(平座金 M8)=11.6、ねじ込み12 → 23.6 以上、底のすきま2 → 11.6+14=25.6 以下 → 25。
    expect(plan.configuration).toBe('tappedBlind');
    expect([plan.boltLength, plan.engagedLength]).toEqual([25, 25 - 11.6]);
    expect(plan.operations.map((op) => op.role)).toEqual(['headWasher', 'bolt']);
    const [washer, bolt] = plan.operations;
    // 板Aの中への向きは組立の +Y。外面は y=60、座金の上(首下)は y=61.6。
    expectPosition(washer?.placement ?? placement([NaN, NaN, NaN]), [105, 60, 25]);
    expectPosition(bolt?.placement ?? placement([NaN, NaN, NaN]), [105, 61.6, 25]);
    // 座金の +Z は +Y(X 軸まわり −90°)、ボルトの +Z は −Y(X 軸まわり +90°)。
    expectRotation(washer?.placement ?? placement([0, 0, 0]), [-HALF, 0, 0, HALF]);
    expectRotation(bolt?.placement ?? placement([0, 0, 0]), [HALF, 0, 0, HALF]);
    expect(plan.missingFacts).toEqual(['washerTableUnverified']);
    expect(plan.headSideComponentId).toBe('component-1');
  });

  it('穴の順番を逆に選んでも頭は通し穴の側に置く', () => {
    const request = blindRequest();
    const plan = planned(planBoltedJoint(rotated, { ...request, first: request.second, second: request.first }, REVISIONS));
    expect([plan.headSideComponentId, plan.farSideComponentId]).toEqual(['component-1', 'component-2']);
  });

  it('長さの上下限はちょうどの値を含み、外れたら底付きや該当なしで断る', () => {
    const noWasher = { headWashers: [] as const };
    // 締め付け10、下限22・上限24。
    expect(planned(planBoltedJoint(rotated, blindRequest({ ...noWasher, lengthAvailability: fixtureLengths([22]) }), REVISIONS)).boltLength).toBe(22);
    expect(planned(planBoltedJoint(rotated, blindRequest({ ...noWasher, lengthAvailability: fixtureLengths([24]) }), REVISIONS)).boltLength).toBe(24);
    expect(codes(planBoltedJoint(rotated, blindRequest({ ...noWasher, lengthAvailability: fixtureLengths([20, 25]) }), REVISIONS)))
      .toEqual(['noStandardLengthFits']);
    expect(codes(planBoltedJoint(rotated, blindRequest({ engagement: 15 }), REVISIONS))).toEqual(['blindBottoming']);
    expect(codes(planBoltedJoint(rotated, blindRequest({ blindBottomClearance: undefined }), REVISIONS))).toEqual(['blindClearanceRequired']);
    expect(codes(planBoltedJoint(rotated, blindRequest({ engagement: undefined }), REVISIONS))).toEqual(['engagementRequired']);
  });

  it('ピッチ・呼びの不一致、ねじ穴側の座金、ねじ穴どうしを断る', () => {
    const odd = { ...BLIND_M8, pitch: 1.1 };
    expect(codes(planBoltedJoint(rotated, blindRequest({ second: selection('component-2', odd, [0, 0, 0], [0, 0, 1]) }), REVISIONS)))
      .toEqual(['pitchNotInCatalog']);
    expect(codes(planBoltedJoint(rotated, blindRequest({ explicitBolt: { nominal: 'M8', threadSeries: 'fine' } }), REVISIONS)))
      .toEqual(['pitchMismatch']);
    expect(codes(planBoltedJoint(rotated, blindRequest({ explicitBolt: { nominal: 'M10', threadSeries: 'coarse' } }), REVISIONS)))
      .toEqual(['nominalMismatch']);
    expect(codes(planBoltedJoint(rotated, blindRequest({ nutWashers: ['springWasher'] }), REVISIONS))).toEqual(['washerOnTappedSide']);
    const threadedA = { kind: 'throughThreaded', nominal: 'M8', pitch: 1.25, threadStart: 0, threadLength: 10, length: 10 } as const;
    expect(codes(planBoltedJoint(rotated, blindRequest({ first: selection('component-1', threadedA, [5, 5, 0], [0, 0, -1]) }), REVISIONS)))
      .toEqual(['bothHolesThreaded']);
  });

  it('首下の円筒部がねじ穴まで届く長さは選ばない', () => {
    const thin = { kind: 'clearance', diameter: 9, length: 2 } as const;
    const through = { kind: 'throughThreaded', nominal: 'M8', pitch: 1.25, threadStart: 0, threadLength: 30, length: 30 } as const;
    const result = planBoltedJoint(IDENTITY_DOC, {
      first: selection('component-1', thin, [0, 0, 0], [0, 0, -1]),
      second: selection('component-2', through, [0, 0, 0], [0, 0, 1]),
      dimensionSeries: 'annexJA', engagement: 25, headWashers: [], nutWashers: [], lengthAvailability: fixtureLengths([30]),
    }, REVISIONS);
    // 30 − b1(22) = 8 > 締め付け 2。
    expect(result.ok ? null : result.rejections[0]?.detail.reason).toBe('shankBeyondGrip');
  });

  it('離れた相手の部品は、いまの配置を読み直して軸と合わせ面が一致する位置へ動かす計画にする', () => {
    // 板B を組立の +Z へ 1 だけずらした。両方とも同じ向きなので、戻す変位は回転なしの (0,0,−1)。
    const moved = moveComponent(rotated, 'component-2', placement([105, 50, 26], ROT_X90));
    const plan = planned(planBoltedJoint(moved, blindRequest(), REVISIONS));
    expect(plan.alignment.movedComponentIds).toEqual(['component-2']);
    plan.alignment.delta.position.forEach((value, index) => expect(value).toBeCloseTo([0, 0, -1][index] ?? NaN, 9));
    plan.alignment.delta.rotation.forEach((value, index) => expect(value).toBeCloseTo([0, 0, 0, 1][index] ?? NaN, 12));
  });
});

describe('寸法表の選択', () => {
  it('呼びとピッチから並目・細目を決め、表に無いものを断る', () => {
    expect(threadChoiceFor('M8', 1.25)).toEqual({ nominal: 'M8', pitch: 1.25, series: 'coarse', diameter: 8 });
    expect(threadChoiceFor('M8', 1)).toEqual({ nominal: 'M8', pitch: 1, series: 'fine', diameter: 8 });
    expect(threadChoiceFor('M8', 1.1)).toMatchObject({ code: 'pitchNotInCatalog' });
    expect(threadChoiceFor('M7', 1)).toMatchObject({ code: 'unknownThread' });
  });

  it('長さの候補が無い行は断り、全径共通の一覧は未確認のまま包む', () => {
    const bolt = findHexBolt('M8', 'annexJA');
    if (bolt === undefined) throw new Error('M8 row missing');
    expect(selectBoltLength(bolt, [], { minimum: 20, maximum: null, gripLength: 20 })).toMatchObject({ code: 'lengthAvailabilityMissing' });
    const global = globalUnverifiedLengthAvailability(bolt.key);
    expect([global.basis, global.verified, global.lengths.length]).toEqual(['globalUnverifiedList', false, 21]);
  });

  it('ねじ部の長さは 125・200 の境で区分の b へ切り替わり、根拠の無い組合せは推定しない', () => {
    const main = findHexBolt('M20', 'main');
    const annex = findHexBolt('M20', 'annexJA');
    const second = findHexBolt('M14', 'main');
    if (main === undefined || annex === undefined || second === undefined) throw new Error('M20/M14 row missing');
    // ミスミの JIS B 1180:2014 抜粋の M20: b=46(ℓ≤125)・52(125<ℓ≤200)・65(ℓ>200)。
    expect([30, 125, 126, 200, 201].map((length) => boltThreadLength(main, length))).toEqual([30, 46, 52, 52, 65]);
    expect(boltThreadLength(main, 150, 'fine')).toBeNull();
    expect(boltThreadLength(annex, 125)).toBe(46);
    expect(boltThreadLength(annex, 150)).toBeNull();
    expect(boltThreadLength(second, 150)).toBeNull();
  });

  it('本体規格・並目の根拠のある呼びは 125mm を超える推奨長さを区分の b で選び、確認済みの範囲を広げない', () => {
    const bolt = findHexBolt('M20', 'main');
    if (bolt === undefined) throw new Error('M20 row missing');
    const verified = verifiedMainLengthAvailability();
    // 首下の円筒部 130−52=78 ≤ 締め付け 80。b(ℓ≤125)=46 のままなら 84 > 80 で断っていた。
    expect(selectBoltLength(bolt, verified, { minimum: 128, maximum: null, gripLength: 80 })).toEqual({
      length: 130, threadLength: 52, basis: 'perDiameterEvidence', verified: true, missingFacts: [] });
    // 推奨長さの最大 150 を超える長さは根拠の候補に無いので選ばない(150 を規格の上限とは扱わない)。
    expect(selectBoltLength(bolt, verified, { minimum: 160, maximum: null, gripLength: 150 }))
      .toMatchObject({ code: 'noStandardLengthFits', detail: { reason: 'noCandidate' } });
    expect(selectBoltLength(bolt, verified, { minimum: 128, maximum: null, gripLength: 80 }, 'fine'))
      .toMatchObject({ code: 'lengthAvailabilityMissing' });
    const global = [globalUnverifiedLengthAvailability(bolt.key)];
    expect(selectBoltLength(bolt, global, { minimum: 128, maximum: null, gripLength: 100 }, 'fine'))
      .toMatchObject({ code: 'noStandardLengthFits', detail: { reason: 'threadLengthAbove125' } });
  });

  it.each([
    [[125, 126], 124, 75, 126, 52],
    [[200, 201], 199, 140, 201, 65],
  ] as const)('custom長さ候補%sはねじ部の段差で後続候補が適合する', (lengths, minimum, gripLength, expected, thread) => {
    const bolt = findHexBolt('M20', 'main');
    if (bolt === undefined) throw new Error('M20 row missing');
    const availability = [{ boltRowKey: bolt.key, lengths, basis: 'perDiameterEvidence' as const,
      verified: false, source: 'custom fixture; not a published recommended length table' }];
    expect(selectBoltLength(bolt, availability, { minimum, maximum: null, gripLength }))
      .toMatchObject({ length: expected, threadLength: thread, verified: false, missingFacts: ['perDiameterLengthAvailability'] });
    expect(selectBoltLength(bolt, availability, { minimum, maximum: expected - 1, gripLength }))
      .toMatchObject({ code: 'noStandardLengthFits' });
    expect(selectBoltLength(bolt, availability, { minimum, maximum: null, gripLength: 1 }))
      .toMatchObject({ code: 'noStandardLengthFits' });
  });
});
