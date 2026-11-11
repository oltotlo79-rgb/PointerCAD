import type { ResolveMateTargetOptions } from '../constraints/mateTargets.js';
import { drainRigidSteps, UNLIMITED_RIGID_WORK, type RigidWorkBudget, type RigidWorkPoint } from '../constraints/solveRigid.js';
import type { JointOccurrenceInputs, JointOccurrenceView } from '../jointOccurrence.js';
import { normalizeQuaternion, type RigidPlacement } from '../placementMath.js';
import { relativePlacement } from '../rigidGroups.js';
import type { AssemblyDocument } from '../types.js';
import {
  CROSS_LEVEL_GEAR_TOLERANCE_DEG, crossLevelGearFailureSteps, type CrossLevelGearChildResult,
  type CrossLevelGearChildState, type CrossLevelGearCoupling, type CrossLevelGearFailure,
} from './crossLevelGear.js';
import type { CrossLevelGearDocumentFailureCode } from './crossLevelGearDocument.js';
import { JointDriveWork, solveSubAssemblyJointDriveSteps } from './subAssemblyJointDrive.js';

/** Every reason a cross-level gear refusal can show: the document/drive codes and a motion that cannot carry the group. */
export type CrossLevelGearNoticeCode = CrossLevelGearDocumentFailureCode | 'coupled-motion';

/**
 * Cross-level gears under ANY parent-level motion (EX12): a drive of another joint, a drag or a presentation step can
 * change the angle of a coupled parent joint through a linkage. The relation thetaChild = ratio * thetaParent + phase
 * must then hold on the shown poses too. These helpers find which coupled parent joints a parent-level pose change
 * moved (by the relative pose of the joint's two members, independent of how the motion was produced) and solve every
 * coupled placement of such a joint for the angle the parent reached, as one group: all children or none.
 */

/** Position (mm) and rotation (unit quaternion component) tolerance for "the two members did not move relative to each other". */
export const CROSS_LEVEL_RELATIVE_POSE_TOLERANCE = 1e-9;

function samePose(a: RigidPlacement, b: RigidPlacement): boolean {
  const qa = normalizeQuaternion(a.rotation), qb = normalizeQuaternion(b.rotation);
  // q and -q are the same rotation.
  const dot = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3];
  const sign = dot < 0 ? -1 : 1;
  return a.position.every((value, axis) => Math.abs(value - (b.position[axis] ?? Number.NaN)) <= CROSS_LEVEL_RELATIVE_POSE_TOLERANCE)
    && qa.every((value, index) => Math.abs(value - sign * (qb[index] ?? Number.NaN)) <= CROSS_LEVEL_RELATIVE_POSE_TOLERANCE);
}

/**
 * The parent joints of `couplings` whose two members moved relative to each other between `before` and `after`
 * (each id once, in coupling order). A member missing from either map counts as moved: nothing is assumed.
 */
export function movedCrossLevelParentJoints(document: AssemblyDocument, couplings: readonly CrossLevelGearCoupling[],
  before: ReadonlyMap<string, RigidPlacement>, after: ReadonlyMap<string, RigidPlacement>): readonly string[] {
  const moved: string[] = [];
  for (const parentJointId of new Set(couplings.map(c => c.parentJointId))) {
    const joint = document.joints.find(item => item.id === parentJointId);
    const a0 = joint === undefined ? undefined : before.get(joint.a.componentId);
    const b0 = joint === undefined ? undefined : before.get(joint.b.componentId);
    const a1 = joint === undefined ? undefined : after.get(joint.a.componentId);
    const b1 = joint === undefined ? undefined : after.get(joint.b.componentId);
    if (a0 === undefined || b0 === undefined || a1 === undefined || b1 === undefined
        || !samePose(relativePlacement(b0, a0), relativePlacement(b1, a1))) moved.push(parentJointId);
  }
  return moved;
}

export interface CrossLevelGearFollowInput {
  readonly inputs: JointOccurrenceInputs;
  readonly view: JointOccurrenceView;
  readonly couplings: readonly CrossLevelGearCoupling[];
  readonly parentJointId: string;
  /** The angle (degrees) the parent joint reached through the other motion. */
  readonly parentAngle: number;
  readonly children?: ReadonlyMap<string, CrossLevelGearChildState>;
  readonly targetOptions?: ResolveMateTargetOptions;
}

/**
 * Solves every coupled placement of `parentJointId` to ratio * parentAngle + phase. The parent poses are not touched
 * (the caller's motion produced them). Any child that cannot reach its angle refuses the whole group.
 */
export type CrossLevelGearFollowOutcome =
  { readonly ok: true; readonly group: readonly CrossLevelGearChildResult[] } | CrossLevelGearFailure;

export function solveCrossLevelGearFollow(input: CrossLevelGearFollowInput): CrossLevelGearFollowOutcome {
  return drainRigidSteps(solveCrossLevelGearFollowSteps(input, UNLIMITED_RIGID_WORK));
}

/** Follows every child in order, retaining all results privately until the entire group succeeds. */
export function* solveCrossLevelGearFollowSteps(input: CrossLevelGearFollowInput,
  budget: RigidWorkBudget): Generator<RigidWorkPoint, CrossLevelGearFollowOutcome, void> {
  const work = new JointDriveWork(budget);
  yield* work.boundary();
  const invalid = yield* work.forward(crossLevelGearFailureSteps(input.inputs, input.view, input.couplings, budget));
  if (invalid !== null) return invalid;
  const group: CrossLevelGearCoupling[] = [];
  for (const c of input.couplings) {
    yield* work.checkpoint();
    if (c.parentJointId === input.parentJointId) group.push(c);
  }
  const first = group[0];
  if (first === undefined) return { ok: false, couplingId: input.parentJointId, code: 'missing-coupling' };
  if (!Number.isFinite(input.parentAngle)) return { ok: false, couplingId: first.id, code: 'invalid-value' };
  const results: CrossLevelGearChildResult[] = [];
  for (const member of group) {
    yield* work.boundary();
    const target = member.ratio * input.parentAngle + member.phaseDeg;
    if (!Number.isFinite(target)) return { ok: false, couplingId: member.id, code: 'unrepresentable-coupling' };
    const state = input.children?.get(JSON.stringify(member.child.path));
    const child = yield* work.forward(solveSubAssemblyJointDriveSteps({ inputs: input.inputs, view: input.view, path: member.child.path,
      ...(state?.initial === undefined ? {} : { initial: state.initial }),
      ...(input.targetOptions === undefined ? {} : { targetOptions: input.targetOptions }),
      request: { jointId: member.child.jointId, coordinate: 'angle', value: target,
        referenceAngle: state?.referenceAngle === undefined ? 0 : state.referenceAngle } }, budget));
    if (!child.ok) return { ok: false, couplingId: member.id, code: 'child-solve-failed' };
    if (child.driven.atLimit || Math.abs(child.driven.actual - target) > CROSS_LEVEL_GEAR_TOLERANCE_DEG) {
      return { ok: false, couplingId: member.id, code: 'child-at-limit' };
    }
    results.push({ couplingId: member.id, path: child.path, jointId: member.child.jointId, outcome: child, angle: child.driven.actual });
    yield* work.boundary();
  }
  return { ok: true, group: results };
}
