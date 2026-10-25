import type { MateResidualTargetPair } from '../constraints/mateResiduals.js';
import { solveDrivenJointSteps, type SolveDrivenJointOutcome, type SolveMatesOptions } from '../constraints/solveMates.js';
import { drainRigidSteps, UNLIMITED_RIGID_WORK, type RigidWorkBudget, type RigidWorkPoint } from '../constraints/solveRigid.js';
import type { ResolveMateTargetOptions } from '../constraints/mateTargets.js';
import type { JointOccurrenceInputs, JointOccurrencePath, JointOccurrenceView } from '../jointOccurrence.js';
import type { RigidPlacement } from '../placementMath.js';
import type { AssemblyDocument } from '../types.js';
import { camFollowerLift } from './camFollower.js';
import type { CrossLevelGearCoupling, CrossLevelGearFailureCode } from './crossLevelGear.js';
import { JointDriveWork, resolveSubAssemblyOccurrenceSteps, solveSubAssemblyJointDriveSteps,
  type SubAssemblyJointDriveOutcome } from './subAssemblyJointDrive.js';

/**
 * Cross-level cam (EX12), model contract only: the disc cam of the same-level relation (camFollower.ts, eccentric
 * circular disc R with eccentricity e and roller r) on a revolute joint of the top-level assembly, driving the slider
 * of ONE subassembly placement (typed occurrence path). The same-level relation infers the follower side and offset
 * from a shared support and an in-line check; across levels there is no shared component, so the law is authored:
 * with rho(theta) = e cos(theta - phase) + sqrt((R + r)^2 - e^2 sin^2(theta - phase)) (camFollowerLift), the child
 * slider translation is x = direction * (rho(theta) + offsetMm), the same "distance = direction * x - offset" relation.
 * Contact of the CAD bodies is not checked (as for the same-level cam: the dimensions, not certified contact).
 *
 * Supported: driving the cam (parent) side; the child follows to its law or the whole drive is refused. The follower
 * side is refused explicitly: rho is not one-to-one over a turn, so a follower position does not give one cam angle.
 * A cam parent joint may not also carry a cross-level gear or a same-level gear/cam, and one placement takes one
 * relation. Saving, editing UI and the ordinary-motion follow are not part of this contract yet.
 */
export interface CrossLevelCamCoupling {
  readonly id: string;
  readonly camJointId: string;
  readonly child: { readonly path: readonly string[]; readonly jointId: string };
  readonly discRadiusMm: number;
  readonly eccentricityMm: number;
  readonly rollerRadiusMm: number;
  readonly phaseDeg: number;
  readonly direction: 1 | -1;
  readonly offsetMm: number;
}

export type CrossLevelCamFailureCode = CrossLevelGearFailureCode | 'invalid-cam-dimensions' | 'invalid-offset'
  | 'unsupported-follower-drive';

export interface CrossLevelCamFailure {
  readonly ok: false;
  readonly couplingId: string;
  readonly code: CrossLevelCamFailureCode;
}

export type CrossLevelCamDriveOutcome = {
  readonly ok: true;
  readonly couplingId: string;
  readonly path: JointOccurrencePath;
  readonly parent: Extract<SolveDrivenJointOutcome, { readonly ok: true }>;
  readonly child: Extract<SubAssemblyJointDriveOutcome, { readonly ok: true }>;
  readonly camAngle: number;
  /** The reached child slider translation (mm), equal to the law within the drive tolerance. */
  readonly followerTranslation: number;
} | CrossLevelCamFailure;

/** mm; the slider drive tolerance with solver slack. */
export const CROSS_LEVEL_CAM_TOLERANCE_MM = 1e-6;

const finite = (value: number): boolean => typeof value === 'number' && Number.isFinite(value);
const failure = (couplingId: string, code: CrossLevelCamFailureCode): CrossLevelCamFailure => ({ ok: false, couplingId, code });

function* singleSteps(document: AssemblyDocument, jointId: string, kind: 'revolute' | 'slider', work: JointDriveWork):
  Generator<RigidWorkPoint, 'missing' | 'duplicate' | 'unsupported' | 'ok', void> {
  const matches: AssemblyDocument['joints'][number][] = [];
  for (const joint of document.joints) {
    yield* work.checkpoint();
    if (joint.id === jointId) matches.push(joint);
  }
  const joint = matches[0];
  if (joint === undefined || joint.suppressed) return 'missing';
  if (matches.length > 1) return 'duplicate';
  return joint.kind === kind ? 'ok' : 'unsupported';
}

/** The follower translation (mm) the law gives at cam angle thetaDeg. */
export function crossLevelCamTranslation(c: CrossLevelCamCoupling, thetaDeg: number): number {
  return c.direction * (camFollowerLift(c, thetaDeg) + c.offsetMm);
}

/** Checks the cam set (and its interplay with the cross-level gears) before any drive; nothing is repaired. */
export function crossLevelCamFailure(inputs: JointOccurrenceInputs, view: JointOccurrenceView,
  cams: readonly CrossLevelCamCoupling[], gears: readonly CrossLevelGearCoupling[] = []): CrossLevelCamFailure | null {
  return drainRigidSteps(crossLevelCamFailureSteps(inputs, view, cams, gears, UNLIMITED_RIGID_WORK));
}

/** Scan cam/gear admission and occurrence identity without an unbounded preparation slice. */
export function* crossLevelCamFailureSteps(inputs: JointOccurrenceInputs, view: JointOccurrenceView,
  cams: readonly CrossLevelCamCoupling[], gears: readonly CrossLevelGearCoupling[], budget: RigidWorkBudget):
  Generator<RigidWorkPoint, CrossLevelCamFailure | null, void> {
  const work = new JointDriveWork(budget);
  const document = inputs.document;
  const ids = new Set<string>(), occurrences = new Set<string>(), busyParents = new Set<string>();
  for (const g of gears) {
    yield* work.checkpoint();
    ids.add(g.id); occurrences.add(JSON.stringify(g.child.path)); busyParents.add(g.parentJointId);
  }
  for (const c of document.mechanismCouplings ?? []) {
    yield* work.checkpoint();
    if (!c.suppressed) { busyParents.add(c.jointAId); busyParents.add(c.jointBId); }
  }
  for (const c of document.camCouplings ?? []) {
    yield* work.checkpoint();
    if (!c.suppressed) { busyParents.add(c.camJointId); busyParents.add(c.followerJointId); }
  }
  for (const c of cams) {
    yield* work.checkpoint();
    if (ids.has(c.id)) return failure(c.id, 'duplicate-coupling');
    ids.add(c.id);
    const reach = c.discRadiusMm + c.rollerRadiusMm;
    if (!finite(c.discRadiusMm) || !finite(c.eccentricityMm) || !finite(c.rollerRadiusMm) || c.discRadiusMm <= 0
        || c.rollerRadiusMm < 0 || c.eccentricityMm < 0 || c.eccentricityMm >= reach) return failure(c.id, 'invalid-cam-dimensions');
    if (!finite(c.phaseDeg)) return failure(c.id, 'invalid-phase');
    if (!finite(c.offsetMm) || (c.direction !== 1 && c.direction !== -1)) return failure(c.id, 'invalid-offset');
    const parent = yield* singleSteps(document, c.camJointId, 'revolute', work);
    if (parent !== 'ok') return failure(c.id, parent === 'missing' ? 'missing-parent-joint'
      : parent === 'duplicate' ? 'duplicate-parent-joint' : 'unsupported-parent-joint');
    if (busyParents.has(c.camJointId)) return failure(c.id, 'coupled-parent-joint');
    busyParents.add(c.camJointId);
    const found = yield* work.forward(resolveSubAssemblyOccurrenceSteps(inputs, view, c.child.path, budget));
    if (!found.ok) return failure(c.id, found.code);
    const key = JSON.stringify(found.occurrence.path);
    if (occurrences.has(key)) return failure(c.id, 'duplicate-occurrence');
    occurrences.add(key);
    const child = yield* singleSteps(found.occurrence.document, c.child.jointId, 'slider', work);
    if (child !== 'ok') return failure(c.id, child === 'unsupported' ? 'unsupported-child-joint' : 'missing-child-joint');
  }
  return null;
}

export interface CrossLevelCamDriveInput {
  readonly inputs: JointOccurrenceInputs;
  readonly view: JointOccurrenceView;
  readonly cams: readonly CrossLevelCamCoupling[];
  readonly gears?: readonly CrossLevelGearCoupling[];
  readonly couplingId: string;
  readonly drive: { readonly side: 'cam' | 'follower'; readonly value: number };
  readonly parent: { readonly targets: ReadonlyMap<string, MateResidualTargetPair>; readonly initial: ReadonlyMap<string, RigidPlacement>;
    readonly options: SolveMatesOptions; readonly referenceAngle?: number };
  readonly child?: { readonly initial?: ReadonlyMap<string, RigidPlacement>; readonly targetOptions?: ResolveMateTargetOptions };
}

/** Drives a cross-level cam from the cam side: the parent joint first, then the child slider to the law. */
export function solveCrossLevelCamDrive(input: CrossLevelCamDriveInput): CrossLevelCamDriveOutcome {
  return drainRigidSteps(solveCrossLevelCamDriveSteps(input, UNLIMITED_RIGID_WORK));
}

/** Only a completed parent and follower produce an outcome; runCooperative owns cancellation. */
export function* solveCrossLevelCamDriveSteps(input: CrossLevelCamDriveInput,
  budget: RigidWorkBudget): Generator<RigidWorkPoint, CrossLevelCamDriveOutcome, void> {
  const work = new JointDriveWork(budget);
  yield* work.boundary();
  const invalid = yield* work.forward(crossLevelCamFailureSteps(input.inputs, input.view, input.cams, input.gears ?? [], budget));
  if (invalid !== null) return invalid;
  let cam: CrossLevelCamCoupling | undefined;
  for (const c of input.cams) {
    yield* work.checkpoint();
    if (c.id === input.couplingId) { cam = c; break; }
  }
  if (cam === undefined) return failure(input.couplingId, 'missing-coupling');
  if (input.drive.side === 'follower') return failure(cam.id, 'unsupported-follower-drive');
  if (!finite(input.drive.value)) return failure(cam.id, 'invalid-value');
  yield* work.boundary();
  const parent = yield* work.forward(solveDrivenJointSteps(input.inputs.document, input.parent.targets, input.parent.initial,
    { jointId: cam.camJointId, coordinate: 'angle', value: input.drive.value,
      referenceAngle: input.parent.referenceAngle === undefined ? 0 : input.parent.referenceAngle }, input.parent.options, budget));
  yield* work.boundary();
  if (!parent.ok) return failure(cam.id, 'parent-solve-failed');
  const camAngle = parent.atLimit ? parent.target : parent.actual;
  if (!finite(camAngle)) return failure(cam.id, 'parent-solve-failed');
  const target = crossLevelCamTranslation(cam, camAngle);
  if (!finite(target)) return failure(cam.id, 'unrepresentable-coupling');
  yield* work.boundary();
  const child = yield* work.forward(solveSubAssemblyJointDriveSteps({ inputs: input.inputs, view: input.view, path: cam.child.path,
    ...(input.child?.initial === undefined ? {} : { initial: input.child.initial }),
    ...(input.child?.targetOptions === undefined ? {} : { targetOptions: input.child.targetOptions }),
    request: { jointId: cam.child.jointId, coordinate: 'translation', value: target } }, budget));
  if (!child.ok) return failure(cam.id, 'child-solve-failed');
  if (child.driven.atLimit || Math.abs(child.driven.actual - target) > CROSS_LEVEL_CAM_TOLERANCE_MM) return failure(cam.id, 'child-at-limit');
  yield* work.boundary();
  return { ok: true, couplingId: cam.id, path: child.path, parent, child, camAngle, followerTranslation: child.driven.actual };
}
