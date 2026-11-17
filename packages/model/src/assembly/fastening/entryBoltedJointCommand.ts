/** Entry-aware single-pair API; legacy callers keep their original result shape. */
import { bindHoleSelection, type FasteningHolePick } from './bindHoleSelection.js';
import type { BoltedJointChoices } from './boltedJointCommand.js';
import { existingConstraintRejections, type FasteningConstraintContext } from './existingConstraints.js';
import { isRejection } from './selectFastener.js';
import { planEntryBoltedJoint } from './planEntryBoltedJoint.js';
import { applyEntryBoltedJoint } from './applyEntryBoltedJoint.js';
import type { EntryBoltedJointPlan, EntryBoltedJointResult, FasteningExtensionRejection } from './holeEntryTypes.js';
import type { ApplyBoltedJointResult } from './applyBoltedJoint.js';
import type { BoltedJointRejection } from './types.js';

export type CommitEntryBoltedJointResult = Extract<ApplyBoltedJointResult, { readonly ok: true }>
  | { readonly ok: false; readonly document: FasteningConstraintContext['document'];
      readonly rejections: readonly BoltedJointRejection[]; readonly entryRejections: readonly FasteningExtensionRejection[] };

export function previewEntryBoltedJoint(context: FasteningConstraintContext, first: FasteningHolePick,
  second: FasteningHolePick, choices: BoltedJointChoices): EntryBoltedJointResult {
  const a = bindHoleSelection(context, first), b = bindHoleSelection(context, second);
  if (isRejection(a) || isRejection(b)) return { ok: false, entryRejections: [],
    rejections: [a, b].flatMap(value => isRejection(value) ? [value] : []) };
  const result = planEntryBoltedJoint(context.document, { ...choices, first: a, second: b }, context.partRevisions);
  if (!result.ok) return result;
  const rejections = existingConstraintRejections(context, result.plan.joint);
  return rejections.length === 0 ? result : { ok: false, rejections, entryRejections: [] };
}

export function commitEntryBoltedJoint(context: FasteningConstraintContext, first: FasteningHolePick,
  second: FasteningHolePick, choices: BoltedJointChoices, previewed: EntryBoltedJointPlan): CommitEntryBoltedJointResult {
  const current = previewEntryBoltedJoint(context, first, second, choices);
  if (!current.ok) return { ...current, document: context.document };
  if (JSON.stringify(current.plan) !== JSON.stringify(previewed)) return { ok: false, document: context.document,
    rejections: [{ code: 'staleSource', detail: { reason: 'previewChanged' } }], entryRejections: [] };
  const applied = applyEntryBoltedJoint(context.document, current.plan, context.partRevisions);
  return applied.ok ? applied : { ...applied, entryRejections: [] };
}
