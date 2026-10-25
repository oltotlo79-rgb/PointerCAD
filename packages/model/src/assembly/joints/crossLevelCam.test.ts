import { stdout } from 'node:process';
import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { appendSolid, createEmptyPartDocument } from '../../part/createPartDocument.js';
import type { PrimitiveFeature } from '../../part/types.js';
import { absoluteCoordinate } from '../../sketch/createSketchDocument.js';
import { runCooperative } from '../constraints/cooperativeRigid.js';
import { drainRigidSteps } from '../constraints/solveRigid.js';
import type { MateResidualTargetPair } from '../constraints/mateResiduals.js';
import { resolveMateTarget } from '../constraints/mateTargets.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import type { JointOccurrenceInputs, JointOccurrenceView } from '../jointOccurrence.js';
import { embedPart, EMPTY_PART_LIBRARY } from '../partLibrary.js';
import type { Quaternion, RigidPlacement } from '../placementMath.js';
import { resolveAssembly } from '../resolveAssembly.js';
import type { AssemblyComponent, AssemblyDocument, ComponentSource, Joint, Placement } from '../types.js';
import { crossLevelCamFailure, crossLevelCamTranslation, solveCrossLevelCamDrive, solveCrossLevelCamDriveSteps,
  type CrossLevelCamCoupling } from './crossLevelCam.js';
import type { CrossLevelGearCoupling } from './crossLevelGear.js';
import { solveCrossLevelGearDriveSteps } from './crossLevelGear.js';
import { jointFramePairFromTargets } from './jointFrames.js';
import { oracleAngle, oracleDistance, oraclePoint, oraclePoseError, oracleRollerDistance,
  requireCyclePlacement } from './mechanismCycleFixture.js';
import { crossLevelCamFailureSteps } from './crossLevelCam.js';
import { solveCrossLevelCamFollow, solveCrossLevelCamFollowSteps } from './crossLevelCamLifecycle.js';
import { expectBoundedDrivePreparation, expectDriveCancellation, expectDrivePlacements,
  observeDriveItems } from './jointDriveSteps.testSupport.js';

/*
 * Cross-level cam, with hand-computed numbers: R = 20, e = 5, r = 4, phase 0, so rho(0) = 5 + 24 = 29,
 * rho(90) = sqrt(24^2 - 5^2) = sqrt(551) = 23.473389..., rho(180) = -5 + 24 = 19. direction +1 and offset -10 give the
 * follower translations 19, 13.473389... and 9. The parent: fixed `ground` at (10, 20, 0), `A` (the child) at the same
 * point on the revolute `cam` (A = a, ground = b, starts at 0), and a part `rod` on the slider `lift` (a non-revolute
 * parent joint). The child: fixed `base`, `follower` on the slider `push` along the origin z axes (follower = a, at
 * most 25), so its z position in the child equals the slider translation, and a part `knob` on the revolute `twist`.
 */
function placement(x: number, y: number, z: number): Placement {
  return { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)], rotation: [0, 0, 0, 1] };
}
function component(id: string, source: ComponentSource, at: Placement, fixed = false): AssemblyComponent {
  return { id, name: id, source, placement: at, fixed, visible: true, suppressed: false };
}
function joint(id: string, kind: Joint['kind'], a: string, b: string): Joint {
  return { id, name: id, kind, a: { kind: 'origin', componentId: a, element: 'z' }, b: { kind: 'origin', componentId: b, element: 'z' },
    minValue: null, maxValue: kind === 'slider' ? { ...expressionValueFromNumber(25), source: '25' } : null, suppressed: false };
}

async function fixture() {
  const size = expressionValueFromNumber(4);
  const box: PrimitiveFeature = { id: 'solid-1', name: 'box', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'box', sizeX: size, sizeY: size, sizeZ: size } };
  const embedded = await embedPart(EMPTY_PART_LIBRARY, appendSolid(createEmptyPartDocument(), box), 'plate.pcad', 'plate.pcad',
    { importedAt: '2026-01-01T00:00:00.000Z' });
  const part = { kind: 'part', partRef: embedded.partRef } as const;
  const child: AssemblyDocument = { ...createAssemblyDocument('cam child'),
    components: [component('base', part, placement(0, 0, 0), true), component('follower', part, placement(0, 0, 0)),
      component('knob', part, placement(0, 0, 0))],
    joints: [joint('push', 'slider', 'follower', 'base'), joint('twist', 'revolute', 'knob', 'base')] };
  const subAssemblies = new Map([['child', child]]);
  const library = { ...embedded.library, assemblies: subAssemblies };
  const document: AssemblyDocument = { ...createAssemblyDocument('parent'), components: [
    component('ground', part, placement(10, 20, 0), true),
    component('A', { kind: 'subAssembly', assemblyRef: 'child' }, placement(10, 20, 0)),
    component('rod', part, placement(10, 20, 0)),
  ], joints: [joint('cam', 'revolute', 'A', 'ground'), joint('lift', 'slider', 'rod', 'ground')] };
  const inputs: JointOccurrenceInputs = { document, library, subAssemblies };
  const view: JointOccurrenceView = { source: inputs, resolved: resolveAssembly(document, { library, subAssemblies }) };
  const frames = new Map(document.joints.flatMap(item => {
    const a = resolveMateTarget(item.a, view.resolved), b = resolveMateTarget(item.b, view.resolved);
    const pair = a.ok && b.ok ? jointFramePairFromTargets(item, { a: a.target, b: b.target }, view.resolved.placements) : null;
    return pair === null ? [] : [[item.id, pair] as const];
  }));
  return { inputs, view, parent: { targets: new Map<string, MateResidualTargetPair>(), initial: view.resolved.placements,
    options: { jointFrames: frames } } };
}

const CAM: CrossLevelCamCoupling = { id: 'k1', camJointId: 'cam', child: { path: ['A'], jointId: 'push' },
  discRadiusMm: 20, eccentricityMm: 5, rollerRadiusMm: 4, phaseDeg: 0, direction: 1, offsetMm: -10 };

function zDegrees(rotation: Quaternion | undefined): number {
  const [x, y, z, w] = rotation ?? [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
  expect(Math.abs(x) + Math.abs(y)).toBeLessThan(1e-9);
  return 2 * Math.atan2(z, w) * 180 / Math.PI;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const drive = (f: Fixture, side: 'cam' | 'follower', value: number, cams: readonly CrossLevelCamCoupling[] = [CAM]) =>
  solveCrossLevelCamDrive({ inputs: f.inputs, view: f.view, cams, couplingId: 'k1', drive: { side, value }, parent: f.parent });

describe('cross-level cam: parent revolute cam, child slider follower', () => {
  it('matches every pose across a full turn with phase and reversed follower at several work budgets', async () => {
    const f = await fixture();
    const cam = { ...CAM, phaseDeg: 25, direction: -1 as const };
    const before = structuredClone(f);
    for (const value of [0, 90, 180, 360]) {
      const input = { ...f, cams: [cam], couplingId: cam.id, drive: { side: 'cam' as const, value } };
      const expected = solveCrossLevelCamDrive(input);
      if (!expected.ok) throw new Error(`refused ${expected.code}`);
      for (const units of [1, 13, 512]) {
        const actual = drainRigidSteps(solveCrossLevelCamDriveSteps(input, { units }));
        if (!actual.ok) throw new Error(`refused ${actual.code}`);
        expectDrivePlacements(actual.parent.placements, expected.parent.placements);
        expectDrivePlacements(actual.child.placements, expected.child.placements);
        expect(actual).toEqual(expected);
      }
      expect(solveCrossLevelCamDriveSteps(input, { units: Number.POSITIVE_INFINITY }).next())
        .toEqual({ done: true, value: expected });
    }
    expect(f).toEqual(before);
  });

  it('bounds cam admission scans and keeps the original refusal after a valid relation', async () => {
    const f = await fixture();
    const joints = observeDriveItems([...Array.from({ length: 96 }, (_, index) =>
      ({ ...joint(`inactive-${String(index)}`, 'revolute', 'A', 'ground'), suppressed: true })), ...f.inputs.document.joints]);
    const document = { ...f.inputs.document, joints: joints.items };
    const inputs = { ...f.inputs, document }, view = { ...f.view, source: inputs };
    const cams = [CAM, { ...CAM, id: 'broken', discRadiusMm: 0 }];
    const expected = { ok: false, couplingId: 'broken', code: 'invalid-cam-dimensions' };
    expect(expectBoundedDrivePreparation(crossLevelCamFailureSteps(inputs, view, cams, [], { units: 3 }), joints, 3)).toEqual(expected);
    expect(drainRigidSteps(crossLevelCamFailureSteps(inputs, view, cams, [], { units: 512 })))
      .toEqual(crossLevelCamFailure(inputs, view, cams));
  });

  it('cancels the cam follower before, during and after solving without publishing or changing shared documents', async () => {
    const f = await fixture();
    const before = structuredClone(f);
    const input = { ...f, cams: [CAM], couplingId: CAM.id, camAngle: 90 };
    const expected = solveCrossLevelCamFollow(input);
    if (!expected.ok) throw new Error(`refused ${expected.code}`);
    const actual = drainRigidSteps(solveCrossLevelCamFollowSteps(input, { units: 13 }));
    if (!actual.ok) throw new Error(`refused ${actual.code}`);
    expectDrivePlacements(actual.outcome.placements, expected.outcome.placements);
    expect(actual).toEqual(expected);
    await expectDriveCancellation(() => solveCrossLevelCamFollowSteps(input, { units: 1 }), () => { expect(f).toEqual(before); });
    const blocked = { ...input, cams: [{ ...CAM, offsetMm: 10 }], camAngle: 0 };
    expect(drainRigidSteps(solveCrossLevelCamFollowSteps(blocked, { units: 13 })))
      .toEqual({ ok: false, couplingId: CAM.id, code: 'child-at-limit' });
    expect(f).toEqual(before);
  });

  it('matches every parent/child placement and cancels at every boundary and numerical checkpoint', async () => {
    const f = await fixture();
    const before = structuredClone(f);
    const input = { ...f, cams: [CAM], couplingId: 'k1', drive: { side: 'cam' as const, value: 90 } };
    const expected = solveCrossLevelCamDrive(input);
    expect(expected.ok).toBe(true);
    expect(drainRigidSteps(solveCrossLevelCamDriveSteps(input, { units: 1 }))).toEqual(expected);
    const budget = { units: 1 };
    const trace = solveCrossLevelCamDriveSteps(input, budget);
    let points = 0, previous = 0;
    for (;;) {
      const next = trace.next();
      if (next.done === true) { expect(next.value).toEqual(expected); break; }
      expect(next.value.done).toBeGreaterThanOrEqual(previous);
      expect(Number.isFinite(next.value.done)).toBe(true);
      previous = next.value.done;
      points += 1;
      expect(points).toBeLessThan(10000);
    }
    expect(points).toBeGreaterThan(4);
    for (let stop = 0; stop <= points; stop += 1) {
      const queue: (() => void)[] = [];
      const run = runCooperative(solveCrossLevelCamDriveSteps(input, budget),
        { pointsPerSlice: 1, schedule: slice => { queue.push(slice); } });
      let published = 0;
      const result = run.result.then(value => { if (value.status === 'completed') published += 1; return value; });
      for (let point = 0; point < stop; point += 1) queue.shift()?.();
      run.cancel();
      while (queue.length > 0) queue.shift()?.();
      expect(await result).toEqual({ status: 'cancelled', progress: run.progress() });
      expect(published).toBe(0);
      expect(f).toEqual(before);
    }
    const blocked = { ...input, cams: [{ ...CAM, offsetMm: 10 }], drive: { side: 'cam' as const, value: 0 } };
    expect(drainRigidSteps(solveCrossLevelCamDriveSteps(blocked, budget)))
      .toEqual({ ok: false, couplingId: 'k1', code: 'child-at-limit' });
  });

  it('follows the hand-computed law at 0, 90 and 180 degrees', async () => {
    expect([0, 90, 180].map(theta => crossLevelCamTranslation(CAM, theta)))
      .toEqual([expect.closeTo(19, 9), expect.closeTo(Math.sqrt(551) - 10, 9), expect.closeTo(9, 9)]);
    const f = await fixture();
    for (const [theta, x] of [[90, Math.sqrt(551) - 10], [180, 9], [0, 19]] as const) {
      const outcome = drive(f, 'cam', theta);
      if (!outcome.ok) throw new Error(`refused ${outcome.code}`);
      expect(Math.abs(zDegrees(outcome.parent.placements.get('A')?.rotation))).toBeCloseTo(theta, 6);
      // The follower's position in the (unturned, resolved) child frame: (10, 20, x).
      const at = outcome.child.placements.get('follower')?.position ?? [];
      [10, 20, x].forEach((value, axis) => expect(at[axis]).toBeCloseTo(value, 6));
      expect(outcome.followerTranslation).toBeCloseTo(x, 6);
    }
  });

  it('refuses a follower-side drive and a follower beyond its range, changing nothing', async () => {
    const f = await fixture();
    expect(drive(f, 'follower', 15)).toEqual({ ok: false, couplingId: 'k1', code: 'unsupported-follower-drive' });
    // offset +10 asks for 39 at 0 degrees, beyond the slider's maximum 25.
    expect(drive(f, 'cam', 0, [{ ...CAM, offsetMm: 10 }])).toEqual({ ok: false, couplingId: 'k1', code: 'child-at-limit' });
  });

  it('refuses invalid dimensions, joints and graphs explicitly', async () => {
    const f = await fixture();
    const code = (cams: readonly CrossLevelCamCoupling[], gears: readonly CrossLevelGearCoupling[] = []) =>
      crossLevelCamFailure(f.inputs, f.view, cams, gears)?.code;
    expect(code([CAM])).toBeUndefined();
    expect(code([{ ...CAM, eccentricityMm: 24 }])).toBe('invalid-cam-dimensions');
    expect(code([{ ...CAM, discRadiusMm: 0 }])).toBe('invalid-cam-dimensions');
    expect(code([{ ...CAM, phaseDeg: Number.NaN }])).toBe('invalid-phase');
    expect(code([{ ...CAM, offsetMm: Number.POSITIVE_INFINITY }])).toBe('invalid-offset');
    expect(code([{ ...CAM, camJointId: 'lift' }])).toBe('unsupported-parent-joint');
    expect(code([{ ...CAM, child: { path: ['A'], jointId: 'twist' } }])).toBe('unsupported-child-joint');
    expect(code([{ ...CAM, child: { path: ['ground'], jointId: 'push' } }])).toBe('not-subassembly');
    expect(code([CAM, { ...CAM, id: 'k2' }])).toBe('coupled-parent-joint');
    expect(code([CAM], [{ id: 'g1', parentJointId: 'cam', child: { path: ['A'], jointId: 'twist' }, ratio: 1, phaseDeg: 0 }]))
      .toBe('coupled-parent-joint');
  });
});

describe('cross-level cam initial angular branch and continuity', () => {
  it('drives from a nonzero shown orientation with no previous reference', async () => {
    const f = await fixture();
    const initial = new Map(f.parent.initial);
    const shown = initial.get('A');
    if (shown === undefined) throw new Error('missing parent placement');
    initial.set('A', { ...shown, rotation: [0, 0, -Math.sin(Math.PI / 12), Math.cos(Math.PI / 12)] });
    const outcome = solveCrossLevelCamDrive({ inputs: f.inputs, view: f.view, cams: [CAM], couplingId: 'k1',
      drive: { side: 'cam', value: 90 }, parent: { ...f.parent, initial } });
    if (!outcome.ok) throw new Error(`refused ${outcome.code}`);
    expect(outcome.camAngle).toBeCloseTo(90, 6);
    expect(zDegrees(outcome.parent.placements.get('A')?.rotation)).toBeCloseTo(-90, 6);
    expect(outcome.followerTranslation).toBeCloseTo(Math.sqrt(551) - 10, 6);
    expect(outcome.child.placements.get('follower')?.position[2]).toBeCloseTo(Math.sqrt(551) - 10, 6);
    expect(zDegrees(initial.get('A')?.rotation)).toBeCloseTo(-30, 9);
  });

  it('keeps the supplied multi-turn cam branch while applying the analytic periodic follower law', async () => {
    const f = await fixture();
    const initial = new Map(f.parent.initial);
    const shown = initial.get('A');
    if (shown === undefined) throw new Error('missing parent placement');
    initial.set('A', { ...shown, rotation: [0, 0, -Math.sin(Math.PI / 12), Math.cos(Math.PI / 12)] });
    const outcome = solveCrossLevelCamDrive({ inputs: f.inputs, view: f.view, cams: [CAM], couplingId: 'k1',
      drive: { side: 'cam', value: 400 }, parent: { ...f.parent, initial, referenceAngle: 390 } });
    if (!outcome.ok) throw new Error(`refused ${outcome.code}`);
    const angle = 40 * Math.PI / 180;
    const expected = 5 * Math.cos(angle) + Math.sqrt(24 * 24 - 25 * Math.sin(angle) ** 2) - 10;
    expect(outcome.camAngle).toBeCloseTo(400, 6);
    expect(zDegrees(outcome.parent.placements.get('A')?.rotation)).toBeCloseTo(-40, 6);
    expect(outcome.followerTranslation).toBeCloseTo(expected, 6);
    expect(outcome.child.placements.get('follower')?.position[2]).toBeCloseTo(expected, 6);
  });

  it('refuses an explicit NaN cam reference without substituting the principal branch', async () => {
    const f = await fixture();
    expect(solveCrossLevelCamDrive({ inputs: f.inputs, view: f.view, cams: [CAM], couplingId: 'k1',
      drive: { side: 'cam', value: 90 }, parent: { ...f.parent, referenceAngle: Number.NaN } }))
      .toEqual({ ok: false, couplingId: 'k1', code: 'parent-solve-failed' });
  });
});

describe('W07 cross-level forward cycles measured from world basis vectors', () => {
  it('solves a negative-ratio gear with nonzero phase through Steps for a full turn', async () => {
    const f = await fixture(), before = structuredClone(f);
    const coupling: CrossLevelGearCoupling = { id: 'oracle-gear', parentJointId: 'cam',
      child: { path: ['A'], jointId: 'twist' }, ratio: -1, phaseDeg: 23 };
    let parent = f.parent;
    let child: Parameters<typeof solveCrossLevelGearDriveSteps>[0]['child'];
    let parentReference = 0;
    let start: { parent: ReadonlyMap<string, RigidPlacement>; child: ReadonlyMap<string, RigidPlacement> } | undefined;
    const maximum = { parentDeg: 0, childDeg: 0, relationDeg: 0, originMm: 0, probeMm: 0,
      closurePositionMm: 0, closureOrientationDeg: 0 };
    let samples = 0;
    for (let theta = 0; theta <= 360; theta += 5) {
      const result = drainRigidSteps(solveCrossLevelGearDriveSteps({ inputs: f.inputs, view: f.view, parent: {
        ...parent, referenceAngle: parentReference }, child, couplings: [coupling], couplingId: coupling.id,
      drive: { side: 'parent', value: theta } }, { units: 16 }));
      expect(result.ok, `cross-level gear at ${theta} degrees`).toBe(true);
      if (!result.ok) throw new Error(result.code);
      const expectedChild = -theta + 23;
      const support = requireCyclePlacement(result.parent.placements, 'ground');
      const carrier = requireCyclePlacement(result.parent.placements, 'A');
      const base = requireCyclePlacement(result.child.placements, 'base');
      const knob = requireCyclePlacement(result.child.placements, 'knob');
      const parentAngle = oracleAngle(support, carrier, theta), childAngle = oracleAngle(base, knob, expectedChild);
      maximum.parentDeg = Math.max(maximum.parentDeg, Math.abs(parentAngle - theta));
      maximum.childDeg = Math.max(maximum.childDeg, Math.abs(childAngle - expectedChild));
      maximum.relationDeg = Math.max(maximum.relationDeg, Math.abs(childAngle + parentAngle - 23));
      // The API returns the child solve in the resolved occurrence's world frame, before carrier motion is applied.
      // Check an off-axis point as well as the origins, so a stationary but correctly reported angle cannot pass.
      for (const [pose, angle] of [[carrier, theta], [knob, expectedChild]] as const) {
        const psi = -angle * Math.PI / 180;
        maximum.originMm = Math.max(maximum.originMm, oracleDistance(pose.position, [10, 20, 0]));
        maximum.probeMm = Math.max(maximum.probeMm, oracleDistance(oraclePoint(pose, [3, 4, 2]),
          [10 + 3 * Math.cos(psi) - 4 * Math.sin(psi), 20 + 3 * Math.sin(psi) + 4 * Math.cos(psi), 2]));
      }
      for (const error of Object.values(maximum)) expect(error).toBeLessThanOrEqual(1e-6);
      start ??= { parent: result.parent.placements, child: result.child.placements };
      parent = { ...f.parent, initial: result.parent.placements };
      child = { initial: result.child.placements, referenceAngle: expectedChild };
      parentReference = theta;
      samples += 1;
    }
    expect(samples).toBe(73);
    if (start?.parent === undefined || start.child === undefined || child?.initial === undefined) throw new Error('Missing cycle endpoint');
    for (const [first, last] of [[start.parent, parent.initial], [start.child, child.initial]] as const) {
      for (const [id, pose] of first) {
        const error = oraclePoseError(pose, requireCyclePlacement(last, id));
        maximum.closurePositionMm = Math.max(maximum.closurePositionMm, error.positionMm);
        maximum.closureOrientationDeg = Math.max(maximum.closureOrientationDeg, error.orientationDeg);
        expect(error.positionMm).toBeLessThanOrEqual(1e-6);
        expect(error.orientationDeg).toBeLessThanOrEqual(1e-6);
      }
    }
    expect(f).toEqual(before);
    stdout.write(`[W07] ${JSON.stringify({ kind: 'cross-level-gear', ratio: -1, phaseDeg: 23, samples, maximum })}${String.fromCharCode(10)}`);
  });

  it('solves a reversed phased cam through Steps and closes the child translation cycle', async () => {
    const f = await fixture(), before = structuredClone(f);
    const cam: CrossLevelCamCoupling = { ...CAM, phaseDeg: 37, direction: -1, offsetMm: -40 };
    const dimensions = { radiusMm: 20, eccentricityMm: 5, rollerRadiusMm: 4, phaseDeg: 37 };
    let parent = f.parent;
    let child: Parameters<typeof solveCrossLevelCamDriveSteps>[0]['child'];
    let first: Extract<ReturnType<typeof solveCrossLevelCamDrive>, { ok: true }> | undefined;
    let last: Extract<ReturnType<typeof solveCrossLevelCamDrive>, { ok: true }> | undefined;
    let referenceAngle = 0, samples = 0;
    const maximum = { parentDeg: 0, childPositionMm: 0, guideMm: 0, closurePositionMm: 0, closureOrientationDeg: 0 };
    for (let theta = 0; theta <= 360; theta += 5) {
      const result = drainRigidSteps(solveCrossLevelCamDriveSteps({ inputs: f.inputs, view: f.view,
        parent: { ...parent, referenceAngle }, child, cams: [cam], couplingId: cam.id,
        drive: { side: 'cam', value: theta } }, { units: 16 }));
      expect(result.ok, `cross-level cam at ${theta} degrees`).toBe(true);
      if (!result.ok) throw new Error(result.code);
      const support = requireCyclePlacement(result.parent.placements, 'ground');
      const carrier = requireCyclePlacement(result.parent.placements, 'A');
      const follower = requireCyclePlacement(result.child.placements, 'follower');
      const expected = 40 - oracleRollerDistance(dimensions, theta);
      maximum.parentDeg = Math.max(maximum.parentDeg, Math.abs(oracleAngle(support, carrier, theta) - theta));
      maximum.childPositionMm = Math.max(maximum.childPositionMm, oracleDistance(follower.position, [10, 20, expected]));
      maximum.guideMm = Math.max(maximum.guideMm, Math.hypot(follower.position[0] - 10, follower.position[1] - 20));
      for (const error of Object.values(maximum)) expect(error).toBeLessThanOrEqual(1e-6);
      first ??= result;
      last = result;
      parent = { ...f.parent, initial: result.parent.placements };
      child = { initial: result.child.placements };
      referenceAngle = theta;
      samples += 1;
    }
    expect(samples).toBe(73);
    if (first === undefined || last === undefined) throw new Error('Missing cam cycle endpoint');
    for (const [a, b] of [[first.parent.placements, last.parent.placements], [first.child.placements, last.child.placements]]) {
      for (const [id, pose] of a) {
        const error = oraclePoseError(pose, requireCyclePlacement(b, id));
        maximum.closurePositionMm = Math.max(maximum.closurePositionMm, error.positionMm);
        maximum.closureOrientationDeg = Math.max(maximum.closureOrientationDeg, error.orientationDeg);
        expect(error.positionMm).toBeLessThanOrEqual(1e-6);
        expect(error.orientationDeg).toBeLessThanOrEqual(1e-6);
      }
    }
    expect(f).toEqual(before);
    stdout.write(`[W07] ${JSON.stringify({ kind: 'cross-level-cam', phaseDeg: 37, direction: -1, samples, maximum })}${String.fromCharCode(10)}`);
  });
});
