/**
 * ボルト締結の操作の下書き(追加要件6)。画面の状態は store の 1 か所に置き、ここは純関数だけ。
 *
 * 選ぶ順は「1 つ目の穴の円筒面 → その合わせ面 → 2 つ目の穴の円筒面 → その合わせ面」。4 面がそろった後は、
 * Shift を押して選んだ穴を 2 組目から足す(頭側・相手側を同じ順に。合わせ面は 1 組目の物を共有する。J-02 P4)。
 * 新しい締結の予告と確定は model の `previewBoltedJointSet` / `commitBoltedJointSet` に任せる(穴が 1 組でも同じ口。
 * 穴の入口のざぐり・皿もみに合う頭を選ぶ)。実らせんの組で選んだ 1 組だけは、記録を残せないので今までの
 * `previewBoltedJoint` / `commitBoltedJoint` を使う。確定の直前に同じ選択をいまの形へ結び直す(選んだ面の指紋を
 * 寸法の正本にしない)。下書きは保存しない。
 */

import { evaluateExpression } from '@pointercad/expression';
import {
  applyPlacementToPoint, buildStandardPartFromSource, CLEARANCE_EVIDENCE, commitBoltedJoint, commitBoltedJointSet,
  entryLengthAvailability, faceResolverFromBodies, findComponent, isSameSubShape,
  globalUnverifiedLengthAvailability, HEX_BOLT_TABLE, holeFeatureForSelection, modeledThreadResolverFromBodies, previewBoltedJoint,
  previewBoltedJointSet, resolveMateTarget, resolveSubShapeReference,
  verifiedMainLengthAvailability,
  boltedJointUserChoices, commitBoltedJointEdit, previewBoltedJointEdit, withBoltedJointRecord,
  type BoltedJointEditFailure, type BoltedJointRecord,
  type ApplyBoltedJointResult, type ApplyBoltedJointSetResult, type AssemblyComponent, type AssemblyDocument, type BoltedJointChoices,
  type BoltedJointPlan, type BoltedJointPlanResult, type BoltedJointRejectionCode, type BoltedJointSetPlan, type BoltedJointSetResult,
  type FastenerDimensionSeries, type FasteningExtensionCode, type FasteningExtensionRejection, type FasteningGeometryContext,
  type FasteningHolePick, type FasteningWasherKind, type MateTarget, type ModeledThreadGroupPick, type PartDocument, type PartLibrary,
  type ThreadSeries, type Vec3,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import { displayNumber } from '../sketch/numericInputPresentation.js';
import type { AssemblyView } from '../store/assemblySlice.js';

/** 穴の枠だけで選べる、実らせんの組の一時的な選択(保存しない)。 */
export interface BoltedJointThreadGroupTarget {
  readonly kind: 'modeledThreadGroup';
  readonly componentId: string;
  readonly group: ModeledThreadGroupPick;
}

export type BoltedJointPickTarget = MateTarget | BoltedJointThreadGroupTarget;

/** 穴の内側の面の選択(2 組目からの穴は面だけで足す。実らせんの組は記録を残せないので足さない)。 */
type BoltedJointHoleFaceTarget = Extract<MateTarget, { readonly kind: 'subShape' }>;

/** 2 組目からの穴。頭側は 1 つ目の穴の部品、相手側は 2 つ目の穴の部品の穴。n 番目どうしを 1 組にする。 */
interface BoltedJointExtraHoles {
  readonly first: readonly BoltedJointHoleFaceTarget[];
  readonly second: readonly BoltedJointHoleFaceTarget[];
}

export interface AssemblyBoltedJointDraft {
  readonly documentId: string;
  /** 選んだ面。順に 穴A・合わせ面A・穴B・合わせ面B。穴の枠だけは実らせんの組でもよい。 */
  readonly picks: readonly BoltedJointPickTarget[];
  /** 4 面の後に Shift で足した 2 組目からの穴。無い時は 1 組だけ。 */
  readonly extraHoles?: BoltedJointExtraHoles;
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

/** 欄の変更。選んだ面・足した穴と文書の id は変更できない(選び直しは取消から、穴の足し外しは Shift の選択から)。 */
export type BoltedJointDraftPatch = Partial<Omit<AssemblyBoltedJointDraft, 'documentId' | 'picks' | 'extraHoles'>>;

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

function sameHoleFace(target: BoltedJointPickTarget, hole: BoltedJointHoleFaceTarget): boolean {
  return target.kind === 'subShape' && target.componentId === hole.componentId && isSameSubShape(target.ref, hole.ref);
}

/**
 * 2 組目からの穴を足すか外す(足した穴をもう一度選ぶと外す)。4 面がそろった新しい締結だけで受ける。
 * 1 組目の穴・どちらの穴の部品でもない部品の面・実らせんの組・部分形状でない選択は受けない(`null`)。
 * 頭側の n 番目と相手側の n 番目が 1 組になる(数が合わない時は、予告が組の数の断りを出す)。
 */
export function toggleBoltedJointExtraHole(draft: AssemblyBoltedJointDraft, target: BoltedJointPickTarget): AssemblyBoltedJointDraft | null {
  if (draft.editRecordId !== undefined || draft.picks.length < BOLTED_JOINT_PICK_COUNT || target.kind !== 'subShape') return null;
  const [holeA, , holeB] = draft.picks;
  if (holeA === undefined || holeB === undefined) return null;
  if (sameHoleFace(holeA, target) || sameHoleFace(holeB, target)) return null;
  const first = target.componentId === holeA.componentId;
  if (!first && target.componentId !== holeB.componentId) return null;
  const extra = draft.extraHoles ?? { first: [], second: [] };
  const list = first ? extra.first : extra.second;
  const next = list.some((hole) => sameHoleFace(target, hole)) ? list.filter((hole) => !sameHoleFace(target, hole)) : [...list, target];
  return { ...draft, extraHoles: first ? { first: next, second: extra.second } : { first: extra.first, second: next } };
}

/** 締結する穴の数(頭側・相手側)。4 面がそろう前は 0。 */
export function boltedJointHoleCounts(draft: AssemblyBoltedJointDraft): { readonly first: number; readonly second: number } {
  if (draft.picks.length < BOLTED_JOINT_PICK_COUNT) return { first: 0, second: 0 };
  return { first: 1 + (draft.extraHoles?.first.length ?? 0), second: 1 + (draft.extraHoles?.second.length ?? 0) };
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
    // 全径共通の一覧を「未確認」の印のまま候補にし、計画にもその事実を残す。ざぐり・皿もみの入口に置く
    // 六角穴付き・皿頭のボルトの候補は、族の行ごとの鍵で model が作る(画面は鍵を組み立てない)。
    lengthAvailability: [...verifiedMainLengthAvailability(),
      ...HEX_BOLT_TABLE.map((row) => globalUnverifiedLengthAvailability(row.key)), ...entryLengthAvailability()],
  };
}

/** 穴の見分け: 部品の名前と、選んだ面の中心の組立の座標(選んだ時の指紋の値。表示だけで、照合には使わない)。 */
interface BoltedJointHoleLabel {
  readonly component: string;
  readonly position: Vec3 | null;
}

/** n 番目の組の頭側・相手側の穴。数が合わず片側が無い時は null。 */
interface BoltedJointPairHoles {
  readonly first: BoltedJointHoleLabel | null;
  readonly second: BoltedJointHoleLabel | null;
}

export type BoltedJointDraftPreview =
  | { readonly kind: 'issue'; readonly issue: BoltedJointDraftIssue }
  /**
   * 実らせんの組で選んだ 1 組と、締結を直す時の予告。直す時の断りには、ざぐり・皿もみの入口の断り(`entryRejections`)が
   * 並ぶことがある(六角穴付き・皿頭のボルトの締結を直す時)。
   */
  | { readonly kind: 'plan'; readonly result: BoltedJointPlanResult; readonly entryRejections?: readonly FasteningExtensionRejection[] }
  /**
   * 新しい締結の予告(穴が 1 組でも)。断りは組全体と、穴の組ごとに分かれる。`pairs` は押した順の組ごとの穴で、
   * 順を間違えた時に、どの穴とどの穴が合わないかを断りの行に添える。
   */
  | { readonly kind: 'set'; readonly result: BoltedJointSetResult; readonly pairs: readonly BoltedJointPairHoles[] };

/** 締結できる予告(確定を押せる)。 */
type BoltedJointReadyPreview =
  | (Extract<BoltedJointDraftPreview, { readonly kind: 'plan' }> & { readonly result: Extract<BoltedJointPlanResult, { readonly ok: true }> })
  | (Extract<BoltedJointDraftPreview, { readonly kind: 'set' }> & { readonly result: Extract<BoltedJointSetResult, { readonly ok: true }> });

/** 確定を押せるか。窓・状態欄・確定の操作が同じ判定を使う(1 組でも断られたら押せない)。 */
export function boltedJointPreviewReady(preview: BoltedJointDraftPreview | null): preview is BoltedJointReadyPreview {
  return preview !== null && preview.kind !== 'issue' && preview.result.ok;
}

function isIssue(value: object): value is BoltedJointDraftIssue {
  return 'kind' in value && typeof value.kind === 'string'
    && ['needPicks', 'notFace', 'holeFeatureUnknown', 'value', 'stale'].includes(value.kind);
}

interface DraftInputs {
  readonly context: FasteningGeometryContext;
  /** 頭側と相手側の穴。n 番目どうしが 1 組(1 組目は 4 面の選択、2 組目からは足した穴と 1 組目の合わせ面)。 */
  readonly first: readonly FasteningHolePick[];
  readonly second: readonly FasteningHolePick[];
  readonly choices: BoltedJointChoices;
}

function sidePicks(context: FasteningGeometryContext, base: BoltedJointPickTarget, face: BoltedJointPickTarget,
  extra: readonly BoltedJointHoleFaceTarget[]): FasteningHolePick[] | BoltedJointDraftIssue {
  const picks: FasteningHolePick[] = [];
  for (const hole of [base, ...extra]) {
    const pick = holePick(context, hole, face);
    if (isIssue(pick)) return pick;
    picks.push(pick);
  }
  return picks;
}

function draftInputs(document: AssemblyDocument, view: AssemblyView, library: PartLibrary,
  draft: AssemblyBoltedJointDraft): DraftInputs | BoltedJointDraftIssue {
  if (view.sourceDocument !== undefined && view.sourceDocument !== document) return { kind: 'stale' };
  const [holeA, faceA, holeB, faceB] = draft.picks;
  if (holeA === undefined || faceA === undefined || holeB === undefined || faceB === undefined) {
    return { kind: 'needPicks', count: draft.picks.length };
  }
  const context = boltedJointGeometryContext(document, view, library);
  const first = sidePicks(context, holeA, faceA, draft.extraHoles?.first ?? []);
  if (isIssue(first)) return first;
  const second = sidePicks(context, holeB, faceB, draft.extraHoles?.second ?? []);
  if (isIssue(second)) return second;
  const choices = boltedJointChoices(draft);
  if (isIssue(choices)) return choices;
  return { context, first, second, choices };
}

function holeLabel(document: AssemblyDocument, view: AssemblyView, target: BoltedJointPickTarget | undefined): BoltedJointHoleLabel | null {
  if (target === undefined) return null;
  const placement = view.resolved.placements.get(target.componentId);
  return { component: findComponent(document, target.componentId)?.name ?? target.componentId,
    position: target.kind === 'subShape' && placement !== undefined ? applyPlacementToPoint(placement, target.ref.fingerprint.position) : null };
}

/** 押した順の組ごとの穴(頭側の n 番目と相手側の n 番目)。 */
function pairHoles(document: AssemblyDocument, view: AssemblyView, draft: AssemblyBoltedJointDraft): BoltedJointPairHoles[] {
  const [holeA, , holeB] = draft.picks;
  const first = [holeA, ...(draft.extraHoles?.first ?? [])], second = [holeB, ...(draft.extraHoles?.second ?? [])];
  const pairs: BoltedJointPairHoles[] = [];
  for (let index = 0; index < Math.max(first.length, second.length); index += 1) {
    pairs.push({ first: holeLabel(document, view, first[index]), second: holeLabel(document, view, second[index]) });
  }
  return pairs;
}

/** 実らせんの組で選んだ 1 組だけ。一括の口は穴ごとの記録を約束するが、実らせんの組は記録の形に入らない。 */
function singleThreadGroupPair(inputs: DraftInputs): { readonly first: FasteningHolePick; readonly second: FasteningHolePick } | null {
  const [first] = inputs.first, [second] = inputs.second;
  if (inputs.first.length !== 1 || inputs.second.length !== 1 || first === undefined || second === undefined) return null;
  return first.holeGroup !== undefined || second.holeGroup !== undefined ? { first, second } : null;
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
  // 入口のある締結の予告の plan は、確定の照合に入口の計画を持つ。作り替えずにそのまま渡す。
  if (preview.ok) return { kind: 'plan', result: { ok: true, plan: preview.plan } };
  if (preview.reason !== 'planRejected') return { kind: 'issue', issue: { kind: preview.reason } };
  const entry = preview.entryRejections ?? [];
  return { kind: 'plan', result: { ok: false, rejections: preview.rejections }, ...(entry.length === 0 ? {} : { entryRejections: entry }) };
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
  const single = singleThreadGroupPair(inputs);
  if (single !== null) return { kind: 'plan', result: previewBoltedJoint(inputs.context, single.first, single.second, inputs.choices) };
  return { kind: 'set', result: previewBoltedJointSet(inputs.context, { first: inputs.first, second: inputs.second, choices: inputs.choices }),
    pairs: pairHoles(document, view, draft) };
}

interface DraftCommitIssue { readonly ok: false; readonly issue: BoltedJointDraftIssue }

/**
 * 確定(1 組の計画)。予告と同じ計画になる時だけ新しい文書を返す。それ以外は文書を変えない。直す時と、実らせんの組で
 * 選んだ 1 組の時に使う。
 */
export function commitBoltedJointDraft(document: AssemblyDocument, view: AssemblyView, library: PartLibrary,
  draft: AssemblyBoltedJointDraft, previewed: BoltedJointPlan): ApplyBoltedJointResult | DraftCommitIssue {
  if (draft.editRecordId !== undefined) return commitEditDraft(document, view, library, draft, draft.editRecordId, previewed);
  const inputs = draftInputs(document, view, library, draft);
  if (isIssue(inputs)) return { ok: false, issue: inputs };
  const single = singleThreadGroupPair(inputs);
  if (single === null) return { ok: false, issue: { kind: 'stale' } };
  const committed = commitBoltedJoint(inputs.context, single.first, single.second, inputs.choices, previewed);
  // 直せるよう、確定した締結の選び方と指定を記録する(実らせんの組で選んだ穴は記録しない)。同じ 1 つの新しい文書。
  return committed.ok ? { ...committed, document: withBoltedJointRecord(committed.document, single.first, single.second,
    inputs.choices, committed.componentIds) } : committed;
}

/**
 * 確定(新しい締結の全部の組)。全部の組を結び直して予告と同じ時だけ、穴の組ごとの記録を持つ 1 つの新しい文書を返す
 * (元に戻す 1 回で全部が消える)。1 組でも違えば文書を変えない。
 */
export function commitBoltedJointSetDraft(document: AssemblyDocument, view: AssemblyView, library: PartLibrary,
  draft: AssemblyBoltedJointDraft, previewed: BoltedJointSetPlan): ApplyBoltedJointSetResult | DraftCommitIssue {
  if (draft.editRecordId !== undefined) return { ok: false, issue: { kind: 'stale' } };
  const inputs = draftInputs(document, view, library, draft);
  if (isIssue(inputs)) return { ok: false, issue: inputs };
  return commitBoltedJointSet(inputs.context, { first: inputs.first, second: inputs.second, choices: inputs.choices }, previewed);
}

/** model の断り(今までの code と、入口・組の数の code)。画面は code と detail の reason だけを読む。 */
interface BoltedJointReasonSource {
  readonly code: BoltedJointRejectionCode | FasteningExtensionCode;
  readonly detail: Readonly<Record<string, string | number>>;
}

const UNSUPPORTED_HOLE_DETAILS = ['blindPlainHole', 'entryAwareCommandRequired', 'unrecordableHoleGroup', 'duplicateHole',
  'mixedComponents'] as const;

/**
 * 断りの文言の鍵。同じ code でも、選び直し方が違う物は detail の reason で案内を分ける(穴が対応しない理由、ざぐりの
 * 呼びの指定、皿頭の座金、入口の面・深さ)。それ以外は code の文言。
 */
function boltedJointReasonKey(rejection: BoltedJointReasonSource): MessageKey {
  const reason = rejection.detail.reason;
  switch (rejection.code) {
    case 'unsupportedHole': {
      const detail = UNSUPPORTED_HOLE_DETAILS.find((name) => name === reason);
      return detail === undefined ? 'assembly.boltedJoint.reason.unsupportedHole' : `assembly.boltedJoint.unsupported.${detail}`;
    }
    case 'boltSizeUnspecified':
      return reason === 'counterboreRequiresExplicitNominal' ? 'assembly.boltedJoint.detail.counterboreRequiresExplicitNominal'
        : 'assembly.boltedJoint.reason.boltSizeUnspecified';
    case 'washerDoesNotFit':
      return reason === 'countersunkHeadWasher' ? 'assembly.boltedJoint.detail.countersunkHeadWasher'
        : 'assembly.boltedJoint.reason.washerDoesNotFit';
    case 'threadEntryUnknown':
      return reason === 'entryPlaneMissing' ? 'assembly.boltedJoint.detail.entryPlaneMissing' : 'assembly.boltedJoint.reason.threadEntryUnknown';
    case 'holeFaceMismatch':
      return reason === 'entryDepthMismatch' ? 'assembly.boltedJoint.detail.entryDepthMismatch' : 'assembly.boltedJoint.reason.holeFaceMismatch';
    default:
      return `assembly.boltedJoint.reason.${rejection.code}`;
  }
}

/**
 * 断りの 1 行。`hole` は穴の組の番号(1 から。頭側・相手側の n 番目)と、その組の穴。組全体の断りと、組が 1 つだけの
 * 時は null(1 組の締結の文は今までのまま)。
 */
interface BoltedJointReasonLine {
  readonly key: MessageKey;
  readonly hole: { readonly number: number; readonly pair: BoltedJointPairHoles | null } | null;
}

/**
 * 予告の断りを、組全体の行 → 穴の組の番号の順に並べる。同じ組の同じ文言と、組全体の行と同じ文言(足りない組の
 * 「組の数が揃っていない」)は 1 行にまとめる。
 */
export function boltedJointReasonLines(preview: Exclude<BoltedJointDraftPreview, { readonly kind: 'issue' }>): readonly BoltedJointReasonLine[] {
  const result = preview.result;
  if (result.ok) return [];
  const whole: readonly BoltedJointReasonSource[] = [...result.rejections, ...(preview.kind === 'plan' ? preview.entryRejections ?? [] : [])];
  const lines: BoltedJointReasonLine[] = [];
  for (const rejection of whole) {
    const key = boltedJointReasonKey(rejection);
    if (!lines.some((line) => line.key === key)) lines.push({ key, hole: null });
  }
  if (preview.kind !== 'set' || !('holes' in result)) return lines;
  const numbered = preview.pairs.length > 1;
  for (const failure of [...result.holes].sort((a, b) => a.index - b.index)) {
    for (const rejection of [...failure.rejections, ...failure.entryRejections]) {
      const key = boltedJointReasonKey(rejection);
      const number = failure.index + 1;
      if (lines.some((line) => line.key === key && (line.hole === null || line.hole.number === number))) continue;
      lines.push({ key, hole: numbered ? { number, pair: preview.pairs[failure.index] ?? null } : null });
    }
  }
  return lines;
}

function holeLabelText(label: BoltedJointHoleLabel | null): string {
  if (label === null) return t('assembly.boltedJoint.holeMissing');
  if (label.position === null) return label.component;
  const [x, y, z] = label.position;
  return t('assembly.boltedJoint.holeLabel').replace('{component}', label.component).replace('{x}', displayNumber(x).text)
    .replace('{y}', displayNumber(y).text).replace('{z}', displayNumber(z).text);
}

/**
 * 断りの 1 行の文。2 組以上の時の穴の組の断りは、番号と、その組の頭側・相手側の穴(部品の名前と座標)を添える
 * (押した順を間違えた時に、どの穴とどの穴が合わないかが分かるように)。状態欄は短い形(番号だけ)を使う。
 */
export function boltedJointReasonText(line: BoltedJointReasonLine, withHoles = true): string {
  if (line.hole === null) return t(line.key);
  const number = String(line.hole.number);
  if (!withHoles) return t('assembly.boltedJoint.holeReasonShort').replace('{hole}', number).replace('{reason}', t(line.key));
  return t('assembly.boltedJoint.holeReason').replace('{hole}', number)
    .replace('{first}', holeLabelText(line.hole.pair?.first ?? null)).replace('{second}', holeLabelText(line.hole.pair?.second ?? null))
    .replace('{reason}', t(line.key));
}
