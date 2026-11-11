import { describe, expect, it } from 'vitest';
import { rotateVector } from '../placementMath.js';
import { rotationBetween } from './alignment.js';

describe('穴の方向を写す最小回転', () => {
  it('鈍角でも143.130度だけ回し、非対称な横向きベクトルを余計にひねらない', () => {
    const q = rotationBetween([0, 0, 1], [0, -0.6, -0.8]);
    const expected = [Math.sqrt(0.9), 0, 0, Math.sqrt(0.1)];
    q.forEach((value, i) => expect(value).toBeCloseTo(expected[i] ?? NaN, 14));
    expect(rotateVector(q, [1, 0, 0])).toEqual([1, 0, 0]);
    rotateVector(q, [0, 0, 1]).forEach((value, i) => expect(value).toBeCloseTo([0, -0.6, -0.8][i] ?? NaN, 14));
  });

  it('同向きとゼロ入力の既存の恒等回転を保つ', () => {
    expect(rotationBetween([0, 0, 1], [0, 0, 1])).toEqual([0, 0, 0, 1]);
    expect(rotationBetween([0, 0, 0], [0, 0, 1])).toEqual([0, 0, 0, 1]);
  });

  it('ちょうど反対なら決定的な半回転、近傍なら元の外積の軸を保つ', () => {
    expect(rotationBetween([0, 0, 1], [0, 0, -1])).toEqual([0, 1, 0, 0]);
    for (const epsilon of [1e-5, 1e-10, 1e-15]) {
      const target = [0, -epsilon, -Math.sqrt(1 - epsilon * epsilon)] as const;
      const q = rotationBetween([0, 0, 1], target);
      expect(q[0]).toBeGreaterThan(0.99);
      expect(q[1]).toBe(0);
      expect(q[2]).toBe(0);
      expect(q[3]).toBeGreaterThan(0);
      rotateVector(q, [0, 0, 1]).forEach((value, i) => expect(value).toBeCloseTo(target[i], 14));
    }
  });
});
