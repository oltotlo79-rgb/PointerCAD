/**
 * フレームの一括配置(J-01 包み 3)の窓の欄の中身: 点の文字(貼り付けられる 1 行に X Y Z)を線の列にし、欄の値から
 * 並べる部材の予告(1 本ごとの長さ・端の伸び縮み・角の扱い)と、店の動作に渡す中身を作る。画面を持たない純関数(検査はここで行う)。
 */
import { evaluateExpression } from '@pointercad/expression';
import { frameCenterPoints, type FrameCornerRule, type FrameDimensionBasis, type FrameLine, type Vec3 } from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import type { FrameEdgeChoice, FrameEdgeFilter, FrameEdgeOrder } from './frameEdgeChoices.js';
import {
  frameMemberSection, frameMembersPreview, type FrameMemberChoice, type FrameMembersPlacement, type FrameMembersRequest,
} from './frameMembersPlacement.js';

export type FrameUp = 'z' | 'y' | 'x';

/**
 * 線の決め方: 点を入れる(貼り付け)か、選んだ部品のまっすぐな辺から(包み 4a)か、3D の画面で点を順に打つ(一筆書き、E-08)。
 * 一筆書きで打った点は点の文字の欄に入るので、読み方・予告・置く中身は「点を入れる」と同じ。
 */
type FrameLineSource = 'points' | 'edges' | 'stroke';

/** 窓の欄の値(文字のまま持ち、予告のたびに読み直す)。辺は読み込んだ時の一覧を持つ(読み直すまで変えない)。 */
export interface FrameLayoutState {
  readonly source: FrameLineSource;
  readonly pointsText: string;
  readonly closed: boolean;
  readonly edges: readonly FrameEdgeChoice[];
  readonly checkedEdges: readonly string[];
  readonly edgeOrder: FrameEdgeOrder;
  readonly edgeFilter: FrameEdgeFilter;
  readonly up: FrameUp;
  readonly quarterTurns: number;
  readonly corners: FrameCornerRule;
  readonly startExtension: string;
  readonly endExtension: string;
  readonly swapThrough: readonly number[];
  /** 打った点の寸法の基準(配置の補助 P-B): 芯・内側・外側。内側・外側は閉じた点の形だけ(辺から選ぶ形では使わない)。 */
  readonly dimensionBasis: FrameDimensionBasis;
}

export const INITIAL_FRAME_LAYOUT: FrameLayoutState = {
  source: 'points', pointsText: '', closed: false, edges: [], checkedEdges: [], edgeOrder: 'number', edgeFilter: 'all',
  up: 'z', quarterTurns: 0, corners: 'butt', startExtension: '0', endExtension: '0', swapThrough: [], dimensionBasis: 'center',
};

const UP_VECTORS: Readonly<Record<FrameUp, readonly [number, number, number]>> = { z: [0, 0, 1], y: [0, 1, 0], x: [1, 0, 0] };

/** 予告の表の 1 行(線の名前・長さ・始点の側・終点の側の文字)。 */
interface FrameLayoutRow {
  readonly line: number;
  readonly cells: readonly string[];
}

/** 予告の角の 1 行(文字と、通す線を入れ替えられるか)。 */
interface FrameLayoutCorner {
  readonly index: number;
  readonly text: string;
  readonly swappable: boolean;
}

export type FrameLayoutView =
  | { readonly kind: 'empty' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly request: FrameMembersRequest; readonly rows: readonly FrameLayoutRow[];
    readonly corners: readonly FrameLayoutCorner[];
    /** 内側・外側の寸法から換えた芯の点の文字(1 行に 1 点)。芯の基準と辺から選ぶ形は空。 */
    readonly centers: readonly string[] };

type ParsedLines = { readonly ok: true; readonly lines: readonly FrameLine[]; readonly centers: readonly Vec3[] }
  | { readonly ok: false; readonly message: string };
type CenterPoints = { readonly ok: true; readonly points: readonly Vec3[]; readonly converted: boolean }
  | { readonly ok: false; readonly message: string };

const fill = (key: MessageKey, values: Readonly<Record<string, string | number>>): string =>
  Object.entries(values).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), t(key));

/** 点の文字を点の列にする。区切りはタブ・カンマ・空白(表計算の表の貼り付け)。空の行は飛ばす。読めない行は行の番号つきの理由。 */
export function parseFramePoints(text: string):
{ readonly ok: true; readonly points: readonly Vec3[] } | { readonly ok: false; readonly message: string } {
  const points: Vec3[] = [];
  for (const [index, raw] of text.split('\n').entries()) {
    const tokens = raw.split(/[\s,、，]+/u).filter((token) => token !== '');
    if (tokens.length === 0) continue;
    const values = tokens.map(Number);
    const [x, y, z] = values;
    if (values.length !== 3 || x === undefined || y === undefined || z === undefined || !values.every(Number.isFinite)) {
      return { ok: false, message: fill('catalog.frameLayout.error.badPoint', { line: index + 1 }) };
    }
    points.push([x, y, z]);
  }
  return { ok: true, points };
}

/**
 * 点の文字を線の列にする。点は 2 つ以上。閉じる時は 3 点以上で最後から最初へも 1 本。点は `toCenters` で寸法の基準から芯の点へ換えてから
 * 線にする(P-B。芯の基準はそのまま)。
 */
function parseFrameLines(text: string, closed: boolean, toCenters: (points: readonly Vec3[]) => CenterPoints): ParsedLines {
  const parsed = parseFramePoints(text);
  if (!parsed.ok) return parsed;
  if (parsed.points.length < 2) return { ok: false, message: t('catalog.frameLayout.error.tooFew') };
  const centered = toCenters(parsed.points);
  if (!centered.ok) return centered;
  const points = centered.points;
  const lines = points.slice(1).map((end, index): FrameLine => ({ start: points[index] ?? end, end }));
  const first = points[0], last = points.at(-1);
  if (closed && points.length >= 3 && first !== undefined && last !== undefined) lines.push({ start: last, end: first });
  return { ok: true, lines, centers: centered.converted ? points : [] };
}

type CenterRefusal = Extract<ReturnType<typeof frameCenterPoints>, { readonly ok: false }>['reason'];
const BASIS_REFUSAL_KEYS: Readonly<Record<CenterRefusal, MessageKey>> = {
  notClosed: 'catalog.frameLayout.error.basis.notClosed', notLevel: 'catalog.frameLayout.error.basis.notLevel',
  degenerate: 'catalog.frameLayout.error.basis.degenerate', reversal: 'catalog.frameLayout.error.basis.reversal',
  collapsed: 'catalog.frameLayout.error.basis.collapsed', badSection: 'catalog.frameLayout.error.basis.badSection',
};

/** 寸法の基準の内側・外側を選べるか(点の形〔点を入れる・一筆書き〕を閉じている時。統括の決定 2026-11-19: 閉じた形だけ)。 */
export function frameDimensionBasisAvailable(state: FrameLayoutState): boolean {
  return state.source !== 'edges' && state.closed;
}

/** 打った点を、寸法の基準から芯の点へ換える口(芯ならそのまま)。断面の向きは並べる時と同じ(上の向き・回し)。鋼材も族も同じ計算。 */
function centerPointsFor(state: FrameLayoutState, member: FrameMemberChoice): (points: readonly Vec3[]) => CenterPoints {
  return (points) => {
    if (state.dimensionBasis === 'center') return { ok: true, points, converted: false };
    const section = frameMemberSection(member);
    const result = section === null ? { ok: false as const, reason: 'badSection' as const }
      : frameCenterPoints(points, state.closed, { basis: state.dimensionBasis, up: UP_VECTORS[state.up], quarterTurns: state.quarterTurns,
        section });
    return result.ok ? { ok: true, points: result.points, converted: true } : { ok: false, message: t(BASIS_REFUSAL_KEYS[result.reason]) };
  };
}

/** 芯の点の表示の桁(mm の小数 3 桁。-0 は 0)。 */
const shownMm = (value: number): string => String(Number(value.toFixed(3)) + 0);

const signed = (value: number): string => value > 0 ? `+${String(value)}` : String(value);

/** 置かなかった理由の文字(線の番号は 1 から)。 */
export function frameRejectionText(rejection: Extract<FrameMembersPlacement, { readonly ok: false }>): string {
  const line = rejection.lineIndex === null ? '' : rejection.lineIndex + 1;
  switch (rejection.reason) {
    case 'degenerateLine': return fill('catalog.frameLayout.error.degenerateLine', { line });
    case 'nonPositiveLength': return fill('catalog.frameLayout.error.nonPositiveLength', { line });
    case 'invalidOption': return t('catalog.frameLayout.error.invalidOption');
    case 'miterUnsupported': return t('catalog.frameLayout.error.miterUnsupported');
    default: return t('catalog.frameLayout.error.other');
  }
}

function cornerText(corner: Extract<ReturnType<typeof frameMembersPreview>, { readonly ok: true }>['corners'][number],
  index: number): string {
  const lines = corner.lines.map((line) => line + 1);
  if (corner.treatment === 'butt' && corner.through !== null) {
    return fill('catalog.frameLayout.corner.butt', { n: index + 1, a: lines[0] ?? '', b: lines[1] ?? '', through: corner.through + 1 });
  }
  const key: MessageKey = corner.treatment === 'miter' ? 'catalog.frameLayout.corner.miter' : CORNER_REASON_KEYS[corner.reason ?? 'rule'];
  return fill(key, { n: index + 1, lines: lines.join('・') });
}

type CornerReason = NonNullable<Extract<ReturnType<typeof frameMembersPreview>, { readonly ok: true }>['corners'][number]['reason']>;
const CORNER_REASON_KEYS: Readonly<Record<CornerReason, MessageKey>> = {
  rule: 'catalog.frameLayout.corner.rule', moreThanTwo: 'catalog.frameLayout.corner.moreThanTwo',
  notPerpendicular: 'catalog.frameLayout.corner.notPerpendicular', miterNotAligned: 'catalog.frameLayout.corner.miterNotAligned',
  miterUnequal: 'catalog.frameLayout.corner.miterUnequal',
};

/** 予告の表の端の文字: 伸び縮みの量と、留めで 45° に切る端の印。 */
const endCell = (adjustment: number, miter: string | null): string => signed(adjustment)
  + (miter === null ? '' : t('catalog.frameLayout.miterMark'));

/** 欄の値と部材から予告を作る(点が無い時は空、読めない・作れない時は理由の文字)。 */
export function frameLayoutView(state: FrameLayoutState, member: FrameMemberChoice): FrameLayoutView {
  const fromPoints = state.source !== 'edges';
  if (fromPoints ? state.pointsText.trim() === '' : state.checkedEdges.length === 0) return { kind: 'empty' };
  const parsed: ParsedLines = fromPoints ? parseFrameLines(state.pointsText, state.closed, centerPointsFor(state, member))
    : { ok: true, lines: checkedEdgeLines(state), centers: [] };
  if (!parsed.ok) return { kind: 'error', message: parsed.message };
  const start = evaluateExpression(state.startExtension), end = evaluateExpression(state.endExtension);
  if (!start.ok || !end.ok) return { kind: 'error', message: t('catalog.frameLayout.error.badExtension') };
  const request: FrameMembersRequest = { member, lines: parsed.lines, up: UP_VECTORS[state.up], quarterTurns: state.quarterTurns,
    startExtension: start.value.value, endExtension: end.value.value, corners: state.corners, swapThrough: state.swapThrough };
  const preview = frameMembersPreview(request);
  if (!preview.ok) return { kind: 'error', message: frameRejectionText(preview) };
  return {
    kind: 'ready', request,
    rows: preview.members.map((planned) => ({ line: planned.lineIndex, cells: [fill('catalog.frameLayout.lineName', { n: planned.lineIndex + 1 }),
      String(planned.lengthMm), endCell(planned.startAdjustment, planned.startMiter), endCell(planned.endAdjustment, planned.endMiter)] })),
    corners: preview.corners.map((corner, index) => ({ index, text: cornerText(corner, index),
      swappable: corner.treatment === 'butt' })),
    centers: parsed.centers.map((point, index) => fill('catalog.frameLayout.centerPoint',
      { n: index + 1, x: shownMm(point[0]), y: shownMm(point[1]), z: shownMm(point[2]) })),
  };
}

/** チェックした辺の線(辺の通し番号の順。予告と店へ渡す線の番号はこの順)。 */
function checkedEdgeLines(state: FrameLayoutState): readonly FrameLine[] {
  return state.edges.filter((edge) => state.checkedEdges.includes(edge.targetId)).map((edge) => edge.line);
}

const DIRECTION_KEYS: Readonly<Record<FrameEdgeChoice['direction'], MessageKey>> = {
  x: 'catalog.frameLayout.direction.x', y: 'catalog.frameLayout.direction.y', z: 'catalog.frameLayout.direction.z',
  other: 'catalog.frameLayout.direction.other',
};

/** 辺の一覧の 1 行の文字(番号・長さ・向き・中点)。 */
export function frameEdgeText(edge: FrameEdgeChoice): string {
  return fill('catalog.frameLayout.edge', { n: edge.number, length: edge.lengthMm, direction: t(DIRECTION_KEYS[edge.direction]),
    x: edge.midpoint[0], y: edge.midpoint[1], z: edge.midpoint[2] });
}

/**
 * 店の「辺を選ぶ途中」のチェック(一覧と 3D の画面のクリックの両方が入れ替える。J-01 包み 4b)を欄の値に入れる。
 * 欄の `checkedEdges` は角の入れ替えをした時のチェックで、チェックが変わっていれば角の並びも変わるので入れ替えは初めに戻す。
 */
export function withPickedEdges(state: FrameLayoutState, checked: readonly string[]): FrameLayoutState {
  const same = checked.length === state.checkedEdges.length && checked.every((id, index) => state.checkedEdges[index] === id);
  return { ...state, checkedEdges: checked, swapThrough: same ? state.swapThrough : [] };
}

/** 角の通す線を入れ替える(もう一度押すと元に戻る)。 */
export function toggleFrameCornerSwap(state: FrameLayoutState, cornerIndex: number): FrameLayoutState {
  const swapThrough = state.swapThrough.includes(cornerIndex)
    ? state.swapThrough.filter((index) => index !== cornerIndex) : [...state.swapThrough, cornerIndex].sort((a, b) => a - b);
  return { ...state, swapThrough };
}
