import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { appendSolid, createEmptyPartDocument } from '../../part/createPartDocument.js';
import type { PrimitiveFeature } from '../../part/types.js';
import { absoluteCoordinate } from '../../sketch/createSketchDocument.js';
import type { MateResidualTargetPair } from '../constraints/mateResiduals.js';
import { resolveMateTarget } from '../constraints/mateTargets.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import type { JointOccurrenceInputs, JointOccurrenceView } from '../jointOccurrence.js';
import { embedPart, EMPTY_PART_LIBRARY } from '../partLibrary.js';
import type { Quaternion, RigidPlacement } from '../placementMath.js';
import { resolveAssembly } from '../resolveAssembly.js';
import type { AssemblyComponent, AssemblyDocument, ComponentSource, Joint, Placement } from '../types.js';
import { crossLevelGearFailure, solveCrossLevelGearDrive, type CrossLevelGearCoupling, type CrossLevelGearDriveInput } from './crossLevelGear.js';
import { crossLevelGearFailureSteps, solveCrossLevelGearDriveSteps } from './crossLevelGear.js';
import { drainRigidSteps } from '../constraints/solveRigid.js';
import { expectBoundedDrivePreparation, expectDrivePlacements, observeDriveItems } from './jointDriveSteps.testSupport.js';
import { jointFramePairFromTargets } from './jointFrames.js';

/*
 * Cross-level gear. Written by hand: the child assembly has a fixed `base` and an `arm` on the revolute `child-turn`
 * (arm = a, base = b, origin z axes, aligned so its angle starts at 0). The parent has a fixed `ground` at (10, 20, 0),
 * the child placed as `A` at the same point (no rotation, so the revolute `drive` (A = a, ground = b) starts at 0) and
 * as `B` at (10, 20, 10) on the slider `lift` along the same axis (satisfied as written, so the parent solve has
 * nothing to correct; it only makes a non-revolute parent joint). Rotations are read back from the quaternions, not from the solver's joint values: A turns about
 * the vertical axis through (10, 20, 0) by s * thetaParent and the arm turns relative to its base by s * thetaChild,
 * with the same s = +1 or -1 for both joints because both are defined the same way (moving = a, fixed = b, +z axes).
 */
function placement(x: number, y: number, z: number, rotation: Quaternion = [0, 0, 0, 1]): Placement {
  return { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)], rotation };
}
function component(id: string, source: ComponentSource, at: Placement = placement(0, 0, 0), fixed = false): AssemblyComponent {
  return { id, name: id, source, placement: at, fixed, visible: true, suppressed: false };
}
function joint(id: string, kind: Joint['kind'], a: string, b: string): Joint {
  return { id, name: id, kind, a: { kind: 'origin', componentId: a, element: 'z' }, b: { kind: 'origin', componentId: b, element: 'z' },
    minValue: null, maxValue: null, suppressed: false };
}

async function fixture(change: (document: AssemblyDocument) => AssemblyDocument = document => document,
  childJoints: readonly Joint[] = [joint('child-turn', 'revolute', 'arm', 'base')]) {
  const size = expressionValueFromNumber(4);
  const box: PrimitiveFeature = { id: 'solid-1', name: 'box', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'box', sizeX: size, sizeY: size, sizeZ: size } };
  const embedded = await embedPart(EMPTY_PART_LIBRARY, appendSolid(createEmptyPartDocument(), box), 'plate.pcad', 'plate.pcad',
    { importedAt: '2026-01-01T00:00:00.000Z' });
  const part = { kind: 'part', partRef: embedded.partRef } as const;
  const child: AssemblyDocument = { ...createAssemblyDocument('geared child'),
    components: [component('base', part, placement(0, 0, 0), true), component('arm', part)], joints: [...childJoints] };
  const subAssemblies = new Map([['child', child]]);
  const library = { ...embedded.library, assemblies: subAssemblies };
  const document = change({ ...createAssemblyDocument('parent'), components: [
    component('ground', part, placement(10, 20, 0), true),
    component('A', { kind: 'subAssembly', assemblyRef: 'child' }, placement(10, 20, 0)),
    component('B', { kind: 'subAssembly', assemblyRef: 'child' }, placement(10, 20, 10)),
  ], joints: [joint('drive', 'revolute', 'A', 'ground'), joint('lift', 'slider', 'B', 'ground')] });
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

const gear = (overrides: Partial<CrossLevelGearCoupling> = {}): CrossLevelGearCoupling =>
  ({ id: 'g1', parentJointId: 'drive', child: { path: ['A'], jointId: 'child-turn' }, ratio: -2, phaseDeg: 0, ...overrides });

/** Degrees of a pure z rotation [0, 0, sin(phi/2), cos(phi/2)]; x and y must stay 0. */
function zDegrees(rotation: Quaternion | undefined): number {
  const [x, y, z, w] = rotation ?? [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
  expect(Math.abs(x) + Math.abs(y)).toBeLessThan(1e-9);
  return 2 * Math.atan2(z, w) * 180 / Math.PI;
}
const at = (placements: ReadonlyMap<string, RigidPlacement>, id: string): readonly number[] =>
  placements.get(id)?.position ?? [Number.NaN, Number.NaN, Number.NaN];

type Fixture = Awaited<ReturnType<typeof fixture>>;
function drive(f: Fixture, couplings: readonly CrossLevelGearCoupling[], side: 'parent' | 'child', value: number) {
  const input: CrossLevelGearDriveInput = { inputs: f.inputs, view: f.view, couplings, couplingId: couplings[0]?.id ?? 'none',
    drive: { side, value }, parent: f.parent };
  return solveCrossLevelGearDrive(input);
}

/** Checks the reached pair against the relation and against the quaternions (axis, centre and a shared sign). */
function expectGeared(outcome: ReturnType<typeof drive>, ratio: number, phase: number, parentAngle: number): void {
  if (!outcome.ok) throw new Error(`refused ${outcome.code}`);
  expect(outcome.parentAngle).toBeCloseTo(parentAngle, 6);
  expect(outcome.childAngle).toBeCloseTo(ratio * parentAngle + phase, 6);
  const turned = zDegrees(outcome.parent.placements.get('A')?.rotation);
  const sign = Math.sign(turned) * Math.sign(parentAngle);
  expect(Math.abs(sign)).toBe(1);
  expect(turned).toBeCloseTo(sign * parentAngle, 6);
  at(outcome.parent.placements, 'A').forEach((value, axis) => expect(value).toBeCloseTo([10, 20, 0][axis] ?? Number.NaN, 9));
  // The child placements are in the parent's solved (unmoved) frame: the base keeps A's resolved pose, the arm turns
  // relative to it by the child angle with the same sign, in place.
  expect(zDegrees(outcome.child.placements.get('base')?.rotation)).toBeCloseTo(0, 9);
  expect(zDegrees(outcome.child.placements.get('arm')?.rotation)).toBeCloseTo(sign * (ratio * parentAngle + phase), 6);
  at(outcome.child.placements, 'arm').forEach((value, axis) => expect(value).toBeCloseTo([10, 20, 0][axis] ?? Number.NaN, 9));
  expect(outcome.path).toEqual(['A']);
}

describe('cross-level gear between a parent joint and a joint inside one subassembly placement', () => {
  it('matches every parent and child pose in either direction at different cooperative budgets', async () => {
    const f = await fixture();
    const coupling = gear({ ratio: -0.5, phaseDeg: 17 });
    for (const side of ['parent', 'child'] as const) {
      const input: CrossLevelGearDriveInput = { ...f, couplings: [coupling], couplingId: coupling.id,
        drive: { side, value: side === 'parent' ? 12 : 11 } };
      const expected = solveCrossLevelGearDrive(input);
      expectGeared(expected, -0.5, 17, 12);
      if (!expected.ok) throw new Error(`refused ${expected.code}`);
      for (const units of [1, 13, 512]) {
        const actual = drainRigidSteps(solveCrossLevelGearDriveSteps(input, { units }));
        if (!actual.ok) throw new Error(`refused ${actual.code}`);
        expectDrivePlacements(actual.parent.placements, expected.parent.placements);
        expectDrivePlacements(actual.child.placements, expected.child.placements);
        expect(actual).toEqual(expected);
      }
      expect(solveCrossLevelGearDriveSteps(input, { units: Number.POSITIVE_INFINITY }).next())
        .toEqual({ done: true, value: expected });
    }
  });

  it('bounds parent-joint admission scans and preserves the first refusal after earlier valid couplings', async () => {
    const f = await fixture();
    const joints = observeDriveItems([...Array.from({ length: 96 }, (_, index) =>
      ({ ...joint(`inactive-${String(index)}`, 'revolute', 'A', 'ground'), suppressed: true })), ...f.inputs.document.joints]);
    const document = { ...f.inputs.document, joints: joints.items };
    const inputs = { ...f.inputs, document }, view = { ...f.view, source: { ...f.inputs, document } };
    const couplings = [gear(), gear({ id: 'broken', ratio: 0 })];
    expect(expectBoundedDrivePreparation(crossLevelGearFailureSteps(inputs, view, couplings, { units: 3 }), joints, 3))
      .toEqual({ ok: false, couplingId: 'broken', code: 'invalid-ratio' });
    expect(drainRigidSteps(crossLevelGearFailureSteps(inputs, view, couplings, { units: 512 })))
      .toEqual(crossLevelGearFailure(inputs, view, couplings));
  });

  it('drives the child by ratio * parent from the parent side, sign and axis read from the poses', async () => {
    const f = await fixture();
    const before = JSON.stringify(f.inputs.document);
    expectGeared(drive(f, [gear()], 'parent', 30), -2, 0, 30);
    // Pure: the document and its child definition are unchanged; the sibling placement B is not part of the result.
    expect(JSON.stringify(f.inputs.document)).toBe(before);
  });

  it('drives the parent by the inverse relation from the child side, with a phase', async () => {
    const f = await fixture();
    const couplings = [gear({ ratio: 0.5, phaseDeg: 15 })];
    expectGeared(drive(f, couplings, 'child', 40), 0.5, 15, 50);
    expectGeared(drive(f, couplings, 'parent', -20), 0.5, 15, -20);
  });

  it('refuses unsupported or inconsistent coupling graphs explicitly', async () => {
    const f = await fixture();
    const refusal = (couplings: readonly CrossLevelGearCoupling[]) => crossLevelGearFailure(f.inputs, f.view, couplings)?.code;
    expect(refusal([gear()])).toBeUndefined();
    expect(refusal([gear(), gear()])).toBe('duplicate-coupling');
    expect(refusal([gear({ ratio: 0 })])).toBe('invalid-ratio');
    expect(refusal([gear({ ratio: Number.NaN })])).toBe('invalid-ratio');
    expect(refusal([gear({ phaseDeg: Number.POSITIVE_INFINITY })])).toBe('invalid-phase');
    expect(refusal([gear({ ratio: 1e-320 })])).toBe('unrepresentable-coupling');
    expect(refusal([gear({ parentJointId: 'none' })])).toBe('missing-parent-joint');
    expect(refusal([gear({ parentJointId: 'lift' })])).toBe('unsupported-parent-joint');
    expect(refusal([gear({ child: { path: ['X'], jointId: 'child-turn' } })])).toBe('missing-component');
    expect(refusal([gear({ child: { path: ['ground'], jointId: 'child-turn' } })])).toBe('not-subassembly');
    expect(refusal([gear({ child: { path: [], jointId: 'child-turn' } })])).toBe('invalid-path');
    expect(refusal([gear({ child: { path: ['A'], jointId: 'none' } })])).toBe('missing-child-joint');
    // Two relations into the same placement could contradict each other through the child's own joints.
    expect(refusal([gear(), gear({ id: 'g2', parentJointId: 'drive', child: { path: ['A'], jointId: 'child-turn' } })]))
      .toBe('duplicate-occurrence');
    // The other placement of the same child is a different occurrence and may be geared on its own.
    expect(refusal([gear(), gear({ id: 'g2', child: { path: ['B'], jointId: 'child-turn' } })])).toBeUndefined();
    const slid = await fixture(undefined, [joint('child-turn', 'slider', 'arm', 'base')]);
    expect(crossLevelGearFailure(slid.inputs, slid.view, [gear()])?.code).toBe('unsupported-child-joint');
  });

  it('refuses a parent joint that already takes part in a top-level gear, keeping that gear as it is', async () => {
    const coupled = await fixture(document => ({ ...document, mechanismCouplings: [{ id: 'top', kind: 'gear', jointAId: 'drive',
      jointBId: 'other', ratio: expressionValueFromNumber(1), phaseDeg: expressionValueFromNumber(0), referenceAngleA: 0, suppressed: false }] }));
    expect(crossLevelGearFailure(coupled.inputs, coupled.view, [gear()])?.code).toBe('coupled-parent-joint');
    expect(drive(coupled, [gear()], 'parent', 30)).toEqual({ ok: false, couplingId: 'g1', code: 'coupled-parent-joint' });
  });

  it('refuses a stale view, a missing coupling and a non-finite value without solving', async () => {
    const f = await fixture();
    // A view solved for another document object (a later edit) is stale even when it looks the same.
    const stale = { ...f, view: { ...f.view, source: { ...f.inputs, document: { ...f.inputs.document } } } };
    expect(drive(stale, [gear()], 'parent', 30)).toEqual({ ok: false, couplingId: 'g1', code: 'stale-view' });
    expect(solveCrossLevelGearDrive({ inputs: f.inputs, view: f.view, couplings: [gear()], couplingId: 'none',
      drive: { side: 'parent', value: 30 }, parent: f.parent })).toEqual({ ok: false, couplingId: 'none', code: 'missing-coupling' });
    expect(drive(f, [gear()], 'child', Number.NaN)).toEqual({ ok: false, couplingId: 'g1', code: 'invalid-value' });
  });
});

describe('cross-level gear initial angular branch and continuity', () => {
  it('reads a nonzero shown orientation on the first drive without inventing an angle-zero pose', async () => {
    const f = await fixture();
    const initial = new Map(f.parent.initial);
    const shown = initial.get('A');
    if (shown === undefined) throw new Error('missing parent placement');
    // Joint angle is minus physical z rotation: cross(a.x,b.x) points along -z for a positive rotation.
    initial.set('A', { ...shown, rotation: [0, 0, -Math.sin(Math.PI / 12), Math.cos(Math.PI / 12)] });
    const outcome = solveCrossLevelGearDrive({ inputs: f.inputs, view: f.view, couplings: [gear()], couplingId: 'g1',
      drive: { side: 'parent', value: 45 }, parent: { ...f.parent, initial } });
    if (!outcome.ok) throw new Error(`refused ${outcome.code}`);
    expect(outcome.parentAngle).toBeCloseTo(45, 6);
    expect(outcome.childAngle).toBeCloseTo(-90, 6);
    expect(zDegrees(outcome.parent.placements.get('A')?.rotation)).toBeCloseTo(-45, 6);
    expect(zDegrees(outcome.child.placements.get('base')?.rotation)).toBeCloseTo(0, 9);
    expect(zDegrees(outcome.child.placements.get('arm')?.rotation)).toBeCloseTo(90, 6);
    expect(zDegrees(initial.get('A')?.rotation)).toBeCloseTo(-30, 9);
  });

  it('retains supplied parent and child multi-turn references instead of reinitializing their branches', async () => {
    const f = await fixture();
    const initial = new Map(f.parent.initial);
    const shown = initial.get('A');
    if (shown === undefined) throw new Error('missing parent placement');
    initial.set('A', { ...shown, rotation: [0, 0, -Math.sin(Math.PI / 12), Math.cos(Math.PI / 12)] });
    // Physical -30 degrees represents joint 390 with the supplied reference; the child starts at joint360.
    const outcome = solveCrossLevelGearDrive({ inputs: f.inputs, view: f.view, couplings: [gear({ ratio: 1 })], couplingId: 'g1',
      drive: { side: 'parent', value: 400 }, parent: { ...f.parent, initial, referenceAngle: 390 },
      child: { referenceAngle: 360 } });
    if (!outcome.ok) throw new Error(`refused ${outcome.code}`);
    expect(outcome.parentAngle).toBeCloseTo(400, 6);
    expect(outcome.childAngle).toBeCloseTo(400, 6);
    expect(zDegrees(outcome.parent.placements.get('A')?.rotation)).toBeCloseTo(-40, 6);
    expect(zDegrees(outcome.child.placements.get('arm')?.rotation)).toBeCloseTo(-40, 6);
  });

  it('refuses explicitly invalid parent or child references instead of defaulting them', async () => {
    const f = await fixture();
    const input: CrossLevelGearDriveInput = { inputs: f.inputs, view: f.view, couplings: [gear()], couplingId: 'g1',
      drive: { side: 'parent', value: 30 }, parent: f.parent };
    expect(solveCrossLevelGearDrive({ ...input, parent: { ...f.parent, referenceAngle: Number.NaN } }))
      .toEqual({ ok: false, couplingId: 'g1', code: 'parent-solve-failed' });
    expect(solveCrossLevelGearDrive({ ...input, child: { referenceAngle: Number.NaN } }))
      .toEqual({ ok: false, couplingId: 'g1', code: 'child-solve-failed' });
  });
});
