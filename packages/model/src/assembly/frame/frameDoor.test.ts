/**
 * パネルと扉(E-10 第 2 段)の扉の計画の検査: 600 × 400 の枠(内側 580 × 380)に、隙間 2・枠の幅 44 の扉を付けると、扉の外形 576 × 376、
 * 扉の枠の中心線は外形から 22 内側の閉じた 4 本、板は 488 × 288、ヒンジ 2 つは開口の片側の線の上で上下の端から 100 の所。断る理由も。
 * 部材の箱はこの検査の中で手で作る(期待は手で解いた値)。
 */
import { describe, expect, it } from 'vitest';

import type { Vec3 } from '../../sketch/vec3.js';
import { rotateVector } from '../placementMath.js';
import { planFrameDoor } from './frameDoor.js';
import type { PlacedFrameMember } from './frameJoints.js';

type FrameDoorInput = Parameters<typeof planFrameDoor>[1];
const BOUNDS = { minX: -10, minY: -10, maxX: 10, maxY: 10 };
const member = (componentId: string, start: Vec3, end: Vec3, xAxis: Vec3): PlacedFrameMember =>
  ({ componentId, start, end, xAxis, yAxis: [0, 0, 1], bounds: BOUNDS, slotLines: [], slotSpec: null });
const FLOOR = [member('bottom', [0, 0, 0], [600, 0, 0], [0, 1, 0]), member('top', [0, 400, 0], [600, 400, 0], [0, 1, 0]),
  member('left', [0, 0, 0], [0, 400, 0], [-1, 0, 0]), member('right', [600, 0, 0], [600, 400, 0], [-1, 0, 0])];
const INPUT: FrameDoorInput = { clearance: 2, frameWidth: 44, boardThickness: 3,
  hinge: { width: 57, depth: 54.5, height: 82.6, side: 'start', offset: 100 } };
const cleaned = (vector: Vec3): readonly number[] => vector.map((value) => Math.round(value * 1e9) / 1e9 + 0);

function plan(input: Partial<FrameDoorInput> = {}) {
  const result = planFrameDoor(FLOOR, { ...INPUT, ...input });
  if (!result.ok) throw new Error(result.reason);
  return result;
}

describe('扉の計画', () => {
  it('扉の外形 576 × 376、枠の中心線は外形から 22 内側(角 (34, 34)〜(566, 366))の閉じた 4 本、板 488 × 288 は中心に', () => {
    const result = plan();
    expect(result.outer).toEqual({ width: 576, height: 376 });
    expect(result.frameLines.map((line) => line.start)).toEqual([[34, 34, 0], [566, 34, 0], [566, 366, 0], [34, 366, 0]]);
    expect(result.frameLines.at(-1)?.end).toEqual([34, 34, 0]);
    expect(result.frameUp).toEqual([0, 0, 1]);
    expect([result.board.width, result.board.height]).toEqual([488, 288]);
    expect(result.board.placement.position).toEqual([300, 200, -1.5]);
  });

  it('ヒンジ: 始まりの側(x = 10)の線の上、上下の端から 100(y = 110 と 290)を中心にし、箱の高さを Y・奥行を Z に向ける', () => {
    const [low, high] = plan().hinges;
    // 箱の原点は下の面の中心なので、中心から高さの半分 41.3 だけ -Y(68.7 と 248.7。小数の端数があるので 1e-6 mm まで比べる)。
    for (const [hinge, y] of [[low, 68.7], [high, 248.7]] as const) {
      [10, y, 0].forEach((value, axis) => { expect(hinge?.position[axis]).toBeCloseTo(value, 6); });
    }
    const rotation = low?.rotation ?? [0, 0, 0, 1];
    expect(cleaned(rotateVector(rotation, [0, 0, 1]))).toEqual([0, 1, 0]);
    expect(cleaned(rotateVector(rotation, [0, 1, 0]))).toEqual([0, 0, 1]);
    expect(plan({ hinge: { ...INPUT.hinge, side: 'end' } }).hinges[0]?.position[0]).toBe(590);
  });

  it('第 3 段 板の押さえ: 間隔 300 で各辺 2 つ(長さ 488・288 とも)の 8 つ、間隔 100 で 5・5・3・3 の 16。中心は辺の (2i+1)/(2n) の所', () => {
    const holder = { width: 23.8, depth: 20, height: 30.5, pitch: 300 };
    expect(plan().holders).toEqual([]);
    const holders = plan({ holder }).holders;
    expect(holders).toHaveLength(8);
    // 板の縁: 始まり x = 10 + 2 + 44 = 56、下 y = 56、長さ 488 × 288。下の辺の 1 つ目の中心 x = 56 + 488 / 4 = 178。
    // 箱の原点は下の面の中心なので、辺の向き(+X)へ高さの半分 15.25 戻す(162.75)。箱の高さを X、奥行を Z へ向ける。
    expect(holders[0]?.position).toEqual([162.75, 56, 0]);
    const rotation = holders[0]?.rotation ?? [0, 0, 0, 1];
    expect(cleaned(rotateVector(rotation, [0, 0, 1]))).toEqual([1, 0, 0]);
    expect(cleaned(rotateVector(rotation, [0, 1, 0]))).toEqual([0, 0, 1]);
    // 始まりの辺(x = 56、+Y の向き)の 1 つ目の中心 y = 56 + 288 / 4 = 128、原点は 15.25 戻して 112.75。
    expect(holders[4]?.position).toEqual([56, 112.75, 0]);
    expect(cleaned(rotateVector(holders[4]?.rotation ?? [0, 0, 0, 1], [0, 0, 1]))).toEqual([0, 1, 0]);
    expect(plan({ holder: { ...holder, pitch: 100 } }).holders).toHaveLength(16);
  });

  it('第 3 段 平たいつなぎ: 扉の枠の 4 隅(34, 34)〜(566, 366)の裏の面(z = -33 / 2)に、高さを -Z へ向けて 1 つずつ', () => {
    expect(plan().connectors).toEqual([]);
    const connectors = plan({ connector: { height: 20, frameDepth: 33 } }).connectors;
    expect(connectors.map((placement) => placement.position)).toEqual([[34, 34, -16.5], [566, 34, -16.5], [566, 366, -16.5], [34, 366, -16.5]]);
    const rotation = connectors[0]?.rotation ?? [0, 0, 0, 1];
    expect(cleaned(rotateVector(rotation, [0, 0, 1]))).toEqual([0, 0, -1]);
    expect(cleaned(rotateVector(rotation, [1, 0, 0]))).toEqual([1, 0, 0]);
  });

  it('断る: 4 本でない・数が正でない・扉の枠の内側が無い・ヒンジが収まらない', () => {
    expect(planFrameDoor(FLOOR.slice(1), INPUT)).toEqual({ ok: false, reason: 'notFour' });
    expect(planFrameDoor(FLOOR, { ...INPUT, frameWidth: 0 })).toEqual({ ok: false, reason: 'invalidNumber' });
    expect(planFrameDoor(FLOOR, { ...INPUT, frameWidth: 200 })).toEqual({ ok: false, reason: 'noRoom' });
    expect(planFrameDoor(FLOOR, { ...INPUT, hinge: { ...INPUT.hinge, offset: 30 } })).toEqual({ ok: false, reason: 'hingeNoRoom' });
    expect(planFrameDoor(FLOOR, { ...INPUT, hinge: { ...INPUT.hinge, offset: 160 } })).toEqual({ ok: false, reason: 'hingeNoRoom' });
    // 押さえ 2 つ × 高さ 300 = 600 は、長さ 488 の辺に収まらない。間隔 0 は数が正でない。
    expect(planFrameDoor(FLOOR, { ...INPUT, holder: { width: 23.8, depth: 20, height: 300, pitch: 300 } }))
      .toEqual({ ok: false, reason: 'holderNoRoom' });
    expect(planFrameDoor(FLOOR, { ...INPUT, holder: { width: 23.8, depth: 20, height: 30.5, pitch: 0 } }))
      .toEqual({ ok: false, reason: 'invalidNumber' });
    expect(planFrameDoor(FLOOR, { ...INPUT, connector: { height: 20, frameDepth: 0 } })).toEqual({ ok: false, reason: 'invalidNumber' });
  });
});
