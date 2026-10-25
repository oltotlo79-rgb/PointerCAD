import { describe, expect, it } from 'vitest';
import type { BeamImpactSample } from '@pointercad/fem';
import { IMPACT_LINEARIZATION_WARNING_ROTATION_RAD, impactRotationBeyondLinearization, maximumImpactRotationRad }
  from './beamImpactDraft.js';

/*
 * The linearisation warning of the impact result (task175, successor of task174). 0.1 rad is a chosen warning threshold
 * of the small-displacement method, not a material or strength value: staying below it is never a strength pass.
 * Expectations are written from the rotation vectors given here and the trigonometry of the threshold, not from a solver.
 */
const sample = (step: number, rotations: readonly [number, number, number][]): BeamImpactSample => ({
  step, timeS: step * 1e-5, energyJ: 1,
  nodes: rotations.map((rotationRad, index) => ({ solverNode: index + 1, nodeId: `n${index}`, displacementM: [0, 0, 0],
    rotationRad, velocityMPerS: [0, 0, 0], angularVelocityRadPerS: [0, 0, 0] })),
  contacts: [],
});

describe('the linearisation warning of a beam impact result', () => {
  it('is a chosen threshold at which the linearised rotation is still accurate', () => {
    const threshold = IMPACT_LINEARIZATION_WARNING_ROTATION_RAD;
    expect(threshold).toBe(0.1);
    // sin θ ≈ θ within 0.2 % and cos θ ≈ 1 within 0.5 % at the threshold.
    expect((threshold - Math.sin(threshold)) / threshold).toBeLessThan(0.002);
    expect(1 - Math.cos(threshold)).toBeLessThan(0.005);
  });

  it('takes the largest rotation vector length over every sample and node, whatever its sign', () => {
    expect(maximumImpactRotationRad([])).toBe(0);
    expect(maximumImpactRotationRad([sample(0, [[0, 0, 0]])])).toBe(0);
    // |(0.03, 0.04, 0)| = 0.05 is larger than |(0, 0, -0.02)| = 0.02 and than the first sample.
    expect(maximumImpactRotationRad([sample(0, [[0, 0, 0]]), sample(2, [[0.03, 0.04, 0], [0, 0, -0.02]])]))
      .toBeCloseTo(0.05, 12);
    expect(maximumImpactRotationRad([sample(0, [[0, -0.2, 0]])])).toBeCloseTo(0.2, 15);
  });

  it('is not beyond at or below the threshold, and is beyond above it, for a negative rotation and for NaN or Infinity', () => {
    expect(impactRotationBeyondLinearization(0)).toBe(false);
    expect(impactRotationBeyondLinearization(IMPACT_LINEARIZATION_WARNING_ROTATION_RAD)).toBe(false);
    expect(impactRotationBeyondLinearization(IMPACT_LINEARIZATION_WARNING_ROTATION_RAD * (1 + 1e-9))).toBe(true);
    expect(impactRotationBeyondLinearization(maximumImpactRotationRad([sample(0, [[0, 0, -0.2]])]))).toBe(true);
    expect(maximumImpactRotationRad([sample(0, [[Number.NaN, 0, 0]])])).toBe(Number.POSITIVE_INFINITY);
    expect(maximumImpactRotationRad([sample(0, [[0, Number.POSITIVE_INFINITY, 0]])])).toBe(Number.POSITIVE_INFINITY);
    expect(impactRotationBeyondLinearization(Number.POSITIVE_INFINITY)).toBe(true);
    expect(impactRotationBeyondLinearization(Number.NaN)).toBe(true);
  });
});
