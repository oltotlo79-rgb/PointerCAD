import {
  buildStandardPartFromSource, commitOccurrenceBoltedJoint, modeledThreadResolverFromBodies,
  previewOccurrenceBoltedJoint, resolveJointOccurrence,
  type AssemblyDocument, type BoltedJointChoices, type CommitJointOccurrenceResult, type JointOccurrenceCommandContext,
  type JointOccurrencePath, type JointOccurrenceResult, type ModeledThreadGroupPick,
  type OccurrenceBoltedJointPreview, type OccurrenceHolePick, type PartLibrary,
} from '@pointercad/model';
import type { AssemblyView } from '../store/assemblySlice.js';
import type { JointOccurrencePick } from '../viewport/pickJointOccurrence.js';
import { boltedJointChoices, type AssemblyBoltedJointDraft, type BoltedJointDraftIssue } from './boltedJointDraft.js';
import { nestedJointCommandContext } from './nestedWeldDraft.js';

/** Transient selection only: a leaf ID never substitutes for its complete occurrence path. */
export type NestedBoltedJointPick = JointOccurrencePick | {
  readonly kind: 'modeledThreadGroup'; readonly path: JointOccurrencePath;
  readonly partKey: string; readonly group: ModeledThreadGroupPick;
};
export interface NestedBoltedJointDraft {
  readonly documentId: string;
  /** hole A, mating face A, hole B, mating face B */
  readonly picks: readonly NestedBoltedJointPick[];
}
export type NestedBoltedJointIssue = BoltedJointDraftIssue
  | { readonly kind: 'invalidPicks' | 'documentMismatch' | 'partKeyChanged' }
  | { readonly kind: 'occurrence'; readonly failure: Extract<JointOccurrenceResult, { readonly ok: false }> };
export type NestedBoltedJointPreview =
  | { readonly kind: 'issue'; readonly issue: NestedBoltedJointIssue }
  | { readonly kind: 'plan'; readonly result: OccurrenceBoltedJointPreview };
export type NestedBoltedJointCommit = CommitJointOccurrenceResult
  | { readonly ok: false; readonly document: AssemblyDocument; readonly issue: NestedBoltedJointIssue }
  | (Extract<OccurrenceBoltedJointPreview, { readonly ok: false }> & { readonly document: AssemblyDocument });

export function createNestedBoltedJointDraft(documentId: string): NestedBoltedJointDraft {
  return { documentId, picks: [] };
}
function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
function validNext(picks: readonly NestedBoltedJointPick[], pick: NestedBoltedJointPick): boolean {
  if (picks.length >= 4 || pick.path.length === 0 || pick.path.some(id => id.length === 0)) return false;
  if (pick.kind === 'jointOccurrence' && pick.ref.fingerprint.kind !== 'face') return false;
  const previous = picks[picks.length - 1];
  if (picks.length % 2 === 1) {
    if (pick.kind !== 'jointOccurrence' || previous === undefined || !samePath(previous.path, pick.path)) return false;
    if (previous.partKey !== pick.partKey) return false;
    if (previous.kind === 'jointOccurrence' && previous.ref.bodyFeatureId === pick.ref.bodyFeatureId
      && previous.ref.index === pick.ref.index) return false;
  }
  const first = picks[0];
  return picks.length !== 2 || first === undefined || !samePath(first.path, pick.path);
}
export function appendNestedBoltedJointPick(draft: NestedBoltedJointDraft, pick: NestedBoltedJointPick): NestedBoltedJointDraft | null {
  if (!validNext(draft.picks, pick)) return null;
  const path: JointOccurrencePath = [pick.path[0], ...pick.path.slice(1)];
  return { ...draft, picks: [...draft.picks, { ...pick, path }] };
}

/** Keep the solve-time source stamp. Add the two bolt capabilities absent from the weld adapter. */
export function nestedBoltedJointCommandContext(document: AssemblyDocument, library: PartLibrary,
  view: AssemblyView): JointOccurrenceCommandContext | null {
  const base = nestedJointCommandContext(document, library, view);
  if (base === null) return null;
  return { ...base,
    partDocument: occurrence => occurrence.leafComponent.source.kind === 'standardPart'
      ? buildStandardPartFromSource(occurrence.leafComponent.source) : base.partDocument(occurrence),
    resolveModeledThread: (occurrence, group) => {
      const resolve = modeledThreadResolverFromBodies(() => base.bodiesOf(occurrence));
      return resolve(occurrence.leafComponent, group);
    },
  };
}

function holePick(context: JointOccurrenceCommandContext, hole: NestedBoltedJointPick,
  face: NestedBoltedJointPick): OccurrenceHolePick | NestedBoltedJointIssue {
  if (face.kind !== 'jointOccurrence' || !samePath(hole.path, face.path)) return { kind: 'invalidPicks' };
  const found = resolveJointOccurrence(context.inputs, hole.path, context.view);
  if (!found.ok) return { kind: 'occurrence', failure: found };
  const occurrence = found.occurrence;
  if (hole.partKey !== occurrence.partKey || face.partKey !== occurrence.partKey) return { kind: 'partKeyChanged' };
  const componentId = occurrence.leafComponent.id;
  if (hole.kind === 'modeledThreadGroup') {
    const resolved = context.resolveModeledThread?.(occurrence, hole.group);
    return resolved?.status === 'matched'
      ? { path: occurrence.path, pick: { componentId, holeFeatureId: resolved.evidence.origin.featureId,
        holeGroup: hole.group, matingFace: face.ref } }
      : { kind: 'holeFeatureUnknown', componentId };
  }
  const resolved = context.resolveFace(occurrence, hole.ref);
  return resolved.status === 'matched' && resolved.wall.status === 'hole'
    ? { path: occurrence.path, pick: { componentId, holeFeatureId: resolved.wall.origin.featureId,
      holeFace: hole.ref, matingFace: face.ref } }
    : { kind: 'holeFeatureUnknown', componentId };
}

type DraftInputs = { readonly issue: NestedBoltedJointIssue } | {
  readonly context: JointOccurrenceCommandContext; readonly first: OccurrenceHolePick;
  readonly second: OccurrenceHolePick; readonly choices: BoltedJointChoices;
};
function inputsOf(context: JointOccurrenceCommandContext | null, draft: NestedBoltedJointDraft,
  fields: AssemblyBoltedJointDraft): DraftInputs {
  if (draft.documentId !== fields.documentId) return { issue: { kind: 'documentMismatch' } satisfies NestedBoltedJointIssue };
  if (draft.picks.length < 4) return { issue: { kind: 'needPicks', count: draft.picks.length } satisfies NestedBoltedJointIssue };
  if (draft.picks.length !== 4 || draft.picks.some((pick, index) => !validNext(draft.picks.slice(0, index), pick))) {
    return { issue: { kind: 'invalidPicks' } satisfies NestedBoltedJointIssue };
  }
  if (context === null) return { issue: { kind: 'stale' } satisfies NestedBoltedJointIssue };
  const [holeA, seatA, holeB, seatB] = draft.picks;
  if (holeA === undefined || seatA === undefined || holeB === undefined || seatB === undefined) {
    return { issue: { kind: 'invalidPicks' } satisfies NestedBoltedJointIssue };
  }
  const first = holePick(context, holeA, seatA), second = holePick(context, holeB, seatB);
  if ('kind' in first) return { issue: first };
  if ('kind' in second) return { issue: second };
  const choices = boltedJointChoices(fields);
  if ('kind' in choices) return { issue: choices };
  return { context, first, second, choices };
}

export function previewNestedBoltedJoint(context: JointOccurrenceCommandContext | null, draft: NestedBoltedJointDraft,
  fields: AssemblyBoltedJointDraft): NestedBoltedJointPreview {
  const inputs = inputsOf(context, draft, fields);
  return 'issue' in inputs ? { kind: 'issue', issue: inputs.issue }
    : { kind: 'plan', result: previewOccurrenceBoltedJoint(inputs.context, inputs.first, inputs.second, inputs.choices) };
}

/** Rebind current values and geometry before the model compares the actual successful preview stamp. */
export function commitNestedBoltedJoint(context: JointOccurrenceCommandContext, draft: NestedBoltedJointDraft,
  fields: AssemblyBoltedJointDraft, previewed: Extract<OccurrenceBoltedJointPreview, { readonly ok: true }>): NestedBoltedJointCommit {
  const inputs = inputsOf(context, draft, fields);
  const document = context.inputs.document;
  if ('issue' in inputs) return { ok: false, document, issue: inputs.issue };
  const current = previewOccurrenceBoltedJoint(inputs.context, inputs.first, inputs.second, inputs.choices);
  if (!current.ok) return { ...current, document };
  return commitOccurrenceBoltedJoint(inputs.context, inputs.first, inputs.second, inputs.choices, previewed);
}
