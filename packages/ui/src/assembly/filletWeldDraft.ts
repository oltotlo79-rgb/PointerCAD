/**
 * すみ肉溶接の操作の下書き。画面の状態は store の 1 か所に置き、ここは純関数だけ。
 *
 * 新しい溶接は「1 つ目の部品の平面(脚が載る面) → その部品の直線の辺(溶接線) → 2 つ目の部品の平面」の順に選ぶ。
 * 既存の溶接を直す時は選び直さず、保存した溶接線のまま脚長・区間・材質を変える。
 * 面と辺の位置・向き・長さは予告と確定のたびにいまの形から読み直し(`bindFilletWeldSelection`)、
 * 確定は予告と同じ計画になる時だけ文書を変える。脚長・材質に既定値は置かない(利用者が決める)。下書きは保存しない。
 */

import { evaluateExpression, exactExpressionValueFromNumber } from '@pointercad/expression';
import {
  applyFilletWeld, bindFilletWeldSelection, faceResolverFromBodies, filletWeldLegs, filletWeldSegmentOptions,
  planFilletWeld, planFilletWeldEdit, resolveSubShapeReference, segmentsFromLengthsAndGaps, weldSegmentsOf,
  type ApplyFilletWeldResult, type AssemblyComponent, type AssemblyDocument, type FilletWeldPlan,
  type FilletWeldPlanResult, type MateTarget, type OccurrenceWeldEditPreview, type OccurrenceWeldPreview, type PartLibrary, type SolidBody, type WeldBodyLookup,
  type WeldGeometryResolver, type WeldSegmentSpec,
} from '@pointercad/model';

import type { AssemblyView } from '../store/assemblySlice.js';

export type FilletWeldSegmentMode = 'continuous' | 'intermittent';

export interface AssemblyFilletWeldDraft {
  readonly documentId: string;
  /** 直す溶接の id。新しい溶接では null(面と辺を選ぶ)。 */
  readonly weldId: string | null;
  /** 選んだもの。順に 1 つ目の面・その部品の辺・2 つ目の面。 */
  readonly picks: readonly MateTarget[];
  /** 式の原文(mm)。脚長は 1 つ目の面の法線の向き(2 つ目の面に載る)・2 つ目の面の法線の向き。 */
  readonly legOnSecondSource: string;
  readonly legOnFirstSource: string;
  readonly mode: FilletWeldSegmentMode;
  /** 溶接線に沿った最初のビードの始点。連続で長さが空なら辺の終わりまで。 */
  readonly startSource: string;
  /** ビードの長さ。断続では `,` か `、` で区切って並べる。 */
  readonly lengthsSource: string;
  /** 断続のビードの間の間隔(長さより 1 つ少なく並べる)。 */
  readonly gapsSource: string;
  /** 質量に使う材質の id。空なら計画が「材質を選んでください」で断る。 */
  readonly materialId: string;
}

/** 欄の変更。文書・直す溶接・選んだものは変えない(選び直しは取消から)。 */
export type FilletWeldDraftPatch = Partial<Omit<AssemblyFilletWeldDraft, 'documentId' | 'weldId' | 'picks'>>;

export type FilletWeldValueField = 'legOnSecond' | 'legOnFirst' | 'start' | 'lengths' | 'gaps';

export type FilletWeldDraftIssue =
  | { readonly kind: 'needPicks'; readonly count: number }
  | { readonly kind: 'value'; readonly field: FilletWeldValueField }
  | { readonly kind: 'gapCount' }
  | { readonly kind: 'segmentCount' }
  | { readonly kind: 'stale' }
  /** 入れ子の部品の溶接の命令が、持ち主・表示などの理由で断った(計画の断りの一覧が無い時)。理由は命令のまま。 */
  | { readonly kind: 'occurrence'; readonly reason: OccurrenceWeldRefusal };

/** 入れ子の部品の溶接の命令の断りの理由(`previewOccurrenceFilletWeld` の失敗の理由そのもの)。 */
export type OccurrenceWeldRefusal = Extract<OccurrenceWeldPreview, { readonly ok: false }>['reason']
  | Extract<OccurrenceWeldEditPreview, { readonly ok: false }>['reason'];

export const FILLET_WELD_PICK_COUNT = 3;

/** 次に選ぶものの文言キー。窓が同じ並びを使う(選ぶ順の正本はこの 1 か所)。 */
export const FILLET_WELD_PICK_GUIDE_KEYS = [
  'assembly.filletWeld.pickFirstFace', 'assembly.filletWeld.pickEdge', 'assembly.filletWeld.pickSecondFace',
] as const;

/** 次に選ぶ部分形状の種類。2 つ目だけが辺(選ぶ種類の切り替えを利用者に求めない)。 */
export function filletWeldPickKind(draft: AssemblyFilletWeldDraft): 'face' | 'edge' {
  return draft.picks.length === 1 ? 'edge' : 'face';
}

export function createFilletWeldDraft(documentId: string): AssemblyFilletWeldDraft {
  return {
    documentId, weldId: null, picks: [], legOnSecondSource: '', legOnFirstSource: '', mode: 'continuous',
    startSource: '0', lengthsSource: '', gapsSource: '', materialId: '',
  };
}

/**
 * 保存した値を欄の式の原文へ戻す。式の文法に指数表記は無い(1e-7 は読めない)ので、`String` ではなく
 * 倍精度を丸めずに普通の 10 進で書く既存の `exactExpressionValueFromNumber` を使う(評価すると同じ値に戻る)。
 */
function numberText(value: number): string {
  return exactExpressionValueFromNumber(value).source;
}

/** 保存した溶接の値で欄を埋めた、直すための下書き。溶接が無い・記録が壊れていれば `null`。 */
export function createFilletWeldEditDraft(
  documentId: string, document: AssemblyDocument, weldId: string,
): AssemblyFilletWeldDraft | null {
  const rows = (weldSegmentsOf(document).get(weldId) ?? []).flatMap((component) => {
    if (component.source.kind !== 'standardPart') return [];
    const options = filletWeldSegmentOptions(component.source.options);
    const legs = filletWeldLegs(component.source.size);
    return options === null || legs === null ? [] : [{ component, options, legs }];
  }).sort((a, b) => a.options.station - b.options.station);
  const first = rows[0];
  if (first === undefined) return null;
  const gaps = rows.slice(1).map((row, index) => {
    const previous = rows[index];
    return previous === undefined ? 0 : row.options.station - (previous.options.station + previous.options.length);
  });
  return {
    documentId, weldId, picks: [],
    legOnSecondSource: numberText(first.legs.legOnSecond), legOnFirstSource: numberText(first.legs.legOnFirst),
    mode: rows.length === 1 ? 'continuous' : 'intermittent',
    startSource: numberText(first.options.station),
    lengthsSource: rows.map((row) => numberText(row.options.length)).join(', '),
    gapsSource: gaps.map(numberText).join(', '),
    materialId: first.component.materialId ?? '',
  };
}

/** 選んでいる部品 1 つが溶接のビードなら、その溶接の id。 */
export function selectedWeldId(document: AssemblyDocument, selection: readonly string[]): string | null {
  if (selection.length !== 1) return null;
  const component = document.components.find((candidate) => candidate.id === selection[0]);
  if (component?.source.kind !== 'standardPart' || component.source.catalog !== 'filletWeld') return null;
  return filletWeldSegmentOptions(component.source.options)?.weldId ?? null;
}

/** 選んだものを 1 つ足す。順(面・同じ部品の辺・別の部品の面)に合わないもの、直す時の選択は足さない(`null`)。 */
export function appendFilletWeldPick(draft: AssemblyFilletWeldDraft, target: MateTarget): AssemblyFilletWeldDraft | null {
  if (draft.weldId !== null || target.kind !== 'subShape' || draft.picks.length >= FILLET_WELD_PICK_COUNT) return null;
  if (target.ref.fingerprint.kind !== filletWeldPickKind(draft)) return null;
  const firstComponent = draft.picks[0]?.componentId;
  if (draft.picks.length === 1 && target.componentId !== firstComponent) return null;
  if (draft.picks.length === 2 && target.componentId === firstComponent) return null;
  return { ...draft, picks: [...draft.picks, target] };
}

function measured(source: string): number | null {
  if (source.trim() === '') return null;
  const result = evaluateExpression(source);
  return result.ok && Number.isFinite(result.value.value) ? result.value.value : null;
}

function measuredList(source: string): number[] | null {
  const parts = source.split(/[,、]/u).map((part) => part.trim()).filter((part) => part !== '');
  const values = parts.map(measured);
  return values.every((value): value is number => value !== null) ? values : null;
}

/**
 * 欄の区間を溶接線に沿った区間へ直す。0 以下・重なり・はみ出しはここでは直さず、計画が理由付きで断る。
 * 連続で長さが空なら、始点から当たりの辺の終わりまでの1本。
 */
export function filletWeldSegments(
  draft: AssemblyFilletWeldDraft, contactLength: number,
): readonly WeldSegmentSpec[] | FilletWeldDraftIssue {
  const start = measured(draft.startSource.trim() === '' ? '0' : draft.startSource);
  if (start === null) return { kind: 'value', field: 'start' };
  if (draft.mode === 'continuous') {
    if (draft.lengthsSource.trim() === '') return [{ start, length: contactLength - start }];
    const length = measured(draft.lengthsSource);
    return length === null ? { kind: 'value', field: 'lengths' } : [{ start, length }];
  }
  const lengths = measuredList(draft.lengthsSource);
  if (lengths === null || lengths.length === 0) return { kind: 'value', field: 'lengths' };
  const gaps = measuredList(draft.gapsSource);
  if (gaps === null) return { kind: 'value', field: 'gaps' };
  if (gaps.length !== lengths.length - 1) return { kind: 'gapCount' };
  // 数の合う有限の値でも、ビードの数が上限(MAX_WELD_SEGMENTS)を超えれば区間を作らない。
  return segmentsFromLengthsAndGaps(start, lengths, gaps) ?? { kind: 'segmentCount' };
}

/** 予告と確定が読む、いまの文書・形・部品の版。 */
export interface FilletWeldDraftContext {
  readonly document: AssemblyDocument;
  readonly resolve: WeldGeometryResolver;
  /** 当たりの判定(ビードの足元が実際の面に載るか)に使う、各部品のいまのボディ。 */
  readonly bodiesOf: WeldBodyLookup;
  readonly partRevisions: ReadonlyMap<string, string>;
}

function partRevisions(library: PartLibrary): Map<string, string> {
  // 締結の下書き(`boltedJointDraft.ts`)と同じ版の作り方。抱き込んだ部品の内容と添付が変われば版が変わる。
  return new Map(library.partFiles.map((file) => [file.ref, `${file.contentHash}:${file.attachmentsDigest}`]));
}

/** いまの表示の形で参照を選び直す口。表示が文書と食い違えば予告しない。 */
export function filletWeldDraftContext(
  document: AssemblyDocument, view: AssemblyView, library: PartLibrary,
): FilletWeldDraftContext | FilletWeldDraftIssue {
  if (view.sourceDocument !== undefined && view.sourceDocument !== document) return { kind: 'stale' };
  const bodiesOf = (component: AssemblyComponent): readonly SolidBody[] | null => {
    const key = view.resolved.partKeys.get(component.id);
    return key === undefined ? null : view.bodies.get(key) ?? null;
  };
  const resolveFace = faceResolverFromBodies(bodiesOf, resolveSubShapeReference);
  return {
    document, partRevisions: partRevisions(library), bodiesOf,
    resolve: (component, reference) => {
      const found = resolveFace(component, reference);
      return found.status === 'matched' ? found.geometry : null;
    },
  };
}

export type FilletWeldDraftPreview =
  | { readonly kind: 'issue'; readonly issue: FilletWeldDraftIssue }
  | { readonly kind: 'plan'; readonly result: FilletWeldPlanResult };

function savedContactLength(document: AssemblyDocument, weldId: string): number {
  const first = weldSegmentsOf(document).get(weldId)?.[0];
  const options = first?.source.kind === 'standardPart' ? filletWeldSegmentOptions(first.source.options) : null;
  return options?.contactLength ?? 0;
}

/** 予告。文書は変えない。 */
export function previewFilletWeldDraft(context: FilletWeldDraftContext, draft: AssemblyFilletWeldDraft): FilletWeldDraftPreview {
  const legOnSecond = measured(draft.legOnSecondSource);
  if (legOnSecond === null) return { kind: 'issue', issue: { kind: 'value', field: 'legOnSecond' } };
  const legOnFirst = measured(draft.legOnFirstSource);
  if (legOnFirst === null) return { kind: 'issue', issue: { kind: 'value', field: 'legOnFirst' } };
  if (draft.weldId !== null) {
    const segments = filletWeldSegments(draft, savedContactLength(context.document, draft.weldId));
    if ('kind' in segments) return { kind: 'issue', issue: segments };
    return { kind: 'plan', result: planFilletWeldEdit(context.document,
      { weldId: draft.weldId, legOnSecond, legOnFirst, segments, materialId: draft.materialId }, context.partRevisions, context.bodiesOf) };
  }
  const [first, edge, second] = draft.picks;
  if (first?.kind !== 'subShape' || edge?.kind !== 'subShape' || second?.kind !== 'subShape') {
    return { kind: 'issue', issue: { kind: 'needPicks', count: draft.picks.length } };
  }
  const bound = bindFilletWeldSelection(context.document, {
    first: { componentId: first.componentId, ref: first.ref },
    edge: { componentId: edge.componentId, ref: edge.ref },
    second: { componentId: second.componentId, ref: second.ref },
  }, context.resolve, context.partRevisions);
  if (!bound.ok) return { kind: 'plan', result: { ok: false, rejections: bound.rejections } };
  const segments = filletWeldSegments(draft, bound.edge.length);
  if ('kind' in segments) return { kind: 'issue', issue: segments };
  return { kind: 'plan', result: planFilletWeld(context.document, {
    first: bound.first, edge: bound.edge, second: bound.second, legOnSecond, legOnFirst, segments, materialId: draft.materialId,
  }, context.partRevisions, context.bodiesOf) };
}

/** 確定。いまの形で計画し直し、予告と同じ計画の時だけ新しい文書を返す。それ以外は文書を変えない。 */
export function commitFilletWeldDraft(
  context: FilletWeldDraftContext, draft: AssemblyFilletWeldDraft, previewed: FilletWeldPlan,
): ApplyFilletWeldResult | { readonly ok: false; readonly issue: FilletWeldDraftIssue } {
  const preview = previewFilletWeldDraft(context, draft);
  if (preview.kind === 'issue') return { ok: false, issue: preview.issue };
  if (!preview.result.ok || JSON.stringify(preview.result.plan) !== JSON.stringify(previewed)) {
    return { ok: false, issue: { kind: 'stale' } };
  }
  return applyFilletWeld(context.document, preview.result.plan, context.partRevisions);
}
