import { describe, expect, it } from 'vitest';
import { ISOMETRIC_DIRECTION, ISOMETRIC_X_DIRECTION, isometricViewDirection } from './isometric.js';

describe('等角図の向き', () => {
  it('視線は(1,1,1)を単位化した値', () => expect(ISOMETRIC_DIRECTION).toEqual([
    0.5773502691896258, 0.5773502691896258, 0.5773502691896258,
  ]));
  it('横軸は(1,-1,0)を単位化した値', () => expect(ISOMETRIC_X_DIRECTION).toEqual([
    0.7071067811865475, -0.7071067811865475, 0,
  ]));
  it('視線と横軸は直交する', () => {
    const { normal, xDir } = isometricViewDirection();
    expect(normal[0] * xDir[0] + normal[1] * xDir[1] + normal[2] * xDir[2]).toBeCloseTo(0, 15);
  });
});
