import { describe, expect, it } from 'vitest';
import { basisValues, controlPointData, interpolateOpen } from './splineInterpolation.js';

describe('import-free spline arithmetic independent geometry', () => {
  it('uses the quadratic Bernstein weights and interpolates the prescribed middle point', () => {
    expect(basisValues(2, 0.5, 2, [0, 0, 0, 1, 1, 1])).toEqual([0.25, 0.5, 0.25]);
    // Chord parameters are 0, 1/2, 1. B(1/2)=(P0 + 2*P1 + P2)/4 fixes P1=(3,-1,0).
    expect(interpolateOpen([[0, 0, 0], [2, 0, 0], [2, 2, 0]], 2)).toEqual({
      poles: [[0, 0, 0], [3, -1, 0], [2, 2, 0]], knots: [0, 1],
      multiplicities: [3, 3], degree: 2, periodic: false,
    });
  });
  it('preserves the given control polygon and one-period pole ordering', () => {
    const points = [[0, 0, 0], [4, 0, 0], [3, 2, 1], [-1, 1, 0]] as const;
    expect(controlPointData(points, 3, true)).toEqual({ poles: points, knots: [0, 1, 2, 3, 4],
      multiplicities: [1, 1, 1, 1, 1], degree: 3, periodic: true });
    expect(controlPointData(points, 3, false)).toEqual({ poles: points, knots: [0, 1],
      multiplicities: [4, 4], degree: 3, periodic: false });
  });
});
