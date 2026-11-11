import { describe, expect, it } from 'vitest';

import type { Vec3 } from '../../sketch/vec3.js';
import { rigidPlacementOf } from '../fastening/frames.js';
import { applyPlacementToPoint, multiplyQuaternion, quaternionFromAxisAngle, rotateVector, type Quaternion } from '../placementMath.js';
import { buildStandardPartFromSource, standardPartNominalVolume } from '../standard/buildStandardPart.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import { applyFilletWeld } from './applyFilletWeld.js';
import { buildFilletWeldPart, createFilletWeldSource, filletWeldSegmentOptions } from './filletWeldPart.js';
import {
  lineEdge, planeFace, teeBodies, teeJoint, WELD_TEST_REVISIONS, weldTestBox, weldTestPlacement,
} from './filletWeld.testSupport.js';
import { planFilletWeld, planFilletWeldEdit, weldSegmentsOf } from './planFilletWeld.js';
import {
  FILLET_WELD_CATALOG_REVISION, FILLET_WELD_GENERATOR_REVISION, FILLET_WELD_OBLIQUE_GENERATOR_REVISION, type FilletWeldPlan,
  type FilletWeldRequest, WELD_LENGTH_TOLERANCE_MM, weldAngleRangeDegrees, weldAngleSinFloor, weldCrossSection, weldCrossSectionIssue,
  weldInteriorAngle,
} from './types.js';

/*
 * 直角でない当たりのすみ肉溶接(手で求めた値と比べる)。
 *
 * 立板(部品 x 0〜100、y 0〜8、z 0〜50)を、溶接する面 y=0(外向き (0,−1,0))の下の辺 (x, 0, 0) を軸に X まわりに
 * φ 回して (0,0,10) に置く。底板(x 0〜100、y −40〜0、z 0〜10)は原点で、上面 z=10 の端 y=0 が溶接線になる。
 * R_x(φ)(0,−1,0) = (0, −cos φ, −sin φ) なので 2 面の内角 θ = acos(−a·b) = acos(sin φ):
 *   φ = +70° → θ = 20°、φ = +30° → θ = 60°(立板が溶接の側へ傾く)、φ = −30° → θ = 120°、φ = −70° → θ = 160°(反対へ傾く)。
 * 座標系: x = a を底板の面へ射影した単位 = (0,−1,0)、y = b = (0,0,1)、z = x × y = (−1,0,0)。
 * 辺の中点 (50,0,10)、長さ 100 → 原点 (100,0,10)。区間の始点 s の断面の頂点(組立の座標):
 *   角 O = (100−s, 0, 10)、底板の上の脚の先 O + 6x = (100−s, −6, 10)、
 *   立板の上の脚の先 O + 8(cos θ x + sin θ y) = (100−s, −8 cos θ, 10 + 8 sin θ)
 *     60°: (100−s, −4, 10+4√3)、120°: (100−s, +4, 10+4√3)。
 * 断面積 = 6 × 8 × sin θ / 2 = 24 sin θ(60°・120° は 12√3)、体積 = 断面積 × 区間の長さ。
 * 平行に近い当たりの下限(脚 6・8 mm): sin θ ≥ 2 × 1e-9 × 8 / 1e-6 = 0.016、θ ≥ asin(0.016) ≈ 0.917°、θ ≤ 約 179.083°。
 */
const MIN_ANGLE = Math.asin(0.016) * 180 / Math.PI;

const SQRT3 = Math.sqrt(3);
const SEGMENTS = [{ start: 5, length: 12.5 }, { start: 25, length: 30 }, { start: 70.25, length: 7.75 }] as const;
const TOTAL = 50.25;
const STANDING = weldTestBox([0, 0, 0], [100, 8, 50]);
const BASE = weldTestBox([0, -40, 0], [100, 0, 10]);
const BODIES = teeBodies({ standing: [STANDING], base: [BASE] });

function aboutX(degrees: number): Quaternion {
  return quaternionFromAxisAngle([1, 0, 0], degrees * Math.PI / 180);
}

function obliqueTee(tiltDegrees: number, outer: { readonly rotation: Quaternion; readonly offset: Vec3 } | null = null): AssemblyDocument {
  const standingRotation = aboutX(tiltDegrees);
  if (outer === null) return teeJoint(weldTestPlacement([0, 0, 10], standingRotation), weldTestPlacement([0, 0, 0]));
  const standingPosition = rotateVector(outer.rotation, [0, 0, 10]);
  return teeJoint(
    weldTestPlacement([standingPosition[0] + outer.offset[0], standingPosition[1] + outer.offset[1], standingPosition[2] + outer.offset[2]],
      multiplyQuaternion(outer.rotation, standingRotation)),
    weldTestPlacement(outer.offset, outer.rotation));
}

function obliqueRequest(overrides: Partial<FilletWeldRequest> = {}): FilletWeldRequest {
  return {
    first: planeFace('component-1', 'standing', [50, 0, 25], [0, -1, 0]),
    second: planeFace('component-2', 'base', [50, -20, 10], [0, 0, 1]),
    edge: lineEdge([50, 0, 0], [1, 0, 0], 100),
    legOnSecond: 6, legOnFirst: 8, segments: SEGMENTS, materialId: 'aluminum',
    ...overrides,
  };
}

function planned(document: AssemblyDocument, request: FilletWeldRequest = obliqueRequest()): FilletWeldPlan {
  const result = planFilletWeld(document, request, WELD_TEST_REVISIONS, BODIES);
  if (!result.ok) throw new Error(JSON.stringify(result.rejections));
  return result.plan;
}

function expectVec(actual: Vec3, expected: Vec3, digits = 9): void {
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index] ?? Number.NaN, digits));
}

function component(document: AssemblyDocument, id: string): AssemblyComponent {
  const found = document.components.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing ${id}`);
  return found;
}

describe('直角でない当たりの計画(20°・60°・120°・160°)', () => {
  it.each([[70, 20], [30, 60], [-30, 120], [-70, 160]] as const)('立板を %s° 傾けると内角 %s°、座標系は正規直交、断面積は 6×8×sin θ/2', (tilt, angle) => {
    const radians = angle * Math.PI / 180;
    const tipY = -8 * Math.cos(radians), tipZ = 10 + 8 * Math.sin(radians), area = 24 * Math.sin(radians);
    const plan = planned(obliqueTee(tilt));
    expect(plan.interiorAngle?.degrees).toBeCloseTo(angle, 9);
    expectVec(plan.frame.origin, [100, 0, 10]);
    expectVec(plan.frame.xAxis, [0, -1, 0]);
    expectVec(plan.frame.yAxis, [0, 0, 1]);
    expectVec(plan.frame.zAxis, [-1, 0, 0]);
    // 24 sin θ × 50.25(60°・120° は 12√3 × 50.25)。
    expect(plan.nominalVolume).toBeCloseTo(area * TOTAL, 9);
    if (angle === 60 || angle === 120) expect(plan.nominalVolume).toBeCloseTo(12 * SQRT3 * TOTAL, 9);
    expect(plan.contact).toHaveLength(6);
    const applied = applyFilletWeld(obliqueTee(tilt), plan, WELD_TEST_REVISIONS);
    if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
    applied.componentIds.forEach((id, index) => {
      const bead = component(applied.document, id);
      const segment = SEGMENTS[index];
      if (segment === undefined || bead.source.kind !== 'standardPart') throw new Error('bead');
      expect(bead.source.generatorRevision).toBe(FILLET_WELD_OBLIQUE_GENERATOR_REVISION);
      expect(Number(bead.source.options.weldAngle)).toBeCloseTo(angle, 9);
      const placement = rigidPlacementOf(bead.placement);
      const s = segment.start;
      // 断面の頂点(部品の座標)を配置で写すと、手で求めた組立の座標になる(座標系を歪めずに実座標で表す)。
      const part = buildStandardPartFromSource(bead.source);
      const points = part?.sketches.flatMap((sketch) => sketch.features)
        .flatMap((feature) => (feature.kind === 'point' && feature.at.mode === 'absolute'
          ? [[feature.at.x.value, feature.at.y.value, feature.at.z.value] as Vec3] : [])) ?? [];
      expect(points).toHaveLength(3);
      expectVec(points[2] ?? [Number.NaN, Number.NaN, Number.NaN], [8 * Math.cos(radians), 8 * Math.sin(radians), 0]);
      expectVec(applyPlacementToPoint(placement, points[0] ?? [0, 0, 0]), [100 - s, 0, 10]);
      expectVec(applyPlacementToPoint(placement, points[1] ?? [0, 0, 0]), [100 - s, -6, 10]);
      expectVec(applyPlacementToPoint(placement, points[2] ?? [0, 0, 0]), [100 - s, tipY, tipZ]);
      expectVec(applyPlacementToPoint(placement, [0, 0, segment.length]), [100 - s - segment.length, 0, 10]);
      expect(standardPartNominalVolume('filletWeld', bead.source.size, bead.source.options)).toBeCloseTo(area * segment.length, 9);
      expect(bead.materialId).toBe('aluminum');
    });
  });

  it('組立ごと Z まわり 90° 回して (5,−7,3) ずらしても、座標系と頂点は同じ回転とずれだけ動く(60°)', () => {
    const outer = { rotation: quaternionFromAxisAngle([0, 0, 1], Math.PI / 2), offset: [5, -7, 3] as Vec3 };
    const plan = planned(obliqueTee(30, outer));
    // R_z(90°)(x, y, z) = (−y, x, z): 原点 R(100,0,10) + (5,−7,3) = (5,93,13)、x = R(0,−1,0) = (1,0,0)、z = R(−1,0,0) = (0,−1,0)。
    expect(plan.interiorAngle?.degrees).toBeCloseTo(60, 9);
    expectVec(plan.frame.origin, [5, 93, 13]);
    expectVec(plan.frame.xAxis, [1, 0, 0]);
    expectVec(plan.frame.yAxis, [0, 0, 1]);
    expectVec(plan.frame.zAxis, [0, -1, 0]);
    const applied = applyFilletWeld(obliqueTee(30, outer), plan, WELD_TEST_REVISIONS);
    if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
    const first = component(applied.document, applied.componentIds[0] ?? '');
    const placement = rigidPlacementOf(first.placement);
    // 区間 0(始点 5): 立板の上の脚の先は R(95, −4, 10+4√3) + (5,−7,3) = (9, 88, 13+4√3)。
    expectVec(applyPlacementToPoint(placement, [4, 4 * SQRT3, 0]), [9, 88, 13 + 4 * SQRT3]);
  });

  it('立板が垂直(φ = 0)なら直角の従来の扱い: 内角なし・x は 1 つ目の面の法線そのもの・版 1・欄 weldAngle なし', () => {
    const plan = planned(obliqueTee(0));
    expect(plan.interiorAngle).toBeNull();
    expectVec(plan.frame.xAxis, [0, -1, 0], 15);
    expectVec(plan.frame.zAxis, [-1, 0, 0], 15);
    expect(plan.nominalVolume).toBe(24 * TOTAL);
    const applied = applyFilletWeld(obliqueTee(0), plan, WELD_TEST_REVISIONS);
    if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
    const bead = component(applied.document, applied.componentIds[0] ?? '');
    expect(bead.source.kind === 'standardPart' ? [bead.source.generatorRevision, 'weldAngle' in bead.source.options] : null)
      .toEqual([FILLET_WELD_GENERATOR_REVISION, false]);
  });
});

describe('平行に近い当たりの下限・崩れた台本', () => {
  it('下限は sin θ ≥ 2 × WELD_DIRECTION_TOLERANCE × max(脚長) / WELD_LENGTH_TOLERANCE_MM で、脚長に比例する', () => {
    expect(weldAngleSinFloor(6, 8)).toBeCloseTo(0.016, 15);
    expect(weldAngleSinFloor(12, 10)).toBeCloseTo(0.024, 15);
    const range = weldAngleRangeDegrees(6, 8);
    expect(range.minimum).toBeCloseTo(MIN_ANGLE, 12);
    expect(range.maximum).toBeCloseTo(180 - MIN_ANGLE, 12);
    // 下限の sin が 1 以上になる脚長(500 mm)では直角でない当たりを扱えない。
    expect(weldAngleRangeDegrees(500, 500)).toEqual({ minimum: 90, maximum: 90 });
  });

  // 下限 ≈ 0.917°(脚 6・8 mm)の両側: 0.95° と 179.05° は計画でき、0.88°・179.12°・0°(平行)は断る。
  it.each([[89.05, 0.95], [-89.05, 179.05]] as const)('立板を %s° 傾けた内角 %s° は下限の内なので計画できる', (tilt, angle) => {
    expect(planned(obliqueTee(tilt)).interiorAngle?.degrees).toBeCloseTo(angle, 6);
  });

  it.each([[89.12, 0.88], [-89.12, 179.12], [90, 0]] as const)('立板を %s° 傾けた内角 %s° は平行に近く断り、この脚長の範囲を添える', (tilt, angle) => {
    const result = planFilletWeld(obliqueTee(tilt), obliqueRequest(), WELD_TEST_REVISIONS, BODIES);
    expect(result.ok ? [] : result.rejections.map((rejection) => rejection.code)).toEqual(['unsupportedJointAngle']);
    const detail = result.ok ? null : result.rejections[0]?.detail;
    expect(detail?.angleDegrees).toBeCloseTo(angle, 6);
    expect(detail?.minimumDegrees).toBeCloseTo(MIN_ANGLE, 12);
    expect(detail?.maximumDegrees).toBeCloseTo(180 - MIN_ANGLE, 12);
  });

  it('同じ内角でも脚長が長いと扱えない: 0.95° は脚 6・8 mm なら組め、脚 12・10 mm(下限 sin 0.024)なら組まない', () => {
    const segment = { weldId: 'weld-1', segment: 0, station: 5, length: 12.5, contactLength: 100,
      parts: ['component-1', 'component-2'] as const, interiorAngleDegrees: 0.95 };
    const small = createFilletWeldSource(6, 8, segment);
    const large = createFilletWeldSource(12, 10, segment);
    expect(buildFilletWeldPart(small)).not.toBeNull();
    expect(standardPartNominalVolume('filletWeld', small.size, small.options)).toBeCloseTo(24 * Math.sin(0.95 * Math.PI / 180) * 12.5, 9);
    expect(filletWeldSegmentOptions(large.options)?.interiorAngleDegrees).toBe(0.95);
    expect(buildFilletWeldPart(large)).toBeNull();
    expect(standardPartNominalVolume('filletWeld', large.size, large.options)).toBeNull();
  });

  it('版と欄 weldAngle が対で一致しない・0° 以下・180° 以上・直角・崩れた値の欄は組まない(別の形で代えない)', () => {
    const oblique = createFilletWeldSource(6, 8, { weldId: 'weld-1', segment: 0, station: 5, length: 12.5, contactLength: 100,
      parts: ['component-1', 'component-2'], interiorAngleDegrees: 60 });
    expect(oblique.generatorRevision).toBe(FILLET_WELD_OBLIQUE_GENERATOR_REVISION);
    expect(oblique.options.weldAngle).toBe('60');
    expect(filletWeldSegmentOptions(oblique.options)?.interiorAngleDegrees).toBe(60);
    expect(buildFilletWeldPart(oblique)?.name).toBe('すみ肉溶接 6×8 60° 長さ12.5');
    expect(buildFilletWeldPart({ ...oblique, generatorRevision: FILLET_WELD_GENERATOR_REVISION })).toBeNull();
    const withoutAngle = Object.fromEntries(Object.entries(oblique.options).filter(([key]) => key !== 'weldAngle'));
    expect(buildFilletWeldPart({ ...oblique, options: withoutAngle })).toBeNull();
    for (const broken of ['0', '180', '200', '90', 'abc', '-60']) {
      expect(filletWeldSegmentOptions({ ...oblique.options, weldAngle: broken }), broken).toBeNull();
      expect(buildFilletWeldPart({ ...oblique, options: { ...oblique.options, weldAngle: broken } }), broken).toBeNull();
    }
  });
});

/*
 * 細すぎる断面(直角も同じ基準)。最小の高さ = 2 × 面積 / 最も長い辺 ≥ WELD_LENGTH_TOLERANCE_MM(1e-6 mm)。
 *   直角・脚 a・b: 斜辺が最も長く、高さ = ab / √(a² + b²)。a = b = 1.2e-6 → 1.2e-6/√2 ≈ 0.849e-6(断る)、
 *     a = b = 1.5e-6 → ≈ 1.061e-6(組める)、a = 1000・b = 1.2e-6 → ≈ 1.2e-6(組める。短い脚だけでは決めない)。
 *   内角 60°・脚 10 と b(b ≪ 10): 最も長い辺は 10(3 辺目 = √(100 − 10b + b²) < 10)、高さ = b sin 60°。
 *     b = 1.2e-6 → ≈ 1.039e-6(組める)、b = 1.1e-6 → ≈ 0.953e-6(断る)。
 *   脚 500 mm: 直角は組める(面積 125000)、直角でない 60° は平行に近い条件(下限の sin = 2)で断る。
 *   脚 1e200: 面積が桁あふれ(nonFinite)で組まない。
 */
describe('細すぎる・大きすぎる断面(直角も同じ基準)', () => {
  const RIGHT_SEGMENT = { weldId: 'weld-1', segment: 0, station: 5, length: 12.5, contactLength: 100,
    parts: ['component-1', 'component-2'] as const };
  const SIXTY = weldInteriorAngle(60);

  it('断面の寸法は実際の三角形から求める(手で求めた値)', () => {
    const right = weldCrossSection(1.2e-6, 1.2e-6, null);
    expect(right.area).toBeCloseTo(0.72e-12, 24);
    expect(right.minimumAltitude / (1.2e-6 / Math.SQRT2)).toBeCloseTo(1, 12);
    expect(weldCrossSection(1000, 1.2e-6, null).minimumAltitude / 1.2e-6).toBeCloseTo(1, 9);
    const thin = weldCrossSection(10, 1.1e-6, SIXTY);
    expect(thin.longestSide).toBe(10);
    expect(thin.minimumAltitude / (1.1e-6 * Math.sin(Math.PI / 3))).toBeCloseTo(1, 9);
    // 160° は鈍角なので 3 辺目が最も長い: √(36 + 64 + 96 cos 20°)、面積 24 sin 160°。
    const obtuse = weldCrossSection(6, 8, weldInteriorAngle(160));
    expect(obtuse.longestSide).toBeCloseTo(Math.sqrt(100 + 96 * Math.cos(Math.PI / 9)), 12);
    expect(obtuse.area).toBeCloseTo(24 * Math.sin(160 * Math.PI / 180), 12);
    expect(obtuse.minimumAltitude).toBeCloseTo(2 * obtuse.area / obtuse.longestSide, 15);
  });

  it.each([
    [1.2e-6, 1.2e-6, null, 'degenerate'], [1.5e-6, 1.5e-6, null, null], [1000, 1.2e-6, null, null],
    [10, 1.2e-6, 60, null], [10, 1.1e-6, 60, 'degenerate'], [500, 500, null, null], [500, 500, 60, 'illConditioned'],
    [1e200, 1e200, null, 'nonFinite'], [6, 8, null, null], [6, 8, 20, null], [6, 8, 160, null],
  ] as const)('脚 %s・%s、内角 %s° の断面の問題は %s', (legOnSecond, legOnFirst, degrees, expected) => {
    const angle = degrees === null ? null : weldInteriorAngle(degrees);
    expect(weldCrossSectionIssue(legOnSecond, legOnFirst, angle)).toBe(expected);
    // 組む・公称体積も同じ基準(問題があれば組まず体積も出さない。直角だけ別の基準にしない)。
    const source = createFilletWeldSource(legOnSecond, legOnFirst, degrees === null ? RIGHT_SEGMENT : { ...RIGHT_SEGMENT, interiorAngleDegrees: degrees });
    expect(buildFilletWeldPart(source) === null).toBe(expected !== null);
    const volume = standardPartNominalVolume('filletWeld', source.size, source.options);
    if (expected === null) expect(volume).toBeCloseTo(weldCrossSection(legOnSecond, legOnFirst, angle).area * 12.5, 9);
    else expect(volume).toBeNull();
  });

  it('直角の細すぎる断面は計画で断り、脚長・内角・最小の高さ・許容差を添える', () => {
    const result = planFilletWeld(obliqueTee(0), obliqueRequest({ legOnSecond: 1.2e-6, legOnFirst: 1.2e-6 }), WELD_TEST_REVISIONS, BODIES);
    expect(result.ok ? [] : result.rejections.map((rejection) => rejection.code)).toEqual(['degenerateCrossSection']);
    const detail = result.ok ? null : result.rejections[0]?.detail;
    expect([detail?.first, detail?.second, detail?.legOnSecond, detail?.legOnFirst, detail?.tolerance])
      .toEqual(['component-1', 'component-2', 1.2e-6, 1.2e-6, WELD_LENGTH_TOLERANCE_MM]);
    expect(detail?.angleDegrees).toBeCloseTo(90, 9);
    expect(Number(detail?.minimumAltitude) / (1.2e-6 / Math.SQRT2)).toBeCloseTo(1, 12);
  });

  it('直角でない細すぎる断面(60°、脚 10・1.1e-6)も計画で断る', () => {
    const result = planFilletWeld(obliqueTee(30), obliqueRequest({ legOnSecond: 10, legOnFirst: 1.1e-6 }), WELD_TEST_REVISIONS, BODIES);
    expect(result.ok ? [] : result.rejections.map((rejection) => rejection.code)).toEqual(['degenerateCrossSection']);
    expect(result.ok ? null : result.rejections[0]?.detail.angleDegrees).toBeCloseTo(60, 9);
  });

  it('直角の溶接を細すぎる脚に直す計画も断る(保存した形が従来どおりでも同じ基準)', () => {
    const document = obliqueTee(0);
    const applied = applyFilletWeld(document, planned(document), WELD_TEST_REVISIONS);
    if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
    const edit = planFilletWeldEdit(applied.document, { weldId: 'weld-1', legOnSecond: 1.2e-6, legOnFirst: 1.2e-6,
      segments: [...SEGMENTS], materialId: 'aluminum' }, WELD_TEST_REVISIONS, BODIES);
    expect(edit.ok ? [] : edit.rejections.map((rejection) => [rejection.code, rejection.detail.weldId])).toEqual([['degenerateCrossSection', 'weld-1']]);
    // 脚長そのものが許容差以下なら脚長の誤りだけを示す(断面の理由を重ねない)。
    const invalid = planFilletWeldEdit(applied.document, { weldId: 'weld-1', legOnSecond: 1e-6, legOnFirst: 8,
      segments: [...SEGMENTS], materialId: 'aluminum' }, WELD_TEST_REVISIONS, BODIES);
    expect(invalid.ok ? [] : invalid.rejections.map((rejection) => rejection.code)).toEqual(['invalidDimension']);
  });

  it('普通の脚の直角のビードは従来と同じ出どころ(欄・版・頂点)のまま', () => {
    const source = createFilletWeldSource(6, 8, RIGHT_SEGMENT);
    expect(JSON.stringify(source)).toBe(JSON.stringify({
      kind: 'standardPart', catalog: 'filletWeld', size: '6x8',
      options: { length: '12.5', weldId: 'weld-1', weldSegment: '0', weldStation: '5', contactLength: '100', weldParts: 'component-1,component-2' },
      catalogRevision: FILLET_WELD_CATALOG_REVISION, generatorRevision: FILLET_WELD_GENERATOR_REVISION,
    }));
    const points = buildFilletWeldPart(source)?.sketches.flatMap((sketch) => sketch.features)
      .flatMap((feature) => (feature.kind === 'point' && feature.at.mode === 'absolute' ? [[feature.at.x.value, feature.at.y.value]] : [])) ?? [];
    expect(points).toEqual([[0, 0], [6, 0], [0, 8]]);
    expect(standardPartNominalVolume('filletWeld', source.size, source.options)).toBe(24 * 12.5);
  });
});

describe('直角でない溶接を直す・保存した台本から戻す', () => {
  it('保存した配置と欄から座標系と内角を戻し、区間を直すと内角を保ったまま置き換える', () => {
    const document = obliqueTee(-30);
    const applied = applyFilletWeld(document, planned(document), WELD_TEST_REVISIONS);
    if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
    const edit = planFilletWeldEdit(applied.document, { weldId: 'weld-1', legOnSecond: 5, legOnFirst: 7,
      segments: [{ start: 10, length: 40 }], materialId: 'steel' }, WELD_TEST_REVISIONS, BODIES);
    if (!edit.ok) throw new Error(JSON.stringify(edit.rejections));
    expect(edit.plan.interiorAngle?.degrees).toBeCloseTo(120, 9);
    expectVec(edit.plan.frame.origin, [100, 0, 10]);
    expectVec(edit.plan.frame.xAxis, [0, -1, 0]);
    // 5 × 7 × sin 120° / 2 × 40 = 35√3/4 × 40 = 350√3。
    expect(edit.plan.nominalVolume).toBeCloseTo(350 * SQRT3, 9);
    const replaced = applyFilletWeld(applied.document, edit.plan, WELD_TEST_REVISIONS);
    if (!replaced.ok) throw new Error(JSON.stringify(replaced.rejections));
    const beads = weldSegmentsOf(replaced.document).get('weld-1') ?? [];
    expect(beads).toHaveLength(1);
    const bead = beads[0];
    expect(bead?.source.kind === 'standardPart' ? [bead.source.size, bead.source.generatorRevision] : null)
      .toEqual(['5x7', FILLET_WELD_OBLIQUE_GENERATOR_REVISION]);
    expect(bead?.source.kind === 'standardPart' ? Number(bead.source.options.weldAngle) : null).toBeCloseTo(120, 9);
    expect(bead?.materialId).toBe('steel');
  });

  it('平行に近い 0.95° の溶接は、脚を 12・10 mm に延ばす直しを断る(下限 sin 0.024 > sin 0.95°)', () => {
    const document = obliqueTee(89.05);
    const applied = applyFilletWeld(document, planned(document), WELD_TEST_REVISIONS);
    if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
    const edit = planFilletWeldEdit(applied.document, { weldId: 'weld-1', legOnSecond: 12, legOnFirst: 10,
      segments: [...SEGMENTS], materialId: 'aluminum' }, WELD_TEST_REVISIONS, BODIES);
    expect(edit.ok ? [] : edit.rejections.map((rejection) => rejection.code)).toEqual(['unsupportedJointAngle']);
    expect(edit.ok ? null : edit.rejections[0]?.detail.angleDegrees).toBeCloseTo(0.95, 6);
    // 同じ脚 6・8 mm のままなら直せる。
    expect(planFilletWeldEdit(applied.document, { weldId: 'weld-1', legOnSecond: 6, legOnFirst: 8,
      segments: [{ start: 0, length: 50 }], materialId: 'aluminum' }, WELD_TEST_REVISIONS, BODIES).ok).toBe(true);
  });

  it('区間ごとに内角が食い違う(1 つだけ書き換えられた)溶接は直さずに断る', () => {
    const document = obliqueTee(30);
    const applied = applyFilletWeld(document, planned(document), WELD_TEST_REVISIONS);
    if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
    const id = applied.componentIds[1] ?? '';
    const bead = component(applied.document, id);
    // 絞り込みは const の変数に置く(プロパティ bead.source の絞り込みは下のコールバックの中まで続かない)。
    const source = bead.source;
    if (source.kind !== 'standardPart') throw new Error('bead');
    const tampered: AssemblyDocument = { ...applied.document, components: applied.document.components.map((item) => item.id === id
      ? { ...item, source: { ...source, options: { ...source.options, weldAngle: '61' } } } : item) };
    const edit = planFilletWeldEdit(tampered, { weldId: 'weld-1', legOnSecond: 6, legOnFirst: 8, segments: [...SEGMENTS],
      materialId: 'aluminum' }, WELD_TEST_REVISIONS, BODIES);
    expect(edit.ok ? [] : edit.rejections.map((rejection) => [rejection.code, rejection.detail.componentId])).toEqual([['weldDamaged', id]]);
  });
});
