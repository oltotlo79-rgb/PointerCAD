/**
 * ボルト締結の操作の入口(EX-06)。画面の予告と確定はどちらもここを通す。
 *
 * - 予告: 選んだ穴と合わせ面を現在の形へ結び付け、整列・規格部品・長さを計画する。文書は変えない。
 * - 確定: 同じ選択をもう一度結び直して計画し直し、予告した計画と完全に同じ時だけ 1 つの新しい
 *   文書を返す(Undo 1段)。形・版・配置・選択のどれかが予告の後に変わっていれば足さずに断る。
 */

import { applyBoltedJoint, type ApplyBoltedJointResult } from './applyBoltedJoint.js';
import { bindHoleSelection, type FasteningHolePick } from './bindHoleSelection.js';
import { existingConstraintRejections, type FasteningConstraintContext } from './existingConstraints.js';
import { planBoltedJoint } from './planBoltedJoint.js';
import { isRejection } from './selectFastener.js';
import type { BoltedJointPlan, BoltedJointPlanResult, BoltedJointRequest } from './types.js';
import type { JointOccurrencePath } from '../jointOccurrence.js';
import { appendJointOccurrenceComponents, jointOccurrenceStamp, occurrenceForGeometryComponent,
  prepareJointOccurrencePair, sameJointOccurrencePreview, type CommitJointOccurrenceResult,
  type JointOccurrenceCommandContext, type JointOccurrenceCommandFailure,
  type JointOccurrencePreviewStamp } from '../jointOccurrenceSelection.js';

/** 穴の選択以外の指定(呼び・座金・ねじ込み長さ・底のすきま・突き出し・長さの候補)。 */
export type BoltedJointChoices = Omit<BoltedJointRequest, 'first' | 'second'>;

export function previewBoltedJoint(
  context: FasteningConstraintContext, first: FasteningHolePick, second: FasteningHolePick, choices: BoltedJointChoices,
): BoltedJointPlanResult {
  const a = bindHoleSelection(context, first);
  const b = bindHoleSelection(context, second);
  if (isRejection(a) || isRejection(b)) {
    return { ok: false, rejections: [a, b].flatMap((entry) => (isRejection(entry) ? [entry] : [])) };
  }
  const result = planBoltedJoint(context.document, { ...choices, first: a, second: b }, context.partRevisions);
  if (!result.ok) return result;
  const rejections = existingConstraintRejections(context, result.plan);
  return rejections.length === 0 ? result : { ok: false, rejections };
}

/** 予告と同じ計画になる時だけ足す。断った時は渡された文書をそのまま返す。 */
export function commitBoltedJoint(
  context: FasteningConstraintContext, first: FasteningHolePick, second: FasteningHolePick,
  choices: BoltedJointChoices, previewed: BoltedJointPlan,
): ApplyBoltedJointResult {
  const current = previewBoltedJoint(context, first, second, choices);
  if (!current.ok) return { ok: false, document: context.document, rejections: current.rejections };
  if (JSON.stringify(current.plan) !== JSON.stringify(previewed)) {
    return { ok: false, document: context.document, rejections: [{ code: 'staleSource', detail: { reason: 'previewChanged' } }] };
  }
  return applyBoltedJoint(context.document, current.plan, context.partRevisions);
}

export interface OccurrenceHolePick {
  readonly path: JointOccurrencePath;
  /** Existing local hole identity; componentId must be the path's last element. */
  readonly pick: FasteningHolePick;
}

export type OccurrenceBoltedJointPreview =
  | { readonly ok: true; readonly plan: BoltedJointPlan; readonly stamp: JointOccurrencePreviewStamp }
  | { readonly ok: false; readonly reason: JointOccurrenceCommandFailure | 'invalid-pick' | 'geometry-rejected';
      readonly rejections: readonly import('./types.js').BoltedJointRejection[] };

/** Nested zero-motion route. The existing flat alignment command above is unchanged. */
export function previewOccurrenceBoltedJoint(context: JointOccurrenceCommandContext,
  first: OccurrenceHolePick, second: OccurrenceHolePick, choices: BoltedJointChoices): OccurrenceBoltedJointPreview {
  if (first.pick.componentId !== first.path[first.path.length - 1]
      || second.pick.componentId !== second.path[second.path.length - 1]) {
    return { ok: false, reason: 'invalid-pick', rejections: [] };
  }
  const prepared = prepareJointOccurrencePair(context, first.path, second.path);
  if (!prepared.ok) return { ...prepared, rejections: [] };
  const pair = prepared.pair;
  const geometry: FasteningConstraintContext = { document: pair.geometryDocument, partRevisions: pair.revisions,
    partDocument: component => {
      const occurrence = occurrenceForGeometryComponent(pair, component);
      return occurrence === null ? null : context.partDocument(occurrence);
    },
    resolveFace: (component, ref) => {
      const occurrence = occurrenceForGeometryComponent(pair, component);
      return occurrence === null ? { status: 'missing' } : context.resolveFace(occurrence, ref);
    },
    resolveModeledThread: (component, group) => {
      const occurrence = occurrenceForGeometryComponent(pair, component);
      return occurrence === null ? { status: 'missing' }
        : context.resolveModeledThread?.(occurrence, group) ?? { status: 'missing' };
    } };
  const result = previewBoltedJoint(geometry, { ...first.pick, componentId: pair.first.occurrenceKey },
    { ...second.pick, componentId: pair.second.occurrenceKey }, choices);
  if (!result.ok) return { ok: false, reason: 'geometry-rejected', rejections: result.rejections };
  if (result.plan.alignment.movedComponentIds.length !== 0) {
    return { ok: false, reason: 'geometry-rejected', rejections: [{ code: 'alignmentBlocked', detail: { reason: 'nestedZeroMotionOnly' } }] };
  }
  return { ok: true, plan: result.plan, stamp: jointOccurrenceStamp(context, pair, result.plan) };
}

export function commitOccurrenceBoltedJoint(context: JointOccurrenceCommandContext,
  first: OccurrenceHolePick, second: OccurrenceHolePick, choices: BoltedJointChoices,
  previewed: Extract<OccurrenceBoltedJointPreview, { readonly ok: true }>): CommitJointOccurrenceResult {
  const current = previewOccurrenceBoltedJoint(context, first, second, choices);
  const document = context.inputs.document;
  if (!current.ok || !sameJointOccurrencePreview(current.stamp, previewed.stamp)) {
    return { ok: false, document, reason: 'preview-changed' };
  }
  const prepared = prepareJointOccurrencePair(context, first.path, second.path);
  if (!prepared.ok) return { ok: false, document, reason: prepared.reason };
  const pair = prepared.pair;
  const staged = applyBoltedJoint(pair.geometryDocument, current.plan, pair.revisions);
  return staged.ok ? appendJointOccurrenceComponents(context, pair, staged.document, staged.componentIds, 'bolt')
    : { ok: false, document, reason: 'invalid-generated-components' };
}
