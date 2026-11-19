import { describe, expect, it } from 'vitest';

import { exceedsMagnitude } from '../../numericTolerance.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { frameCenterPoints } from './frameDimensionBasis.js';

/** 換える時の欄(部材の断面・上の向き・回し・基準)。書き出しは関数だけにし、型は関数の引数から取る。 */
type FrameCenterPointsOptions = Parameters<typeof frameCenterPoints>[2];

/* 配置の補助 P-B: 芯・内側・外側の寸法から芯の点へ換える。期待の点は手で解いた値(断面 40×40 なら中心から面まで 20)。 */
const SQUARE_40 = { minX: -20, minY: -20, maxX: 20, maxY: 20 };
const options = (basis: FrameCenterPointsOptions['basis'], extra: Partial<FrameCenterPointsOptions> = {}): FrameCenterPointsOptions =>
  ({ basis, up: [0, 0, 1], quarterTurns: 0, section: SQUARE_40, ...extra });
const RECT: readonly Vec3[] = [[0, 0, 0], [1000, 0, 0], [1000, 500, 0], [0, 500, 0]];

function expectPoints(actual: ReturnType<typeof frameCenterPoints>, expected: readonly Vec3[]): void {
  expect(actual.ok).toBe(true);
  if (!actual.ok) return;
  expect(actual.points).toHaveLength(expected.length);
  actual.points.forEach((point, index) => {
    point.forEach((value, axis) => { expect(exceedsMagnitude(value - (expected[index]?.[axis] ?? Number.NaN), 1e-9), `${index}:${axis}`).toBe(false); });
  });
}

describe('芯・内側・外側の寸法から芯の点', () => {
  it('芯はそのまま返す(開いた線でも)', () => {
    expect(frameCenterPoints(RECT, false, options('center'))).toEqual({ ok: true, points: RECT });
  });

  it('外側の 1000×500 の長方形は、断面 40×40 なら芯が 960×460(各辺を 20 内へ)', () => {
    expectPoints(frameCenterPoints(RECT, true, options('outer')), [[20, 20, 0], [980, 20, 0], [980, 480, 0], [20, 480, 0]]);
  });

  it('内側の 1000×500 の長方形は、芯が 1040×540(各辺を 20 外へ)。時計回りに打っても同じ角になる', () => {
    expectPoints(frameCenterPoints(RECT, true, options('inner')), [[-20, -20, 0], [1020, -20, 0], [1020, 520, 0], [-20, 520, 0]]);
    const clockwise: readonly Vec3[] = [[0, 0, 0], [0, 500, 0], [1000, 500, 0], [1000, 0, 0]];
    expectPoints(frameCenterPoints(clockwise, true, options('inner')), [[-20, -20, 0], [-20, 520, 0], [1020, 520, 0], [1020, -20, 0]]);
  });

  it('長方形の断面 20×40 は、部材を置く時と同じ向き(回し 0 なら面の中の幅 20、回し 1 なら 40)でずらす', () => {
    const section = { minX: -10, minY: -20, maxX: 10, maxY: 20 };
    expectPoints(frameCenterPoints(RECT, true, options('outer', { section })), [[10, 10, 0], [990, 10, 0], [990, 490, 0], [10, 490, 0]]);
    expectPoints(frameCenterPoints(RECT, true, options('outer', { section, quarterTurns: 1 })),
      [[20, 20, 0], [980, 20, 0], [980, 480, 0], [20, 480, 0]]);
  });

  it('同じ向きに続く点(辺の途中の点)は、その辺をずらした線の上に残す', () => {
    const withMiddle: readonly Vec3[] = [[0, 0, 0], [500, 0, 0], [1000, 0, 0], [1000, 500, 0], [0, 500, 0]];
    expectPoints(frameCenterPoints(withMiddle, true, options('outer')),
      [[20, 20, 0], [500, 20, 0], [980, 20, 0], [980, 480, 0], [20, 480, 0]]);
  });

  it('高さの違う形・上の向きが面の高さの軸(XZ 面の形を上 +Y で)', () => {
    const lifted: readonly Vec3[] = [[0, 300, 0], [1000, 300, 0], [1000, 300, 500], [0, 300, 500]];
    expectPoints(frameCenterPoints(lifted, true, options('outer', { up: [0, 1, 0] })),
      [[20, 300, 20], [980, 300, 20], [980, 300, 480], [20, 300, 480]]);
  });

  it('断る: 開いた線・3 点未満・同じ高さに無い点・潰れる小さな形・折り返す点', () => {
    expect(frameCenterPoints(RECT, false, options('outer'))).toEqual({ ok: false, reason: 'notClosed' });
    expect(frameCenterPoints(RECT.slice(0, 2), true, options('inner'))).toEqual({ ok: false, reason: 'notClosed' });
    expect(frameCenterPoints([[0, 0, 0], [1000, 0, 5], [1000, 500, 0], [0, 500, 0]], true, options('outer')))
      .toEqual({ ok: false, reason: 'notLevel' });
    expect(frameCenterPoints([[0, 0, 0], [30, 0, 0], [30, 30, 0], [0, 30, 0]], true, options('outer')))
      .toEqual({ ok: false, reason: 'collapsed' });
    expect(frameCenterPoints([[0, 0, 0], [1000, 0, 0], [500, 0, 0], [500, 500, 0]], true, options('outer')))
      .toEqual({ ok: false, reason: 'reversal' });
  });
});
