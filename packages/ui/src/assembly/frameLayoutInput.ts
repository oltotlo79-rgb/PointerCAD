/**
 * フレームの一括配置(J-01 包み 3)の窓の欄の中身: 点の文字(貼り付けられる 1 行に X Y Z)を線の列にし、欄の値から
 * 並べる部材の予告(1 本ごとの長さ・端の伸び縮み・角の扱い)と、店の動作に渡す中身を作る。画面を持たない純関数(検査はここで行う)。
 */
import { evaluateExpression } from '@pointercad/expression';
import type { FrameCornerRule, FrameLine } from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import type { FrameEdgeChoice, FrameEdgeFilter, FrameEdgeOrder } from './frameEdgeChoices.js';
import { frameMembersPreview, type FrameMemberChoice, type FrameMembersPlacement, type FrameMembersRequest } from './frameMembersPlacement.js';

export type FrameUp = 'z' | 'y' | 'x';

/** 線の決め方: 点を入れる(貼り付け)か、選んだ部品のまっすぐな辺から(包み 4a)。 */
type FrameLineSource = 'points' | 'edges';

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
}

export const INITIAL_FRAME_LAYOUT: FrameLayoutState = {
  source: 'points', pointsText: '', closed: false, edges: [], checkedEdges: [], edgeOrder: 'number', edgeFilter: 'all',
  up: 'z', quarterTurns: 0, corners: 'butt', startExtension: '0', endExtension: '0', swapThrough: [],
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
    readonly corners: readonly FrameLayoutCorner[] };

type ParsedLines = { readonly ok: true; readonly lines: readonly FrameLine[] } | { readonly ok: false; readonly message: string };

const fill = (key: MessageKey, values: Readonly<Record<string, string | number>>): string =>
  Object.entries(values).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), t(key));

/** 点の文字を線の列にする。区切りはタブ・カンマ・空白(表計算の表の貼り付け)。空の行は飛ばす。閉じる時は 3 点以上で最後から最初へも 1 本。 */
function parseFrameLines(text: string, closed: boolean): ParsedLines {
  const points: (readonly [number, number, number])[] = [];
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
  if (points.length < 2) return { ok: false, message: t('catalog.frameLayout.error.tooFew') };
  const lines = points.slice(1).map((end, index): FrameLine => ({ start: points[index] ?? end, end }));
  const first = points[0], last = points.at(-1);
  if (closed && points.length >= 3 && first !== undefined && last !== undefined) lines.push({ start: last, end: first });
  return { ok: true, lines };
}

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
  if (state.source === 'points' ? state.pointsText.trim() === '' : state.checkedEdges.length === 0) return { kind: 'empty' };
  const parsed: ParsedLines = state.source === 'points' ? parseFrameLines(state.pointsText, state.closed)
    : { ok: true, lines: checkedEdgeLines(state) };
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
