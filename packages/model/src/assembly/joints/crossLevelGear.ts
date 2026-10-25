import type { MateResidualTargetPair } from '../constraints/mateResiduals.js';
import { solveDrivenJointSteps, type SolveDrivenJointOutcome, type SolveMatesOptions } from '../constraints/solveMates.js';
import { drainRigidSteps, UNLIMITED_RIGID_WORK, type RigidWorkBudget, type RigidWorkPoint } from '../constraints/solveRigid.js';
import type { ResolveMateTargetOptions } from '../constraints/mateTargets.js';
import type { JointOccurrenceFailureCode, JointOccurrenceInputs, JointOccurrencePath, JointOccurrenceView } from '../jointOccurrence.js';
import type { RigidPlacement } from '../placementMath.js';
import type { AssemblyDocument } from '../types.js';
import { JointDriveWork, resolveSubAssemblyOccurrenceSteps, solveSubAssemblyJointDriveSteps,
  type SubAssemblyJointDriveOutcome } from './subAssemblyJointDrive.js';

/**
 * Cross-level gear (EX12): a revolute joint of the top-level assembly coupled to a revolute joint inside ONE
 * subassembly placement (typed occurrence path, never a flattened row id), with the gear relation of
 * GearRatioCoupling taking the parent joint as A: thetaChild = ratio * thetaParent + phaseDeg (degrees).
 *
 * The parent solve keeps every subassembly rigid and parent joints only target top-level components, so the motion
 * inside a placement never changes the parent's constraints, and moving the parent never changes a child-relative
 * joint value. The two systems are therefore solved one after the other with the existing public drives: the parent
 * joint (solveDrivenJoint) first, then the child joint of each coupled placement (solveSubAssemblyJointDrive) to the
 * angle the relation gives for the parent's reached angle. Both results are transient motion: nothing here writes a
 * document.
 *
 * One parent joint may drive several placements (one coupling each). Moving that parent moves ALL of them as one
 * group: the parent once, then every coupled child; if any child cannot follow, the whole drive is refused, so a shown
 * state never leaves a saved relation unsatisfied. Supported graph only: each placement has at most one cross-level
 * coupling, and the parent joint takes part in no top-level gear or cam coupling. Everything else is refused with an
 * explicit code.
 */
export interface CrossLevelGearCoupling {
  readonly id: string;
  readonly parentJointId: string;
  readonly child: { readonly path: readonly string[]; readonly jointId: string };
  readonly ratio: number;
  readonly phaseDeg: number;
}

export type CrossLevelGearFailureCode = JointOccurrenceFailureCode
  | 'duplicate-coupling' | 'duplicate-occurrence' | 'invalid-ratio' | 'invalid-phase' | 'unrepresentable-coupling'
  | 'missing-parent-joint' | 'duplicate-parent-joint' | 'unsupported-parent-joint' | 'coupled-parent-joint'
  | 'missing-child-joint' | 'unsupported-child-joint' | 'missing-coupling' | 'invalid-value'
  | 'parent-solve-failed' | 'child-solve-failed' | 'child-at-limit';

export interface CrossLevelGearFailure {
  readonly ok: false;
  readonly couplingId: string;
  readonly code: CrossLevelGearFailureCode;
}

/** The shown child placements and angle reference of one placement (an earlier drive), keyed by its occurrence key. */
export interface CrossLevelGearChildState {
  readonly initial?: ReadonlyMap<string, RigidPlacement>;
  readonly referenceAngle?: number;
}

export interface CrossLevelGearDriveInput {
  readonly inputs: JointOccurrenceInputs;
  readonly view: JointOccurrenceView;
  readonly couplings: readonly CrossLevelGearCoupling[];
  readonly couplingId: string;
  /** Which side the user drives (of the coupling `couplingId`), and its angle in degrees. */
  readonly drive: { readonly side: 'parent' | 'child'; readonly value: number };
  /** The parent's solver inputs, exactly as the top-level joint drive passes them. */
  readonly parent: {
    readonly targets: ReadonlyMap<string, MateResidualTargetPair>;
    readonly initial: ReadonlyMap<string, RigidPlacement>;
    readonly options: SolveMatesOptions;
    readonly referenceAngle?: number;
  };
  /** Shown state of the driven coupling's placement (kept for single-coupling callers). */
  readonly child?: CrossLevelGearChildState & { readonly targetOptions?: ResolveMateTargetOptions };
  /** Shown state of every coupled placement by occurrence key (JSON of the path); wins over `child`. */
  readonly children?: ReadonlyMap<string, CrossLevelGearChildState>;
  readonly targetOptions?: ResolveMateTargetOptions;
}

/** One coupled placement of the moved parent, solved to the relation. */
export interface CrossLevelGearChildResult {
  readonly couplingId: string;
  readonly path: JointOccurrencePath;
  readonly jointId: string;
  readonly outcome: Extract<SubAssemblyJointDriveOutcome, { readonly ok: true }>;
  readonly angle: number;
}

export type CrossLevelGearDriveOutcome = {
  readonly ok: true;
  readonly couplingId: string;
  /** The driven coupling's placement (also the first entry of `group`). */
  readonly path: JointOccurrencePath;
  readonly parent: Extract<SolveDrivenJointOutcome, { readonly ok: true }>;
  readonly child: Extract<SubAssemblyJointDriveOutcome, { readonly ok: true }>;
  /** Reached angles (degrees); childAngle = ratio * parentAngle + phaseDeg within the drive tolerance. */
  readonly parentAngle: number;
  readonly childAngle: number;
  /** Every coupling of the same parent joint, driven coupling first, each at its own relation. */
  readonly group: readonly CrossLevelGearChildResult[];
} | CrossLevelGearFailure;

/** Degrees; the same order as the drive tolerance of an angle driver (1e-9 degree rows) with solver slack. */
export const CROSS_LEVEL_GEAR_TOLERANCE_DEG = 1e-6;

const finite = (value: number): boolean => typeof value === 'number' && Number.isFinite(value);
const failure = (couplingId: string, code: CrossLevelGearFailureCode): CrossLevelGearFailure => ({ ok: false, couplingId, code });

function* revoluteSteps(document: AssemblyDocument, jointId: string, work: JointDriveWork):
  Generator<RigidWorkPoint, 'missing' | 'duplicate' | 'unsupported' | 'ok', void> {
  const matches: AssemblyDocument['joints'][number][] = [];
  for (const joint of document.joints) {
    yield* work.checkpoint();
    if (joint.id === jointId) matches.push(joint);
  }
  const joint = matches[0];
  if (joint === undefined || joint.suppressed) return 'missing';
  if (matches.length > 1) return 'duplicate';
  return joint.kind === 'revolute' ? 'ok' : 'unsupported';
}

/** Checks the whole set before any drive; the first refusal is returned, nothing is repaired or skipped. */
export function crossLevelGearFailure(inputs: JointOccurrenceInputs, view: JointOccurrenceView,
  couplings: readonly CrossLevelGearCoupling[]): CrossLevelGearFailure | null {
  return drainRigidSteps(crossLevelGearFailureSteps(inputs, view, couplings, UNLIMITED_RIGID_WORK));
}

/** Admission of the complete relation set is cancellable too; the first refusal keeps its original precedence. */
export function* crossLevelGearFailureSteps(inputs: JointOccurrenceInputs, view: JointOccurrenceView,
  couplings: readonly CrossLevelGearCoupling[], budget: RigidWorkBudget): Generator<RigidWorkPoint, CrossLevelGearFailure | null, void> {
  const work = new JointDriveWork(budget);
  const ids = new Set<string>(), occurrences = new Set<string>();
  const document = inputs.document;
  const coupledParents = new Set<string>();
  for (const c of document.mechanismCouplings ?? []) {
    yield* work.checkpoint();
    if (!c.suppressed) { coupledParents.add(c.jointAId); coupledParents.add(c.jointBId); }
  }
  for (const c of document.camCouplings ?? []) {
    yield* work.checkpoint();
    if (!c.suppressed) { coupledParents.add(c.camJointId); coupledParents.add(c.followerJointId); }
  }
  for (const c of couplings) {
    yield* work.checkpoint();
    if (ids.has(c.id)) return failure(c.id, 'duplicate-coupling');
    ids.add(c.id);
    if (!finite(c.ratio) || c.ratio === 0) return failure(c.id, 'invalid-ratio');
    if (!finite(c.phaseDeg)) return failure(c.id, 'invalid-phase');
    if (!finite(1 / c.ratio) || !finite(-c.phaseDeg / c.ratio)) return failure(c.id, 'unrepresentable-coupling');
    const parent = yield* revoluteSteps(document, c.parentJointId, work);
    if (parent !== 'ok') return failure(c.id, parent === 'missing' ? 'missing-parent-joint'
      : parent === 'duplicate' ? 'duplicate-parent-joint' : 'unsupported-parent-joint');
    if (coupledParents.has(c.parentJointId)) return failure(c.id, 'coupled-parent-joint');
    const found = yield* work.forward(resolveSubAssemblyOccurrenceSteps(inputs, view, c.child.path, budget));
    if (!found.ok) return failure(c.id, found.code);
    const key = JSON.stringify(found.occurrence.path);
    if (occurrences.has(key)) return failure(c.id, 'duplicate-occurrence');
    occurrences.add(key);
    const child = yield* revoluteSteps(found.occurrence.document, c.child.jointId, work);
    if (child !== 'ok') return failure(c.id, child === 'unsupported' ? 'unsupported-child-joint' : 'missing-child-joint');
  }
  return null;
}

/** The cross-level couplings that move with `parentJointId` (in the given order). */
export function crossLevelGearGroup(couplings: readonly CrossLevelGearCoupling[], parentJointId: string): readonly CrossLevelGearCoupling[] {
  return couplings.filter(c => c.parentJointId === parentJointId);
}

/**
 * Drives one cross-level gear from either side, with every other coupling of the same parent joint: the parent joint
 * first (to the requested angle, or to the angle the inverse relation of the driven coupling gives for a requested
 * child angle), then the child joint of each coupled placement to ratio * reachedParentAngle + phaseDeg. A child that
 * cannot reach its angle refuses the whole drive (no partial result), so a shown group always satisfies every relation.
 */
export function solveCrossLevelGearDrive(input: CrossLevelGearDriveInput): CrossLevelGearDriveOutcome {
  return drainRigidSteps(solveCrossLevelGearDriveSteps(input, UNLIMITED_RIGID_WORK));
}

/** Parent first, then each child in group order; cancellation discards the whole unpublished group. */
export function* solveCrossLevelGearDriveSteps(input: CrossLevelGearDriveInput,
  budget: RigidWorkBudget): Generator<RigidWorkPoint, CrossLevelGearDriveOutcome, void> {
  const work = new JointDriveWork(budget);
  yield* work.boundary();
  const invalid = yield* work.forward(crossLevelGearFailureSteps(input.inputs, input.view, input.couplings, budget));
  if (invalid !== null) return invalid;
  let coupling: CrossLevelGearCoupling | undefined;
  for (const c of input.couplings) {
    yield* work.checkpoint();
    if (c.id === input.couplingId) { coupling = c; break; }
  }
  if (coupling === undefined) return failure(input.couplingId, 'missing-coupling');
  if (!finite(input.drive.value)) return failure(coupling.id, 'invalid-value');
  const parentTarget = input.drive.side === 'parent' ? input.drive.value : (input.drive.value - coupling.phaseDeg) / coupling.ratio;
  if (!finite(parentTarget)) return failure(coupling.id, 'unrepresentable-coupling');
  yield* work.boundary();
  const parent = yield* work.forward(solveDrivenJointSteps(input.inputs.document, input.parent.targets, input.parent.initial,
    { jointId: coupling.parentJointId, coordinate: 'angle', value: parentTarget,
      referenceAngle: input.parent.referenceAngle === undefined ? 0 : input.parent.referenceAngle }, input.parent.options, budget));
  yield* work.boundary();
  if (!parent.ok) return failure(coupling.id, 'parent-solve-failed');
  const parentAngle = parent.atLimit ? parent.target : parent.actual;
  const targetOptions = input.targetOptions ?? input.child?.targetOptions;
  const group = [coupling];
  for (const c of input.couplings) {
    yield* work.checkpoint();
    if (c.parentJointId === coupling.parentJointId && c.id !== coupling.id) group.push(c);
  }
  const results: CrossLevelGearChildResult[] = [];
  for (const member of group) {
    yield* work.boundary();
    const target = member.ratio * parentAngle + member.phaseDeg;
    if (!finite(target)) return failure(member.id, 'unrepresentable-coupling');
    const state = input.children?.get(JSON.stringify(member.child.path)) ?? (member === coupling ? input.child : undefined);
    const child = yield* work.forward(solveSubAssemblyJointDriveSteps({ inputs: input.inputs, view: input.view, path: member.child.path,
      ...(state?.initial === undefined ? {} : { initial: state.initial }),
      ...(targetOptions === undefined ? {} : { targetOptions }),
      request: { jointId: member.child.jointId, coordinate: 'angle', value: target,
        referenceAngle: state?.referenceAngle === undefined ? 0 : state.referenceAngle } }, budget));
    if (!child.ok) return failure(member.id, 'child-solve-failed');
    if (child.driven.atLimit || Math.abs(child.driven.actual - target) > CROSS_LEVEL_GEAR_TOLERANCE_DEG) {
      return failure(member.id, 'child-at-limit');
    }
    results.push({ couplingId: member.id, path: child.path, jointId: member.child.jointId, outcome: child, angle: child.driven.actual });
    yield* work.boundary();
  }
  const first = results[0];
  if (first === undefined) return failure(coupling.id, 'missing-coupling');
  return { ok: true, couplingId: coupling.id, path: first.path, parent, child: first.outcome, parentAngle, childAngle: first.angle, group: results };
}
