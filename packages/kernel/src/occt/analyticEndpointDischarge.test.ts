import { describe, expect, it } from 'vitest';
import { dischargeEndpointNeighbourhoods } from './analyticEndpointDischarge.js';
import type { TrimChord } from './analyticTrimCorridorsR4.js';

// AUTHOR-ONLY, UNEXECUTED. Hand-derived from the tangent-cone lemma; s = M L^2 / |chord|.
const tick = (): void => undefined;
const budget = { take: (): void => undefined };
const chord = (occurrence: number, from: number, to: number, a: readonly [number, number], b: readonly [number, number], m: number): TrimChord =>
  ({ occurrence, interval: 0, from, to, a, b, secondDerivativeBound: m, parameterLength: 1 });

describe('endpoint-neighbourhood discharge (partial local obligation)', () => {
  it('square corner: s = 0.8/4 = 0.2 each, right angle, s1+s2 = 0.4 < 1 -> node discharged', () => {
    const result = dischargeEndpointNeighbourhoods([chord(0, 0, 1, [0, 0], [4, 0], 0.8), chord(1, 1, 2, [4, 0], [4, 4], 0.8)], tick, budget);
    expect([...result.discharged]).toEqual([1]);
    expect(result).toMatchObject({ partial: true, nativeGapsClosed: false, certificateEmitted: false });
  });

  it('Astra curved counterexample (M=3, L=1, |chord|=sqrt 5): s = 3/sqrt 5 > 1, refused instead of admitted', () => {
    expect(() => dischargeEndpointNeighbourhoods([chord(0, 0, 1, [0, 0], [2, -1], 3), chord(1, 0, 2, [0, 0], [2, 1], 3)], tick, budget))
      .toThrow('tangent cone not resolved');
  });

  it('acute 45 degrees: sin = 1/sqrt 2 ~ 0.707; s = 0.05/2 and 0.05/sqrt 8 -> (pi/2)(s1+s2) ~ 0.067 < 0.707 discharged; M = 0.6 refused', () => {
    const good = [chord(0, 0, 1, [0, 0], [2, 0], 0.05), chord(1, 0, 2, [0, 0], [2, 2], 0.05)];
    expect([...dischargeEndpointNeighbourhoods(good, tick, budget).discharged]).toEqual([0]);
    // s1 = 0.3, s2 = 0.6/sqrt 8 ~ 0.212 -> (pi/2)(0.512) ~ 0.804 > 0.707
    const bad = [chord(0, 0, 1, [0, 0], [2, 0], 0.6), chord(1, 0, 2, [0, 0], [2, 2], 0.6)];
    expect(() => dischargeEndpointNeighbourhoods(bad, tick, budget)).toThrow('acute junction');
  });

  it('obtuse junction with s1 + s2 >= 1 refused; unequal shared coordinates refused', () => {
    // Straight continuation: s = 2/4 = 0.5 each -> sum 1, not < 1.
    expect(() => dischargeEndpointNeighbourhoods([chord(0, 0, 1, [0, 0], [4, 0], 2), chord(1, 0, 2, [0, 0], [-4, 0], 2)], tick, budget))
      .toThrow('obtuse junction');
    expect(() => dischargeEndpointNeighbourhoods([chord(0, 0, 1, [0, 0], [4, 0], 0), chord(1, 0, 2, [3, 0], [4, 4], 0)], tick, budget))
      .toThrow('unequal coordinates');
  });
});
