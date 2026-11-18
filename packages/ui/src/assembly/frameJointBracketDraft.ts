/**
 * 締結部品の自動判別(E-07。設計 wip/e07-e09-design.md §2・§5)の打ちかけの純関数。状態は store の 1 か所(`assemblyJointBracketDraft`)に置き、
 * ここは純関数だけ。
 *
 * - 接続: 今の組立の部材の接続(frameJoints)のうち L・T・突き合わせ。十字は、通す部材と当てる 1 本ずつの T 2 つに分けて扱う。
 * - 予告: 接続ごとに、合う板の候補の全部(合わない物は理由つき)を並べる。候補は自動で確定しない。利用者が接続ごとに 1 つ選ぶ。
 * - 確定: 選んだ候補で接続ごとに計画を作り直し、全部が通った時だけ、1 回の文書で足す(Undo 1 回)。違えば文書を変えずに予告を作り直す。
 * - 入れ替え(E-13): 記録のある接続 1 つの板とつなぎ方を、別の候補へ替える。候補は記録の板・ナット・ボルトを消した文書で作り、確定は
 *   古い部品を消して新しい物を足す 1 回の文書(記録の id は保つ)。今の板の候補に「今」の印を付ける(選ぶまで確定を押せないのは同じ)。
 */
import {
  applyJointBracket, classifyFrameJoints, detachFrameJointRecord, frameSlotCandidates, jointBracketChoices, placedFrameMembers,
  recordedFrameJoint, splitCrossJoints, swapFrameJointBracket,
  type AssemblyDocument, type FrameJoint, type FrameJointRecord, type JointBracketChoice, type JointBracketChoices, type JointBracketInputs,
  type JointBracketRecords, type PartLibrary,
} from '@pointercad/model';

import type { AssemblyView } from '../store/assemblySlice.js';
import { boltedJointGeometryContext } from './boltedJointDraft.js';

/** 遅れて読む族と行の表(板の表・溝用のナットの族と行・板の 2 つの族)。 */
export interface FrameJointBracketData {
  readonly records: JointBracketRecords;
  readonly nutFamily: JointBracketInputs['nutFamily'];
  readonly nutRecords: JointBracketInputs['nutRecords'];
  readonly families: JointBracketInputs['families'];
}

export interface FrameJointBracketDraft {
  readonly documentId: string;
  /** 締結する接続の id(十字は分けた T の id)。 */
  readonly jointIds: readonly string[];
  /** 接続ごとに選んだ候補の鍵(`jointBracketChoiceKey`)。 */
  readonly selected: Readonly<Record<string, string>>;
  readonly choices: JointBracketChoices;
  /** 入れ替える記録の id(新しく留める時は null)。 */
  readonly swapRecordId: string | null;
  /** 同じ形の接続の組(呼ぶ側が渡す。組ごとに 1 つの候補をまとめて選べる)と、組ごとに選んだ候補の形の鍵。 */
  readonly groups: readonly FrameJointBracketGroup[];
  readonly groupSelected: Readonly<Record<string, string>>;
}

/** 同じ形の接続の組(安全柵などの呼ぶ側が作る。鍵と、その組の接続の id)。 */
export interface FrameJointBracketGroup {
  readonly key: string;
  readonly jointIds: readonly string[];
}

export type FrameJointBracketDraftPatch = Partial<Pick<FrameJointBracketDraft, 'choices'>>;

export function createFrameJointBracketDraft(documentId: string, jointIds: readonly string[], groups: readonly FrameJointBracketGroup[] = []):
FrameJointBracketDraft {
  return { documentId, jointIds, selected: {}, choices: { nominal: null, nutEntry: '後入れ', nutMaterial: 'steel' }, swapRecordId: null,
    groups, groupSelected: {} };
}

/** 入れ替えの打ちかけ(記録の接続 1 つ。値の欄は記録の選んだ値で始める)。記録の接続が今の組立に無ければ null。 */
export function createFrameJointSwapDraft(documentId: string, document: AssemblyDocument, view: AssemblyView, recordId: string):
FrameJointBracketDraft | null {
  const record = document.frameJoints?.find((candidate) => candidate.id === recordId);
  const joint = record === undefined ? null : recordedFrameJoint(record, bracketJoints(document, view));
  return record === undefined || joint === null ? null
    : { documentId, jointIds: [joint.id], selected: {}, choices: record.choices, swapRecordId: recordId, groups: [], groupSelected: {} };
}

/** 選んだ部品(板か溝用のナット・ボルト)が属する記録がちょうど 1 つの時、その記録の id。無い・2 つ以上の時は null。 */
export function selectedJointRecordId(document: AssemblyDocument, selection: readonly string[]): string | null {
  const picked = new Set(selection);
  const hits = (document.frameJoints ?? []).filter((record) => picked.has(record.bracket.componentId)
    || record.fastenerIds.some((id) => picked.has(id)));
  return hits.length === 1 ? hits[0]?.id ?? null : null;
}

/** 記録の今の板の候補の鍵(`jointBracketChoiceKey` と同じ形。板の部品が無い・族の部品でない時は null)。 */
function recordChoiceKey(document: AssemblyDocument, record: FrameJointRecord): string | null {
  const source = document.components.find((component) => component.id === record.bracket.componentId)?.source;
  if (source?.kind !== 'standardPart') return null;
  const faces = record.bracket.faces.map((face) => `${face.componentId}:${face.face}`).join(',');
  return `${source.options.family ?? ''}:${source.options.item ?? ''}:${record.bracket.orientation}:${faces}`;
}

/** 候補を作る文書(入れ替えの時は、記録の板・ナット・ボルトを消した文書)。 */
function candidateDocument(document: AssemblyDocument, draft: FrameJointBracketDraft): AssemblyDocument {
  return draft.swapRecordId === null ? document : detachFrameJointRecord(document, draft.swapRecordId, true);
}

/** 今の組立の、締結できる形の接続(L・T・突き合わせ。十字は T 2 つ)。 */
function bracketJoints(document: AssemblyDocument, view: AssemblyView): readonly FrameJoint[] {
  return splitCrossJoints(classifyFrameJoints(placedFrameMembers(document, view.resolved.placements)))
    .filter((joint) => joint.kind === 'L' || joint.kind === 'T' || joint.kind === 'butt');
}

/** 候補の鍵(板の族・行・向き・乗る面。同じ入力なら同じ鍵)。 */
export function jointBracketChoiceKey(choice: JointBracketChoice): string {
  const faces = choice.bracket.faces.map((face) => `${face.componentId}:${face.face}`).join(',');
  return `${choice.bracket.familyId}:${choice.bracket.key}:${choice.bracket.orientation}:${faces}`;
}

/**
 * 候補の形の鍵(接続に依らない): 板の族・行・向きと、乗る面の組。同じ形の接続どうしで「同じ候補」を見分けるのに使う。
 * 途中で当たられる部材(T の通す部材)の面は、当てる部材の端が当たる面に決まるので名前を入れない(柱の両側から当たる横の材でも同じ鍵)。
 * 端で当たる部材の面は、角のどちら側かを分けるので入れる(始点・終点の違いは入れない)。同じ鍵の候補が 1 つの接続に 2 つ以上ある時は、
 * まとめて選ばせない(`groupRowOf` が組から外す)。
 */
function jointBracketShapeKey(choice: JointBracketChoice, joint: FrameJoint): string {
  const parts = new Map(joint.members.map((member) => [member.componentId, member.part]));
  const faces = choice.bracket.faces.map((face) => (parts.get(face.componentId) === 'side' ? 'side' : `end:${face.face}`)).sort().join(',');
  return `${choice.bracket.familyId}:${choice.bracket.key}:${choice.bracket.orientation}:${faces}`;
}

export type FrameJointBracketPreview =
  | { readonly kind: 'issue'; readonly issue: 'loading' | 'stale' | 'noJoints' }
  | { readonly kind: 'plan'; readonly rows: readonly FrameJointBracketRow[]; readonly groups: readonly FrameJointBracketGroupRow[] };

/**
 * まとめて選べる組(2 つ以上の接続のどれにも、通る候補がちょうど 1 つずつある形がある組だけ)。その形と、代表の候補(初めの接続の物)。
 * 形が 1 つも無い組(接続ごとに通る候補が違う)は入れず、その接続は接続ごとに選ぶ(当て推量で選ばない)。
 */
export interface FrameJointBracketGroupRow {
  readonly key: string;
  readonly jointIds: readonly string[];
  readonly shapes: readonly { readonly shapeKey: string; readonly sample: JointBracketChoice }[];
  readonly selectedShape: string | null;
}

/** 組のまとめて選べる形(組の全部の接続で、その形の通る候補がちょうど 1 つ)。 */
function groupRowOf(group: FrameJointBracketGroup, rows: readonly FrameJointBracketRow[], selected: string | undefined):
FrameJointBracketGroupRow | null {
  const members = group.jointIds.flatMap((id) => rows.filter((row) => row.joint.id === id));
  const first = members[0];
  if (first === undefined || members.length < 2) return null;
  const unique = (row: FrameJointBracketRow, shape: string): readonly JointBracketChoice[] =>
    row.choices.filter((choice) => choice.result.ok && jointBracketShapeKey(choice, row.joint) === shape);
  const shapes = first.choices.filter((choice) => choice.result.ok).flatMap((sample) => {
    const shapeKey = jointBracketShapeKey(sample, first.joint);
    return members.every((row) => unique(row, shapeKey).length === 1) ? [{ shapeKey, sample }] : [];
  });
  if (shapes.length === 0) return null;
  return { key: group.key, jointIds: members.map((row) => row.joint.id), shapes,
    selectedShape: selected !== undefined && shapes.some((shape) => shape.shapeKey === selected) ? selected : null };
}

/** 組で選んだ形に合う、接続ごとの候補の鍵(組の接続の全部で 1 つずつ。合わない接続は入れない)。 */
export function jointBracketGroupSelection(preview: FrameJointBracketPreview | null, groupKey: string, shapeKey: string):
Readonly<Record<string, string>> {
  if (preview === null || preview.kind !== 'plan') return {};
  const group = preview.groups.find((candidate) => candidate.key === groupKey);
  if (group === undefined || !group.shapes.some((shape) => shape.shapeKey === shapeKey)) return {};
  return Object.fromEntries(preview.rows.filter((row) => group.jointIds.includes(row.joint.id)).flatMap((row) => {
    const choice = row.choices.find((candidate) => candidate.result.ok && jointBracketShapeKey(candidate, row.joint) === shapeKey);
    return choice === undefined ? [] : [[row.joint.id, jointBracketChoiceKey(choice)]];
  }));
}

export interface FrameJointBracketRow {
  readonly joint: FrameJoint;
  readonly choices: readonly JointBracketChoice[];
  /** 選んだ候補の鍵(選んでいない・選んだ候補が今は無い時は null)。 */
  readonly selectedKey: string | null;
  /** 入れ替えの時の、今の板の候補の鍵(新しく留める時・今の板が無い時は null)。 */
  readonly currentKey: string | null;
}

/** 確定を押せるか(どの接続も、通る候補を 1 つ選んでいる)。 */
export function frameJointBracketReady(preview: FrameJointBracketPreview | null): boolean {
  return preview !== null && preview.kind === 'plan' && preview.rows.length > 0 && preview.rows.every((row) =>
    row.selectedKey !== null && row.choices.some((choice) => jointBracketChoiceKey(choice) === row.selectedKey && choice.result.ok));
}

/** 接続 1 つの計画の入力(部材・溝の候補は今の表示の配置から)。 */
function inputsFor(document: AssemblyDocument, view: AssemblyView, library: PartLibrary, data: FrameJointBracketData, joint: FrameJoint,
  choices: JointBracketChoices): JointBracketInputs {
  const placements = view.resolved.placements;
  const members = new Map(placedFrameMembers(document, placements).map((member) => [member.componentId, member]));
  return { joint, members, frames: frameSlotCandidates(document, placements), records: data.records, families: data.families, choices,
    nutFamily: data.nutFamily, nutRecords: data.nutRecords, partRevisions: boltedJointGeometryContext(document, view, library).partRevisions };
}

/** 予告: 接続ごとの候補と、選んだ候補。表示が古い・読み込み中・接続が無い時は理由。 */
export function previewFrameJointBrackets(document: AssemblyDocument, view: AssemblyView, library: PartLibrary, draft: FrameJointBracketDraft,
  data: FrameJointBracketData | null): FrameJointBracketPreview {
  if (view.sourceDocument !== document) return { kind: 'issue', issue: 'stale' };
  if (data === null) return { kind: 'issue', issue: 'loading' };
  const record = draft.swapRecordId === null ? undefined : document.frameJoints?.find((candidate) => candidate.id === draft.swapRecordId);
  if (draft.swapRecordId !== null && record === undefined) return { kind: 'issue', issue: 'noJoints' };
  const base = candidateDocument(document, draft);
  const joints = bracketJoints(base, view).filter((joint) => draft.jointIds.includes(joint.id));
  if (joints.length === 0) return { kind: 'issue', issue: 'noJoints' };
  const currentKey = record === undefined ? null : recordChoiceKey(document, record);
  const rows = joints.map((joint): FrameJointBracketRow => {
    const choices = jointBracketChoices(base, inputsFor(base, view, library, data, joint, draft.choices));
    const key = draft.selected[joint.id] ?? null;
    return { joint, choices, selectedKey: key !== null && choices.some((choice) => jointBracketChoiceKey(choice) === key) ? key : null, currentKey };
  });
  const groups = draft.groups.flatMap((group) => {
    const row = groupRowOf(group, rows, draft.groupSelected[group.key]);
    return row === null ? [] : [row];
  });
  return { kind: 'plan', rows, groups };
}

/** 入れ替えの確定: 古い部品を消した文書で、選んだ候補を作り直して替える(記録の id は保つ)。通らなければ作り直した予告。 */
function commitSwap(document: AssemblyDocument, view: AssemblyView, library: PartLibrary,
  context: { readonly draft: FrameJointBracketDraft; readonly data: FrameJointBracketData; readonly preview: FrameJointBracketPreview }):
  { readonly ok: true; readonly document: AssemblyDocument; readonly componentIds: readonly string[] }
  | { readonly ok: false; readonly preview: FrameJointBracketPreview } {
  const { draft, data, preview } = context;
  const row = preview.kind === 'plan' ? preview.rows[0] : undefined;
  if (draft.swapRecordId === null || row === undefined) return { ok: false, preview };
  const base = candidateDocument(document, draft);
  const inputs = inputsFor(base, view, library, data, row.joint, draft.choices);
  const choice = jointBracketChoices(base, inputs).find((candidate) => jointBracketChoiceKey(candidate) === row.selectedKey);
  const swapped = choice === undefined ? null : swapFrameJointBracket(document, draft.swapRecordId, inputs, choice);
  return swapped === null || !swapped.ok ? { ok: false, preview: previewFrameJointBrackets(document, view, library, draft, data) }
    : { ok: true, document: swapped.document, componentIds: swapped.componentIds };
}

/**
 * 確定: 選んだ候補で、接続ごとに計画を作り直して順に足す(後の接続は、前の板を足した文書で計画する)。1 つでも通らなければ、
 * 文書を変えずに作り直した予告を返す。全部が通った時だけ、1 回の文書で返す。
 */
export function commitFrameJointBrackets(document: AssemblyDocument, view: AssemblyView, library: PartLibrary, draft: FrameJointBracketDraft,
  data: FrameJointBracketData | null):
  { readonly ok: true; readonly document: AssemblyDocument; readonly componentIds: readonly string[] }
  | { readonly ok: false; readonly preview: FrameJointBracketPreview } {
  const preview = previewFrameJointBrackets(document, view, library, draft, data);
  if (preview.kind !== 'plan' || data === null || !frameJointBracketReady(preview)) return { ok: false, preview };
  if (draft.swapRecordId !== null) return commitSwap(document, view, library, { draft, data, preview });
  let next = document;
  const componentIds: string[] = [];
  for (const row of preview.rows) {
    const inputs = inputsFor(next, view, library, data, row.joint, draft.choices);
    const choice = jointBracketChoices(next, inputs).find((candidate) => jointBracketChoiceKey(candidate) === row.selectedKey);
    const applied = choice === undefined ? null : applyJointBracket(next, inputs, choice);
    if (applied === null || !applied.ok) return { ok: false, preview: previewFrameJointBrackets(document, view, library, draft, data) };
    next = applied.document;
    componentIds.push(...applied.componentIds);
  }
  return { ok: true, document: next, componentIds };
}
