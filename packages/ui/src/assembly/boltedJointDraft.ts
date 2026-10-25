/**
 * ボルト締結の操作の下書き(追加要件6)。画面の状態は store の 1 か所に置き、ここは純関数だけ。
 *
 * 選ぶ順は「1 つ目の穴の円筒面 → その合わせ面 → 2 つ目の穴の円筒面 → その合わせ面」。
 * 予告と確定は model の `previewBoltedJoint` / `commitBoltedJoint` に任せ、確定の直前に同じ選択を
 * いまの形へ結び直す(選んだ面の指紋を寸法の正本にしない)。下書きは保存しない。
 */

import { evaluateExpression } from '@pointercad/expression';
import {
  buildStandardPartFromSource, CLEARANCE_EVIDENCE, commitBoltedJoint, faceResolverFromBodies, findComponent,
  globalUnverifiedLengthAvailability, HEX_BOLT_TABLE, holeFeatureForSelection, modeledThreadResolverFromBodies, previewBoltedJoint,
  resolveMateTarget, resolveSubShapeReference,
  verifiedMainLengthAvailability,
  boltedJointUserChoices, commitBoltedJointEdit, previewBoltedJointEdit, withBoltedJointRecord,
  type BoltedJointEditFailure, type BoltedJointRecord,
  type ApplyBoltedJointResult, type AssemblyComponent, type AssemblyDocument, type BoltedJointChoices,
  type BoltedJointPlan, type BoltedJointPlanResult, type FastenerDimensionSeries, type FasteningGeometryContext,
  type FasteningHolePick, type FasteningWasherKind, type MateTarget, type ModeledThreadGroupPick, type PartDocument, type PartLibrary,
  type ThreadSeries,
} from '@pointercad/model';

import type { AssemblyView } from '../store/assemblySlice.js';

/** 穴の枠だけで選べる、実らせんの組の一時的な選択(保存しない)。 */
export interface BoltedJointThreadGroupTarget {
  readonly kind: 'modeledThreadGroup';
  readonly componentId: string;
  readonly group: ModeledThreadGroupPick;
}

export type BoltedJointPickTarget = MateTarget | BoltedJointThreadGroupTarget;

export interface AssemblyBoltedJointDraft {
  readonly documentId: string;
  /** 選んだ面。順に 穴A・合わせ面A・穴B・合わせ面B。穴の枠だけは実らせんの組でもよい。 */
  readonly picks: readonly BoltedJointPickTarget[];
  readonly dimensionSeries: FastenerDimensionSeries;
  /** 通し穴どうしで利用者が決めた呼び。空なら確認済みの通し穴の根拠から選ぶ(穴径から推定しない)。 */
  readonly nominal: string;
  readonly threadSeries: ThreadSeries;
  /** 式の原文(mm)。ねじ穴へのねじ込み長さ・止まり穴の底のすきま・ナットの外の突き出し。 */
  readonly engagementSource: string;
  readonly bottomClearanceSource: string;
  readonly protrusionSource: string;
  readonly headWashers: readonly FasteningWasherKind[];
  readonly nutWashers: readonly FasteningWasherKind[];
  /** 直す時だけ: 直す締結の記録の id(面は選び直さない)。新しい締結では無い。 */
  readonly editRecordId?: string;
}

/** 欄の変更。選んだ面と文書の id は変更できない(選び直しは取消から)。 */
export type BoltedJointDraftPatch = Partial<Omit<AssemblyBoltedJointDraft, 'documentId' | 'picks'>>;

export type BoltedJointDraftIssue =
  | { readonly kind: 'needPicks'; readonly count: number }
  | { readonly kind: 'notFace' }
  | { readonly kind: 'holeFeatureUnknown'; readonly componentId: string }
  | { readonly kind: 'value'; readonly field: 'engagement' | 'bottomClearance' | 'protrusion' }
  /** 直す時の断り(計画の断りは計画の理由の一覧で見せる)。 */
  | { readonly kind: Exclude<BoltedJointEditFailure, 'planRejected'> }
  | { readonly kind: 'stale' };

export const BOLTED_JOINT_PICK_COUNT = 4;

/** 次に選ぶ面の文言キー。窓と状態欄が同じ並びを使う(選ぶ順の正本はこの 1 か所)。 */
export const BOLTED_JOINT_PICK_GUIDE_KEYS = [
  'assembly.boltedJoint.pickHoleA', 'assembly.boltedJoint.pickFaceA',
  'assembly.boltedJoint.pickHoleB', 'assembly.boltedJoint.pickFaceB',
] as const;

/**
 * 新しい締結の画面の既定は本体規格・並目(径ごとの推奨呼び長さの根拠がある系列)。下書きは保存しないので、
 * 保存済みの部品・規格部品の配置の既定(附属書JA、`createStandardPartSource`)は変わらない。
 */
export function createBoltedJointDraft(documentId: string): AssemblyBoltedJointDraft {
  return {
    documentId, picks: [], dimensionSeries: 'main', nominal: '', threadSeries: 'coarse',
    engagementSource: '', bottomClearanceSource: '', protrusionSource: '0', headWashers: [], nutWashers: [],
  };
}

/** 今の選択が穴の枠(穴A・穴B)か。実らせんの組はここだけで受ける。 */
export function boltedJointHoleSlotActive(draft: AssemblyBoltedJointDraft): boolean {
  return draft.picks.length < BOLTED_JOINT_PICK_COUNT && draft.picks.length % 2 === 0;
}

/**
 * 面を 1 つ足す。部分形状でない・5 つ目・穴と合わせ面が別の部品の選択は足さない(`null`)。
 * 実らせんの組は穴の枠だけで足す(合わせ面の枠では断る)。
 */
export function appendBoltedJointPick(draft: AssemblyBoltedJointDraft, target: BoltedJointPickTarget): AssemblyBoltedJointDraft | null {
  if (draft.picks.length >= BOLTED_JOINT_PICK_COUNT) return null;
  if (target.kind === 'modeledThreadGroup' ? !boltedJointHoleSlotActive(draft) : target.kind !== 'subShape') return null;
  const pairStart = draft.picks.length % 2 === 1 ? draft.picks[draft.picks.length - 1] : undefined;
  if (pairStart !== undefined && pairStart.componentId !== target.componentId) return null;
  return { ...draft, picks: [...draft.picks, target] };
}

function partRevisions(library: PartLibrary): Map<string, string> {
  return new Map(library.partFiles.map((file) => [file.ref, `${file.contentHash}:${file.attachmentsDigest}`]));
}

function partDocumentOf(library: PartLibrary, component: AssemblyComponent): PartDocument | null {
  switch (component.source.kind) {
    case 'part': return library.parts.get(component.source.partRef) ?? null;
    case 'standardPart': return buildStandardPartFromSource(component.source);
    case 'subAssembly': return null;
  }
}

/** いまの表示の形・部品の一式から、締結の結び付けに使う文脈を作る。 */
export function boltedJointGeometryContext(
  document: AssemblyDocument, view: AssemblyView, library: PartLibrary,
): Parameters<typeof previewBoltedJoint>[0] {
  return {
    document, partRevisions: partRevisions(library),
    resolveConstraintTarget: (target, placements) => resolveMateTarget(target, { ...view.resolved, placements }, {
      subShape: (key, reference) => {
        const body = view.bodies.get(key)?.find((candidate) => candidate.featureId === reference.bodyFeatureId);
        if (body === undefined) return null;
        const resolution = resolveSubShapeReference(body, reference);
        return resolution.status === 'matched' ? resolution.match.geometry : null;
      },
    }),
    partDocument: (component) => partDocumentOf(library, component),
    resolveFace: faceResolverFromBodies((component) => bodiesOfComponent(view, component), resolveSubShapeReference),
    resolveModeledThread: modeledThreadResolverFromBodies((component) => bodiesOfComponent(view, component)),
  };
}

function bodiesOfComponent(view: AssemblyView, component: AssemblyComponent) {
  const key = view.resolved.partKeys.get(component.id);
  return key === undefined ? null : view.bodies.get(key) ?? null;
}

function holePick(context: FasteningGeometryContext, hole: BoltedJointPickTarget, face: BoltedJointPickTarget):
  FasteningHolePick | BoltedJointDraftIssue {
  if (hole.kind === 'modeledThreadGroup' && face.kind === 'subShape') {
    // 由来は今のボディで結び直した証拠から取る(選んだ時の値は照合だけに使う)。
    const component = findComponent(context.document, hole.componentId);
    const resolved = component === undefined ? null : context.resolveModeledThread?.(component, hole.group) ?? null;
    if (resolved?.status !== 'matched') return { kind: 'holeFeatureUnknown', componentId: hole.componentId };
    return { componentId: hole.componentId, holeFeatureId: resolved.evidence.origin.featureId, holeGroup: hole.group, matingFace: face.ref };
  }
  if (hole.kind !== 'subShape' || face.kind !== 'subShape') return { kind: 'notFace' };
  const component = findComponent(context.document, hole.componentId);
  const featureId = component === undefined ? null : holeFeatureForSelection(context, component, hole.ref);
  if (featureId === null) return { kind: 'holeFeatureUnknown', componentId: hole.componentId };
  return { componentId: hole.componentId, holeFeatureId: featureId, holeFace: hole.ref, matingFace: face.ref };
}

function measured(source: string, allowZero: boolean): number | undefined | null {
  if (source.trim() === '') return undefined;
  const result = evaluateExpression(source);
  if (!result.ok || !Number.isFinite(result.value.value)) return null;
  const value = result.value.value;
  return value > 0 || (allowZero && value === 0) ? value : null;
}

/** 下書きの欄を計画の指定へ直す。空欄は「指定なし」(必要なら計画が理由付きで断る)。 */
export function boltedJointChoices(draft: AssemblyBoltedJointDraft): BoltedJointChoices | BoltedJointDraftIssue {
  const engagement = measured(draft.engagementSource, false);
  const blindBottomClearance = measured(draft.bottomClearanceSource, true);
  const minimumProtrusion = measured(draft.protrusionSource, true);
  if (engagement === null) return { kind: 'value', field: 'engagement' };
  if (blindBottomClearance === null) return { kind: 'value', field: 'bottomClearance' };
  if (minimumProtrusion === null) return { kind: 'value', field: 'protrusion' };
  return {
    dimensionSeries: draft.dimensionSeries,
    ...(draft.nominal === '' ? {} : { explicitBolt: { nominal: draft.nominal, threadSeries: draft.threadSeries } }),
    clearanceEvidence: CLEARANCE_EVIDENCE,
    engagement, blindBottomClearance, minimumProtrusion,
    headWashers: draft.headWashers, nutWashers: draft.nutWashers,
    // 本体規格・並目は径ごとの推奨呼び長さ(確認済みの抜粋)を先に使う。根拠の無い系列・呼びだけ、
    // 全径共通の一覧を「未確認」の印のまま候補にし、計画にもその事実を残す。
    lengthAvailability: [...verifiedMainLengthAvailability(),
      ...HEX_BOLT_TABLE.map((row) => globalUnverifiedLengthAvailability(row.key))],
  };
}

export type BoltedJointDraftPreview =
  | { readonly kind: 'issue'; readonly issue: BoltedJointDraftIssue }
  | { readonly kind: 'plan'; readonly result: BoltedJointPlanResult };

function isIssue(value: object): value is BoltedJointDraftIssue {
  return 'kind' in value && typeof value.kind === 'string'
    && ['needPicks', 'notFace', 'holeFeatureUnknown', 'value', 'stale'].includes(value.kind);
}

interface DraftInputs {
  readonly context: FasteningGeometryContext;
  readonly first: FasteningHolePick;
  readonly second: FasteningHolePick;
  readonly choices: BoltedJointChoices;
}

function draftInputs(document: AssemblyDocument, view: AssemblyView, library: PartLibrary,
  draft: AssemblyBoltedJointDraft): DraftInputs | BoltedJointDraftIssue {
  if (view.sourceDocument !== undefined && view.sourceDocument !== document) return { kind: 'stale' };
  const [holeA, faceA, holeB, faceB] = draft.picks;
  if (holeA === undefined || faceA === undefined || holeB === undefined || faceB === undefined) {
    return { kind: 'needPicks', count: draft.picks.length };
  }
  const context = boltedJointGeometryContext(document, view, library);
  const first = holePick(context, holeA, faceA);
  if (isIssue(first)) return first;
  const second = holePick(context, holeB, faceB);
  if (isIssue(second)) return second;
  const choices = boltedJointChoices(draft);
  if (isIssue(choices)) return choices;
  return { context, first, second, choices };
}

/** 直す時の下書き。記録した指定を欄へ入れて開く。 */
export function createBoltedJointEditDraft(documentId: string, record: BoltedJointRecord): AssemblyBoltedJointDraft {
  const choices = record.choices;
  const text = (value: number | undefined): string => (value === undefined ? '' : String(value));
  return {
    documentId, picks: [], editRecordId: record.id, dimensionSeries: choices.dimensionSeries,
    nominal: choices.explicitBolt?.nominal ?? '', threadSeries: choices.explicitBolt?.threadSeries ?? 'coarse',
    engagementSource: text(choices.engagement), bottomClearanceSource: text(choices.blindBottomClearance),
    protrusionSource: text(choices.minimumProtrusion), headWashers: choices.headWashers, nutWashers: choices.nutWashers,
  };
}

interface EditInputs {
  readonly context: FasteningGeometryContext;
  readonly user: ReturnType<typeof boltedJointUserChoices>;
  readonly catalog: Pick<BoltedJointChoices, 'clearanceEvidence' | 'lengthAvailability'>;
}

function editInputs(document: AssemblyDocument, view: AssemblyView, library: PartLibrary,
  draft: AssemblyBoltedJointDraft): EditInputs | BoltedJointDraftIssue {
  if (view.sourceDocument !== undefined && view.sourceDocument !== document) return { kind: 'stale' };
  const choices = boltedJointChoices(draft);
  if (isIssue(choices)) return choices;
  return { context: boltedJointGeometryContext(document, view, library), user: boltedJointUserChoices(choices),
    catalog: { ...(choices.clearanceEvidence === undefined ? {} : { clearanceEvidence: choices.clearanceEvidence }),
      lengthAvailability: choices.lengthAvailability } };
}

/** 直す時の予告。記録の選び方といまの欄で、既存の計画に通し直す(文書は変えない)。 */
function previewEditDraft(document: AssemblyDocument, view: AssemblyView, library: PartLibrary,
  draft: AssemblyBoltedJointDraft, recordId: string): BoltedJointDraftPreview {
  const inputs = editInputs(document, view, library, draft);
  if (isIssue(inputs)) return { kind: 'issue', issue: inputs };
  const preview = previewBoltedJointEdit(inputs.context, recordId, inputs.user, inputs.catalog);
  if (preview.ok) return { kind: 'plan', result: { ok: true, plan: preview.plan } };
  return preview.reason === 'planRejected' ? { kind: 'plan', result: { ok: false, rejections: preview.rejections } }
    : { kind: 'issue', issue: { kind: preview.reason } };
}

/** 直す確定。予告と同じ計画の時だけ、締結部品を入れ替えた 1 つの新しい文書を返す。 */
function commitEditDraft(document: AssemblyDocument, view: AssemblyView, library: PartLibrary,
  draft: AssemblyBoltedJointDraft, recordId: string, previewed: BoltedJointPlan,
): ApplyBoltedJointResult | { readonly ok: false; readonly issue: BoltedJointDraftIssue } {
  const inputs = editInputs(document, view, library, draft);
  if (isIssue(inputs)) return { ok: false, issue: inputs };
  const result = commitBoltedJointEdit(inputs.context, recordId, inputs.user, inputs.catalog, previewed);
  return result.ok ? { ok: true, document: result.document, componentIds: result.record.componentIds }
    : { ok: false, document, rejections: result.rejections };
}

/** 予告。文書は変えない。 */
export function previewBoltedJointDraft(document: AssemblyDocument, view: AssemblyView, library: PartLibrary,
  draft: AssemblyBoltedJointDraft): BoltedJointDraftPreview {
  if (draft.editRecordId !== undefined) return previewEditDraft(document, view, library, draft, draft.editRecordId);
  const inputs = draftInputs(document, view, library, draft);
  if (isIssue(inputs)) return { kind: 'issue', issue: inputs };
  return { kind: 'plan', result: previewBoltedJoint(inputs.context, inputs.first, inputs.second, inputs.choices) };
}

/** 確定。予告と同じ計画になる時だけ新しい文書を返す。それ以外は文書を変えない。 */
export function commitBoltedJointDraft(document: AssemblyDocument, view: AssemblyView, library: PartLibrary,
  draft: AssemblyBoltedJointDraft, previewed: BoltedJointPlan): ApplyBoltedJointResult | { readonly ok: false; readonly issue: BoltedJointDraftIssue } {
  if (draft.editRecordId !== undefined) return commitEditDraft(document, view, library, draft, draft.editRecordId, previewed);
  const inputs = draftInputs(document, view, library, draft);
  if (isIssue(inputs)) return { ok: false, issue: inputs };
  const committed = commitBoltedJoint(inputs.context, inputs.first, inputs.second, inputs.choices, previewed);
  // 直せるよう、確定した締結の選び方と指定を記録する(実らせんの組で選んだ穴は記録しない)。同じ 1 つの新しい文書。
  return committed.ok ? { ...committed, document: withBoltedJointRecord(committed.document, inputs.first, inputs.second,
    inputs.choices, committed.componentIds) } : committed;
}
