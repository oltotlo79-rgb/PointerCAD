/**
 * 確定したボルト締結を直す(EX-06)。新しい計画の仕組みは作らず、既存の予告・確定
 * (`previewBoltedJoint`・`commitBoltedJoint`)を、古い締結部品を除いた文書で通し直す。
 *
 * 直すには、穴の選び方と利用者の指定が要る。確定の時にそれを `BoltedJointRecord` として文書に残す
 * (形・長さ・位置・寸法表から作る候補など、導出できる値は残さない。§6 設計の規律)。記録の無い締結
 * (記録を残す前に作った締結・実らせんの組で選んだ締結)は直せないと断り、推測で作り直さない。
 *
 * 成功は 1 つの新しい文書(Undo 1 段): 古い締結部品を外し、同じ板へ新しい部品を足し、記録を差し替える。
 * 板・ほかの部品・合致・ジョイント・組は保つ。断る時は渡された文書をそのまま返す。
 */

import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import { removeComponent } from '../assemblyEdit.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import type { FasteningGeometryContext, FasteningHolePick } from './bindHoleSelection.js';
import { commitBoltedJoint, previewBoltedJoint, type BoltedJointChoices } from './boltedJointCommand.js';
import type { BoltedJointPlan, BoltedJointPlanResult, BoltedJointRejection } from './types.js';

/** 寸法表から毎回作る指定(記録しない)。通し穴の根拠と長さの候補。 */
export type BoltedJointCatalogChoices = Pick<BoltedJointChoices, 'clearanceEvidence' | 'lengthAvailability'>;

/** 利用者が決めた指定だけ(寸法系列・呼び・ねじ込み・底のすきま・突き出し・座金)。 */
export type BoltedJointUserChoices = Omit<BoltedJointChoices, 'clearanceEvidence' | 'lengthAvailability'>;

/** 面で選んだ穴。実らせんの組の選び方は記録しない(その締結は直せないと断る)。 */
export interface BoltedJointRecordedPick {
  readonly componentId: string;
  readonly holeFeatureId: string;
  readonly holeFace: SubShapeRef;
  readonly matingFace: SubShapeRef;
}

/** 確定した平らな締結の、直すための記録(入力だけ)。 */
export interface BoltedJointRecord {
  readonly id: string;
  readonly first: BoltedJointRecordedPick;
  readonly second: BoltedJointRecordedPick;
  readonly choices: BoltedJointUserChoices;
  /** この締結が足した部品(座金・ボルト・ナット)。 */
  readonly componentIds: readonly string[];
}

export type BoltedJointEditFailure =
  /** 記録が無い(記録を残す前に作った締結・実らせんの組で選んだ締結を含む)。 */
  | 'jointRecordMissing'
  /** 足した部品か板が欠けた・規格部品でなくなった・組が解かれた。 */
  | 'jointPartsChanged'
  /** 足した部品に合致・ジョイントが付いている(外すと拘束が消える)。 */
  | 'jointPartsConstrained'
  /** 直すと板が動く(締結の後に板の位置・形が変わった)。 */
  | 'jointGeometryChanged'
  /** 計画が断った(理由は `rejections`)。 */
  | 'planRejected';

export type BoltedJointEditPreview =
  | { readonly ok: true; readonly plan: BoltedJointPlan; readonly record: BoltedJointRecord }
  | { readonly ok: false; readonly reason: BoltedJointEditFailure; readonly rejections: readonly BoltedJointRejection[] };

export type BoltedJointEditResult =
  | { readonly ok: true; readonly document: AssemblyDocument; readonly record: BoltedJointRecord }
  | { readonly ok: false; readonly document: AssemblyDocument; readonly reason: BoltedJointEditFailure;
      readonly rejections: readonly BoltedJointRejection[] };

const FASTENER_CATALOGS: ReadonlySet<string> = new Set(['hexBolt', 'hexNut', 'plainWasher', 'springWasher']);

export function boltedJointRecords(document: AssemblyDocument): readonly BoltedJointRecord[] {
  return document.boltedJoints ?? [];
}

export function findBoltedJointRecord(document: AssemblyDocument, recordId: string): BoltedJointRecord | undefined {
  return boltedJointRecords(document).find((record) => record.id === recordId);
}

/** 部品の id から締結の記録を引く(板・座金・ボルト・ナットのどれでもよい)。 */
export function boltedJointRecordForComponent(document: AssemblyDocument, componentId: string): BoltedJointRecord | undefined {
  return boltedJointRecords(document).find((record) => record.componentIds.includes(componentId)
    || record.first.componentId === componentId || record.second.componentId === componentId);
}

/** 利用者の指定だけを写す(寸法表から作る指定は落とす)。 */
export function boltedJointUserChoices(choices: BoltedJointChoices): BoltedJointUserChoices {
  return {
    dimensionSeries: choices.dimensionSeries,
    ...(choices.explicitBolt === undefined ? {} : { explicitBolt: choices.explicitBolt }),
    ...(choices.engagement === undefined ? {} : { engagement: choices.engagement }),
    ...(choices.blindBottomClearance === undefined ? {} : { blindBottomClearance: choices.blindBottomClearance }),
    ...(choices.minimumProtrusion === undefined ? {} : { minimumProtrusion: choices.minimumProtrusion }),
    headWashers: choices.headWashers, nutWashers: choices.nutWashers,
  };
}

function recordedPick(pick: FasteningHolePick): BoltedJointRecordedPick | null {
  return pick.holeFace === undefined ? null
    : { componentId: pick.componentId, holeFeatureId: pick.holeFeatureId, holeFace: pick.holeFace, matingFace: pick.matingFace };
}

/** 確定した時の選択から記録を作り、文書へ足す。実らせんの組で選んだ穴は記録できないので文書をそのまま返す。 */
export function withBoltedJointRecord(
  document: AssemblyDocument, first: FasteningHolePick, second: FasteningHolePick, choices: BoltedJointChoices,
  componentIds: readonly string[],
): AssemblyDocument {
  const a = recordedPick(first), b = recordedPick(second);
  if (a === null || b === null || componentIds.length === 0) return document;
  const records = boltedJointRecords(document);
  const used = new Set(records.map((record) => record.id));
  let index = records.length + 1;
  while (used.has(`bolted-joint-${String(index)}`)) index += 1;
  const record: BoltedJointRecord = { id: `bolted-joint-${String(index)}`, first: a, second: b,
    choices: boltedJointUserChoices(choices), componentIds };
  return { ...document, boltedJoints: [...records, record] };
}

/** 合致・ジョイントの端(`MateTarget`)が足した部品を指すか(assemblyEdit.ts の targetsComponent と同じ判定)。 */
function referencesAny(target: { readonly componentId: string }, ids: ReadonlySet<string>): boolean {
  return ids.has(target.componentId);
}

/**
 * 記録の部品が今もこの締結のものとして残っているか(欠けた・入れ替わった・抑制した・組が解かれた・拘束が付いた
 * 時は理由を返す)。板は動かさないので、板の位置・形の変化は計画の接触の確かめが断る。
 */
function jointPartsIssue(document: AssemblyDocument, record: BoltedJointRecord): BoltedJointEditFailure | null {
  const find = (id: string): AssemblyComponent | undefined => document.components.find((component) => component.id === id);
  const head = find(record.first.componentId), far = find(record.second.componentId);
  const group = head?.rigidGroupId;
  if (head === undefined || far === undefined || group === undefined || group === '' || far.rigidGroupId !== group) {
    return 'jointPartsChanged';
  }
  const intact = (part: AssemblyComponent | undefined): boolean => part !== undefined && !part.suppressed
    && part.source.kind === 'standardPart' && FASTENER_CATALOGS.has(part.source.catalog) && part.rigidGroupId === group;
  if (record.componentIds.length === 0 || !record.componentIds.map(find).every(intact)) return 'jointPartsChanged';
  const ids = new Set(record.componentIds);
  if ([...document.mates, ...document.joints].some((entry) => referencesAny(entry.a, ids) || referencesAny(entry.b, ids))) {
    return 'jointPartsConstrained';
  }
  return null;
}

/**
 * 直した時の予告。文書は変えない。古い部品を残したままの文書で計画する(計画は板の穴と合わせ面だけを読み、
 * 古い部品は形にも位置にも関わらない)。こうすると新しい部品の id が古い部品の id を再利用しない
 * (`nextComponentId` は今ある id の最大 + 1)。
 */
export function previewBoltedJointEdit(
  context: FasteningGeometryContext, recordId: string, choices: BoltedJointUserChoices, catalog: BoltedJointCatalogChoices,
): BoltedJointEditPreview {
  const record = findBoltedJointRecord(context.document, recordId);
  if (record === undefined) return { ok: false, reason: 'jointRecordMissing', rejections: [] };
  const issue = jointPartsIssue(context.document, record);
  if (issue !== null) return { ok: false, reason: issue, rejections: [] };
  const result: BoltedJointPlanResult = previewBoltedJoint(context, record.first, record.second, { ...choices, ...catalog });
  if (!result.ok) return { ok: false, reason: 'planRejected', rejections: result.rejections };
  // 板は同じ組なので整列は動かさない(alignment.ts の sameGroup)。動く計画は直す操作として受けない。
  if (result.plan.alignment.movedComponentIds.length > 0) return { ok: false, reason: 'jointGeometryChanged', rejections: [] };
  return { ok: true, plan: result.plan, record };
}

/**
 * 直す。予告と同じ計画になる時だけ、新しい部品を足し、古い部品を外し、記録を差し替えた 1 つの文書を返す。
 * 断る時は `context.document` をそのまま返す(途中まで変えた文書を返さない)。
 */
export function commitBoltedJointEdit(
  context: FasteningGeometryContext, recordId: string, choices: BoltedJointUserChoices, catalog: BoltedJointCatalogChoices,
  previewed: BoltedJointPlan,
): BoltedJointEditResult {
  const original = context.document;
  const preview = previewBoltedJointEdit(context, recordId, choices, catalog);
  if (!preview.ok) return { ok: false, document: original, reason: preview.reason, rejections: preview.rejections };
  const committed = commitBoltedJoint(context, preview.record.first, preview.record.second, { ...choices, ...catalog }, previewed);
  if (!committed.ok) return { ok: false, document: original, reason: 'planRejected', rejections: committed.rejections };
  // 古い部品は公開の削除で外す(分解のステップ・入れ子の結び付けからも抜ける)。合致・ジョイントは付いていないと確かめ済み。
  let next = committed.document;
  for (const id of preview.record.componentIds) next = removeComponent(next, id);
  const record: BoltedJointRecord = { ...preview.record, choices, componentIds: committed.componentIds };
  // 記録の並びの位置を保つ(保存の並びが直すたびに入れ替わらない)。
  const records = boltedJointRecords(original).map((entry) => (entry.id === recordId ? record : entry));
  return { ok: true, document: { ...next, boltedJoints: records }, record };
}
