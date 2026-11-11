import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import type { Vec3 } from '../../sketch/vec3.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import type { JointDriveRequest } from '../joints/driveJoint.js';
import type { JointFrame, JointFramePair } from '../joints/jointFrames.js';
import {
  applyPlacementToPoint, IDENTITY_QUATERNION, quaternionFromAxisAngle, rotateVector, type RigidPlacement,
} from '../placementMath.js';
import type { AssemblyComponent, AssemblyDocument, Joint, JointKind, MechanismGearCoupling } from '../types.js';
import { runCooperative } from './cooperativeRigid.js';
import { solveDrivenJoint, solveDrivenJointSteps, solveMates, type SolveDrivenJointOutcome } from './solveMates.js';

/**
 * task136: a real 1000-component assembly whose movable components (180, i.e. 1080 variables in total) are spread over
 * 120 small independent groups of mixed joints and gear links. The per-solve cap of 600 variables applies to each
 * connected group; this proves the whole-assembly count no longer refuses independent groups. It does not claim a
 * coupled 1000-component solve or any timing. The checks below recompute joint geometry from the returned placements
 * with local formulas instead of reading the solver's residual rows.
 */

const TOTAL = 1000;
const GROUPS = 120;
const PART_REFS = 12;
/** Slider/cylindrical groups use filler `f${g % 40}`; with g % 4 in {1, 2} that is 20 distinct fillers, 3 groups each. */
const FILLER_MODULUS = 40;
const SHARED_FILLERS = 20;
const GROUPS_PER_FILLER = 3;
const POSITION = 1e-6;
const DIRECTION = 1e-6;
const ANGLE_DEG = 1e-6;
const GEAR_RATIO = 2;
/** Drive target of slider g1j: signed travel along the anchor frame z (driveJoint coordinateRow, projectedResidual). */
const SLIDER_TARGET = 15;
const SLIDER_START = 5;

const LOCAL: JointFrame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const BALL_TOP: JointFrame = { origin: [0, 0, 20], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

interface Spec {
  readonly joints: Joint[];
  readonly frames: Map<string, JointFramePair>;
  readonly couplings: MechanismGearCoupling[];
  readonly components: AssemblyComponent[];
  readonly placements: Map<string, RigidPlacement>;
  readonly groups: string[][];
  readonly kinds: Map<string, JointKind>;
}

function part(id: string, index: number, fixed: boolean): AssemblyComponent {
  return { id, name: id, source: { kind: 'part', partRef: `part-${index % PART_REFS}` },
    placement: DEFAULT_COMPONENT_PLACEMENT, fixed, visible: true, suppressed: false };
}
function frameAt(origin: Vec3): JointFrame { return { ...LOCAL, origin }; }
function placed(position: Vec3, axis: Vec3 = [0, 0, 1], angle = 0): RigidPlacement {
  return { position, rotation: angle === 0 ? IDENTITY_QUATERNION : quaternionFromAxisAngle(axis, angle) };
}
function anchorOf(g: number): string { return g % 4 === 1 || g % 4 === 2 ? `f${g % FILLER_MODULUS}` : 'ground'; }
function anchorPosition(index: number): Vec3 { return [0, 500 + 10 * index, 0]; }
/** Ground-side joint origin of group g in the anchor's local coordinates. */
function site(g: number): Vec3 { return [200 * g, 0, 0]; }
function add(v: Vec3, w: Vec3): Vec3 { return [v[0] + w[0], v[1] + w[1], v[2] + w[2]]; }
function sub(v: Vec3, w: Vec3): Vec3 { return [v[0] - w[0], v[1] - w[1], v[2] - w[2]]; }
function dot(v: Vec3, w: Vec3): number { return v[0] * w[0] + v[1] * w[1] + v[2] * w[2]; }
function cross(v: Vec3, w: Vec3): Vec3 { return [v[1] * w[2] - v[2] * w[1], v[2] * w[0] - v[0] * w[2], v[0] * w[1] - v[1] * w[0]]; }
function norm(v: Vec3): number { return Math.hypot(v[0], v[1], v[2]); }

/**
 * 1000 components: ground, 120 groups cycling gear pair / slider / cylindrical / ball+revolute, and fixed fillers with
 * 12 part references. The 60 slider and cylindrical groups hang on 20 shared fixed fillers, three groups per filler
 * (checked in the first test). With `chain`, 101 fillers become one connected revolute chain on ground (606 variables,
 * over the 600 cap).
 */
function build(chain: boolean): Spec {
  const joints: Joint[] = [], couplings: MechanismGearCoupling[] = [], components: AssemblyComponent[] = [part('ground', 0, true)];
  const frames = new Map<string, JointFramePair>(), placements = new Map<string, RigidPlacement>([['ground', placed([0, 0, 0])]]);
  const groups: string[][] = [], kinds = new Map<string, JointKind>();
  const joint = (id: string, kind: JointKind, a: string, b: string, frameA: JointFrame, frameB: JointFrame) => {
    joints.push({ id, name: id, kind, a: { kind: 'origin', componentId: a, element: 'origin' },
      b: { kind: 'origin', componentId: b, element: 'origin' }, minValue: null, maxValue: null, suppressed: false });
    frames.set(id, { a: frameA, b: frameB });
    kinds.set(id, kind);
  };
  const movable = (id: string, placement: RigidPlacement) => {
    components.push(part(id, components.length, false));
    placements.set(id, placement);
  };
  for (let g = 0; g < GROUPS; g += 1) {
    const anchor = anchorOf(g), at = add(anchor === 'ground' ? [0, 0, 0] : anchorPosition(g % FILLER_MODULUS), site(g));
    if (g % 4 === 0) {
      // Two revolute joints on ground linked by a gear: thetaB = 2 thetaA. B starts 10 degrees off the relation.
      movable(`g${g}a`, placed(add(at, [0.3, -0.2, 0.1]), [1, 0, 0], 0.01));
      movable(`g${g}b`, placed(add(at, [49.9, 0.25, -0.2]), [0, 0, 1], 10 * Math.PI / 180));
      joint(`g${g}ja`, 'revolute', `g${g}a`, anchor, LOCAL, frameAt(site(g)));
      joint(`g${g}jb`, 'revolute', `g${g}b`, anchor, LOCAL, frameAt(add(site(g), [50, 0, 0])));
      couplings.push({ id: `g${g}c`, kind: 'gear', jointAId: `g${g}ja`, jointBId: `g${g}jb`,
        ratio: expressionValueFromNumber(GEAR_RATIO), phaseDeg: expressionValueFromNumber(0), referenceAngleA: 0, suppressed: false });
      groups.push([`g${g}a`, `g${g}b`]);
    } else if (g % 4 === 1) {
      movable(`g${g}s`, placed(add(at, [0.4, 0.3, SLIDER_START]), [0, 1, 0], 0.02));
      joint(`g${g}j`, 'slider', `g${g}s`, anchor, LOCAL, frameAt(site(g)));
      groups.push([`g${g}s`]);
    } else if (g % 4 === 2) {
      movable(`g${g}y`, placed(add(at, [-0.3, 0.2, 3]), [1, 0, 1], 0.015));
      joint(`g${g}j`, 'cylindrical', `g${g}y`, anchor, LOCAL, frameAt(site(g)));
      groups.push([`g${g}y`]);
    } else {
      movable(`g${g}p`, placed(add(at, [0.2, 0.1, -0.3]), [1, 1, 0], 0.1));
      movable(`g${g}q`, placed(add(at, [0.3, -0.2, 20.1])));
      joint(`g${g}jp`, 'ball', `g${g}p`, anchor, LOCAL, frameAt(site(g)));
      joint(`g${g}jq`, 'revolute', `g${g}q`, `g${g}p`, LOCAL, BALL_TOP);
      groups.push([`g${g}p`, `g${g}q`]);
    }
  }
  const chainIds: string[] = [];
  for (let i = 0; components.length < TOTAL; i += 1) {
    const id = `f${i}`;
    if (chain && i >= 100 && i < 201) {
      const k = i - 100;
      chainIds.push(id);
      movable(id, placed([k, -300 + 2 * k, 0]));
      joint(`chain${k}`, 'revolute', id, k === 0 ? 'ground' : `f${i - 1}`, LOCAL, frameAt([0, 0, 10]));
      continue;
    }
    components.push(part(id, components.length, true));
    placements.set(id, placed(anchorPosition(i)));
  }
  if (chain) groups.push(chainIds);
  return { joints, frames, couplings, components, placements, groups, kinds };
}

function documentOf(spec: Spec): AssemblyDocument {
  return { ...createAssemblyDocument('1000'), components: spec.components, joints: spec.joints, mechanismCouplings: spec.couplings };
}

interface WorldFrame { readonly origin: Vec3; readonly x: Vec3; readonly z: Vec3 }
function world(placements: ReadonlyMap<string, RigidPlacement>, id: string, frame: JointFrame): WorldFrame {
  const placement = placements.get(id);
  if (placement === undefined) throw new Error(`no placement: ${id}`);
  return { origin: applyPlacementToPoint(placement, frame.origin), x: rotateVector(placement.rotation, frame.x),
    z: rotateVector(placement.rotation, frame.z) };
}
/** Signed joint angle in degrees: atan2((a.x x b.x).b.z, a.x.b.x) (the documented joint chart). */
function angle(a: WorldFrame, b: WorldFrame): number {
  return Math.atan2(dot(cross(a.x, b.x), b.z), dot(a.x, b.x)) * 180 / Math.PI;
}
/** Signed slider travel: (a.origin - b.origin).b.z, the same sign as the joint's translation coordinate. */
function travel(spec: Spec, placements: ReadonlyMap<string, RigidPlacement>, jointId: string): number {
  const entry = spec.joints.find((j) => j.id === jointId), pair = spec.frames.get(jointId);
  if (entry === undefined || pair === undefined) throw new Error(`no joint: ${jointId}`);
  const a = world(placements, entry.a.componentId, pair.a), b = world(placements, entry.b.componentId, pair.b);
  return dot(sub(a.origin, b.origin), b.z);
}

/** Independent geometric violations of every joint and gear of the listed groups; [] when all hold. */
function violations(spec: Spec, placements: ReadonlyMap<string, RigidPlacement>, only?: ReadonlySet<string>): string[] {
  const found: string[] = [];
  const frameOf = new Map(spec.joints.map((j): [string, { a: WorldFrame; b: WorldFrame }] => {
    const pair = spec.frames.get(j.id);
    if (pair === undefined) throw new Error(`no frames: ${j.id}`);
    return [j.id, { a: world(placements, j.a.componentId, pair.a), b: world(placements, j.b.componentId, pair.b) }];
  }));
  for (const j of spec.joints) {
    if (only !== undefined && !only.has(j.a.componentId)) continue;
    const pair = frameOf.get(j.id);
    if (pair === undefined) continue;
    const offset = sub(pair.a.origin, pair.b.origin);
    if (j.kind === 'revolute' || j.kind === 'ball') {
      if (norm(offset) >= POSITION) found.push(`${j.id}: origin ${norm(offset)}`);
    } else if (norm(cross(offset, pair.b.z)) >= POSITION) found.push(`${j.id}: off axis ${norm(cross(offset, pair.b.z))}`);
    if (j.kind !== 'ball') {
      if (norm(cross(pair.a.z, pair.b.z)) >= DIRECTION || dot(pair.a.z, pair.b.z) <= 0) found.push(`${j.id}: axis`);
    }
    if (j.kind === 'slider' && (norm(cross(pair.a.x, pair.b.x)) >= DIRECTION || dot(pair.a.x, pair.b.x) <= 0)) found.push(`${j.id}: turned`);
  }
  const bodyOf = new Map(spec.joints.map((j): [string, string] => [j.id, j.a.componentId]));
  for (const c of spec.couplings) {
    if (only !== undefined && !only.has(bodyOf.get(c.jointAId) ?? '')) continue;
    const a = frameOf.get(c.jointAId), b = frameOf.get(c.jointBId);
    if (a === undefined || b === undefined) continue;
    const residual = angle(b.a, b.b) - GEAR_RATIO * angle(a.a, a.b);
    if (Math.abs(residual) >= ANGLE_DEG) found.push(`${c.id}: gear ${residual}`);
  }
  return found;
}

function snapshot(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item instanceof Map ? [...item.entries()] : item);
}

describe('task136 heterogeneous 1000-component assembly in independent small groups', () => {
  it('the fixture is real: 1000 components, 12 part references, 180 movable over the 600-variable total, every group violated', () => {
    const spec = build(false);
    expect(spec.components.length).toBe(TOTAL);
    expect(new Set(spec.components.map((c) => c.source.kind === 'part' ? c.source.partRef : '')).size).toBe(PART_REFS);
    const movable = spec.components.filter((c) => !c.fixed).length;
    expect(movable).toBe(180);
    expect(movable * 6).toBeGreaterThan(600);
    expect(new Set(spec.joints.map((j) => j.kind))).toEqual(new Set(['revolute', 'slider', 'cylindrical', 'ball']));
    expect(spec.couplings.length).toBe(30);
    // Fixed fillers actually shared as anchors, counted from the built joints rather than assumed.
    const fixedIds = new Set(spec.components.filter((c) => c.fixed && c.id !== 'ground').map((c) => c.id));
    const uses = new Map<string, number>();
    for (const j of spec.joints) if (fixedIds.has(j.b.componentId)) uses.set(j.b.componentId, (uses.get(j.b.componentId) ?? 0) + 1);
    expect(uses.size).toBe(SHARED_FILLERS);
    expect([...uses.values()].every((count) => count === GROUPS_PER_FILLER)).toBe(true);
    expect(travel(spec, spec.placements, 'g1j')).toBeCloseTo(SLIDER_START, 12);
    // Each group starts violated, so a pass below can only come from actually solving it.
    for (const group of spec.groups) expect(violations(spec, spec.placements, new Set(group)).length).toBeGreaterThan(0);
  });

  it('solves all 120 groups separately, satisfies every joint and gear, and keeps fixed parts in place', () => {
    const spec = build(false), document = documentOf(spec), before = snapshot(document), initial = snapshot(spec.placements);
    const result = solveMates(document, new Map(), spec.placements, { jointFrames: spec.frames });
    expect(result.diagnosis.limits).toEqual([]);
    expect(result.couplingFailure).toBeUndefined();
    expect(result.converged).toBe(true);
    // Shared fixed fillers anchor groups without merging them; gear and ball+revolute pairs stay together.
    expect(result.diagnosis.components.map((c) => c.componentIds)).toEqual(spec.groups);
    expect(Math.max(...result.diagnosis.components.map((c) => c.variables))).toBe(12);
    expect(violations(spec, result.placements)).toEqual([]);
    for (const c of spec.components) if (c.fixed) expect(result.placements.get(c.id)).toEqual(spec.placements.get(c.id));
    expect(snapshot(document)).toBe(before);
    expect(snapshot(spec.placements)).toBe(initial);
  }, 60_000);

  it('drives one slider through the public cooperative flow; a cancelled run publishes nothing and a fresh run succeeds', async () => {
    const spec = build(false), document = documentOf(spec), before = snapshot(document), initial = snapshot(spec.placements);
    const request: JointDriveRequest = { jointId: 'g1j', coordinate: 'translation', value: SLIDER_TARGET, referenceAngle: 0 };
    const options = { jointFrames: spec.frames };
    const queue: (() => void)[] = [];
    const cancelled = runCooperative<SolveDrivenJointOutcome>(
      solveDrivenJointSteps(document, new Map(), spec.placements, request, options, { units: 256 }),
      { schedule: (slice) => { queue.push(slice); }, pointsPerSlice: 8 });
    queue.shift()?.();
    expect(cancelled.progress()).toBeGreaterThan(0);
    cancelled.cancel();
    while (queue.length > 0) queue.shift()?.();
    const stopped = await cancelled.result;
    expect(stopped.status).toBe('cancelled');
    expect(snapshot(document)).toBe(before);
    expect(snapshot(spec.placements)).toBe(initial);

    const fresh = solveDrivenJoint(document, new Map(), spec.placements, request, options);
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) throw new Error(fresh.reason);
    expect(fresh.outcome.converged).toBe(true);
    expect(violations(spec, fresh.placements)).toEqual([]);
    // Signed: +15 along the anchor z, not -15 (the start is +5 on the same side).
    expect(Math.abs(travel(spec, fresh.placements, 'g1j') - SLIDER_TARGET)).toBeLessThan(POSITION);

    const full = runCooperative<SolveDrivenJointOutcome>(
      solveDrivenJointSteps(document, new Map(), spec.placements, request, options, { units: 256 }),
      { schedule: (slice) => { queue.push(slice); }, pointsPerSlice: 8 });
    let slices = 0;
    while (queue.length > 0) {
      slices += 1;
      queue.shift()?.();
    }
    expect(slices).toBeGreaterThan(1);
    expect(await full.result).toEqual({ status: 'completed', value: fresh });
  }, 60_000);

  it('refuses only the connected 101-component chain (606/600) and still solves the 120 small groups', () => {
    const spec = build(true), document = documentOf(spec);
    expect(spec.components.length).toBe(TOTAL);
    const chain = spec.groups[spec.groups.length - 1];
    expect(chain.length).toBe(101);
    const result = solveMates(document, new Map(), spec.placements, { jointFrames: spec.frames });
    expect(result.diagnosis.limits).toEqual([{ scope: 'component', componentIds: chain, variables: 606, maximum: 600 }]);
    expect(result.diagnosis.status).toBe('variableLimit');
    expect(result.converged).toBe(false);
    expect(result.diagnosis.components.map((c) => c.componentIds)).toEqual(spec.groups);
    for (const id of chain) expect(result.placements.get(id)).toEqual(spec.placements.get(id));
    const small = new Set(spec.groups.slice(0, GROUPS).flat());
    expect(violations(spec, result.placements, small)).toEqual([]);
    expect(violations(spec, result.placements, new Set(chain)).length).toBeGreaterThan(0);
  }, 60_000);
});
