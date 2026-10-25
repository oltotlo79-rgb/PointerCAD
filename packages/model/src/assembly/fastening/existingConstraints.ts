/** Check the proposed placement against existing constraint geometry without moving the document. */
import { buildMateResidualReport, prepareMateResiduals, type MateResidualTargetPair } from '../constraints/mateResiduals.js';
import { resolveMateTarget, type MateTargetOutcome } from '../constraints/mateTargets.js';
import { collectMateVariables } from '../constraints/mateVariables.js';
import { DEFAULT_RIGID_ANGLE_TOLERANCE, DEFAULT_RIGID_LENGTH_TOLERANCE } from '../constraints/solveRigid.js';
import { jointFramePairFromTargets, type JointFramePair } from '../joints/jointFrames.js';
import { buildJointResidualReport, prepareJointResiduals } from '../joints/jointResiduals.js';
import { composePlacement, type RigidPlacement } from '../placementMath.js';
import { assemblyExpressionContext } from '../resolveAssembly.js';
import { rigidGroupMemberIds } from '../rigidGroups.js';
import type { MateTarget } from '../types.js';
import type { FasteningGeometryContext } from './bindHoleSelection.js';
import { rigidPlacementOf } from './frames.js';
import type { BoltedJointPlan, BoltedJointRejection } from './types.js';

export interface FasteningConstraintContext extends FasteningGeometryContext {
  /** Re-resolve current topology, using the supplied saved placements rather than a solver's displayed placements. */
  readonly resolveConstraintTarget?: (target: MateTarget, placements: ReadonlyMap<string, RigidPlacement>) => MateTargetOutcome;
}

export function existingConstraintRejections(context: FasteningConstraintContext, plan: BoltedJointPlan): BoltedJointRejection[] {
  const document = context.document;
  const affected = new Set([plan.headSideComponentId, plan.farSideComponentId]
    .flatMap((id) => rigidGroupMemberIds(document, id)));
  const touches = (entry: { readonly a: MateTarget; readonly b: MateTarget; readonly suppressed: boolean }) =>
    !entry.suppressed && (affected.has(entry.a.componentId) || affected.has(entry.b.componentId));
  const mates = document.mates.filter(touches);
  const joints = document.joints.filter(touches);
  if (mates.length === 0 && joints.length === 0) return [];
  const initial = new Map(document.components.filter((component) => !component.suppressed)
    .map((component) => [component.id, rigidPlacementOf(component.placement)] as const));
  const moved = new Set(plan.alignment.movedComponentIds);
  const aligned = new Map([...initial].map(([id, placement]) =>
    [id, moved.has(id) ? composePlacement(plan.alignment.delta, placement) : placement] as const));
  const targets = new Map<string, MateResidualTargetPair>();
  const frames = new Map<string, JointFramePair>();
  const rejected: BoltedJointRejection[] = [];
  const unresolved = (constraintId: string) => rejected.push({ code: 'existingConstraintUnresolved', detail: { constraintId } });
  const resolve = (target: MateTarget): MateTargetOutcome => {
    if (context.resolveConstraintTarget !== undefined) return context.resolveConstraintTarget(target, initial);
    // Origins require no part topology. A subshape must never fall back to its saved fingerprint.
    if (target.kind === 'origin') return resolveMateTarget(target,
      { placements: initial, parts: new Map(), partKeys: new Map(), errors: [] });
    return { ok: false, code: 'missingSubShape', message: 'Current constraint geometry is unavailable' };
  };
  for (const entry of [...mates, ...joints]) {
    const a = resolve(entry.a), b = resolve(entry.b);
    if (!a.ok || !b.ok) { unresolved(entry.id); continue; }
    targets.set(entry.id, { a: a.target, b: b.target });
  }
  for (const joint of joints) {
    const pair = targets.get(joint.id);
    const frame = pair === undefined ? null : jointFramePairFromTargets(joint, pair, initial);
    if (frame === null) unresolved(joint.id); else frames.set(joint.id, frame);
  }
  if (rejected.length > 0) return rejected;
  const expression = assemblyExpressionContext(document);
  const prepared = prepareMateResiduals({ mates, targets, placements: initial,
    parameters: expression.variables, exactVariables: expression.exactVariables, nonLengthVariables: expression.nonLengthVariables });
  const preparedJoints = prepareJointResiduals({ joints, frames, placements: initial });
  for (const entry of prepared.skipped) unresolved(entry.mateId);
  for (const entry of preparedJoints.skipped) unresolved(entry.jointId);
  if (rejected.length > 0) return rejected;
  // No solving: all positions are fixed for this check. Preparation keeps original orientation branches.
  const variableSet = collectMateVariables({ ...document, components: document.components.map((component) => ({ ...component, fixed: true })) });
  const report = buildMateResidualReport({ mates: prepared.mates, placements: aligned, variableSet });
  const jointReport = buildJointResidualReport({ joints: preparedJoints.joints, placements: aligned, variableSet });
  for (const entry of report.skipped) unresolved(entry.mateId);
  for (const entry of jointReport.skipped) unresolved(entry.jointId);
  const conflicts = new Set([...report.branchViolations, ...jointReport.branchViolations]);
  const byId = new Map(prepared.mates.map((mate) => [mate.mateId, mate]));
  for (const row of report.rows) {
    const mate = byId.get(row.mateId);
    // Canonical mate rows use 1/100 for lengths and 1 for directions. Angle rows use the solver's cosine tolerance.
    const angle = DEFAULT_RIGID_ANGLE_TOLERANCE;
    const tolerance = mate?.kind === 'angle'
      ? 2 * Math.sin(angle / 2) * Math.min(Math.abs(Math.sin(mate.value - angle / 2)), Math.abs(Math.sin(mate.value + angle / 2)))
      : row.scale * (row.scale === 1 ? Math.sin(angle) : DEFAULT_RIGID_LENGTH_TOLERANCE);
    if (!Number.isFinite(row.value) || Math.abs(row.value) >= tolerance) conflicts.add(row.mateId);
  }
  for (const row of jointReport.rows) {
    const tolerance = row.scale * (row.measure === 'length' ? DEFAULT_RIGID_LENGTH_TOLERANCE
      : row.measure === 'rotation' ? DEFAULT_RIGID_ANGLE_TOLERANCE : Math.sin(DEFAULT_RIGID_ANGLE_TOLERANCE));
    if (!Number.isFinite(row.value) || Math.abs(row.value) >= tolerance) conflicts.add(row.jointId);
  }
  for (const constraintId of conflicts) rejected.push({ code: 'existingConstraintConflict', detail: { constraintId } });
  return rejected;
}
