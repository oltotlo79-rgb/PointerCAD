import { evaluateExpression } from '@pointercad/expression';
import type { AssemblyDocument, Joint } from '../types.js';
import { assemblyExpressionContext } from '../resolveAssembly.js';
import type { RigidPlacement } from '../placementMath.js';
import {
  drainRigidSteps, solveRigidSteps, UNLIMITED_RIGID_WORK, type RigidResidualRow, type RigidSolveInput, type RigidSolveOutcome,
  type RigidWorkBudget, type RigidWorkPoint,
} from '../constraints/solveRigid.js';
import type { MateVariableSet } from '../constraints/mateVariables.js';
import { driveJointRows, jointValue, type PreparedJointDrive } from './driveJoint.js';
import type { JointFramePair } from './jointFrames.js';
import { camFollowerRows, type PreparedCamFollower } from './camFollower.js';
import { prepareJointResiduals, type JointResidualInput, type JointResidualSkipReason,
  type PreparedJointResidual } from './jointResiduals.js';

/** Evaluated numeric input only; persistent ratio/phase are ExpressionValue. */
export interface GearRatioCoupling {
  readonly id: string;
  readonly kind: 'gear';
  readonly jointAId: string;
  readonly jointBId: string;
  /** thetaB = ratio * thetaA + phaseDeg, both angles in degrees. */
  readonly ratio: number;
  readonly phaseDeg: number;
  readonly referenceAngleA: number;
  readonly suppressed: boolean;
}
export type MechanismCouplingFailureReason = JointResidualSkipReason | 'missingJoint' | 'suppressedJoint'
  | 'duplicateJoint' | 'duplicateCoupling' | 'duplicateReference' | 'unsupportedJoint'
  | 'invalidRatio' | 'invalidPhase' | 'invalidReference' | 'contradictoryLoop' | 'unrepresentableCoupling' | 'invalidExpression';
export interface MechanismCouplingFailure {
  readonly ok: false;
  readonly couplingId: string;
  readonly reason: MechanismCouplingFailureReason;
}
export interface PreparedGearRatioCoupling {
  readonly definition: GearRatioCoupling;
  readonly a: PreparedJointResidual;
  readonly b: PreparedJointResidual;
}
export interface PreparedMechanismCouplings {
  readonly couplings: readonly PreparedGearRatioCoupling[];
  readonly references: ReadonlyMap<string, number>;
  /** Cam-follower relations (camFollower.ts) solved in the same group; absent when there are none. */
  readonly cams?: readonly PreparedCamFollower[];
}
export interface MechanismCouplingRow extends RigidResidualRow {
  readonly couplingId: string;
  readonly jointAId: string;
  readonly jointBId: string;
}
const finite = (value: number): boolean => typeof value === 'number' && Number.isFinite(value);
const ANGLE_EPSILON_DEG = 1e-9;
const refusal = (couplingId: string, reason: MechanismCouplingFailureReason): MechanismCouplingFailure =>
  ({ ok: false, couplingId, reason });

/** Evaluate authored expressions; never fall back to stale cached numeric values. */
export function evaluateMechanismCouplings(assembly: AssemblyDocument): MechanismCouplingFailure | {
  readonly ok: true; readonly couplings: readonly GearRatioCoupling[];
} {
  const context = assemblyExpressionContext(assembly), couplings: GearRatioCoupling[] = [];
  for (const c of assembly.mechanismCouplings ?? []) {
    const ratio = evaluateExpression(c.ratio.source, context), phase = evaluateExpression(c.phaseDeg.source, context);
    if (!ratio.ok || !phase.ok || !finite(ratio.value.value) || !finite(phase.value.value))
      return refusal(c.id, 'invalidExpression');
    couplings.push({ ...c, ratio: ratio.value.value, phaseDeg: phase.value.value });
  }
  return { ok: true, couplings };
}

/** Affine cycles can be redundant, lock an angle, or contradict each other.
 * A nonunit ratio product alone is not proof of contradiction. */
function inspectLoops(couplings: readonly GearRatioCoupling[]): MechanismCouplingFailure | null {
  const edges = new Map<string, { to: string; ratio: number; phase: number; id: string }[]>();
  for (const c of couplings) {
    const forward = edges.get(c.jointAId) ?? [], inverse = edges.get(c.jointBId) ?? [];
    forward.push({ to: c.jointBId, ratio: c.ratio, phase: c.phaseDeg, id: c.id });
    inverse.push({ to: c.jointAId, ratio: 1 / c.ratio, phase: -c.phaseDeg / c.ratio, id: c.id });
    edges.set(c.jointAId, forward); edges.set(c.jointBId, inverse);
  }
  const visited = new Set<string>();
  for (const root of edges.keys()) {
    if (visited.has(root)) continue;
    const values = new Map<string, { scale: number; offset: number }>([[root, { scale: 1, offset: 0 }]]);
    const pending = [root]; let fixedRoot: number | undefined;
    while (pending.length > 0) {
      const id = pending.pop(); if (id === undefined) break;
      visited.add(id);
      const from = values.get(id); if (from === undefined) continue;
      for (const edge of edges.get(id) ?? []) {
        const scale = edge.ratio * from.scale, offset = edge.ratio * from.offset + edge.phase;
        if (!finite(scale) || scale === 0 || !finite(offset)) return refusal(edge.id, 'unrepresentableCoupling');
        const previous = values.get(edge.to);
        if (previous === undefined) { values.set(edge.to, { scale, offset }); pending.push(edge.to); continue; }
        const coefficient = scale - previous.scale, constant = offset - previous.offset;
        const scaleEpsilon = 64 * Number.EPSILON * Math.max(1, Math.abs(scale), Math.abs(previous.scale));
        if (Math.abs(coefficient) <= scaleEpsilon) {
          if (Math.abs(constant) > ANGLE_EPSILON_DEG) return refusal(edge.id, 'contradictoryLoop');
        } else {
          const required = -constant / coefficient;
          if (!finite(required)) return refusal(edge.id, 'unrepresentableCoupling');
          if (fixedRoot !== undefined && Math.abs(fixedRoot - required) > ANGLE_EPSILON_DEG)
            return refusal(edge.id, 'contradictoryLoop');
          fixedRoot = required;
        }
      }
    }
  }
  return null;
}

/** Geometry-free loop admission for already evaluated and structurally checked persisted relations. */
export function mechanismCouplingLoopFailure(couplings: readonly GearRatioCoupling[]): MechanismCouplingFailure | null {
  return inspectLoops(couplings.filter(c => !c.suppressed));
}

/** Validate the complete active relation set before returning any prepared rows.
 * Original definitions, frames, document and placements are never mutated. */
export function prepareMechanismCouplings(input: {
  readonly couplings: readonly GearRatioCoupling[];
  readonly joints: readonly Joint[];
  readonly frames: ReadonlyMap<string, JointFramePair>;
  readonly placements: ReadonlyMap<string, RigidPlacement>;
}): MechanismCouplingFailure | { readonly ok: true; readonly prepared: PreparedMechanismCouplings } {
  const ids = new Set<string>(), pairs = new Set<string>(), active: GearRatioCoupling[] = [];
  const joints = new Map<string, Joint>(), duplicates = new Set<string>();
  for (const joint of input.joints) { if (joints.has(joint.id)) duplicates.add(joint.id); joints.set(joint.id, joint); }
  const prepared: PreparedGearRatioCoupling[] = [], references = new Map<string, number>();
  const noVariables: MateVariableSet = { variables: [], initial: [], movableComponentIds: [], frozen: new Map(),
    tooMany: false, columnOf: () => null, componentOf: () => null };
  for (const c of input.couplings) {
    if (ids.has(c.id)) return refusal(c.id, 'duplicateCoupling'); ids.add(c.id);
    if (!finite(c.ratio) || c.ratio === 0) return refusal(c.id, 'invalidRatio');
    if (!finite(c.phaseDeg)) return refusal(c.id, 'invalidPhase');
    if (!finite(c.referenceAngleA)) return refusal(c.id, 'invalidReference');
    if (!finite(1 / c.ratio) || !finite(-c.phaseDeg / c.ratio)
        || !finite(c.ratio * c.referenceAngleA + c.phaseDeg)) return refusal(c.id, 'unrepresentableCoupling');
    if (c.suppressed) continue;
    if (c.jointAId === c.jointBId) return refusal(c.id, 'duplicateReference');
    const pair = JSON.stringify([c.jointAId, c.jointBId].sort());
    if (pairs.has(pair)) return refusal(c.id, 'duplicateReference'); pairs.add(pair);
    const originals: Joint[] = [];
    for (const id of [c.jointAId, c.jointBId]) {
      if (duplicates.has(id)) return refusal(c.id, 'duplicateJoint');
      const joint = joints.get(id);
      if (joint === undefined) return refusal(c.id, 'missingJoint');
      if (joint.suppressed) return refusal(c.id, 'suppressedJoint');
      if (joint.kind !== 'revolute') return refusal(c.id, 'unsupportedJoint');
      originals.push(joint);
    }
    const report = prepareJointResiduals({ joints: originals, frames: input.frames, placements: input.placements });
    if (report.skipped.length > 0) return refusal(c.id, report.skipped[0].reason);
    const [a, b] = report.joints;
    if (a === undefined || b === undefined) return refusal(c.id, 'missingFrame');
    for (const [joint, reference] of [[a, c.referenceAngleA], [b, c.ratio * c.referenceAngleA + c.phaseDeg]] as const) {
      const current = jointValue({ joint, coordinate: 'angle', referenceAngle: reference,
        placements: input.placements, variableSet: noVariables });
      if (!current.ok) return refusal(c.id, current.reason === 'invalidReference' ? 'invalidReference' : 'invalidFrame');
      const previous = references.get(joint.jointId);
      if (previous !== undefined && Math.abs(previous - current.value) > ANGLE_EPSILON_DEG)
        return refusal(c.id, 'invalidReference');
      references.set(joint.jointId, current.value);
    }
    prepared.push({ definition: { ...c }, a, b }); active.push(c);
  }
  const loop = inspectLoops(active); if (loop !== null) return loop;
  return { ok: true, prepared: { couplings: prepared, references } };
}

/** Permanent coupled angle rows in the existing analytic joint chart. */
export function mechanismCouplingRows(input: Omit<JointResidualInput, 'joints'> & {
  readonly prepared: PreparedMechanismCouplings;
  readonly references: ReadonlyMap<string, number>;
}): MechanismCouplingFailure | { readonly ok: true; readonly rows: readonly MechanismCouplingRow[] } {
  const rows: MechanismCouplingRow[] = [];
  for (const c of input.prepared.couplings) {
    const read = (joint: PreparedJointResidual) => driveJointRows({ ...input, joint, coordinate: 'angle',
      referenceAngle: input.references.get(joint.jointId), target: 0 });
    const a = read(c.a), b = read(c.b);
    if (!a.ok || !b.ok) return refusal(c.definition.id, (!a.ok ? a.reason : !b.ok ? b.reason : 'invalidFrame') === 'invalidReference'
      ? 'invalidReference' : 'rotationBranch');
    const denominator = Math.hypot(1, c.definition.ratio), scale = 1 / denominator;
    const weightA = -c.definition.ratio / denominator;
    const value = b.rows[0].value * scale + a.rows[0].value * weightA - c.definition.phaseDeg * Math.PI / 180 * scale;
    const gradient = new Map<number, number>();
    for (const [column, v] of a.rows[0].gradient) gradient.set(column, v * weightA);
    for (const [column, v] of b.rows[0].gradient) gradient.set(column, (gradient.get(column) ?? 0) + v * scale);
    if (!finite(value) || !finite(scale) || scale <= 0 || [...gradient.values()].some(v => !finite(v)))
      return refusal(c.definition.id, 'unrepresentableCoupling');
    rows.push({ couplingId: c.definition.id, jointAId: c.a.jointId, jointBId: c.b.jointId,
      value, gradient, scale, unit: 'angle', tolerance: ANGLE_EPSILON_DEG * Math.PI / 180, constant: a.rows[0].constant === true && b.rows[0].constant === true });
  }
  if (input.prepared.cams !== undefined && input.prepared.cams.length > 0) {
    const cams = camFollowerRows({ ...input, prepared: input.prepared.cams });
    if (!cams.ok) return refusal(cams.couplingId, cams.reason === 'rotationBranch' ? 'rotationBranch' : 'unrepresentableCoupling');
    rows.push(...cams.rows);
  }
  return { ok: true, rows };
}

/** Call only from the solver's accepted retract; never mutate trial references. */
export function advanceMechanismReferences(input: Omit<JointResidualInput, 'joints'> & {
  readonly prepared: PreparedMechanismCouplings;
  readonly references: ReadonlyMap<string, number>;
}): MechanismCouplingFailure | { readonly ok: true; readonly references: ReadonlyMap<string, number> } {
  const references = new Map(input.references);
  for (const c of input.prepared.couplings) for (const joint of [c.a, c.b]) {
    const value = jointValue({ ...input, joint, coordinate: 'angle', referenceAngle: input.references.get(joint.jointId) });
    if (!value.ok) return refusal(c.definition.id, value.reason === 'invalidReference' ? 'invalidReference' : 'invalidFrame');
    references.set(joint.jointId, value.value);
  }
  // The cam angle keeps its own continuous branch reference exactly like a gear joint.
  for (const c of input.prepared.cams ?? []) {
    const value = jointValue({ ...input, joint: c.cam, coordinate: 'angle', referenceAngle: input.references.get(c.cam.jointId) });
    if (!value.ok) return refusal(c.definition.id, value.reason === 'invalidReference' ? 'invalidReference' : 'invalidFrame');
    references.set(c.cam.jointId, value.value);
  }
  return { ok: true, references };
}

export interface MechanismGroupSolve {
  readonly result: RigidSolveOutcome<ReadonlyMap<string, RigidPlacement>>;
  readonly references: ReadonlyMap<string, number>;
  readonly actual?: number;
}

/** Existing rigid solver with permanent coupled rows and optional existing driver.
 * All branch references belong to accepted state, never evaluation closures. */
export function solveMechanismGroup(input: RigidSolveInput<ReadonlyMap<string, RigidPlacement>>,
  variableSet: MateVariableSet, prepared: PreparedMechanismCouplings, drive?: PreparedJointDrive): MechanismGroupSolve {
  return drainRigidSteps(solveMechanismGroupSteps(input, variableSet, prepared, drive, UNLIMITED_RIGID_WORK));
}

/** solveMechanismGroup through cooperative rigid steps: the same rows, accepted references and arithmetic. */
export function* solveMechanismGroupSteps(input: RigidSolveInput<ReadonlyMap<string, RigidPlacement>>,
  variableSet: MateVariableSet, prepared: PreparedMechanismCouplings, drive: PreparedJointDrive | undefined,
  budget: RigidWorkBudget): Generator<RigidWorkPoint, MechanismGroupSolve, void> {
  const initialReferences = new Map(prepared.references);
  if (drive?.coordinate === 'angle' && drive.referenceAngle !== undefined)
    initialReferences.set(drive.joint.jointId, drive.referenceAngle);
  const solved = yield* solveRigidSteps({ initial: { placements: input.initial, references: initialReferences },
    variables: input.variables, options: input.options,
    evaluate: (state, increments) => {
      const permanent = input.evaluate(state.placements, increments);
      const common = { placements: state.placements, increments, variableSet, prepared, references: state.references,
        characteristicLength: input.options?.characteristicLength };
      const coupled = mechanismCouplingRows(common);
      const driver = drive === undefined ? null : driveJointRows({ ...common, joint: drive.joint,
        coordinate: drive.coordinate, referenceAngle: state.references.get(drive.joint.jointId), target: drive.target });
      return { ...permanent, valid: permanent.valid !== false && coupled.ok && (driver === null || driver.ok),
        rows: [...permanent.rows, ...(coupled.ok ? coupled.rows : []), ...(driver?.ok ? driver.rows.map(row =>
          drive?.coordinate === 'angle' ? { ...row, tolerance: Math.min(input.options?.angleTolerance ?? 1e-9, 1e-9 * Math.PI / 180) } : row) : [])] };
    },
    retract: (state, increments) => {
      const common = { placements: state.placements, increments, variableSet, prepared, references: state.references };
      const next = advanceMechanismReferences(common);
      if (!next.ok) throw new Error(next.reason);
      const references = new Map(next.references);
      if (drive?.coordinate === 'angle') {
        const current = jointValue({ ...common, joint: drive.joint, coordinate: drive.coordinate,
          referenceAngle: state.references.get(drive.joint.jointId) });
        if (!current.ok) throw new Error(current.reason);
        references.set(drive.joint.jointId, current.value);
      }
      return { placements: input.retract(state.placements, increments), references };
    },
    branchCandidates: input.branchCandidates === undefined ? undefined
      : (state, violations) => input.branchCandidates?.(state.placements, violations) ?? [],
  }, budget);
  const current = drive === undefined ? null : jointValue({ placements: solved.base.placements, variableSet,
    joint: drive.joint, coordinate: drive.coordinate, referenceAngle: solved.base.references.get(drive.joint.jointId) });
  return { result: { ...solved, base: solved.base.placements }, references: solved.base.references,
    ...(current?.ok ? { actual: current.value } : {}) };
}
