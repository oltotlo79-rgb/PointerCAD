import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { appendSolid, createEmptyPartDocument } from '../../part/createPartDocument.js';
import type { PrimitiveFeature } from '../../part/types.js';
import { absoluteCoordinate } from '../../sketch/createSketchDocument.js';
import { runCooperative } from '../constraints/cooperativeRigid.js';
import { drainRigidSteps, type RigidWorkPoint } from '../constraints/solveRigid.js';
import type { MateResidualTargetPair } from '../constraints/mateResiduals.js';
import { resolveMateTarget } from '../constraints/mateTargets.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import type { JointOccurrenceInputs, JointOccurrenceView } from '../jointOccurrence.js';
import { embedPart, EMPTY_PART_LIBRARY } from '../partLibrary.js';
import type { Quaternion } from '../placementMath.js';
import { resolveAssembly } from '../resolveAssembly.js';
import type { AssemblyComponent, AssemblyDocument, ComponentSource, Joint, Placement } from '../types.js';
import { solveCrossLevelGearDrive, solveCrossLevelGearDriveSteps, type CrossLevelGearCoupling } from './crossLevelGear.js';
import { solveCrossLevelGearFollow, solveCrossLevelGearFollowSteps } from './crossLevelGearFollow.js';
import { jointFramePairFromTargets } from './jointFrames.js';
import { expectDrivePlacements } from './jointDriveSteps.testSupport.js';
import type { RigidPlacement } from '../placementMath.js';

/*
 * One parent joint, two coupled placements (Root finding on 013/014: only the selected child moved). Written by hand:
 * the parent has a fixed `ground` at (10, 20, 0), the child `childA` placed as A at the same point on the revolute
 * `drive` (A = a, ground = b, starts at 0), and the child `childB` placed as B at (10, 20, 10) on the slider `lift`.
 * Each child has a fixed `base` and an `arm` on its revolute `child-turn` (starts at 0); childB's turn is limited to
 * [-90, 20] degrees. g1: drive -> A/child-turn, ratio -2, phase 0. g2: drive -> B/child-turn, ratio 0.5, phase 15.
 * Angles are read from the quaternions with one shared sign s (all joints are moving = a, fixed = b, +z axes).
 */
function placement(x: number, y: number, z: number): Placement {
  return { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)], rotation: [0, 0, 0, 1] };
}
function component(id: string, source: ComponentSource, at: Placement, fixed = false): AssemblyComponent {
  return { id, name: id, source, placement: at, fixed, visible: true, suppressed: false };
}
function joint(id: string, kind: Joint['kind'], a: string, b: string, limits: readonly [ExpressionValue | null, ExpressionValue | null] = [null, null]): Joint {
  return { id, name: id, kind, a: { kind: 'origin', componentId: a, element: 'z' }, b: { kind: 'origin', componentId: b, element: 'z' },
    minValue: limits[0], maxValue: limits[1], suppressed: false };
}
const degrees = (value: number): ExpressionValue => ({ ...expressionValueFromNumber(value), source: String(value) });

async function fixture() {
  const size = expressionValueFromNumber(4);
  const box: PrimitiveFeature = { id: 'solid-1', name: 'box', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'box', sizeX: size, sizeY: size, sizeZ: size } };
  const embedded = await embedPart(EMPTY_PART_LIBRARY, appendSolid(createEmptyPartDocument(), box), 'plate.pcad', 'plate.pcad',
    { importedAt: '2026-01-01T00:00:00.000Z' });
  const part = { kind: 'part', partRef: embedded.partRef } as const;
  const child = (name: string, limits?: readonly [ExpressionValue | null, ExpressionValue | null]): AssemblyDocument => ({
    ...createAssemblyDocument(name), components: [component('base', part, placement(0, 0, 0), true), component('arm', part, placement(0, 0, 0))],
    joints: [joint('child-turn', 'revolute', 'arm', 'base', limits)] });
  const subAssemblies = new Map([['childA', child('childA')], ['childB', child('childB', [degrees(-90), degrees(20)])]]);
  const library = { ...embedded.library, assemblies: subAssemblies };
  const document: AssemblyDocument = { ...createAssemblyDocument('parent'), components: [
    component('ground', part, placement(10, 20, 0), true),
    component('A', { kind: 'subAssembly', assemblyRef: 'childA' }, placement(10, 20, 0)),
    component('B', { kind: 'subAssembly', assemblyRef: 'childB' }, placement(10, 20, 10)),
  ], joints: [joint('drive', 'revolute', 'A', 'ground'), joint('lift', 'slider', 'B', 'ground')] };
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

const G1: CrossLevelGearCoupling = { id: 'g1', parentJointId: 'drive', child: { path: ['A'], jointId: 'child-turn' }, ratio: -2, phaseDeg: 0 };
const G2: CrossLevelGearCoupling = { id: 'g2', parentJointId: 'drive', child: { path: ['B'], jointId: 'child-turn' }, ratio: 0.5, phaseDeg: 15 };

function zDegrees(rotation: Quaternion | undefined): number {
  const [x, y, z, w] = rotation ?? [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
  expect(Math.abs(x) + Math.abs(y)).toBeLessThan(1e-9);
  return 2 * Math.atan2(z, w) * 180 / Math.PI;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const drive = (f: Fixture, couplingId: string, side: 'parent' | 'child', value: number) =>
  solveCrossLevelGearDrive({ inputs: f.inputs, view: f.view, couplings: [G1, G2], couplingId, drive: { side, value }, parent: f.parent });

/** Both relations hold on the poses: A turned by s*theta, A's arm by s*(-2 theta), B's arm by s*(0.5 theta + 15). */
function expectGroup(outcome: ReturnType<typeof drive>, theta: number): void {
  if (!outcome.ok) throw new Error(`refused ${outcome.couplingId} ${outcome.code}`);
  const turned = zDegrees(outcome.parent.placements.get('A')?.rotation);
  const sign = Math.sign(turned) * Math.sign(theta);
  expect(Math.abs(sign)).toBe(1);
  expect(turned).toBeCloseTo(sign * theta, 6);
  const byPath = new Map(outcome.group.map(member => [member.path.join('/'), member]));
  expect([...byPath.keys()].sort()).toEqual(['A', 'B']);
  expect(zDegrees(byPath.get('A')?.outcome.placements.get('arm')?.rotation)).toBeCloseTo(sign * -2 * theta, 6);
  expect(zDegrees(byPath.get('B')?.outcome.placements.get('arm')?.rotation)).toBeCloseTo(sign * (0.5 * theta + 15), 6);
  expect([byPath.get('A')?.angle, byPath.get('B')?.angle].map(value => Math.round((value ?? Number.NaN) * 1e6) / 1e6))
    .toEqual([-2 * theta, 0.5 * theta + 15]);
  // B is not moved by drive at the parent level (it sits on the slider only).
  expect(outcome.parent.placements.get('B')?.position[2]).toBeCloseTo(10, 9);
}

describe('cross-level gears sharing one parent joint move as one group', () => {
  it('publishes a complete selected-first group once and exposes no solved child at any earlier point', async () => {
    const f = await fixture();
    const before = structuredClone(f);
    const input = { ...f, couplings: [G1, G2], couplingId: 'g2', drive: { side: 'child' as const, value: 16 } };
    const expected = solveCrossLevelGearDrive(input);
    if (!expected.ok) throw new Error(`refused ${expected.code}`);
    const queue: (() => void)[] = [];
    const run = runCooperative(solveCrossLevelGearDriveSteps(input, { units: 13 }),
      { pointsPerSlice: 1, schedule: slice => { queue.push(slice); } });
    let publishes = 0;
    const result = run.result.then(value => {
      if (value.status === 'completed' && value.value.ok) {
        publishes += 1;
        expect(value.value.group.map(child => child.couplingId)).toEqual(['g2', 'g1']);
        expectDrivePlacements(value.value.parent.placements, expected.parent.placements);
        for (const [index, child] of value.value.group.entries()) {
          const reference = expected.group[index];
          if (reference === undefined) throw new Error('missing child');
          expectDrivePlacements(child.outcome.placements, reference.outcome.placements);
        }
      }
      return value;
    });
    let slices = 0;
    while (queue.length > 0) {
      expect(publishes).toBe(0);
      queue.shift()?.();
      slices += 1;
      expect(slices).toBeLessThan(10000);
    }
    expect(await result).toEqual({ status: 'completed', value: expected });
    expect(publishes).toBe(1);
    expect(f).toEqual(before);
  });

  it('discards a solved first child when the second child has an invalid shown map', async () => {
    const f = await fixture();
    const before = structuredClone(f);
    const follow = { ...f, couplings: [G1, G2], parentJointId: 'drive', parentAngle: 2,
      children: new Map([[JSON.stringify(['B']), { initial: new Map<string, RigidPlacement>() }]]) };
    const steps = solveCrossLevelGearFollowSteps(follow, { units: 13 });
    let sawIteration = false, points = 0;
    for (;;) {
      const next = steps.next();
      if (next.done === true) {
        expect(next.value).toEqual({ ok: false, couplingId: 'g2', code: 'child-solve-failed' });
        expect(sawIteration).toBe(true);
        break;
      }
      expect(Object.keys(next.value).sort()).toEqual(['done', 'phase']);
      if (next.value.phase === 'residual') sawIteration = true;
      points += 1;
      expect(points).toBeLessThan(10000);
    }
    expect(f).toEqual(before);
    expect(solveCrossLevelGearFollow(follow)).toEqual({ ok: false, couplingId: 'g2', code: 'child-solve-failed' });
  });

  it('keeps the selected-first order and exact parent/child placements in both cooperative drive directions', async () => {
    const f = await fixture();
    for (const side of ['parent', 'child'] as const) {
      const input = { ...f, couplings: [G1, G2], couplingId: 'g2', drive: { side, value: side === 'parent' ? 2 : 16 } };
      const expected = solveCrossLevelGearDrive(input);
      expectGroup(expected, 2);
      const actual = drainRigidSteps(solveCrossLevelGearDriveSteps(input, { units: 1 }));
      expect(actual).toEqual(expected);
      if (actual.ok) expect(actual.group.map(member => member.couplingId)).toEqual(['g2', 'g1']);
    }
  });

  it('cancels at every checkpoint of a multi-child drive and follow, including after a solved sibling', async () => {
    const f = await fixture();
    const before = structuredClone(f);
    const input = { ...f, couplings: [G1, G2], couplingId: 'g1', drive: { side: 'parent' as const, value: 2 } };
    const follow = { ...f, couplings: [G1, G2], parentJointId: 'drive', parentAngle: 2 };
    const factories: readonly (() => Generator<RigidWorkPoint, { readonly ok: boolean }, void>)[] = [
      () => solveCrossLevelGearDriveSteps(input, { units: 1 }),
      () => solveCrossLevelGearFollowSteps(follow, { units: 1 })];
    for (const factory of factories) {
      let points = 0, previous = 0;
      const phases = new Set<string>();
      const trace = factory();
      for (;;) {
        const next = trace.next();
        if (next.done === true) { expect(next.value.ok).toBe(true); break; }
        expect(next.value.done).toBeGreaterThanOrEqual(previous);
        expect(Number.isFinite(next.value.done)).toBe(true);
        previous = next.value.done;
        phases.add(next.value.phase);
        points += 1;
        expect(points).toBeLessThan(10000);
      }
      expect(points).toBeGreaterThan(4);
      expect(phases.has('residual')).toBe(true);
      for (let stop = 0; stop <= points; stop += 1) {
        const queue: (() => void)[] = [];
        const run = runCooperative(factory(), { pointsPerSlice: 1, schedule: slice => { queue.push(slice); } });
        let published = 0;
        const result = run.result.then(value => { if (value.status === 'completed') published += 1; return value; });
        for (let point = 0; point < stop; point += 1) queue.shift()?.();
        run.cancel();
        while (queue.length > 0) queue.shift()?.();
        expect(await result).toEqual({ status: 'cancelled', progress: run.progress() });
        expect(published).toBe(0);
        expect(f).toEqual(before);
      }
    }
    expect(drainRigidSteps(solveCrossLevelGearFollowSteps(follow, { units: 1 }))).toEqual(solveCrossLevelGearFollow(follow));
    const blocked = { ...input, drive: { side: 'parent' as const, value: 20 } };
    expect(drainRigidSteps(solveCrossLevelGearDriveSteps(blocked, { units: 512 })))
      .toEqual({ ok: false, couplingId: 'g2', code: 'child-at-limit' });
    expect(f).toEqual(before);
  });

  it('moves both coupled placements from the parent side, each at its own ratio and phase', async () => {
    const f = await fixture();
    const outcome = drive(f, 'g1', 'parent', 2);
    expectGroup(outcome, 2);
    if (outcome.ok) expect([outcome.path, outcome.childAngle]).toEqual([['A'], expect.closeTo(-4, 6)]);
  });

  it('moves the parent and the other placement from either child side', async () => {
    const f = await fixture();
    // B's child to 16 -> theta = (16 - 15) / 0.5 = 2; A's child follows to -4.
    const fromB = drive(f, 'g2', 'child', 16);
    expectGroup(fromB, 2);
    if (fromB.ok) expect([fromB.couplingId, fromB.path]).toEqual(['g2', ['B']]);
    // A's child to 6 -> theta = -3; B's child follows to 13.5.
    expectGroup(drive(f, 'g1', 'child', 6), -3);
  });

  it('refuses the whole group when one placement cannot follow, naming that coupling', async () => {
    const f = await fixture();
    // theta = 30 puts B's child at 30, above its maximum 20, while A alone (child -60) could follow.
    expect(drive(f, 'g1', 'parent', 30)).toEqual({ ok: false, couplingId: 'g2', code: 'child-at-limit' });
    expect(drive(f, 'g2', 'child', 30)).toEqual({ ok: false, couplingId: 'g2', code: 'child-at-limit' });
  });
});

describe('cross-level group reference validation for every coupled placement', () => {
  it('preserves an explicit invalid reference on a nonselected child and refuses the whole group', async () => {
    const f = await fixture();
    const before = JSON.stringify(f.inputs.document);
    const outcome = solveCrossLevelGearDrive({ inputs: f.inputs, view: f.view, couplings: [G1, G2], couplingId: 'g1',
      drive: { side: 'parent', value: 2 }, parent: f.parent,
      children: new Map([[JSON.stringify(['B']), { referenceAngle: Number.NaN }]]) });
    expect(outcome).toEqual({ ok: false, couplingId: 'g2', code: 'child-solve-failed' });
    expect(JSON.stringify(f.inputs.document)).toBe(before);
  });
});

describe('cross-level gear following starts or continues the child angle branch', () => {
  it('follows both ratios and phases from a public first motion without saved child references', async () => {
    const f = await fixture();
    const before = structuredClone(f.inputs.document);
    const initial = structuredClone(f.view.resolved.placements);
    const outcome = solveCrossLevelGearFollow({ inputs: f.inputs, view: f.view, couplings: [G1, G2],
      parentJointId: 'drive', parentAngle: 2 });
    if (!outcome.ok) throw new Error(`refused ${outcome.couplingId} ${outcome.code}`);
    expect(outcome.group.map(member => member.couplingId)).toEqual(['g1', 'g2']);
    for (const [id, expectedAngle] of [['g1', -4], ['g2', 16]] as const) {
      const member = outcome.group.find(item => item.couplingId === id);
      if (member === undefined) throw new Error('missing coupled child');
      expect(member.angle).toBeCloseTo(expectedAngle, 6);
      expect(zDegrees(member.outcome.placements.get('arm')?.rotation)).toBeCloseTo(-expectedAngle, 6);
    }
    expect(f.inputs.document).toEqual(before);
    expect(f.view.resolved.placements).toEqual(initial);
  });

  it('reaches the actual child limit instead of failing an absent-reference preparation', async () => {
    const f = await fixture();
    expect(solveCrossLevelGearFollow({ inputs: f.inputs, view: f.view, couplings: [G1, G2],
      parentJointId: 'drive', parentAngle: 30 }))
      .toEqual({ ok: false, couplingId: 'g2', code: 'child-at-limit' });
  });

  it('preserves an explicitly invalid reference on the second child and refuses the entire follow', async () => {
    const f = await fixture();
    expect(solveCrossLevelGearFollow({ inputs: f.inputs, view: f.view, couplings: [G1, G2],
      parentJointId: 'drive', parentAngle: 2,
      children: new Map([[JSON.stringify(['B']), { referenceAngle: Number.NaN }]]) }))
      .toEqual({ ok: false, couplingId: 'g2', code: 'child-solve-failed' });
  });

  it('continues a supplied full-turn child reference instead of resetting it to the principal branch', async () => {
    const f = await fixture();
    const coupling = { ...G1, ratio: 1 };
    const outcome = solveCrossLevelGearFollow({ inputs: f.inputs, view: f.view, couplings: [coupling],
      parentJointId: 'drive', parentAngle: 400,
      children: new Map([[JSON.stringify(['A']), { referenceAngle: 360 }]]) });
    if (!outcome.ok) throw new Error(`refused ${outcome.couplingId} ${outcome.code}`);
    expect(outcome.group).toHaveLength(1);
    expect(outcome.group[0]?.angle).toBeCloseTo(400, 6);
    expect(zDegrees(outcome.group[0]?.outcome.placements.get('arm')?.rotation)).toBeCloseTo(-40, 6);
  });
});
