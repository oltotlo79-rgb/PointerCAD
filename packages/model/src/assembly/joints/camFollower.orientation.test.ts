import { describe, expect, it } from 'vitest';
import { IDENTITY_PLACEMENT, type RigidPlacement } from '../placementMath.js';
import type { MateVariableSet } from '../constraints/mateVariables.js';
import type { Joint } from '../types.js';
import type { JointFrame, JointFramePair } from './jointFrames.js';
import { camFollowerRows, prepareCamFollowers, type CamFollowerCoupling } from './camFollower.js';

// R 20, e 5, r 4, phase 0: the roller centre is 29 mm from the cam axis at theta 0.
const cam = (patch: Partial<CamFollowerCoupling> = {}): CamFollowerCoupling => ({ id: 'cam-1', kind: 'cam',
  camJointId: 'jc', followerJointId: 'jf', discRadiusMm: 20, eccentricityMm: 5, rollerRadiusMm: 4, phaseDeg: 0,
  referenceAngleCam: 0, suppressed: false, ...patch });
const camFrame: JointFrame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const sliderFrame: JointFrame = { origin: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] };
const NO_VARIABLES: MateVariableSet = { variables: [], initial: [], movableComponentIds: [], frozen: new Map(),
  tooMany: false, columnOf: () => null, componentOf: () => null };
const origin = (componentId: string) => ({ kind: 'origin', componentId, element: 'origin' }) as const;

/** Slider between the follower and the support (ground), authored with the follower on side a or b. */
function fixture(options: { side: number; followerOnA: boolean; slider?: JointFrame; sliderSupport?: string }) {
  const support = options.sliderSupport ?? 'ground';
  const [sliderA, sliderB] = options.followerOnA ? ['follower', support] : [support, 'follower'];
  const joints: Joint[] = [
    { id: 'jc', name: 'cam', kind: 'revolute', a: origin('cam'), b: origin('ground'), minValue: null, maxValue: null, suppressed: false },
    { id: 'jf', name: 'follower', kind: 'slider', a: origin(sliderA), b: origin(sliderB), minValue: null, maxValue: null, suppressed: false },
  ];
  const slider = options.slider ?? sliderFrame;
  const frames = new Map<string, JointFramePair>([['jc', { a: camFrame, b: camFrame }], ['jf', { a: slider, b: slider }]]);
  const placements = new Map<string, RigidPlacement>([['ground', IDENTITY_PLACEMENT], ['cam', IDENTITY_PLACEMENT],
    ['other', IDENTITY_PLACEMENT], ['follower', { ...IDENTITY_PLACEMENT, position: [options.side, 0, 0] }]]);
  return { joints, frames, placements };
}
function prepared(f: ReturnType<typeof fixture>, couplings = [cam()], drivenJointIds: ReadonlySet<string> = new Set()) {
  return prepareCamFollowers({ ...f, couplings, drivenJointIds });
}
/** Row value at the fixture placements with the follower moved to a new roller-centre side coordinate. */
function rowAt(f: ReturnType<typeof fixture>, side: number): number {
  const result = prepared(f);
  if (!result.ok) throw new Error(result.reason);
  const placements = new Map(f.placements).set('follower', { ...IDENTITY_PLACEMENT, position: [side, 0, 0] });
  const rows = camFollowerRows({ placements, variableSet: NO_VARIABLES, prepared: result.prepared,
    references: new Map() });
  if (!rows.ok) throw new Error(rows.reason);
  return rows.rows[0].value;
}

describe('cam follower orientation: the row is (distance of the roller centre from the cam axis - rho) / L', () => {
  it.each([
    { side: 29, followerOnA: true, direction: 1 },
    { side: -29, followerOnA: true, direction: -1 },
    { side: 29, followerOnA: false, direction: -1 },
    { side: -29, followerOnA: false, direction: 1 },
  ])('follower at $side on slider side a=$followerOnA', ({ side, followerOnA, direction }) => {
    const f = fixture({ side, followerOnA });
    const result = prepared(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared[0].direction).toBe(direction);
    expect(result.prepared[0].maximumPressureAngleDeg).toBeCloseTo(Math.asin(5 / 24) * 180 / Math.PI, 12);
    const outward = Math.sign(side);
    // In contact at the authored pose; 1 mm away from the cam is +1/L, 1 mm into the cam is -1/L.
    expect(rowAt(f, side)).toBeCloseTo(0, 14);
    expect(rowAt(f, side + outward)).toBeCloseTo(1 / 100, 14);
    expect(rowAt(f, side - outward)).toBeCloseTo(-1 / 100, 14);
  });

  it('an authored pose out of contact is not absorbed as an offset: the row reports the gap', () => {
    const f = fixture({ side: 31, followerOnA: true });
    expect(rowAt(f, 31)).toBeCloseTo(2 / 100, 14);
    expect(rowAt(f, 29)).toBeCloseTo(0, 14);
  });
});

describe('cam follower refusals keep the scene', () => {
  it('refuses a roller centre on the cam axis, a parallel axis and a skew axis as notInLine', () => {
    expect(prepared(fixture({ side: 0, followerOnA: true }))).toMatchObject({ ok: false, reason: 'notInLine' });
    expect(prepared(fixture({ side: 29, followerOnA: true, slider: camFrame })))
      .toMatchObject({ ok: false, reason: 'notInLine' });
    expect(prepared(fixture({ side: 29, followerOnA: true, slider: { ...sliderFrame, origin: [0, 3, 0] } })))
      .toMatchObject({ ok: false, reason: 'notInLine' });
  });

  it('refuses a slider that does not share the cam support', () => {
    expect(prepared(fixture({ side: 29, followerOnA: true, sliderSupport: 'other' })))
      .toMatchObject({ ok: false, reason: 'unsupportedTopology' });
  });

  it('refuses multiple drivers of one follower', () => {
    const f = fixture({ side: 29, followerOnA: true });
    expect(prepared(f, [cam()], new Set(['jf']))).toMatchObject({ ok: false, reason: 'multipleDrivers' });
    expect(prepared(f, [cam(), cam({ id: 'cam-2' })])).toMatchObject({ ok: false, reason: 'multipleDrivers' });
  });

  it('refuses dimensions without contact for every angle and wrong joint kinds', () => {
    const f = fixture({ side: 29, followerOnA: true });
    expect(prepared(f, [cam({ eccentricityMm: 24 })])).toMatchObject({ ok: false, reason: 'invalidCamDimensions' });
    expect(prepared(f, [cam({ discRadiusMm: 0 })])).toMatchObject({ ok: false, reason: 'invalidCamDimensions' });
    expect(prepared(f, [cam({ rollerRadiusMm: -1 })])).toMatchObject({ ok: false, reason: 'invalidCamDimensions' });
    expect(prepared(f, [cam({ camJointId: 'jf', followerJointId: 'jc' })])).toMatchObject({ ok: false, reason: 'unsupportedJoint' });
  });

  it('does not mutate placements or frames', () => {
    const f = fixture({ side: 29, followerOnA: false });
    const before = JSON.stringify([[...f.placements], [...f.frames]]);
    prepared(f);
    expect(JSON.stringify([[...f.placements], [...f.frames]])).toBe(before);
  });
});
