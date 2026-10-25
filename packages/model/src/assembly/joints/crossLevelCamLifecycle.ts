import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import type { ResolveMateTargetOptions } from '../constraints/mateTargets.js';
import { drainRigidSteps, UNLIMITED_RIGID_WORK, type RigidWorkBudget, type RigidWorkPoint } from '../constraints/solveRigid.js';
import { jointOccurrencePath, type JointOccurrenceInputs, type JointOccurrencePath, type JointOccurrenceView } from '../jointOccurrence.js';
import type { RigidPlacement } from '../placementMath.js';
import { assemblyExpressionContext, MAX_SUB_ASSEMBLY_DEPTH } from '../resolveAssembly.js';
import type { AssemblyDocument } from '../types.js';
import {
  CROSS_LEVEL_CAM_TOLERANCE_MM, crossLevelCamFailureSteps, crossLevelCamTranslation, type CrossLevelCamCoupling,
  type CrossLevelCamFailure, type CrossLevelCamFailureCode,
} from './crossLevelCam.js';
import { JointDriveWork, solveSubAssemblyJointDriveSteps, type SubAssemblyJointDriveOutcome } from './subAssemblyJointDrive.js';

/**
 * Saved cross-level cam (EX12): the authored definition behind CrossLevelCamCoupling (crossLevelCam.ts), stored like
 * the same-level MechanismCamCoupling (expressions and ids only, never a solved angle or pose). `offsetMm` and
 * `direction` are an AUTHORED LAW chosen by the user: the follower translation is direction * (rho(theta) + offset).
 * Nothing checks that the CAD bodies touch across the levels (the same-level cam's shared-support and in-line checks
 * do not exist across levels), so a saved cam never claims validated contact.
 */
export interface CrossLevelCamCouplingDefinition {
  readonly id: string;
  readonly kind: 'crossLevelCam';
  readonly camJointId: string;
  readonly childPath: readonly string[];
  readonly childJointId: string;
  readonly discRadiusMm: ExpressionValue;
  readonly eccentricityMm: ExpressionValue;
  readonly rollerRadiusMm: ExpressionValue;
  readonly phaseDeg: ExpressionValue;
  readonly offsetMm: ExpressionValue;
  readonly direction: 1 | -1;
  readonly suppressed: boolean;
}

/** The saved kinds (the file reader's readLiteral list). */
export const CROSS_LEVEL_CAM_KINDS: readonly CrossLevelCamCouplingDefinition['kind'][] = ['crossLevelCam'];

export type CrossLevelCamDocumentFailureCode = CrossLevelCamFailureCode | 'invalid-expression' | 'invalid-id';

export interface CrossLevelCamDocumentFailure {
  readonly couplingId: string;
  readonly code: CrossLevelCamDocumentFailureCode;
}

const finite = (value: number): boolean => typeof value === 'number' && Number.isFinite(value);
const failure = (couplingId: string, code: CrossLevelCamDocumentFailureCode): CrossLevelCamDocumentFailure => ({ couplingId, code });

type Evaluated = { readonly ok: true; readonly cam: CrossLevelCamCoupling } | { readonly ok: false; readonly failure: CrossLevelCamDocumentFailure };

function evaluateOne(document: AssemblyDocument, c: CrossLevelCamCouplingDefinition): Evaluated {
  const context = assemblyExpressionContext(document);
  const values = [c.discRadiusMm, c.eccentricityMm, c.rollerRadiusMm, c.phaseDeg, c.offsetMm].map(value => evaluateExpression(value.source, context));
  const numbers: number[] = [];
  for (const value of values) {
    if (!value.ok || !finite(value.value.value)) return { ok: false, failure: failure(c.id, 'invalid-expression') };
    numbers.push(value.value.value);
  }
  const [discRadiusMm = Number.NaN, eccentricityMm = Number.NaN, rollerRadiusMm = Number.NaN, phaseDeg = Number.NaN, offsetMm = Number.NaN] = numbers;
  return { ok: true, cam: { id: c.id, camJointId: c.camJointId, child: { path: [...c.childPath], jointId: c.childJointId },
    discRadiusMm, eccentricityMm, rollerRadiusMm, phaseDeg, direction: c.direction, offsetMm } };
}

/** Evaluates the authored expressions of the active definitions; a bad expression is a refusal, never a stale number. */
export function evaluateCrossLevelCamCouplings(document: AssemblyDocument):
  { readonly ok: true; readonly cams: readonly CrossLevelCamCoupling[] } | ({ readonly ok: false } & CrossLevelCamDocumentFailure) {
  const cams: CrossLevelCamCoupling[] = [];
  for (const c of document.crossLevelCamCouplings ?? []) {
    if (c.suppressed) continue;
    const evaluated = evaluateOne(document, c);
    if (!evaluated.ok) return { ok: false, ...evaluated.failure };
    cams.push(evaluated.cam);
  }
  return { ok: true, cams };
}

/**
 * What one document can check on its own: ids (unique among every coupling kind), expressions, dimensions, offset,
 * direction, the cam joint (one revolute, not in a same-level gear/cam, not the parent of a cross-level gear) and the
 * first path element; one active relation per placement across cross-level gears and cams.
 */
export function crossLevelCamDocumentFailure(document: AssemblyDocument): CrossLevelCamDocumentFailure | null {
  const definitions = document.crossLevelCamCouplings ?? [];
  if (definitions.length === 0) return null;
  const otherIds = new Set([...(document.mechanismCouplings ?? []), ...(document.camCouplings ?? []),
    ...(document.crossLevelGearCouplings ?? [])].map(c => c.id));
  const busyParents = new Set([
    ...(document.mechanismCouplings ?? []).filter(c => !c.suppressed).flatMap(c => [c.jointAId, c.jointBId]),
    ...(document.camCouplings ?? []).filter(c => !c.suppressed).flatMap(c => [c.camJointId, c.followerJointId]),
    ...(document.crossLevelGearCouplings ?? []).filter(c => !c.suppressed).map(c => c.parentJointId),
  ]);
  const occurrences = new Set((document.crossLevelGearCouplings ?? []).filter(c => !c.suppressed).map(c => JSON.stringify(c.childPath)));
  const ids = new Set<string>();
  for (const c of definitions) {
    if (c.id.length === 0 || otherIds.has(c.id)) return failure(c.id, 'invalid-id');
    if (ids.has(c.id)) return failure(c.id, 'duplicate-coupling');
    ids.add(c.id);
    const evaluated = evaluateOne(document, c);
    if (!evaluated.ok) return evaluated.failure;
    const cam = evaluated.cam, reach = cam.discRadiusMm + cam.rollerRadiusMm;
    if (cam.discRadiusMm <= 0 || cam.rollerRadiusMm < 0 || cam.eccentricityMm < 0 || cam.eccentricityMm >= reach) {
      return failure(c.id, 'invalid-cam-dimensions');
    }
    if (c.direction !== 1 && c.direction !== -1) return failure(c.id, 'invalid-offset');
    const parents = document.joints.filter(joint => joint.id === c.camJointId);
    if (parents.length === 0) return failure(c.id, 'missing-parent-joint');
    if (parents.length > 1) return failure(c.id, 'duplicate-parent-joint');
    if (parents[0]?.kind !== 'revolute') return failure(c.id, 'unsupported-parent-joint');
    const path = jointOccurrencePath(c.childPath);
    if (path === null) return failure(c.id, 'invalid-path');
    if (path.length > MAX_SUB_ASSEMBLY_DEPTH) return failure(c.id, 'depth-exceeded');
    if (c.childJointId.length === 0) return failure(c.id, 'missing-child-joint');
    const tops = document.components.filter(component => component.id === path[0]);
    if (tops.length === 0) return failure(c.id, 'missing-component');
    if (tops.length > 1) return failure(c.id, 'ambiguous-component');
    if (tops[0]?.source.kind !== 'subAssembly') return failure(c.id, 'not-subassembly');
    if (c.suppressed) continue;
    if (parents[0].suppressed) return failure(c.id, 'missing-parent-joint');
    if (busyParents.has(c.camJointId)) return failure(c.id, 'coupled-parent-joint');
    busyParents.add(c.camJointId);
    const key = JSON.stringify(path);
    if (occurrences.has(key)) return failure(c.id, 'duplicate-occurrence');
    occurrences.add(key);
  }
  return null;
}

/** The rest, with the embedded subassemblies: every path element, no cycle, and one slider child joint. */
export function crossLevelCamTreeFailure(document: AssemblyDocument,
  assemblies: ReadonlyMap<string, AssemblyDocument>): CrossLevelCamDocumentFailure | null {
  const local = crossLevelCamDocumentFailure(document);
  if (local !== null) return local;
  for (const c of document.crossLevelCamCouplings ?? []) {
    let current = document;
    const ancestors = new Set<string>();
    for (const id of c.childPath) {
      const matches = current.components.filter(component => component.id === id);
      const component = matches[0];
      if (component === undefined) return failure(c.id, 'missing-component');
      if (matches.length > 1) return failure(c.id, 'ambiguous-component');
      if (component.source.kind !== 'subAssembly') return failure(c.id, 'not-subassembly');
      const ref = component.source.assemblyRef;
      if (ancestors.has(ref)) return failure(c.id, 'cyclic-path');
      ancestors.add(ref);
      const child = assemblies.get(ref);
      if (child === undefined) return failure(c.id, 'missing-subassembly');
      current = child;
    }
    const joints = current.joints.filter(joint => joint.id === c.childJointId);
    const joint = joints[0];
    if (joint === undefined || joints.length > 1 || (!c.suppressed && joint.suppressed)) return failure(c.id, 'missing-child-joint');
    if (joint.kind !== 'slider') return failure(c.id, 'unsupported-child-joint');
  }
  return null;
}

/** What an edit did to one saved cross-level cam (the same report as the gears'). */
export interface CrossLevelCamRepair extends CrossLevelCamDocumentFailure {
  readonly action: 'suspended' | 'removed';
}

/**
 * Keeps the saved cross-level cams of an edited document readable, in order with those already kept, exactly like
 * pruneCrossLevelGears: kept, kept suspended, or removed, every change reported; an unchanged document is returned as
 * the same object.
 */
export function pruneCrossLevelCams(document: AssemblyDocument, assemblies: ReadonlyMap<string, AssemblyDocument>):
  { readonly document: AssemblyDocument; readonly repairs: readonly CrossLevelCamRepair[] } {
  const definitions = document.crossLevelCamCouplings;
  if (definitions === undefined || definitions.length === 0) return { document, repairs: [] };
  const kept: CrossLevelCamCouplingDefinition[] = [], repairs: CrossLevelCamRepair[] = [];
  const check = (candidate: CrossLevelCamCouplingDefinition) =>
    crossLevelCamTreeFailure({ ...document, crossLevelCamCouplings: [...kept, candidate] }, assemblies);
  for (const c of definitions) {
    const problem = check(c);
    if (problem === null) { kept.push(c); continue; }
    const inactive: CrossLevelCamCouplingDefinition = { ...c, suppressed: true };
    if (!c.suppressed && check(inactive) === null) {
      kept.push(inactive);
      repairs.push({ couplingId: c.id, code: problem.code, action: 'suspended' });
      continue;
    }
    repairs.push({ couplingId: c.id, code: problem.code, action: 'removed' });
  }
  return repairs.length === 0 ? { document, repairs } : { document: { ...document, crossLevelCamCouplings: kept }, repairs };
}

/**
 * The child slider of one cam placed at the law value for a cam angle reached by another motion (the parent poses
 * are the caller's). Refused (no result) when the slider cannot reach it.
 */
export interface CrossLevelCamFollowInput {
  readonly inputs: JointOccurrenceInputs;
  readonly view: JointOccurrenceView;
  readonly cams: readonly CrossLevelCamCoupling[];
  readonly couplingId: string;
  readonly camAngle: number;
  readonly initial?: ReadonlyMap<string, RigidPlacement>;
  readonly targetOptions?: ResolveMateTargetOptions;
}

export type CrossLevelCamFollowOutcome = {
  readonly ok: true;
  readonly path: JointOccurrencePath;
  readonly outcome: Extract<SubAssemblyJointDriveOutcome, { readonly ok: true }>;
  readonly translation: number;
} | CrossLevelCamFailure;

export function solveCrossLevelCamFollow(input: CrossLevelCamFollowInput): CrossLevelCamFollowOutcome {
  return drainRigidSteps(solveCrossLevelCamFollowSteps(input, UNLIMITED_RIGID_WORK));
}

/** The follower's iteration and its two boundaries are cancellable, with no partial outcome. */
export function* solveCrossLevelCamFollowSteps(input: CrossLevelCamFollowInput,
  budget: RigidWorkBudget): Generator<RigidWorkPoint, CrossLevelCamFollowOutcome, void> {
  const work = new JointDriveWork(budget);
  yield* work.boundary();
  const invalid = yield* work.forward(crossLevelCamFailureSteps(input.inputs, input.view, input.cams, [], budget));
  if (invalid !== null) return invalid;
  let cam: CrossLevelCamCoupling | undefined;
  for (const c of input.cams) {
    yield* work.checkpoint();
    if (c.id === input.couplingId) { cam = c; break; }
  }
  if (cam === undefined) return { ok: false, couplingId: input.couplingId, code: 'missing-coupling' };
  const target = crossLevelCamTranslation(cam, input.camAngle);
  if (!finite(target)) return { ok: false, couplingId: cam.id, code: 'unrepresentable-coupling' };
  yield* work.boundary();
  const child = yield* work.forward(solveSubAssemblyJointDriveSteps({ inputs: input.inputs, view: input.view, path: cam.child.path,
    ...(input.initial === undefined ? {} : { initial: input.initial }),
    ...(input.targetOptions === undefined ? {} : { targetOptions: input.targetOptions }),
    request: { jointId: cam.child.jointId, coordinate: 'translation', value: target } }, budget));
  if (!child.ok) return { ok: false, couplingId: cam.id, code: 'child-solve-failed' };
  if (child.driven.atLimit || Math.abs(child.driven.actual - target) > CROSS_LEVEL_CAM_TOLERANCE_MM) {
    return { ok: false, couplingId: cam.id, code: 'child-at-limit' };
  }
  yield* work.boundary();
  return { ok: true, path: child.path, outcome: child, translation: child.driven.actual };
}
