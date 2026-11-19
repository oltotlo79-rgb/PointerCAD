/**
 * 配置の補助 P-A 寸法で動かす(統括の決定 2026-11-19: 1 回だけ動かし、拘束は残さない。残す時は距離の合致)。
 * 選んだ部品(アルミフレーム・鋼材・機械要素・部品のファイル、どれでも同じ)を、世界の軸 1 つの向きに、基準(原点の面か、ほかの部品)からの
 * 寸法が打った数になるように平行に動かす。次の文書を作るだけの純関数(形を作らない。部品の世界の外接箱は呼ぶ側が表示の形から作って渡す。
 * 伸縮〔memberStretch.ts〕と同じ渡し方)。店はこれを 1 回で入れる(元に戻す 1 回で戻る)。
 *
 * - 寸法の取り方(P-B の言葉に揃える): 内側 = 向かい合う面どうしのすき間、芯 = 中心どうし、外側 = 外形の全体(基準の遠い面から部品の遠い面)。
 *   基準が原点の面の時は、面から部品の近い面・中心・遠い面まで。部品が基準のどちら側にあるかは中心で決め、その側で測る(同じなら + の側)。
 * - 動かすのは選んだ部品と、締結で 1 つの組になった部品(rigidGroupId が同じ物。一緒に動く)。位置は動く軸の座標だけを数に置き換える
 *   (ほかの 2 つの座標の式はそのまま。伸縮と同じ)。
 * - 断る(何も変えずに理由を返す): 部品が無い・外接箱が無い・基準が自分(か同じ組)・固定した部品・数が有限でない・動かす量が 0・
 *   動く部品が合致・ジョイントなどに指されている(数。組の中の締結の記録は、組ごと動くので数えない)。
 */
import { expressionValueFromNumber } from '@pointercad/expression';

import { withinMagnitude } from '../numericTolerance.js';
import type { PartBox } from './frame/frameJointCheck.js';
import { componentReferenceCount } from './frame/memberSplitMerge.js';
import { rigidGroupMemberIds } from './rigidGroups.js';
import type { AssemblyComponent, AssemblyDocument } from './types.js';

export type DimensionMoveAxis = 0 | 1 | 2;
export type DimensionMoveBasis = 'inner' | 'center' | 'outer';

/** 基準: 原点を通る面(軸に垂直、座標 0)か、ほかの部品の外接箱。 */
type DimensionMoveReference = { readonly kind: 'origin' } | { readonly kind: 'component'; readonly componentId: string };

interface DimensionMoveRequest {
  readonly componentId: string;
  readonly axis: DimensionMoveAxis;
  readonly reference: DimensionMoveReference;
  readonly basis: DimensionMoveBasis;
  /** 打った寸法(mm)。 */
  readonly target: number;
}

type DimensionMoveRejection = 'unknownComponent' | 'noBox' | 'sameComponent' | 'fixed' | 'nonFinite' | 'noChange' | 'referenced';

export type DimensionMovePlan =
  | { readonly ok: true; readonly document: AssemblyDocument; readonly current: number; readonly delta: number;
    readonly movedIds: readonly string[] }
  | { readonly ok: false; readonly reason: DimensionMoveRejection; readonly count: number };

/** 動かす量が 0 とみなす量(mm)。部材の並べ・伸縮と同じ桁。 */
const MOVE_TOLERANCE_MM = 1e-6;
const ROUNDING = 1e6;
const round = (value: number): number => Math.round(value * ROUNDING) / ROUNDING;
const refused = (reason: DimensionMoveRejection, count = 0): DimensionMovePlan => ({ ok: false, reason, count });

/** 軸の上の範囲(外接箱をその軸へ写した [下, 上])。 */
interface Span {
  readonly low: number;
  readonly high: number;
}

const spanOf = (box: PartBox, axis: DimensionMoveAxis): Span => ({ low: box.min[axis], high: box.max[axis] });
const centerOf = (span: Span): number => (span.low + span.high) / 2;

/**
 * 今の寸法と、部品が基準の + 側か(+ 側なら寸法が増える向きは +、- 側なら -)。基準の範囲は面なら [0, 0]。
 */
function measureDimension(moving: Span, reference: Span, basis: DimensionMoveBasis): { readonly value: number; readonly sign: 1 | -1 } {
  const sign = centerOf(moving) >= centerOf(reference) ? 1 : -1;
  if (basis === 'center') return { value: sign * (centerOf(moving) - centerOf(reference)), sign };
  if (sign === 1) return { value: basis === 'inner' ? moving.low - reference.high : moving.high - reference.low, sign };
  return { value: basis === 'inner' ? reference.low - moving.high : reference.high - moving.low, sign };
}

function shifted(component: AssemblyComponent, axis: DimensionMoveAxis, delta: number): AssemblyComponent {
  const [x, y, z] = component.placement.position;
  const shift = (index: DimensionMoveAxis, value: typeof x): typeof x =>
    (index === axis ? expressionValueFromNumber(round(value.value + delta)) : value);
  return { ...component, placement: { ...component.placement, position: [shift(0, x), shift(1, y), shift(2, z)] } };
}

/** 今の寸法(数を打つ前に窓に出す)。部品・外接箱が無い時と、基準が自分(か同じ組)の時は null。 */
export function measureComponentDimension(document: AssemblyDocument, request: Omit<DimensionMoveRequest, 'target'>,
  boxes: ReadonlyMap<string, PartBox>): number | null {
  const movingBox = boxes.get(request.componentId);
  if (movingBox === undefined || !document.components.some((candidate) => candidate.id === request.componentId)) return null;
  if (request.reference.kind === 'component' && rigidGroupMemberIds(document, request.componentId).includes(request.reference.componentId)) {
    return null;
  }
  const referenceBox = request.reference.kind === 'component' ? boxes.get(request.reference.componentId) : undefined;
  if (request.reference.kind === 'component' && referenceBox === undefined) return null;
  const reference: Span = referenceBox === undefined ? { low: 0, high: 0 } : spanOf(referenceBox, request.axis);
  return round(measureDimension(spanOf(movingBox, request.axis), reference, request.basis).value);
}

/** 寸法で動かす計画。作れない時は何も変えずに理由を返す。 */
export function planDimensionMove(document: AssemblyDocument, request: DimensionMoveRequest, boxes: ReadonlyMap<string, PartBox>):
DimensionMovePlan {
  const component = document.components.find((candidate) => candidate.id === request.componentId);
  if (component === undefined) return refused('unknownComponent');
  if (!Number.isFinite(request.target)) return refused('nonFinite');
  const movedIds = rigidGroupMemberIds(document, component.id);
  if (request.reference.kind === 'component' && movedIds.includes(request.reference.componentId)) return refused('sameComponent');
  const movingBox = boxes.get(component.id);
  const referenceBox = request.reference.kind === 'component' ? boxes.get(request.reference.componentId) : undefined;
  if (movingBox === undefined || (request.reference.kind === 'component' && referenceBox === undefined)) return refused('noBox');
  const moved = document.components.filter((candidate) => movedIds.includes(candidate.id));
  if (moved.some((candidate) => candidate.fixed)) return refused('fixed');
  const reference: Span = referenceBox === undefined ? { low: 0, high: 0 } : spanOf(referenceBox, request.axis);
  const current = measureDimension(spanOf(movingBox, request.axis), reference, request.basis);
  const delta = round(current.sign * (request.target - current.value));
  if (withinMagnitude(delta, MOVE_TOLERANCE_MM)) return refused('noChange');
  // 組の中の締結の記録は、組ごと動くので指し先として数えない(組の外の合致・ジョイントなどは数える)。
  const referenced = componentReferenceCount({ ...document, boltedJoints: undefined }, movedIds);
  if (referenced > 0) return refused('referenced', referenced);
  const next: AssemblyDocument = { ...document,
    components: document.components.map((candidate) => (movedIds.includes(candidate.id) ? shifted(candidate, request.axis, delta) : candidate)) };
  return { ok: true, document: next, current: round(current.value), delta, movedIds };
}
