/**
 * 入れ子の組の葉の部品どうしのすみ肉溶接の下書き(純関数だけ。画面の状態は store の 1 か所に置く)。
 *
 * 選ぶ順は平らな溶接と同じ「1 つ目の部品の面 → その部品の辺 → 2 つ目の部品の面」。部品は根からの配置の経路
 * (分けない id の並び)で指し、表示の行 ID から作り直さない。形は表示が持つ葉の部品のボディから、動きと組の持ち主は
 * 経路の先頭の根の配置から、model の命令(previewOccurrenceFilletWeld / commitOccurrenceFilletWeld)が決める。
 */

import { evaluateExpression } from '@pointercad/expression';
import {
  commitOccurrenceFilletWeld, commitOccurrenceFilletWeldEdit, faceResolverFromBodies, filletWeldSegmentOptions,
  previewOccurrenceFilletWeld, previewOccurrenceFilletWeldEdit, resolveSubShapeReference, weldSegmentsOf,
  type AssemblyDocument, type CommitJointOccurrenceResult, type CommitOccurrenceWeldEditResult, type FilletWeldEditRequest,
  type JointOccurrenceCommandContext, type OccurrenceWeldChoices, type OccurrenceWeldEditPreview,
  type OccurrenceWeldPick, type OccurrenceWeldPicks, type OccurrenceWeldPreview, type PartLibrary, type ResolvedJointOccurrence,
} from '@pointercad/model';

import type { AssemblyView } from '../store/assemblySlice.js';
import { filletWeldSegments, type AssemblyFilletWeldDraft, type FilletWeldDraftPreview } from './filletWeldDraft.js';
import { jointOccurrenceInputsOf } from '../viewport/pickJointOccurrence.js';

export interface NestedWeldDraft {
  readonly documentId: string;
  /** 選んだもの。順に 1 つ目の面・その配置の辺・別の配置の面。 */
  readonly picks: readonly OccurrenceWeldPick[];
}

export function createNestedWeldDraft(documentId: string): NestedWeldDraft {
  return { documentId, picks: [] };
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** 次に選ぶ部分形状の種類。2 つ目だけが辺。 */
export function nestedWeldPickKind(draft: NestedWeldDraft): 'face' | 'edge' {
  return draft.picks.length === 1 ? 'edge' : 'face';
}

/**
 * 選んだもの 1 つを足す。順(面・同じ配置の辺・別の配置の面)に合わないもの、4 つ目は足さない(`null`)。
 * 配置は経路の全体で比べる(同じ子の組の2か所は、葉の id が同じでも別の配置)。
 */
export function appendNestedWeldPick(draft: NestedWeldDraft, pick: OccurrenceWeldPick): NestedWeldDraft | null {
  if (draft.picks.length >= 3 || pick.ref.fingerprint.kind !== nestedWeldPickKind(draft)) return null;
  const first = draft.picks[0];
  if (draft.picks.length === 1 && (first === undefined || !samePath(first.path, pick.path))) return null;
  if (draft.picks.length === 2 && (first === undefined || samePath(first.path, pick.path))) return null;
  return { ...draft, picks: [...draft.picks, { path: pick.path, ref: pick.ref }] };
}

function weldPicksOf(draft: NestedWeldDraft): OccurrenceWeldPicks | null {
  const [first, edge, second] = draft.picks;
  return first === undefined || edge === undefined || second === undefined ? null : { first, edge, second };
}

/**
 * 命令に渡す、いまの表示の形と部品文書を引く口。表示に解いた時の入力が無ければ `null`(押した時に入力を作り直さない。
 * 入力が今の文書・一式と違う時は、命令の中の経路の解決が stale-view として断る)。
 */
export function nestedJointCommandContext(
  document: AssemblyDocument, library: PartLibrary, view: AssemblyView,
): JointOccurrenceCommandContext | null {
  if (view.source === undefined) return null;
  // 葉の部品の形は、表示が持つ部品の鍵ごとのボディ(同じ子の組の2か所は同じ形を共有し、配置は命令が経路から決める)。
  const bodiesOf = (occurrence: ResolvedJointOccurrence) => view.bodies.get(occurrence.partKey) ?? null;
  return {
    inputs: jointOccurrenceInputsOf(document, library),
    view: { source: view.source, resolved: view.resolved },
    bodiesOf,
    partDocument: (occurrence) => (occurrence.leafComponent.source.kind === 'part'
      ? library.parts.get(occurrence.leafComponent.source.partRef) ?? null : null),
    resolveFace: (occurrence, ref) => faceResolverFromBodies(() => bodiesOf(occurrence), resolveSubShapeReference)(occurrence.leafComponent, ref),
    resolveWeldGeometry: (occurrence, ref) => {
      const found = faceResolverFromBodies(() => bodiesOf(occurrence), resolveSubShapeReference)(occurrence.leafComponent, ref);
      return found.status === 'matched' ? found.geometry : null;
    },
  };
}

export type NestedWeldPreview =
  | { readonly kind: 'needPicks'; readonly count: number }
  | { readonly kind: 'stale' }
  | { readonly kind: 'plan'; readonly result: OccurrenceWeldPreview }
  /** 保存した入れ子の溶接を直す予告(`previewOccurrenceFilletWeldEdit` の結果)。 */
  | { readonly kind: 'edit'; readonly result: OccurrenceWeldEditPreview };

/** 予告。文書は変えない。 */
export function previewNestedWeld(
  context: JointOccurrenceCommandContext | null, draft: NestedWeldDraft, choices: OccurrenceWeldChoices,
): NestedWeldPreview {
  const picks = weldPicksOf(draft);
  if (picks === null) return { kind: 'needPicks', count: draft.picks.length };
  if (context === null) return { kind: 'stale' };
  return { kind: 'plan', result: previewOccurrenceFilletWeld(context, picks, choices) };
}

/** 確定。いまの表示で命令が計画し直し、予告と同じ時だけ新しい根の文書を返す(違えば命令が preview-changed で断る)。 */
export function commitNestedWeld(
  context: JointOccurrenceCommandContext | null, draft: NestedWeldDraft, choices: OccurrenceWeldChoices,
  previewed: Extract<OccurrenceWeldPreview, { readonly ok: true }>,
): CommitJointOccurrenceResult | null {
  const picks = weldPicksOf(draft);
  return picks === null || context === null ? null : commitOccurrenceFilletWeld(context, picks, choices, previewed);
}

function measuredLeg(source: string): number | null {
  if (source.trim() === '') return null;
  const result = evaluateExpression(source);
  return result.ok && Number.isFinite(result.value.value) ? result.value.value : null;
}

/**
 * 溶接の打ちかけの欄(脚長・区間・材質)を、入れ子の命令へ渡す選び方にする。区間の長さの基準は、選んだ辺の今の長さ
 * (辺の指紋の長さ)。欄が数でない・区間を作れない・辺をまだ選んでいなければ `null`(命令を呼ばない)。
 */
export function nestedWeldChoices(weld: AssemblyFilletWeldDraft, draft: NestedWeldDraft): OccurrenceWeldChoices | null {
  const edge = draft.picks[1]?.ref.fingerprint;
  const legOnSecond = measuredLeg(weld.legOnSecondSource);
  const legOnFirst = measuredLeg(weld.legOnFirstSource);
  if (edge?.kind !== 'edge' || legOnSecond === null || legOnFirst === null) return null;
  const segments = filletWeldSegments(weld, edge.length);
  return 'kind' in segments ? null : { legOnSecond, legOnFirst, segments, materialId: weld.materialId };
}

/** 溶接の打ちかけの欄と選んだ経路から、いまの表示で入れ子の予告を作る(欄が足りなければ `null`)。 */
export function nestedWeldPreviewFor(
  document: AssemblyDocument, library: PartLibrary, view: AssemblyView, weld: AssemblyFilletWeldDraft, draft: NestedWeldDraft,
): NestedWeldPreview | null {
  if (draft.picks.length < 3) return { kind: 'needPicks', count: draft.picks.length };
  const choices = nestedWeldChoices(weld, draft);
  return choices === null ? null : previewNestedWeld(nestedJointCommandContext(document, library, view), draft, choices);
}

/**
 * 入れ子の予告を、溶接の窓と状態欄が読む今の予告の形へ写す(窓と状態欄の文言・翻訳はそのまま使う)。
 * 選び終わるまでは選ぶ数、表示に解いた時の入力が無い時は「形が古い」、命令が持ち主・表示などの理由で断った時はその
 * 理由(課題 `occurrence`)、計画の断りはその一覧のまま。欄が数でない時は、今の溶接と同じく欄の予告(`null` のまま窓が欄の理由を出す)。
 */
export function nestedWeldDisplayPreview(
  preview: NestedWeldPreview | null, draft: NestedWeldDraft, weld: AssemblyFilletWeldDraft,
): FilletWeldDraftPreview | null {
  if (preview === null) {
    // 欄が数でない・区間を作れない: 平らな溶接と同じ欄の理由(窓・状態欄の今の文言)で見せる。
    if (measuredLeg(weld.legOnSecondSource) === null) return { kind: 'issue', issue: { kind: 'value', field: 'legOnSecond' } };
    if (measuredLeg(weld.legOnFirstSource) === null) return { kind: 'issue', issue: { kind: 'value', field: 'legOnFirst' } };
    const edge = draft.picks[1]?.ref.fingerprint;
    const segments = edge?.kind === 'edge' ? filletWeldSegments(weld, edge.length) : null;
    return segments !== null && 'kind' in segments ? { kind: 'issue', issue: segments } : null;
  }
  if (preview.kind === 'needPicks') return { kind: 'issue', issue: { kind: 'needPicks', count: draft.picks.length } };
  if (preview.kind === 'stale') return { kind: 'issue', issue: { kind: 'stale' } };
  const result = preview.result;
  if (result.ok) return { kind: 'plan', result: { ok: true, plan: result.plan } };
  return result.rejections.length > 0 ? { kind: 'plan', result: { ok: false, rejections: result.rejections } }
    : { kind: 'issue', issue: { kind: 'occurrence', reason: result.reason } };
}

/** 溶接の打ちかけで今までに選んだ数。入れ子の葉を選んだ後は入れ子の下書きの数(平らな picks は空になる)。 */
export function weldPickCount(weld: AssemblyFilletWeldDraft, nested: NestedWeldDraft | null): number {
  return nested?.picks.length ?? weld.picks.length;
}

/**
 * 溶接の id のビードのどれかが、入れ子の部品の結び付け(`jointOccurrenceConnections`)に入っていれば、
 * その溶接は入れ子の直しの命令で直す。結び付けが壊れていても平らの直しへは落とさない(命令が理由付きで断る)。
 */
export function isOccurrenceWeld(document: AssemblyDocument, weldId: string): boolean {
  const segments = weldSegmentsOf(document).get(weldId) ?? [];
  const beads = new Set(segments.map((bead) => bead.id));
  // 結び付け全体が欠けても、保存した母材の持ち主が子の組なら平らの直しへは落とさない。
  const hasSubAssemblyOwner = segments.some((bead) => {
    const options = bead.source.kind === 'standardPart' ? filletWeldSegmentOptions(bead.source.options) : null;
    return options?.parts.some((id) => document.components.some((component) =>
      component.id === id && component.source.kind === 'subAssembly')) ?? false;
  });
  if (hasSubAssemblyOwner) return true;
  return (document.jointOccurrenceConnections ?? [])
    .some((connection) => connection.componentIds.some((id) => beads.has(id)));
}

/** 保存した溶接の当たりの辺の長さ(区間の欄の基準。最初のビードの記録から読む)。読めなければ `null`。 */
function savedContactLength(document: AssemblyDocument, weldId: string): number | null {
  const first = weldSegmentsOf(document).get(weldId)?.[0];
  const options = first?.source.kind === 'standardPart' ? filletWeldSegmentOptions(first.source.options) : null;
  return options?.contactLength ?? null;
}

/** 直す溶接の欄(脚長・区間・材質)を、直しの命令の頼みにする。欄が数でない・区間を作れなければ `null`。 */
export function nestedWeldEditRequest(document: AssemblyDocument, weld: AssemblyFilletWeldDraft): FilletWeldEditRequest | null {
  if (weld.weldId === null) return null;
  const legOnSecond = measuredLeg(weld.legOnSecondSource);
  const legOnFirst = measuredLeg(weld.legOnFirstSource);
  const contactLength = savedContactLength(document, weld.weldId);
  if (legOnSecond === null || legOnFirst === null || contactLength === null) return null;
  const segments = filletWeldSegments(weld, contactLength);
  return 'kind' in segments ? null : { weldId: weld.weldId, legOnSecond, legOnFirst, segments, materialId: weld.materialId };
}

/** 入れ子の溶接を直す予告(いまの表示が解いた時の入力で)。表示に入力が無ければ古い。欄が足りなければ `null`。 */
export function nestedWeldEditPreviewFor(
  document: AssemblyDocument, library: PartLibrary, view: AssemblyView, weld: AssemblyFilletWeldDraft,
): NestedWeldPreview | null {
  const request = nestedWeldEditRequest(document, weld);
  if (request === null) return null;
  const context = nestedJointCommandContext(document, library, view);
  return context === null ? { kind: 'stale' } : { kind: 'edit', result: previewOccurrenceFilletWeldEdit(context, request) };
}

/** 直しの確定。予告と同じ時だけ新しい根の文書(命令が古い・変わったものを理由付きで断る)。 */
export function commitNestedWeldEdit(
  document: AssemblyDocument, library: PartLibrary, view: AssemblyView, weld: AssemblyFilletWeldDraft,
  previewed: Extract<OccurrenceWeldEditPreview, { readonly ok: true }>,
): CommitOccurrenceWeldEditResult | null {
  const request = nestedWeldEditRequest(document, weld);
  const context = nestedJointCommandContext(document, library, view);
  return request === null || context === null ? null : commitOccurrenceFilletWeldEdit(context, request, previewed);
}

/** 直しの予告を、窓と状態欄が読む今の予告の形へ写す(欄の理由・計画の断り・命令の理由は新しい溶接と同じ扱い)。 */
export function nestedWeldEditDisplayPreview(
  preview: NestedWeldPreview | null, weld: AssemblyFilletWeldDraft, document: AssemblyDocument,
): FilletWeldDraftPreview | null {
  const displayed = nestedWeldDisplayPreview(preview, createNestedWeldDraft(weld.documentId), weld);
  if (displayed !== null) return displayed;
  // 直す時は面・辺を選び直さない。欄の診断にも保存した当たりの長さを使う。
  const contactLength = weld.weldId === null ? null : savedContactLength(document, weld.weldId);
  if (contactLength === null) return { kind: 'issue', issue: { kind: 'occurrence', reason: 'weld-association-damaged' } };
  const segments = filletWeldSegments(weld, contactLength);
  return 'kind' in segments ? { kind: 'issue', issue: segments } : { kind: 'issue', issue: { kind: 'stale' } };
}
