/**
 * 平面から安全柵(E-12 第 1 段)の窓の欄の中身: 欄の文字を読み、model の `planSafetyFence` で柱・横の材・パネルを決め、予告の文字と
 * 置く中身を作る。画面を持たない純関数。柵の部材を並べるだけで、安全の規格への適合は確かめない(窓に 1 文を出す)。
 */
import { evaluateExpression } from '@pointercad/expression';
import {
  planSafetyFence, PRODUCT_CATALOG_REGISTRY, rotateVector, type RigidPlacement, type SafetyFenceResult, type Vec3,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import { parseFramePoints } from './frameLayoutInput.js';
import { frameMemberSection, type FrameMemberChoice } from './frameMembersPlacement.js';

/** パネルの板の族(注文の寸法。幅と高さを欄で入れる)。 */
export const FENCE_PANEL_FAMILY = 'panel-board-order';
/** 足の族(第 2 段): 足の板(板厚の分だけ柱を上げる)とアジャスター(欄の高さの分。皿の厚さ以上)。今ある行だけを選べる。 */
export const FENCE_FOOT_FAMILIES = { base: 't-slot-foot-base', adjuster: 't-slot-adjuster' } as const;
type FenceFootKind = 'none' | keyof typeof FENCE_FOOT_FAMILIES;

/** 窓の欄の値(文字のまま持ち、予告のたびに読み直す)。railItemKey は横の材の族の行(null は柱と同じ部材)。 */
export interface SafetyFenceState {
  readonly pointsText: string;
  readonly closed: boolean;
  readonly height: string;
  readonly spacing: string;
  readonly railItemKey: string | null;
  readonly railHeights: string;
  readonly panelItemKey: string | null;
  readonly panelGap: string;
  /** 足の種類・行・アジャスターの時の床から柱の下端までの高さ(第 2 段)。 */
  readonly footKind: FenceFootKind;
  readonly footItemKey: string | null;
  readonly footHeight: string;
  /** 区画ごとの指定(第 3 段。区画の番号 → 'none' パネル無し・'open' 出入口・板の行の鍵)。点・間隔・板を替えると初めに戻す。 */
  readonly bayOverrides: Readonly<Record<string, string>>;
}

export const INITIAL_SAFETY_FENCE: SafetyFenceState = {
  pointsText: '', closed: true, height: '1200', spacing: '1000', railItemKey: null, railHeights: '100, 1190', panelItemKey: null, panelGap: '0',
  footKind: 'none', footItemKey: null, footHeight: '', bayOverrides: {},
};

/** 置く中身: 柱と横の材の部材、パネルの板の行、計画。 */
export interface SafetyFenceRequest {
  readonly post: FrameMemberChoice;
  readonly rail: FrameMemberChoice;
  readonly panelItemKey: string | null;
  /** 足の族と行(置かない時は null)。 */
  readonly foot: { readonly familyId: string; readonly itemKey: string } | null;
  /** 置くパネル(区画ごとの指定を当てた後。板の行と置き方は区画ごと)。 */
  readonly panels: readonly { readonly bay: number; readonly width: number; readonly height: number; readonly itemKey: string;
    readonly placement: RigidPlacement }[];
  readonly plan: Extract<SafetyFenceResult, { readonly ok: true }>;
}

type SafetyFenceView =
  | { readonly kind: 'empty' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly request: SafetyFenceRequest; readonly summary: string };

const REASON_KEYS: Readonly<Record<string, MessageKey>> = {
  tooFewPoints: 'catalog.fence.error.tooFewPoints', invalidNumber: 'catalog.fence.error.invalidNumber',
  degenerateEdge: 'catalog.fence.error.degenerateEdge', noRoom: 'catalog.fence.error.noRoom', railOutOfRange: 'catalog.fence.error.railOutOfRange',
  noPanelRoom: 'catalog.fence.error.noPanelRoom', tooMany: 'catalog.fence.error.tooMany', panelTooLarge: 'catalog.fence.error.panelTooLarge',
  footTooLow: 'catalog.fence.error.footTooLow', noFoot: 'catalog.fence.error.noFoot',
};

const errorView = (reason: string, bay: number | null = null): SafetyFenceView => ({ kind: 'error',
  message: t(REASON_KEYS[reason] ?? 'catalog.fence.error.invalidNumber').replace('{bay}', String((bay ?? 0) + 1)) });

function numberOf(text: string): number | null {
  const result = evaluateExpression(text);
  return result.ok && Number.isFinite(result.value.value) ? result.value.value : null;
}

/** 横の材の部材(族の行を選んだ時はその行、鋼材と未選択は柱と同じ)。 */
function railChoice(post: FrameMemberChoice, railItemKey: string | null): FrameMemberChoice {
  return railItemKey === null || post.kind !== 'catalogItem' ? post : { ...post, itemKey: railItemKey };
}

/** 寸法ごとの数の並びの文字(「980 × 8、480 × 4」)。 */
function countsText(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([value, count]) => `${value} × ${String(count)}`).join('、');
}

/** パネルの板の行の板厚と、その寸法で板を作れるか(行の大きさの上限)。 */
function panelRow(itemKey: string): { readonly thickness: number; readonly max: readonly [number, number] | null;
  readonly fits: (width: number, height: number) => boolean; } | null {
  const family = PRODUCT_CATALOG_REGISTRY.loaded(FENCE_PANEL_FAMILY);
  const row = family?.rows.find((candidate) => candidate.key === itemKey);
  const thickness = row?.dims.thickness;
  if (family === undefined || row === undefined || thickness === undefined) return null;
  const { maxWidth, maxHeight } = row.dims;
  return { thickness, max: maxWidth === undefined || maxHeight === undefined ? null : [maxWidth, maxHeight],
    fits: (width, height) => family.build(row, { width: String(width), height: String(height) }) !== null };
}

/**
 * 区画ごとの指定を当てたパネル(第 3 段): 'none' と 'open' の区画は置かず、行の鍵を指定した区画はその行の板にする。板厚が全体の行と違う時は、
 * 板の中心が枠の中心の面に乗るよう、置き方を板厚の差の半分だけ面の法線の向きへずらす。行が読めない・上限を超える区画は、その区画の番号。
 */
function bayPanels(plan: Extract<SafetyFenceResult, { readonly ok: true }>, state: SafetyFenceState, thickness: number):
SafetyFenceRequest['panels'] | { readonly reason: 'invalidNumber' | 'panelTooLarge'; readonly bay: number } {
  const panels: SafetyFenceRequest['panels'][number][] = [];
  for (const item of plan.panels) {
    const choice = state.bayOverrides[String(item.bay)];
    if (choice === 'none' || choice === 'open' || state.panelItemKey === null) continue;
    const itemKey = choice ?? state.panelItemKey;
    const row = panelRow(itemKey);
    if (row === null) return { reason: 'invalidNumber', bay: item.bay };
    if (!row.fits(item.width, item.height)) return { reason: 'panelTooLarge', bay: item.bay };
    const normal = rotateVector(item.placement.rotation, [0, 0, 1]), shift = (thickness - row.thickness) / 2;
    const [x, y, z] = item.placement.position;
    panels.push({ bay: item.bay, width: item.width, height: item.height, itemKey, placement: { rotation: item.placement.rotation,
      position: [x + normal[0] * shift, y + normal[1] * shift, z + normal[2] * shift] } });
  }
  return panels;
}

/** 床の線の点の文字(1 行に X Y)を床の点(Z = 0)にする。読めない途中の文字なら null。 */
export function fencePointsOrNull(text: string): readonly Vec3[] | null {
  const parsed = parseFramePoints(text.split('\n').map((line) => line.trim() === '' ? line : `${line} 0`).join('\n'));
  return parsed.ok ? parsed.points : null;
}

/** 3D の画面で打った点の列を、床の線の点の欄の文字(1 行に X Y)にする。 */
export function fenceStrokeText(points: readonly Vec3[]): string {
  return points.map((point) => `${String(point[0])} ${String(point[1])}`).join('\n');
}

/**
 * 3D の画面で打った点を欄の値に重ねる(①)。欄の文字が同じ点の列を表している間(数を直した直後・行末の改行)は文字をそのまま残し、
 * 点が増えた・消えた時だけ書き直す。閉じるも打った点の列に合わせる。変わらない時は同じ値を返す。
 */
export function withFenceStroke(state: SafetyFenceState, stroke: { readonly points: readonly Vec3[]; readonly closed: boolean }): SafetyFenceState {
  const points = fencePointsOrNull(state.pointsText);
  const same = points !== null && points.length === stroke.points.length
    && points.every((point, index) => point[0] === stroke.points[index]?.[0] && point[1] === stroke.points[index]?.[1]);
  if (same && state.closed === stroke.closed) return state;
  return { ...state, pointsText: same ? state.pointsText : fenceStrokeText(stroke.points), closed: stroke.closed };
}

/** 足の族・行と高さ(置かない時は 'none'、行が無い・高さが読めない・皿より低い時は理由)。 */
function footOf(state: SafetyFenceState): { readonly familyId: string; readonly itemKey: string; readonly height: number } | 'none' | 'noFoot'
  | 'invalidNumber' | 'footTooLow' {
  if (state.footKind === 'none') return 'none';
  const familyId = FENCE_FOOT_FAMILIES[state.footKind];
  const row = state.footItemKey === null ? undefined
    : PRODUCT_CATALOG_REGISTRY.loaded(familyId)?.rows.find((candidate) => candidate.key === state.footItemKey);
  if (row === undefined || state.footItemKey === null) return 'noFoot';
  if (state.footKind === 'base') {
    const thickness = row.dims.thickness;
    return thickness === undefined ? 'noFoot' : { familyId, itemKey: state.footItemKey, height: thickness };
  }
  const height = numberOf(state.footHeight), pad = row.dims.padThickness;
  if (height === null || pad === undefined) return 'invalidNumber';
  return height < pad ? 'footTooLow' : { familyId, itemKey: state.footItemKey, height };
}

/** 欄の値と柱の部材から予告を作る(点が無い時は空、読めない・作れない時は理由の文字)。 */
export function safetyFenceView(state: SafetyFenceState, post: FrameMemberChoice): SafetyFenceView {
  if (state.pointsText.trim() === '') return { kind: 'empty' };
  const points = fencePointsOrNull(state.pointsText);
  if (points === null) return { kind: 'error', message: t('catalog.fence.error.badPoint') };
  const foot = footOf(state);
  if (typeof foot === 'string' && foot !== 'none') return errorView(foot);
  const rail = railChoice(post, state.railItemKey);
  const postSection = frameMemberSection(post), railSection = frameMemberSection(rail);
  const height = numberOf(state.height), spacing = numberOf(state.spacing), gap = numberOf(state.panelGap);
  const railHeights = state.railHeights.split(/[,、，\s]+/u).filter((token) => token !== '').map(numberOf);
  const panel = state.panelItemKey === null ? null : panelRow(state.panelItemKey);
  if (postSection === null || railSection === null || height === null || spacing === null || gap === null
    || railHeights.some((value) => value === null) || (state.panelItemKey !== null && panel === null)) return errorView('invalidNumber');
  const plan = planSafetyFence({ points, closed: state.closed, height, maxSpacing: spacing, post: postSection, rail: railSection,
    railHeights: railHeights.filter((value): value is number => value !== null),
    panel: panel === null ? null : { thickness: panel.thickness, gap, max: panel.max },
    foot: foot === 'none' ? null : { height: foot.height },
    openBays: Object.entries(state.bayOverrides).filter(([, value]) => value === 'open').map(([key]) => Number(key)) });
  if (!plan.ok) return errorView(plan.reason, plan.bay);
  const panels = bayPanels(plan, state, panel?.thickness ?? 0);
  if ('reason' in panels) return errorView(panels.reason, panels.bay);
  const railLengths = plan.rails.map((line) => String(Math.round(Math.hypot(line.end[0] - line.start[0], line.end[1] - line.start[1]) * 1e6) / 1e6));
  const summary = t(plan.panels.length === 0 ? 'catalog.fence.previewNoPanel' : 'catalog.fence.preview').replace('{posts}', String(plan.posts.length)).replace('{rails}', String(plan.rails.length))
    .replace('{panels}', String(panels.length)).replace('{railLengths}', countsText(railLengths))
    .replace('{panelSizes}', countsText(panels.map((item) => `${String(item.width)}×${String(item.height)}`)));
  const feet = plan.feet.length === 0 ? '' : t('catalog.fence.previewFeet').replace('{feet}', String(plan.feet.length));
  return { kind: 'ready', request: { post, rail, panelItemKey: state.panelItemKey,
    foot: foot === 'none' ? null : { familyId: foot.familyId, itemKey: foot.itemKey }, panels, plan }, summary: summary + feet };
}
