import type { AssemblyDocument } from '../types.js';
import type { BoltedJointChoices } from './boltedJointCommand.js';
import type { BoltedJointHoleFailure, BoltedJointSetRequest, BoltedJointSetResult } from './boltedJointSetTypes.js';
import type { EntryBoltedJointPlan, EntryHoleSelection, FasteningExtensionRejection } from './holeEntryTypes.js';
import type { BoltedJointRejection } from './types.js';
import { isRejection } from './selectFastener.js';
import { planEntryBoltedJoint } from './planEntryBoltedJoint.js';
import { applyEntryBoltedJoint } from './applyEntryBoltedJoint.js';

export function planBoltedJointSet(document: AssemblyDocument, request: BoltedJointSetRequest,
  partRevisions: ReadonlyMap<string, string> = new Map()): BoltedJointSetResult {
  return planBoundBoltedJointSet(document, request.first, request.second, request.choices, partRevisions);
}

type BoundHole = EntryHoleSelection | BoltedJointRejection;
type ConstraintCheck = (document: AssemblyDocument, plan: EntryBoltedJointPlan) => readonly BoltedJointRejection[];

function holeIdentity(hole: EntryHoleSelection): string {
  return JSON.stringify([hole.componentId, hole.holeFeatureId, hole.axisOrigin, hole.axisDirection]);
}

/** Every selected side belongs to one component, and each hole occurs at most once on that side. */
function selectionIssues(values: readonly BoundHole[]): ReadonlyMap<number, BoltedJointRejection> {
  const componentId = values.find((value): value is EntryHoleSelection => !isRejection(value))?.componentId;
  const seen = new Set<string>(), out = new Map<number, BoltedJointRejection>();
  values.forEach((value, index) => {
    if (isRejection(value)) return;
    const key = holeIdentity(value);
    if (value.componentId !== componentId || seen.has(key)) out.set(index, { code: 'unsupportedHole',
      detail: { componentId: value.componentId, reason: seen.has(key) ? 'duplicateHole' : 'mixedComponents' } });
    seen.add(key);
  });
  return out;
}

/** Stage immutable documents privately so later holes cannot independently realign an already joined pair. */
export function planBoundBoltedJointSet(document: AssemblyDocument, first: readonly BoundHole[], second: readonly BoundHole[],
  choices: BoltedJointChoices, partRevisions: ReadonlyMap<string, string>, check?: ConstraintCheck): BoltedJointSetResult {
  const countRejection: FasteningExtensionRejection = { code: 'holeCountMismatch', detail: { first: first.length, second: second.length } };
  const rejections = first.length !== second.length || first.length === 0 ? [countRejection] : [];
  const firstIssues = selectionIssues(first), secondIssues = selectionIssues(second);
  const holes: BoltedJointHoleFailure[] = [], joints: EntryBoltedJointPlan[] = [];
  let staged = document;
  for (let index = 0; index < Math.max(first.length, second.length); index += 1) {
    const a = first[index], b = second[index];
    const invalid = [a, b, firstIssues.get(index), secondIssues.get(index)]
      .flatMap(value => value !== undefined && isRejection(value) ? [value] : []);
    if (a === undefined || b === undefined || isRejection(a) || isRejection(b) || invalid.length > 0) {
      holes.push({ index, rejections: invalid, entryRejections: a === undefined || b === undefined ? [countRejection] : [] });
      continue;
    }
    const result = planEntryBoltedJoint(staged, { ...choices, first: a, second: b }, partRevisions);
    if (!result.ok) { holes.push({ index, rejections: result.rejections, entryRejections: result.entryRejections }); continue; }
    const constraints = check?.(staged, result.plan) ?? [];
    if (constraints.length > 0) { holes.push({ index, rejections: constraints, entryRejections: [] }); continue; }
    const applied = applyEntryBoltedJoint(staged, result.plan, partRevisions);
    if (!applied.ok) { holes.push({ index, rejections: applied.rejections, entryRejections: [] }); continue; }
    staged = applied.document;
    joints.push(result.plan);
  }
  return holes.length > 0 || rejections.length > 0 ? { ok: false, rejections, holes } : { ok: true, plan: { joints } };
}
