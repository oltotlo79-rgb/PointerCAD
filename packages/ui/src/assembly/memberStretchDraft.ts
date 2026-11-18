/**
 * 伸縮(E-13。設計 wip/e13-design.md §2)の打ちかけの純関数。状態は store の 1 か所(`assemblyMemberStretchDraft`)に置き、ここは純関数だけ。
 *
 * - 欄: 向き(世界の軸の 6 つ)・面の位置(その軸の座標、mm。式でよい)・量(mm。負は縮める)。
 * - 始める時に部材を 1 本選んでいれば、向きはその部材の軸(世界の軸に沿う時だけ。始点 → 終点の向き)、面の位置はその部材の中央で始める。
 *   量は空で始める(利用者が入れる)。
 * - 予告: model の計画(伸び縮みする部材と動く部品、または断る理由と数)。部品の外接箱は表示の形から作る(接合チェックと同じ作り方)。
 * - 確定は予告と同じ入力で計画を作り直し、通った時だけ 1 回の文書で入れる(店の操作)。
 */
import { evaluateExpression } from '@pointercad/expression';
import {
  placedFrameMembers, planMemberStretch, withinMagnitude, type AssemblyDocument, type MemberStretchDirection, type MemberStretchPlan,
  type PartBox, type Vec3,
} from '@pointercad/model';

import type { AssemblyView } from '../store/assemblySlice.js';
import { assemblyPartBoxes } from './frameJointCheckView.js';

type PlacedMember = ReturnType<typeof placedFrameMembers>[number];
/** 向きの文言の鍵の名前(+ や − を鍵に入れない)。 */
type DirectionName = 'plusX' | 'minusX' | 'plusY' | 'minusY' | 'plusZ' | 'minusZ';

/** 向きの選択肢の並び(+X・−X・+Y・−Y・+Z・−Z)と、文言の鍵の名前。 */
export const MEMBER_STRETCH_DIRECTIONS: readonly { readonly direction: MemberStretchDirection; readonly name: DirectionName }[] = [
  { direction: '+x', name: 'plusX' }, { direction: '-x', name: 'minusX' }, { direction: '+y', name: 'plusY' },
  { direction: '-y', name: 'minusY' }, { direction: '+z', name: 'plusZ' }, { direction: '-z', name: 'minusZ' },
];

/** 向きの軸(0 = X・1 = Y・2 = Z)。 */
const MEMBER_STRETCH_AXES: Readonly<Record<MemberStretchDirection, 0 | 1 | 2>> = {
  '+x': 0, '-x': 0, '+y': 1, '-y': 1, '+z': 2, '-z': 2,
};

/** 部材の軸を世界の軸とみなす、成分の大きさの 1 からの差(配置の回転は四元数で、丸めの桁の誤差が残る)。 */
const AXIS_TOLERANCE = 1e-6;
/** 面の位置の初めの値の丸め(mm の 1e-6)。 */
const ROUNDING = 1e6;

export interface MemberStretchDraft {
  readonly documentId: string;
  readonly direction: MemberStretchDirection;
  /** 面の位置と量の入力の文字(式でよい)。 */
  readonly plane: string;
  readonly amount: string;
}

export type MemberStretchDraftPatch = Partial<Pick<MemberStretchDraft, 'direction' | 'plane' | 'amount'>>;

export type MemberStretchPreview =
  | { readonly kind: 'issue'; readonly issue: 'stale' | 'plane' | 'amount' }
  | { readonly kind: 'plan'; readonly plan: MemberStretchPlan; readonly markers: MemberStretchMarkers };

/**
 * 3D の予告の印(E-13 の後の段): 面(向きの軸に直交する、部品の全部を囲む四角)と、動く部品・伸び縮みする部材の今の外接箱。
 * 断る時は、理由の部品(面をまたぐ部品など)の外接箱を出す(どれを直せばよいかを見せる)。
 */
export interface MemberStretchMarkers {
  readonly plane: { readonly axis: 0 | 1 | 2; readonly at: number; readonly min: Vec3; readonly max: Vec3 } | null;
  readonly moved: readonly PartBox[];
  readonly stretched: readonly PartBox[];
  readonly refused: readonly PartBox[];
}

/** 部材の軸が世界の軸に沿う時の、向きと中央の座標。沿わない時は null。 */
function memberAxis(member: PlacedMember): { readonly direction: MemberStretchDirection; readonly plane: number } | null {
  const along: readonly [number, number, number] = [member.end[0] - member.start[0], member.end[1] - member.start[1],
    member.end[2] - member.start[2]];
  const length = Math.hypot(along[0], along[1], along[2]);
  if (!(length > 0)) return null;
  const index = along.findIndex((value) => withinMagnitude(Math.abs(value) / length - 1, AXIS_TOLERANCE));
  const entry = index < 0 ? undefined : MEMBER_STRETCH_DIRECTIONS[index * 2 + ((along[index] ?? 0) > 0 ? 0 : 1)];
  const middle = ((member.start[index] ?? 0) + (member.end[index] ?? 0)) / 2;
  return entry === undefined ? null : { direction: entry.direction, plane: Math.round(middle * ROUNDING) / ROUNDING };
}

/** 打ちかけを作る(選んだ部材 1 本が世界の軸に沿う時は、その軸と中央で始める。無ければ +X・0)。 */
export function createMemberStretchDraft(documentId: string, document: AssemblyDocument, view: AssemblyView, selection: readonly string[]):
MemberStretchDraft {
  const picked = selection.length === 1 ? placedFrameMembers(document, view.resolved.placements)
    .find((member) => member.componentId === selection[0]) : undefined;
  const axis = picked === undefined ? null : memberAxis(picked);
  return { documentId, direction: axis?.direction ?? '+x', plane: axis === null ? '0' : String(axis.plane), amount: '' };
}

/** 入力の文字の値(式でよい)。読めない・有限でない時は null。 */
function numberOf(text: string): number | null {
  if (text.trim() === '') return null;
  const result = evaluateExpression(text);
  return result.ok && Number.isFinite(result.value.value) ? result.value.value : null;
}

/** 予告。表示が古い・面の位置か量が読めない時は理由。 */
export function previewMemberStretch(document: AssemblyDocument, view: AssemblyView, draft: MemberStretchDraft): MemberStretchPreview {
  if (view.sourceDocument !== document) return { kind: 'issue', issue: 'stale' };
  const plane = numberOf(draft.plane);
  if (plane === null) return { kind: 'issue', issue: 'plane' };
  const amount = numberOf(draft.amount);
  if (amount === null) return { kind: 'issue', issue: 'amount' };
  const boxes = assemblyPartBoxes(document, view);
  const plan = planMemberStretch(document, { direction: draft.direction, plane, amount }, boxes);
  return { kind: 'plan', plan, markers: markersOf(plan, boxes, draft.direction, plane) };
}

/** 面を部品の全部の外接箱より少し広げる比(向きの軸に直交する 2 つの向きの両側)。 */
const PLANE_MARGIN_RATIO = 0.1;

/** 予告の印(面は部品の全部の外接箱を囲む。部品が無い時は面を出さない)。 */
function markersOf(plan: MemberStretchPlan, boxes: ReadonlyMap<string, PartBox>, direction: MemberStretchDirection, plane: number):
MemberStretchMarkers {
  const pick = (ids: readonly string[]): PartBox[] => ids.flatMap((id) => {
    const box = boxes.get(id);
    return box === undefined ? [] : [box];
  });
  const all = [...boxes.values()];
  const axis = MEMBER_STRETCH_AXES[direction];
  const low = (k: 0 | 1 | 2): number => Math.min(...all.map((box) => box.min[k]));
  const high = (k: 0 | 1 | 2): number => Math.max(...all.map((box) => box.max[k]));
  const widen = (k: 0 | 1 | 2, value: number, sign: 1 | -1): number => (k === axis ? plane : value + sign * (high(k) - low(k)) * PLANE_MARGIN_RATIO);
  const min: Vec3 = [widen(0, low(0), -1), widen(1, low(1), -1), widen(2, low(2), -1)];
  const max: Vec3 = [widen(0, high(0), 1), widen(1, high(1), 1), widen(2, high(2), 1)];
  const bounds = all.length === 0 ? null : { axis, at: plane, min, max };
  if (!plan.ok) return { plane: bounds, moved: [], stretched: [], refused: pick(plan.componentIds) };
  return { plane: bounds, moved: pick(plan.moved), stretched: pick(plan.stretched.map((member) => member.componentId)), refused: [] };
}

/** 3D の予告の印(窓を閉じた・入力が読めない時は null)。 */
export function memberStretchMarkers(preview: MemberStretchPreview | null): MemberStretchMarkers | null {
  return preview !== null && preview.kind === 'plan' ? preview.markers : null;
}

/** 確定を押せるか(計画が通っている)。 */
export function memberStretchReady(preview: MemberStretchPreview | null): boolean {
  return preview !== null && preview.kind === 'plan' && preview.plan.ok;
}
