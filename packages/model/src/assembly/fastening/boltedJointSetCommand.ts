import { existingConstraintRejections, type FasteningConstraintContext } from './existingConstraints.js';
import type { ApplyBoltedJointSetResult, BoltedJointHoleFailure, BoltedJointSetPicks, BoltedJointSetPlan, BoltedJointSetResult } from './boltedJointSetTypes.js';
import { bindHoleSelection, type FasteningHolePick } from './bindHoleSelection.js';
import { planBoundBoltedJointSet } from './planBoltedJointSet.js';
import { applyEntryBoltedJoint } from './applyEntryBoltedJoint.js';
import { withBoltedJointRecord } from './boltedJointEdit.js';
import type { EntryHoleSelection } from './holeEntryTypes.js';
import type { BoltedJointRejection } from './types.js';

export function previewBoltedJointSet(context: FasteningConstraintContext, picks: BoltedJointSetPicks): BoltedJointSetResult {
  // A set promises one existing-format record per pair. Group-only picks cannot be represented in that format.
  const bind = (pick: FasteningHolePick): EntryHoleSelection | BoltedJointRejection => pick.holeGroup === undefined
    ? bindHoleSelection(context, pick) : { code: 'unsupportedHole', detail: { componentId: pick.componentId, reason: 'unrecordableHoleGroup' } };
  return planBoundBoltedJointSet(context.document, picks.first.map(bind), picks.second.map(bind), picks.choices,
    context.partRevisions, (document, plan) => existingConstraintRejections({ ...context, document }, plan.joint));
}

function changedPlans(current: BoltedJointSetPlan, previewed: BoltedJointSetPlan): BoltedJointHoleFailure[] {
  const holes: BoltedJointHoleFailure[] = [];
  for (let index = 0; index < Math.max(current.joints.length, previewed.joints.length); index += 1) {
    if (JSON.stringify(current.joints[index]) !== JSON.stringify(previewed.joints[index])) holes.push({ index,
      rejections: [{ code: 'staleSource', detail: { reason: 'previewChanged' } }], entryRejections: [] });
  }
  return holes;
}

/** Rebind and replan all pairs, then return exactly one document. Every failure returns the original document. */
export function commitBoltedJointSet(context: FasteningConstraintContext, picks: BoltedJointSetPicks,
  previewed: BoltedJointSetPlan): ApplyBoltedJointSetResult {
  const current = previewBoltedJointSet(context, picks);
  if (!current.ok) return { ...current, document: context.document };
  const changed = changedPlans(current.plan, previewed);
  if (changed.length > 0) return { ok: false, document: context.document, rejections: [], holes: changed };
  let staged = context.document;
  const componentIds: (readonly string[])[] = [];
  for (const [index, plan] of current.plan.joints.entries()) {
    const first = picks.first[index], second = picks.second[index];
    if (first === undefined || second === undefined) return { ok: false, document: context.document, holes: [],
      rejections: [{ code: 'holeCountMismatch', detail: { first: picks.first.length, second: picks.second.length } }] };
    const applied = applyEntryBoltedJoint(staged, plan, context.partRevisions);
    if (!applied.ok) return { ok: false, document: context.document, rejections: [],
      holes: [{ index, rejections: applied.rejections, entryRejections: [] }] };
    staged = withBoltedJointRecord(applied.document, first, second, picks.choices, applied.componentIds);
    componentIds.push(applied.componentIds);
  }
  return { ok: true, document: staged, componentIds };
}
