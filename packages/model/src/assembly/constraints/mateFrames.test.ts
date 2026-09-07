import { describe, expect, it } from 'vitest';

import { dotVec3, lengthVec3, type Vec3 } from '../../sketch/vec3.js';
import { quaternionFromAxisAngle, rotateVector } from '../placementMath.js';
import { createMateFrame, mateAlignmentSign, rotateMateFrame } from './mateFrames.js';

describe('局所座標で固定する合致の基底', () => {
  const diagonal = 1 / Math.sqrt(3);
  const directions: readonly Vec3[] = [[0, 0, 1], [diagonal, diagonal, diagonal]];
  for (const n of directions) {
    it(`${n.join(',')}: 長さ1・直交`, () => {
      const frame = createMateFrame(n);
      if (frame === null) throw new Error('基底が必要');
      expect(lengthVec3(frame.t)).toBeCloseTo(1, 15);
      expect(lengthVec3(frame.s)).toBeCloseTo(1, 15);
      expect(dotVec3(n, frame.t)).toBeCloseTo(0, 15);
      expect(dotVec3(n, frame.s)).toBeCloseTo(0, 15);
      expect(dotVec3(frame.t, frame.s)).toBeCloseTo(0, 15);
    });
    it(`${n.join(',')}: 回転後も法線と直交`, () => {
      const frame = createMateFrame(n);
      if (frame === null) throw new Error('基底が必要');
      const q = quaternionFromAxisAngle([2, -3, 1], 1.2);
      const rotated = rotateMateFrame(frame, q);
      const normal = rotateVector(q, n);
      expect(lengthVec3(rotated.t)).toBeCloseTo(1, 15);
      expect(lengthVec3(rotated.s)).toBeCloseTo(1, 15);
      expect(dotVec3(normal, rotated.t)).toBeCloseTo(0, 15);
      expect(dotVec3(normal, rotated.s)).toBeCloseTo(0, 15);
      expect(dotVec3(rotated.t, rotated.s)).toBeCloseTo(0, 15);
    });
  }
  it('Z法線はX/Yの基底を持つ', () => {
    expect(createMateFrame([0, 0, 1])).toEqual({ t: [0, 1, 0], s: [1, 0, 0] });
  });
  it.each([[0, 0, 0], [NaN, 0, 1], [Infinity, 1, 0]])('退化した法線(%s,%s,%s)を断る', (x, y, z) => {
    expect(createMateFrame([x, y, z])).toBeNull();
  });
  it('初期の逆向きと明示の反転を追跡する', () => {
    expect(mateAlignmentSign([0, 0, -1], [0, 0, 1], false)).toBe(-1);
    expect(mateAlignmentSign([0, 0, -1], [0, 0, 1], true)).toBe(1);
  });
});
