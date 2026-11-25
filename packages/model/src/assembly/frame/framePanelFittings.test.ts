/**
 * パネルと扉(E-10 第 1 段)の枠の開口の検査: 選んだ 4 本の枠の内側の寸法・中心・向き、隙間、縦の面の枠、断る理由。
 * 部材の箱はこの検査の中で手で作る(断面 20×20 で軸の上に中心。期待は手で解いた値)。
 */
import { describe, expect, it } from 'vitest';

import type { Vec3 } from '../../sketch/vec3.js';
import { rotateVector } from '../placementMath.js';
import type { PlacedFrameMember } from './frameJoints.js';
import { framePanelOpening } from './framePanelOpening.js';
import { planFramePanelFittings } from './framePanelFittings.js';

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
  it('開口の角まで届く突合せの枠はそのまま使い、途中で途切れた横材では板を計画しない', () => {
    const butted = [
      member('bottom', [10, 0, 0], [590, 0, 0], [0, 1, 0], [0, 0, 1]),
      member('top', [10, 400, 0], [590, 400, 0], [0, 1, 0], [0, 0, 1]),
      member('left', [0, 10, 0], [0, 390, 0], [-1, 0, 0], [0, 0, 1]),
      member('right', [600, 10, 0], [600, 390, 0], [-1, 0, 0], [0, 0, 1]),
    ];
    expect(framePanelOpening(butted, PANEL)).toEqual(framePanelOpening(FLOOR, PANEL));
    const short = member('bottom', [100, 0, 0], [500, 0, 0], [0, 1, 0], [0, 0, 1]);
    expect(framePanelOpening([short, ...butted.slice(1)], PANEL)).toEqual({ ok: false, reason: 'notRectangle' });
  });

  it('反転で寸法と板の中央を保ち、局所の上と表を反転する。非有限な部材は断る', () => {
    const flipped = framePanelOpening(FLOOR, { ...PANEL, flip: true });
    if (!flipped.ok) throw new Error(flipped.reason);
    expect([flipped.width, flipped.height, flipped.placement.position]).toEqual([580, 380, [300, 200, 1.5]]);
    expect(cleaned(rotateVector(flipped.placement.rotation, [0, 1, 0]))).toEqual([0, -1, 0]);
    expect(cleaned(rotateVector(flipped.placement.rotation, [0, 0, 1]))).toEqual([0, 0, -1]);
    const invalid = FLOOR.map((part) => ({ ...part, yAxis: [NaN, 0, 1] as const }));
    expect(framePanelOpening(invalid, PANEL)).toEqual({ ok: false, reason: 'notRectangle' });
  });

  it('押さえ4個とつなぎ4個を辺と裏面に計画し、取付面の反転と広すぎる隙間を扱う', () => {
    const options = { ...PANEL, flip: false, holder: { width: 23.8, depth: 20, height: 30.5 }, connector: true };
    const fittings = planFramePanelFittings(FLOOR, options);
    if (!fittings.ok) throw new Error(fittings.reason);
    expect(fittings.holders.map((part) => part.position)).toEqual([[284.75, 10, 0], [284.75, 390, 0], [10, 184.75, 0], [590, 184.75, 0]]);
    expect(fittings.connectors.map((part) => part.position)).toEqual([[10, 10, -10], [10, 390, -10], [590, 10, -10], [590, 390, -10]]);
    const flipped = planFramePanelFittings(FLOOR, { ...options, flip: true });
    if (!flipped.ok) throw new Error(flipped.reason);
    expect(flipped.connectors.map((part) => part.position[2])).toEqual([10, 10, 10, 10]);
    expect(planFramePanelFittings(FLOOR, { ...options, gap: 24 })).toEqual({ ok: false, reason: 'holderNoRoom' });
  });
});
