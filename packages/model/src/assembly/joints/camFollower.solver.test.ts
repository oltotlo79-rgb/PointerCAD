import { describe, expect, it } from 'vitest';
import { expressionValueFromNumber } from '@pointercad/expression';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import { diagnoseMates, solveDrivenJoint, solveMates } from '../constraints/solveMates.js';
import { IDENTITY_PLACEMENT, type RigidPlacement } from '../placementMath.js';
import type { AssemblyComponent, AssemblyDocument, Joint, MechanismCamCoupling } from '../types.js';
import { jointValue } from './driveJoint.js';
import type { JointFrame, JointFramePair } from './jointFrames.js';
import { prepareJointResiduals } from './jointResiduals.js';
import { createCamCycleFixture } from './mechanismCycleFixture.js';

const R = 20, E = 5, ROLLER = 4;
const camFrame: JointFrame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const sliderFrame: JointFrame = { origin: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] };
const origin = (componentId: string) => ({ kind: 'origin', componentId, element: 'origin' }) as const;

/**
 * Independent oracle from the construction, not from the closed form: the eccentric disc centre sits at e along the
 * eccentric direction, which the cam joint angle theta turns by -theta in the world (jointValue measures b.x from a.x).
 * The roller centre lies on the follower axis u at distance d with |d u - c| = R + r; d is found by bisection.
 */
function oracleDistance(thetaDeg: number, axis: 1 | -1): number {
  const world = -thetaDeg * Math.PI / 180;
  // Phase 0: at theta 0 the eccentricity points along u toward the follower.
  const centre = [axis * E * Math.cos(world), E * Math.sin(world)] as const;
  const miss = (d: number): number => Math.hypot(axis * d - centre[0], centre[1]) - (R + ROLLER);
  let low = axis * centre[0], high = low + R + ROLLER + 1;
  for (let i = 0; i < 200; i += 1) { const mid = (low + high) / 2; if (miss(mid) > 0) high = mid; else low = mid; }
  return (low + high) / 2;
}

function fixture(options: { axis: 1 | -1; followerOnA: boolean; gapMm?: number; coupling?: Partial<MechanismCamCoupling> }) {
  const components: AssemblyComponent[] = ['ground', 'cam', 'follower'].map(id => ({ id, name: id,
    source: { kind: 'part', partRef: 'part' }, placement: DEFAULT_COMPONENT_PLACEMENT,
    fixed: id === 'ground', visible: true, suppressed: false }));
  const [sliderA, sliderB] = options.followerOnA ? ['follower', 'ground'] : ['ground', 'follower'];
  const joints: Joint[] = [
    { id: 'jc', name: 'cam', kind: 'revolute', a: origin('cam'), b: origin('ground'), minValue: null, maxValue: null, suppressed: false },
    { id: 'jf', name: 'follower', kind: 'slider', a: origin(sliderA), b: origin(sliderB), minValue: null, maxValue: null, suppressed: false },
  ];
  const cam: MechanismCamCoupling = { id: 'cam-1', kind: 'cam', camJointId: 'jc', followerJointId: 'jf',
    discRadiusMm: expressionValueFromNumber(R), eccentricityMm: expressionValueFromNumber(E),
    rollerRadiusMm: expressionValueFromNumber(ROLLER), phaseDeg: expressionValueFromNumber(0),
    referenceAngleCam: 0, suppressed: false, ...options.coupling };
  const assembly: AssemblyDocument = { ...createAssemblyDocument('cam'), components, joints, camCouplings: [cam] };
  const frames = new Map<string, JointFramePair>([['jc', { a: camFrame, b: camFrame }], ['jf', { a: sliderFrame, b: sliderFrame }]]);
  const placements = new Map<string, RigidPlacement>([['ground', IDENTITY_PLACEMENT], ['cam', IDENTITY_PLACEMENT],
    ['follower', { ...IDENTITY_PLACEMENT, position: [options.axis * (R + ROLLER + E + (options.gapMm ?? 0)), 0, 0] }]]);
  return { assembly, joints, frames, placements };
}
function camAngle(f: ReturnType<typeof fixture>, placements: ReadonlyMap<string, RigidPlacement>, reference: number): number {
  const joint = prepareJointResiduals({ ...f, placements }).joints.find(j => j.jointId === 'jc');
  if (joint === undefined) throw new Error('Fixture cam joint absent');
  const value = jointValue({ joint, coordinate: 'angle', referenceAngle: reference, placements,
    variableSet: { variables: [], initial: [], movableComponentIds: [], frozen: new Map(), tooMany: false,
      columnOf: () => null, componentOf: () => null } });
  if (!value.ok) throw new Error(value.reason);
  return value.value;
}

describe('cam follower through the public drive solver against an independent construction', () => {
  it.each([
    { axis: 1, followerOnA: true }, { axis: -1, followerOnA: true },
    { axis: 1, followerOnA: false }, { axis: -1, followerOnA: false },
  ] as const)('a full turn in 30 degree drives keeps the roller on the cam (axis $axis, follower on a=$followerOnA)', ({ axis, followerOnA }) => {
    const f = fixture({ axis, followerOnA }), before = structuredClone(f.assembly);
    let placements: ReadonlyMap<string, RigidPlacement> = f.placements, reference = 0;
    for (let target = 30; target <= 360; target += 30) {
      const result = solveDrivenJoint(f.assembly, new Map(), placements,
        { jointId: 'jc', coordinate: 'angle', value: target, referenceAngle: reference }, { jointFrames: f.frames });
      expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.reason);
      expect(result.actual).toBeCloseTo(target, 6);
      expect(diagnoseMates(f.assembly, result.outcome).couplingFailure).toBeUndefined();
      const follower = result.placements.get('follower');
      if (follower === undefined) throw new Error('Follower placement absent');
      // The follower moves only along its axis and its roller centre matches the construction.
      expect(axis * follower.position[0]).toBeCloseTo(oracleDistance(target, axis), 6);
      expect(follower.position[1]).toBeCloseTo(0, 9);
      expect(follower.position[2]).toBeCloseTo(0, 9);
      placements = result.placements; reference = result.actual;
    }
    // Extremes of the eccentric disc: R + r + e at 0/360 and R + r - e at 180 are reached by the construction too.
    expect(oracleDistance(0, axis)).toBeCloseTo(R + ROLLER + E, 12);
    expect(oracleDistance(180, axis)).toBeCloseTo(R + ROLLER - E, 12);
    expect(f.assembly).toEqual(before);
  });

  it('ordinary solving pulls an authored gap into contact instead of absorbing it', () => {
    const f = fixture({ axis: 1, followerOnA: true, gapMm: 2 });
    const result = solveMates(f.assembly, new Map(), f.placements, { jointFrames: f.frames });
    expect(result.converged).toBe(true);
    const follower = result.placements.get('follower');
    if (follower === undefined) throw new Error('Follower placement absent');
    expect(follower.position[0]).toBeCloseTo(oracleDistance(camAngle(f, result.placements, 0), 1), 6);
  });
});

describe('cam follower refusals through the public solver keep the scene', () => {
  it('refuses driving the follower slider while the cam drives it (multiple drivers)', () => {
    const f = fixture({ axis: 1, followerOnA: true }), before = structuredClone(f.placements);
    const result = solveDrivenJoint(f.assembly, new Map(), f.placements,
      { jointId: 'jf', coordinate: 'translation', value: 40 }, { jointFrames: f.frames });
    expect(result.ok).toBe(false);
    expect(result.outcome?.couplingFailure).toMatchObject({ reason: 'multipleDrivers' });
    expect(result.placements).toEqual(before);
  });

  it.each([
    [{ eccentricityMm: expressionValueFromNumber(R + ROLLER) }, 'invalidCamDimensions'],
    [{ discRadiusMm: expressionValueFromNumber(-1) }, 'invalidCamDimensions'],
    [{ followerJointId: 'jc' }, 'duplicateReference'],
  ] as const)('refuses %o as %s without moving anything', (patch, reason) => {
    const f = fixture({ axis: 1, followerOnA: true, coupling: patch }), before = structuredClone(f.placements);
    const result = solveMates(f.assembly, new Map(), f.placements, { jointFrames: f.frames });
    expect(result.converged).toBe(false);
    expect(result.couplingFailure).toMatchObject({ reason });
    expect(result.placements).toEqual(before);
    expect(diagnoseMates(f.assembly, result).complete).toBe(false);
  });
});

describe('W07 invalid cam inputs preserve the authored document and shown poses', () => {
  it.each(['missing-joint', 'eccentricity-at-reach'] as const)('rejects %s with an explicit admission reason', problem => {
    // r=0 is a knife-edge follower: e=R makes the circle/line construction singular at 90 degrees.
    const f = createCamCycleFixture({ radiusMm: 13, eccentricityMm: problem === 'eccentricity-at-reach' ? 13 : 3,
      rollerRadiusMm: 0, phaseDeg: 37 }, { side: 1, camOnA: true, followerOnA: true });
    const assembly = problem === 'missing-joint' ? { ...f.assembly,
      camCouplings: f.assembly.camCouplings?.map(c => ({ ...c, followerJointId: 'absent-follower-joint' })) } : f.assembly;
    const before = structuredClone({ assembly, frames: f.frames, placements: f.placements });
    const expectedReason = problem === 'missing-joint' ? 'missingJoint' : 'invalidCamDimensions';
    const result = solveDrivenJoint(assembly, new Map(), f.placements,
      { jointId: 'jc', coordinate: 'angle', value: 45, referenceAngle: 0 }, { jointFrames: f.frames });
    expect(result.ok).toBe(false);
    expect(result.outcome?.converged).toBe(false);
    expect(result.outcome?.couplingFailure).toMatchObject({ couplingId: 'cam-cycle', reason: expectedReason });
    expect(result.outcome?.iterations).toBe(0);
    expect(result.placements).toEqual(before.placements);
    expect({ assembly, frames: f.frames, placements: f.placements }).toEqual(before);
  });
});
