/**
 * 図面の溶接記号を組立の溶接(`WeldSymbol.weldId`)へ明示して結び付けた時の、溶接側の実際の値と照合。
 * 値は図面へ写さず、図面の元と同じ sourceRef・内容の指紋で抱き込んだ組立から毎回読み直す(注記の
 * `machiningFeatureId` と同じ考え方)。溶接を直せば次に読む時に新しい値になり、消せば「見つからない」になる。
 *
 * 溶接記号の 1 組の欄(脚長 1 つ・溶接長 1 つ・中心間隔 1 つ・個数)で表せるのは、2 脚が等しく、ビードが 1 本か、
 * 同じ長さのビードが同じ中心間隔で並ぶ溶接だけ。区間ごとに長さ・間隔が違う溶接と、2 脚の長さが違う溶接は
 * 記号では表せないと明示し、記号を解決済みにしない。それらの値は記号とは別の補足の一覧(各ビードの始点・終点・
 * 長さ、ビードの間の間隔、2 脚、範囲)として画面に出す。結び付けていない記号は照合しない(一致するとは言わない)。
 */
import type { DrawingDocument } from '@pointercad/drawing';

import { validPlacement } from '../assembly/fastening/frames.js';
import type { AssemblyDocument } from '../assembly/types.js';
import { filletWeldLegs, filletWeldSegmentOptions, filletWeldSegmentRevision } from '../assembly/welding/filletWeldPart.js';
import { weldSegmentsOf } from '../assembly/welding/planFilletWeld.js';
import { WELD_LENGTH_TOLERANCE_MM } from '../assembly/welding/types.js';
import type { DrawingSourceLibrary } from './sourceLibrary.js';
import type { ResolvedWeldSymbol, WeldIssue } from './welding.js';

/** 溶接線に沿った始点・終点・長さ(mm、溶接の始点の測り方のまま)。 */
export interface LinkedWeldBead {
  readonly start: number;
  readonly end: number;
  readonly length: number;
}

export type LinkedWeldLimitation = 'irregularBeads' | 'unequalLegs';

export interface LinkedWeldData {
  readonly weldId: string;
  readonly legOnSecond: number;
  readonly legOnFirst: number;
  /** 始点の順。 */
  readonly beads: readonly LinkedWeldBead[];
  /** 隣り合うビードの間の長さ(ビードの数 − 1 個)。 */
  readonly gaps: readonly number[];
  /** 最初のビードの始点から最後のビードの終点まで。 */
  readonly extent: { readonly start: number; readonly end: number };
  /** 当たりの線の長さ。 */
  readonly contactLength: number;
  /** 記号の 1 組の欄で表せない理由。空なら表せる。 */
  readonly limitations: readonly LinkedWeldLimitation[];
}

export type LinkedWeldMissingReason = 'sourceNotEmbedded' | 'notAssembly' | 'weldMissing' | 'weldDamaged';

export type LinkedWeldResolution =
  | { readonly kind: 'linked'; readonly data: LinkedWeldData }
  | { readonly kind: 'missing'; readonly reason: LinkedWeldMissingReason };

const close = (a: number, b: number): boolean => Math.abs(a - b) <= WELD_LENGTH_TOLERANCE_MM;

/**
 * 抱き込んだ組立の 1 つの溶接の値。ビードの記録は、溶接を直す計画(`planFilletWeldEdit`)と同じ検証を通ったもの
 * だけを使う: 欄が読める(`filletWeldSegmentOptions`)、寸法が読める(`filletWeldLegs`)、生成の版が欄と一致する
 * (`filletWeldSegmentRevision`)、配置が正しい(`validPlacement`)、全ビードで溶接の id・2 部品・当たりの長さ・
 * 脚長が同じ。1 つでも外れれば値を出さず `weldDamaged`(壊れた記録を正しい寸法として図面に出さない)。
 */
export function linkedWeldOf(assembly: AssemblyDocument, weldId: string): LinkedWeldResolution {
  const beads = weldSegmentsOf(assembly).get(weldId);
  if (weldId === '' || beads === undefined || beads.length === 0) return { kind: 'missing', reason: 'weldMissing' };
  let legs: { readonly legOnSecond: number; readonly legOnFirst: number } | null = null;
  let contactLength: number | null = null;
  let parts: readonly [string, string] | null = null;
  const rows: LinkedWeldBead[] = [];
  for (const bead of beads) {
    if (bead.source.kind !== 'standardPart') return { kind: 'missing', reason: 'weldDamaged' };
    const options = filletWeldSegmentOptions(bead.source.options);
    const size = filletWeldLegs(bead.source.size);
    if (options === null || size === null || options.weldId !== weldId || !validPlacement(bead.placement)
      || bead.source.generatorRevision !== filletWeldSegmentRevision(options)) return { kind: 'missing', reason: 'weldDamaged' };
    if ((legs !== null && (legs.legOnSecond !== size.legOnSecond || legs.legOnFirst !== size.legOnFirst))
      || (contactLength !== null && !close(contactLength, options.contactLength))
      || (parts !== null && (parts[0] !== options.parts[0] || parts[1] !== options.parts[1]))) return { kind: 'missing', reason: 'weldDamaged' };
    legs = size;
    contactLength = options.contactLength;
    parts = options.parts;
    rows.push({ start: options.station, end: options.station + options.length, length: options.length });
  }
  if (legs === null || contactLength === null) return { kind: 'missing', reason: 'weldMissing' };
  rows.sort((left, right) => left.start - right.start);
  const gaps = rows.slice(1).map((row, index) => row.start - (rows[index]?.end ?? row.start));
  const first = rows[0], last = rows[rows.length - 1];
  if (first === undefined || last === undefined) return { kind: 'missing', reason: 'weldMissing' };
  const limitations: LinkedWeldLimitation[] = [];
  if (rows.length > 1) {
    const pitch = (rows[1]?.start ?? first.start) - first.start;
    const regular = rows.every((row, index) => close(row.length, first.length)
      && (index === 0 || close(row.start - (rows[index - 1]?.start ?? row.start), pitch)));
    if (!regular) limitations.push('irregularBeads');
  }
  if (!close(legs.legOnSecond, legs.legOnFirst)) limitations.push('unequalLegs');
  return { kind: 'linked', data: { weldId, legOnSecond: legs.legOnSecond, legOnFirst: legs.legOnFirst, beads: rows, gaps,
    extent: { start: first.start, end: last.end }, contactLength, limitations } };
}

/**
 * 図面の元として抱き込んだ組立(図面の `source` と同じ sourceRef・contentHash)から結び付けた溶接を読む。
 * 元が抱き込まれていない・部品の図面の時は照合できない理由を返す。
 */
export function resolveLinkedWeld(document: DrawingDocument, library: DrawingSourceLibrary, weldId: string): LinkedWeldResolution {
  const embedded = library.sources.find((entry) => entry.metadata.sourceRef === document.source.sourceRef
    && entry.metadata.contentHash === document.source.contentHash);
  if (embedded === undefined) return { kind: 'missing', reason: 'sourceNotEmbedded' };
  if (document.source.sourceKind !== 'assembly' || 'sketches' in embedded.document) return { kind: 'missing', reason: 'notAssembly' };
  return linkedWeldOf(embedded.document, weldId);
}

/** 図面の元の組立にある溶接の id(結び付ける欄の選択肢。始点の順ではなく文書の順)。元が無ければ空。 */
export function linkableWeldIds(document: DrawingDocument, library: DrawingSourceLibrary): readonly string[] {
  const embedded = library.sources.find((entry) => entry.metadata.sourceRef === document.source.sourceRef
    && entry.metadata.contentHash === document.source.contentHash);
  if (embedded === undefined || document.source.sourceKind !== 'assembly' || 'sketches' in embedded.document) return [];
  return [...weldSegmentsOf(embedded.document).keys()].filter((id) => id !== '');
}

/** 表せる溶接の記号の欄の値。継手の全長を連続で溶接する時は溶接長を書かない(`null`)。 */
export interface LinkedWeldSymbolValues {
  readonly legMm: number;
  readonly lengthMm: number | null;
  readonly pitchMm: number | null;
  readonly count: number | null;
}

export function linkedWeldSymbolValues(data: LinkedWeldData): LinkedWeldSymbolValues | null {
  const first = data.beads[0], second = data.beads[1];
  if (data.limitations.length > 0 || first === undefined) return null;
  if (second === undefined) {
    const full = close(first.start, 0) && close(first.end, data.contactLength);
    return { legMm: data.legOnSecond, lengthMm: full ? null : first.length, pitchMm: null, count: null };
  }
  return { legMm: data.legOnSecond, lengthMm: first.length, pitchMm: second.start - first.start, count: data.beads.length };
}

const MISSING_MESSAGES: Readonly<Record<LinkedWeldMissingReason, string>> = {
  sourceNotEmbedded: '結び付けた溶接の元の組立が図面に取り込まれていないため、溶接記号を溶接と照合できません。元を取り込み直してください。',
  notAssembly: '溶接への結び付けは、組立を元にした図面だけで使えます。',
  weldMissing: '結び付けた溶接が元の組立に見つかりません(消されたか、別の溶接に置き換わりました)。結び付けを外すか、溶接を選び直してください。',
  weldDamaged: '結び付けた溶接のビードの記録が読めないか食い違っているため、溶接記号を照合できません。',
};
const LIMITATION_MESSAGES: Readonly<Record<LinkedWeldLimitation, string>> = {
  irregularBeads: '結び付けた溶接はビードごとに長さか間隔が違うため、この溶接記号の 1 組の寸法では表せません。各ビードの値は補足の一覧を見てください。',
  unequalLegs: '結び付けた溶接は 2 脚の長さが違うため、この溶接記号の脚長 1 つでは表せません。2 脚の値は補足の一覧を見てください。',
};

/**
 * 結び付けた記号を溶接の値と照合する。結び付けていない記号は照合しない(空)。表せない溶接・見つからない溶接は
 * 必ず理由を返す(記号を解決済みにしない)。表せる溶接は、すみ肉の 1 組だけを持ち、その脚長・溶接長・中心間隔・
 * 個数が溶接の値と許容差の内で一致する時だけ理由が無い。
 */
export function linkedWeldIssues(resolved: ResolvedWeldSymbol, linked: LinkedWeldResolution | null): readonly WeldIssue[] {
  if (resolved.symbol.weldId === undefined || linked === null) return [];
  if (linked.kind === 'missing') return [{ code: 'linkedWeld', message: MISSING_MESSAGES[linked.reason] }];
  if (linked.data.limitations.length > 0) {
    return linked.data.limitations.map((limitation) => ({ code: 'linkedWeld' as const, message: LIMITATION_MESSAGES[limitation] }));
  }
  const expected = linkedWeldSymbolValues(linked.data);
  const side = resolved.sides.length === 1 ? resolved.sides[0] : undefined;
  const same = (actual: number | null, wanted: number | null): boolean => actual === null || wanted === null ? actual === wanted
    : Number.isFinite(actual) && close(actual, wanted);
  const agrees = expected !== null && side !== undefined && side.spec.kind === 'fillet' && side.spec.side !== 'center'
    && side.spec.size?.kind === 'leg' && same(side.sizeMm, expected.legMm) && same(side.lengthMm, expected.lengthMm)
    && same(side.pitchMm, expected.pitchMm) && same(side.count, expected.count);
  return agrees ? [] : [{ code: 'linkedWeld',
    message: '溶接記号の脚長・溶接長・中心間隔・個数が、結び付けた溶接と違います。溶接の値に合わせてください。' }];
}
