/**
 * パネルと扉(E-10 第 1 段)の枠の開口の検査: 選んだ 4 本の枠の内側の寸法・中心・向き、隙間、縦の面の枠、断る理由。
 * 部材の箱はこの検査の中で手で作る(断面 20×20 で軸の上に中心。期待は手で解いた値)。
 */
import { describe, expect, it } from 'vitest';

import type { Vec3 } from '../../sketch/vec3.js';
import { rotateVector } from '../placementMath.js';
import type { PlacedFrameMember } from './frameJoints.js';
import { framePanelOpening } from './framePanelOpening.js';

const BOUNDS = { minX: -10, minY: -10, maxX: 10, maxY: 10 };
const member = (componentId: string, start: Vec3, end: Vec3, xAxis: Vec3, yAxis: Vec3): PlacedFrameMember =>
  ({ componentId, start, end, xAxis, yAxis, bounds: BOUNDS, slotLines: [], slotSpec: null });
/** 床の上の 600 × 400 の枠(X の向きの部材は局所 x = +Y、Y の向きの部材は局所 x = −X。どちらも局所 y = +Z)。 */
const FLOOR = [
  member('bottom', [0, 0, 0], [600, 0, 0], [0, 1, 0], [0, 0, 1]), member('top', [0, 400, 0], [600, 400, 0], [0, 1, 0], [0, 0, 1]),
  member('left', [0, 0, 0], [0, 400, 0], [-1, 0, 0], [0, 0, 1]), member('right', [600, 0, 0], [600, 400, 0], [-1, 0, 0], [0, 0, 1]),
];
const PANEL = { thickness: 3, gap: 0 };
const cleaned = (vector: Vec3): readonly number[] => vector.map((value) => Math.round(value * 1e9) / 1e9 + 0);

describe('枠の開口', () => {
  it('600 × 400 の枠は内側 580 × 380、中心 (300, 200) で、板は板厚の半分だけ下へずらして局所 X が辺・Z が上', () => {
    const result = framePanelOpening(FLOOR, PANEL);
    if (!result.ok) throw new Error(result.reason);
    expect([result.width, result.height]).toEqual([580, 380]);
    expect(result.placement.position).toEqual([300, 200, -1.5]);
    expect(cleaned(rotateVector(result.placement.rotation, [1, 0, 0]))).toEqual([1, 0, 0]);
    expect(cleaned(rotateVector(result.placement.rotation, [0, 0, 1]))).toEqual([0, 0, 1]);
  });

  it('隙間は各辺から引く。選ぶ順に関わらず同じ寸法', () => {
    expect(framePanelOpening(FLOOR, { thickness: 3, gap: 5 })).toMatchObject({ width: 570, height: 370 });
    const shuffled = [FLOOR[2], FLOOR[0], FLOOR[3], FLOOR[1]].filter((item): item is PlacedFrameMember => item !== undefined);
    expect(framePanelOpening(shuffled, PANEL)).toMatchObject({ ok: true, width: 380, height: 580 });
  });

  it('縦の面(XZ)の枠は、板の法線が面に直交する(-Y)', () => {
    const wall = [
      member('b', [0, 0, 0], [600, 0, 0], [0, 1, 0], [0, 0, 1]), member('t', [0, 0, 400], [600, 0, 400], [0, 1, 0], [0, 0, 1]),
      member('l', [0, 0, 0], [0, 0, 400], [1, 0, 0], [0, 1, 0]), member('r', [600, 0, 0], [600, 0, 400], [1, 0, 0], [0, 1, 0]),
    ];
    const result = framePanelOpening(wall, PANEL);
    if (!result.ok) throw new Error(result.reason);
    expect([result.width, result.height]).toEqual([580, 380]);
    expect(cleaned(rotateVector(result.placement.rotation, [0, 0, 1]))).toEqual([0, -1, 0]);
    expect(result.placement.position).toEqual([300, 1.5, 200]);
  });

  it('断る: 4 本でない・直交する 2 組にならない・同じ面に無い・内側が無い・板厚が正でない', () => {
    expect(framePanelOpening(FLOOR.slice(0, 3), PANEL)).toEqual({ ok: false, reason: 'notFour' });
    const parallel = FLOOR.map((item, index) => member(item.componentId, [0, index * 100, 0], [600, index * 100, 0], [0, 1, 0], [0, 0, 1]));
    expect(framePanelOpening(parallel, PANEL)).toEqual({ ok: false, reason: 'notRectangle' });
    const lifted = [...FLOOR.slice(0, 3), member('right', [600, 0, 50], [600, 400, 50], [-1, 0, 0], [0, 0, 1])];
    expect(framePanelOpening(lifted, PANEL)).toEqual({ ok: false, reason: 'notCoplanar' });
    const tight = [
      member('b', [0, 0, 0], [15, 0, 0], [0, 1, 0], [0, 0, 1]), member('t', [0, 15, 0], [15, 15, 0], [0, 1, 0], [0, 0, 1]),
      member('l', [0, 0, 0], [0, 15, 0], [-1, 0, 0], [0, 0, 1]), member('r', [15, 0, 0], [15, 15, 0], [-1, 0, 0], [0, 0, 1]),
    ];
    expect(framePanelOpening(tight, PANEL)).toEqual({ ok: false, reason: 'noRoom' });
    expect(framePanelOpening(FLOOR, { thickness: 0, gap: 0 })).toEqual({ ok: false, reason: 'invalidNumber' });
  });
});
