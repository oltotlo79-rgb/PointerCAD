import { describe, expect, it } from 'vitest';
import { camDimensionFailure, camFollowerLift, camFollowerLiftSlope, type CamFollowerCoupling } from './camFollower.js';

const cam = (overrides: Partial<CamFollowerCoupling> = {}): CamFollowerCoupling => ({
  id: 'cam-1', kind: 'cam', camJointId: 'joint-1', followerJointId: 'joint-2', discRadiusMm: 20, eccentricityMm: 5,
  rollerRadiusMm: 4, phaseDeg: 0, referenceAngleCam: 0, suppressed: false, ...overrides,
});

/**
 * Independent geometric oracle (not the closed form under test): the disc centre sits at e*(cos u, sin u) in the
 * plane normal to the cam axis, the follower line is the x axis through the cam axis, and the roller centre is the
 * intersection of that line with the circle of radius R + r around the disc centre, on the +x side. Solved by
 * bisection on the line, so a sign or square-root error in the closed form cannot be reproduced by the oracle.
 */
function rollerCentreByConstruction(c: CamFollowerCoupling, thetaDeg: number): number {
  const u = (thetaDeg - c.phaseDeg) * Math.PI / 180, cx = c.eccentricityMm * Math.cos(u), cy = c.eccentricityMm * Math.sin(u);
  const reach = c.discRadiusMm + c.rollerRadiusMm, outside = (x: number): boolean => Math.hypot(x - cx, cy) > reach;
  let inside = cx, out = cx + 2 * reach;
  if (outside(inside) || !outside(out)) throw new Error('construction does not bracket the contact');
  for (let i = 0; i < 200; i += 1) { const mid = (inside + out) / 2; if (outside(mid)) out = mid; else inside = mid; }
  return (inside + out) / 2;
}

describe('eccentric disc cam with in-line roller follower: contact kinematics', () => {
  it('matches the independent circle/line construction over a full turn, for roller and knife-edge followers', () => {
    for (const c of [cam(), cam({ rollerRadiusMm: 0 }), cam({ eccentricityMm: 0 }), cam({ phaseDeg: 37 })]) {
      for (let theta = -360; theta <= 360; theta += 7.5) {
        expect(camFollowerLift(c, theta)).toBeCloseTo(rollerCentreByConstruction(c, theta), 9);
      }
    }
  });
  it('has the physical extremes: lift R + r + e at u = 0, R + r - e at u = 180 deg, constant for e = 0', () => {
    const c = cam();
    expect(camFollowerLift(c, 0)).toBeCloseTo(29, 12);
    expect(camFollowerLift(c, 180)).toBeCloseTo(19, 12);
    expect(camFollowerLift(cam({ phaseDeg: 90 }), 90)).toBeCloseTo(29, 12);
    expect(camFollowerLift(cam({ eccentricityMm: 0 }), 123)).toBeCloseTo(24, 12);
  });
  it('slope equals a central finite difference of the lift (per radian)', () => {
    const c = cam({ phaseDeg: 11 }), h = 1e-5;
    for (let theta = -170; theta <= 170; theta += 17) {
      const numeric = (camFollowerLift(c, theta + h) - camFollowerLift(c, theta - h)) / (2 * h * Math.PI / 180);
      expect(camFollowerLiftSlope(c, theta)).toBeCloseTo(numeric, 5);
    }
    expect(camFollowerLiftSlope(c, 11)).toBeCloseTo(0, 12);
  });
  it('refuses dimensions that lose contact or are not physical, and accepts the boundary-safe ones', () => {
    expect(camDimensionFailure(cam())).toBeNull();
    expect(camDimensionFailure(cam({ rollerRadiusMm: 0 }))).toBeNull();
    for (const bad of [{ eccentricityMm: 24 }, { eccentricityMm: 30 }, { discRadiusMm: 0 }, { discRadiusMm: -1 },
      { rollerRadiusMm: -0.1 }, { eccentricityMm: -1 }, { discRadiusMm: Number.NaN }, { eccentricityMm: Number.POSITIVE_INFINITY }]) {
      expect(camDimensionFailure(cam(bad))).toEqual({ ok: false, couplingId: 'cam-1', reason: 'invalidCamDimensions' });
    }
    expect(camDimensionFailure(cam({ phaseDeg: Number.NaN }))?.reason).toBe('invalidPhase');
    expect(camDimensionFailure(cam({ referenceAngleCam: Number.NaN }))?.reason).toBe('invalidReference');
  });
});
