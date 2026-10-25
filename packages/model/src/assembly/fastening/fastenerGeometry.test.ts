import { describe, expect, it } from 'vitest';

import { rotateVector } from '../placementMath.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { perpendicularAxis, rotationBetween } from './alignment.js';
import { rotationFromZ } from './fastenerPlacements.js';

/*
 * 期待値は回したい向き d そのもの(+Z を回した先は d、長さ L の先端は L·d)。回転は既存の
 * rotateVector で掛け、計画の補助関数で期待値を作らない。許容は 1e-12(長さ 1)・1e-9(150mm)。
 */

const SMALL = 1e-5;
const NEAR = Math.sqrt(1 - SMALL * SMALL);

function expectVector(actual: Vec3, expected: Vec3, digits: number): void {
  actual.forEach((value, index) => {
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeCloseTo(expected[index] ?? NaN, digits);
  });
}

describe('部品の +Z を穴の軸へ向ける回転', () => {
  const directions: readonly (readonly [string, Vec3])[] = [
    ['+Z に近い小さな傾き', [SMALL, 0, NEAR]],
    ['−Z に近い小さな傾き', [SMALL, 0, -NEAR]],
    ['ちょうど +Z', [0, 0, 1]],
    ['ちょうど −Z', [0, 0, -1]],
    ['一般の向き', [1 / Math.sqrt(14), 2 / Math.sqrt(14), 3 / Math.sqrt(14)]],
    ['水平', [0, -1, 0]],
  ];

  it.each(directions)('%s へ +Z を写し、150mm の先端もずれない', (_name, direction) => {
    const rotation = rotationFromZ(direction);
    expect(Math.hypot(...rotation)).toBeCloseTo(1, 14);
    expectVector(rotateVector(rotation, [0, 0, 1]), direction, 12);
    // 長いボルト(150mm)の先端。傾き 1e-5 を丸めると先端は 1.5e-3mm ずれ、1e-9 を超える。
    expectVector(rotateVector(rotation, [0, 0, 150]), [150 * direction[0], 150 * direction[1], 150 * direction[2]], 9);
  });

  it('小さな傾きを +Z へ丸めない', () => {
    const tip = rotateVector(rotationFromZ([SMALL, 0, NEAR]), [0, 0, 100]);
    expect(tip[0]).toBeCloseTo(100 * SMALL, 12);
  });
});

describe('向きどうしを写す最小の回転', () => {
  const pairs: readonly (readonly [string, Vec3, Vec3])[] = [
    ['同じ向き', [0, 0, 1], [0, 0, 1]],
    ['直角', [1, 0, 0], [0, 1, 0]],
    ['ほぼ逆向き', [0, 0, 1], [SMALL, 0, -NEAR]],
    ['ちょうど逆向き', [0, 1, 0], [0, -1, 0]],
    ['一般', [0, 0, 1], [2 / 3, -1 / 3, 2 / 3]],
  ];

  it.each(pairs)('%s', (_name, from, to) => {
    expectVector(rotateVector(rotationBetween(from, to), from), to, 12);
  });

  it('垂直な軸は長さ 1 で元の向きと直交する', () => {
    for (const u of [[0, 0, 1], [1, 0, 0], [0.6, 0.8, 0]] as const) {
      const axis = perpendicularAxis(u);
      expect(Math.hypot(...axis)).toBeCloseTo(1, 14);
      expect(axis[0] * u[0] + axis[1] * u[1] + axis[2] * u[2]).toBeCloseTo(0, 14);
    }
  });
});
