/**
 * ケガキの位置(E-14)の純関数の検査: 途中に当たる相手の部材は両側の 2 つの位置(面つき)、溝のナットは 1 つの位置、端どうしの接続は
 * 出さず、0.1 mm に丸めて同じ面の同じ位置は 1 つにまとめる事。部材と接続はこの検査の中で手で作る(期待の位置は手で解いた値)。
 */
import { describe, expect, it } from 'vitest';

import type { Vec3 } from '../../sketch/vec3.js';
import type { FrameJoint, PlacedFrameMember } from './frameJoints.js';
import { frameScribeMarks } from './frameScribeMarks.js';
import type { FrameSlotLine } from './frameSlots.js';

const BOUNDS = { minX: -10, minY: -10, maxX: 10, maxY: 10 };

/** 断面 20×20 の部材(局所 x・y の向きを渡す)。 */
function member(componentId: string, start: Vec3, end: Vec3, xAxis: Vec3, yAxis: Vec3, slotLines: readonly FrameSlotLine[] = []): PlacedFrameMember {
  return { componentId, start, end, xAxis, yAxis, bounds: BOUNDS, slotLines, slotSpec: null };
}

/** X の向きの長さ 1000 の部材(局所 x = 世界の +Y、局所 y = 世界の +Z)。上の面(世界の z = 10)に溝の線を 1 本持つ。 */
const TOP_SLOT = { face: 'top', start: [0, 0, 10], end: [1000, 0, 10], inward: [0, 0, -1], across: [0, 1, 0], opening: 6, shoulder: 2,
  slotDepth: 6, roomSimplified: false } as unknown as FrameSlotLine;
const BASE = member('base', [0, 0, 0], [1000, 0, 0], [0, 1, 0], [0, 0, 1], [TOP_SLOT]);

const joint = (id: string, kind: FrameJoint['kind'], members: FrameJoint['members']): FrameJoint => ({ id, kind, members, point: [0, 0, 0] });

describe('ケガキの位置', () => {
  it('T: 途中(右の面)に当たる 20×20 の相手は、相手の両側の 490 と 510。当てる側の部材(端で当たる)には出さない', () => {
    // 相手は世界の +Y の向き(局所 x = 世界の +X)で、x = 500 に立つ。
    const post = member('post', [500, 10, 0], [500, 300, 0], [1, 0, 0], [0, 0, 1]);
    const result = frameScribeMarks([BASE, post], [joint('t', 'T', [{ componentId: 'base', part: 'side', face: 'right' },
      { componentId: 'post', part: 'start', face: null }])], []);
    expect(result).toEqual([{ componentId: 'base', lengthMm: 1000, marks: [
      { face: 'right', positionMm: 490, kind: 'member', otherComponentId: 'post' },
      { face: 'right', positionMm: 510, kind: 'member', otherComponentId: 'post' }] }]);
  });

  it('交差: 途中どうしなら両方の部材に相手の両側が出る。端どうし(L)は出さない', () => {
    const cross = member('cross', [300, -200, 20], [300, 200, 20], [1, 0, 0], [0, 0, 1]);
    const crossing = frameScribeMarks([BASE, cross], [joint('c', 'crossing', [{ componentId: 'base', part: 'side', face: 'top' },
      { componentId: 'cross', part: 'side', face: 'bottom' }])], []);
    expect(crossing.map((entry) => [entry.componentId, entry.marks.map((mark) => [mark.face, mark.positionMm])])).toEqual([
      ['base', [['top', 290], ['top', 310]]], ['cross', [['bottom', 190], ['bottom', 210]]]]);
    const corner = member('corner', [1000, 0, 0], [1000, 500, 0], [1, 0, 0], [0, 0, 1]);
    expect(frameScribeMarks([BASE, corner], [joint('l', 'L', [{ componentId: 'base', part: 'end', face: null },
      { componentId: 'corner', part: 'start', face: null }])], [])).toEqual([]);
  });

  it('溝のナット: 上の面の溝の中のナットは、その位置(0.1 mm に丸め)。同じ位置の 2 つは 1 つにまとめ、溝の外のナットは出さない', () => {
    const result = frameScribeMarks([BASE], [], [
      { componentId: 'n1', point: [250.04, 0, 7] }, { componentId: 'n2', point: [249.98, 0.5, 6] },
      { componentId: 'n3', point: [600, 50, 7] }, { componentId: 'n4', point: [700, 0, 20] }]);
    expect(result).toEqual([{ componentId: 'base', lengthMm: 1000, marks: [
      { face: 'top', positionMm: 250, kind: 'nut', otherComponentId: 'n1' }] }]);
  });

  it('端(0 と長さ)の位置は出さず、面の順(上・左・下・右)・距離の順に並べる', () => {
    const atStart = member('a', [0, 10, 0], [0, 300, 0], [1, 0, 0], [0, 0, 1]);
    const mid = member('m', [800, -10, 0], [800, -300, 0], [1, 0, 0], [0, 0, 1]);
    const result = frameScribeMarks([BASE, atStart, mid], [
      joint('t1', 'T', [{ componentId: 'base', part: 'side', face: 'right' }, { componentId: 'm', part: 'start', face: null }]),
      joint('t2', 'T', [{ componentId: 'base', part: 'side', face: 'left' }, { componentId: 'a', part: 'start', face: null }]),
    ], [{ componentId: 'n1', point: [900, 0, 7] }]);
    // 相手 a は x = -10〜10 に当たり、0 以下は出さないので 10 だけ。
    expect(result[0]?.marks.map((mark) => [mark.face, mark.positionMm])).toEqual([
      ['top', 900], ['left', 10], ['right', 790], ['right', 810]]);
  });
});
