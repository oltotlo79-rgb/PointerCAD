/**
 * フレームの一括配置(J-01 包み 1)の純関数の検査: 線の列から、部材 1 本ごとの長さ・配置・角の扱いを出す事。
 * 期待の値はこの検査の中で手で解いた物(部材は +Z へ押し出した形、断面の外形の中心を線に乗せる、
 * 局所の Z = 線の向き、局所の Y = 上の向きを線に直交させた向き、局所の X = Y × Z)。
 */
import { describe, expect, it } from 'vitest';

import type { Vec3 } from '../../sketch/vec3.js';
import { rotateVector } from '../placementMath.js';
import { planFrameMembers, type FrameLine } from './frameMembers.js';

type FrameMemberOptions = Parameters<typeof planFrameMembers>[1];
type FrameMemberPlan = Extract<ReturnType<typeof planFrameMembers>, { readonly ok: true }>['members'][number];

const SQUARE_20 = { minX: -10, minY: -10, maxX: 10, maxY: 10 } as const;
const OPTIONS: FrameMemberOptions = { section: SQUARE_20, up: [0, 0, 1], startExtension: 0, endExtension: 0, corners: 'butt' };

function line(start: Vec3, end: Vec3): FrameLine {
  return { start, end };
}

/** 500×300 の長方形を、原点から反時計回りに閉じた 4 本の線。 */
const RECTANGLE: readonly FrameLine[] = [
  line([0, 0, 0], [500, 0, 0]), line([500, 0, 0], [500, 300, 0]), line([500, 300, 0], [0, 300, 0]), line([0, 300, 0], [0, 0, 0]),
];

function expectVec(actual: Vec3, expected: Vec3): void {
  actual.forEach((value, index) => { expect(value).toBeCloseTo(expected[index] ?? NaN, 9); });
}

/** 部材の局所の点を世界へ写す(p' = R·p + t)。 */
function toWorld(member: FrameMemberPlan, local: Vec3): Vec3 {
  const rotated = rotateVector(member.placement.rotation, local);
  const [x, y, z] = member.placement.position;
  return [rotated[0] + x, rotated[1] + y, rotated[2] + z];
}

function membersOf(result: ReturnType<typeof planFrameMembers>): readonly FrameMemberPlan[] {
  if (!result.ok) throw new Error(`rejected: ${result.reason}`);
  return result.members;
}

describe('フレームの一括配置の純関数', () => {
  it('閉じた長方形を突き当てで並べると、先の線の部材が通って伸び、後の線の部材が縮み、外形は 520×320 になる', () => {
    const result = planFrameMembers(RECTANGLE, OPTIONS);
    const members = membersOf(result);
    expect(members.map((member) => [member.lineIndex, member.lengthMm])).toEqual([[0, 520], [1, 300], [2, 500], [3, 280]]);
    expect(members.map((member) => [member.startAdjustment, member.endAdjustment])).toEqual([[10, 10], [-10, 10], [-10, 10], [-10, -10]]);
    // 線 0 は x = -10 から 510 まで(線の上、断面の中心が線に乗る)。
    expectVec(toWorld(members[0], [0, 0, 0]), [-10, 0, 0]);
    expectVec(toWorld(members[0], [0, 0, 520]), [510, 0, 0]);
    // 線 3 は y = 290 から 10 まで(上と下の部材の面に当たる)。
    expectVec(toWorld(members[3], [0, 0, 0]), [0, 290, 0]);
    expectVec(toWorld(members[3], [0, 0, 280]), [0, 10, 0]);
    if (!result.ok) throw new Error('rejected');
    expect(result.corners.map((corner) => [corner.lines, corner.treatment, corner.through])).toEqual([
      [[0, 3], 'butt', 0], [[0, 1], 'butt', 0], [[1, 2], 'butt', 1], [[2, 3], 'butt', 2]]);
  });

  it('向き: 局所の Z は線の向き、局所の Y は上の向き(+Z)、局所の X は Y × Z で、基底は直交', () => {
    const members = membersOf(planFrameMembers(RECTANGLE, { ...OPTIONS, corners: 'none' }));
    const first = members[0];
    expectVec(rotateVector(first.placement.rotation, [0, 0, 1]), [1, 0, 0]);
    expectVec(rotateVector(first.placement.rotation, [0, 1, 0]), [0, 0, 1]);
    expectVec(rotateVector(first.placement.rotation, [1, 0, 0]), [0, 1, 0]);
    const second = members[1];
    expectVec(rotateVector(second.placement.rotation, [0, 0, 1]), [0, 1, 0]);
    expectVec(rotateVector(second.placement.rotation, [1, 0, 0]), [-1, 0, 0]);
  });

  it('角の扱いが「そのまま」なら長さは線の長さで、角は理由つきで扱わない', () => {
    const result = planFrameMembers(RECTANGLE.slice(0, 2), { ...OPTIONS, corners: 'none' });
    expect(membersOf(result).map((member) => member.lengthMm)).toEqual([500, 300]);
    if (!result.ok) throw new Error('rejected');
    expect(result.corners).toEqual([{ point: [500, 0, 0], lines: [0, 1], treatment: 'none', reason: 'rule', through: null }]);
  });

  it('斜めの線(3-4-5)は長さ 500 で、局所の Z は (0.6, 0.8, 0)、局所の Y は +Z', () => {
    const [member] = membersOf(planFrameMembers([line([0, 0, 0], [300, 400, 0])], OPTIONS));
    if (member === undefined) throw new Error('no member');
    expect(member.lengthMm).toBe(500);
    expectVec(rotateVector(member.placement.rotation, [0, 0, 1]), [0.6, 0.8, 0]);
    expectVec(rotateVector(member.placement.rotation, [0, 1, 0]), [0, 0, 1]);
    expectVec(toWorld(member, [0, 0, 500]), [300, 400, 0]);
  });

  it('上の向きが線と平行なら、候補(+Z、+Y、+X)の次へ替える(縦の線は局所の Y が +Y)', () => {
    const [member] = membersOf(planFrameMembers([line([0, 0, 0], [0, 0, 1000])], OPTIONS));
    if (member === undefined) throw new Error('no member');
    expectVec(rotateVector(member.placement.rotation, [0, 0, 1]), [0, 0, 1]);
    expectVec(rotateVector(member.placement.rotation, [0, 1, 0]), [0, 1, 0]);
    expectVec(rotateVector(member.placement.rotation, [1, 0, 0]), [1, 0, 0]);
  });

  it('断面の原点が角にある外形(平鋼 50×6)は、外形の中心 (25, 3) が線に乗る', () => {
    const [member] = membersOf(planFrameMembers([line([100, 200, 0], [100, 200, 600])],
      { ...OPTIONS, section: { minX: 0, minY: 0, maxX: 50, maxY: 6 } }));
    if (member === undefined) throw new Error('no member');
    expectVec(toWorld(member, [25, 3, 0]), [100, 200, 0]);
    expectVec(toWorld(member, [25, 3, 600]), [100, 200, 600]);
  });

  it('90° 回すと断面の長い辺(40)が枠の面の中に入り、突き当ての伸び縮みは 20 になる', () => {
    const tall = { minX: -10, minY: -20, maxX: 10, maxY: 20 };
    const flat = membersOf(planFrameMembers(RECTANGLE, { ...OPTIONS, section: tall }));
    expect(flat.map((member) => member.lengthMm)).toEqual([520, 300, 500, 280]);
    const turned = membersOf(planFrameMembers(RECTANGLE, { ...OPTIONS, section: tall, quarterTurns: 1 }));
    expect(turned.map((member) => member.lengthMm)).toEqual([540, 300, 500, 260]);
    expectVec(rotateVector(turned[0].placement.rotation, [1, 0, 0]), [0, 0, 1]);
  });

  it('角の番号を入れ替えに入れると、その角だけ後の線の部材を通す(角 1 は線 1 が通り、線 0 が縮む)', () => {
    const result = planFrameMembers(RECTANGLE, { ...OPTIONS, swapThrough: [1] });
    expect(membersOf(result).map((member) => member.lengthMm)).toEqual([500, 320, 500, 280]);
    if (!result.ok) throw new Error('rejected');
    expect(result.corners.map((corner) => corner.through)).toEqual([0, 1, 1, 2]);
  });

  it('伸ばす量は両端に足し、負の値は縮める', () => {
    const [member] = membersOf(planFrameMembers([line([0, 0, 0], [500, 0, 0])],
      { ...OPTIONS, startExtension: 15, endExtension: -5 }));
    if (member === undefined) throw new Error('no member');
    expect(member.lengthMm).toBe(510);
    expectVec(toWorld(member, [0, 0, 0]), [-15, 0, 0]);
    expectVec(toWorld(member, [0, 0, 510]), [495, 0, 0]);
  });

  it('3 本が会う角と、直角でない角は突き当てにせず、理由を出して長さを変えない', () => {
    const corner3 = planFrameMembers([line([0, 0, 0], [100, 0, 0]), line([0, 0, 0], [0, 100, 0]), line([0, 0, 0], [0, 0, 100])], OPTIONS);
    expect(membersOf(corner3).map((member) => member.lengthMm)).toEqual([100, 100, 100]);
    if (!corner3.ok) throw new Error('rejected');
    expect(corner3.corners.map((corner) => [corner.lines, corner.treatment, corner.reason])).toEqual([[[0, 1, 2], 'none', 'moreThanTwo']]);
    const oblique = planFrameMembers([line([0, 0, 0], [100, 0, 0]), line([100, 0, 0], [150, 100, 0])], OPTIONS);
    expect(membersOf(oblique).map((member) => member.lengthMm)).toEqual([100, Math.round(Math.hypot(50, 100) * 1e6) / 1e6]);
    if (!oblique.ok) throw new Error('rejected');
    expect(oblique.corners.map((corner) => [corner.treatment, corner.reason])).toEqual([['none', 'notPerpendicular']]);
  });

  it('作れない時は置かずに理由を返す(線が無い・長さ 0 の線・縮めすぎ・外形が無い・数でない値・上の向きが 0)', () => {
    expect(planFrameMembers([], OPTIONS)).toEqual({ ok: false, reason: 'noLines', lineIndex: null });
    expect(planFrameMembers([line([1, 2, 3], [1, 2, 3])], OPTIONS)).toEqual({ ok: false, reason: 'degenerateLine', lineIndex: 0 });
    expect(planFrameMembers([line([0, 0, 0], [500, 0, 0])], { ...OPTIONS, startExtension: -300, endExtension: -200 }))
      .toEqual({ ok: false, reason: 'nonPositiveLength', lineIndex: 0 });
    expect(planFrameMembers(RECTANGLE, { ...OPTIONS, section: { minX: 0, minY: 0, maxX: 0, maxY: 10 } }))
      .toEqual({ ok: false, reason: 'invalidSection', lineIndex: null });
    expect(planFrameMembers([line([0, 0, 0], [Number.NaN, 0, 0])], OPTIONS)).toEqual({ ok: false, reason: 'invalidNumber', lineIndex: 0 });
    expect(planFrameMembers(RECTANGLE, { ...OPTIONS, up: [0, 0, 0] })).toEqual({ ok: false, reason: 'invalidUp', lineIndex: null });
  });
});
