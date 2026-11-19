/**
 * 配置の補助 P-A 寸法で動かす(統括の決定 2026-11-19: 1 回だけ動かし、拘束は残さない。残す時は距離の合致)。
 * 選んだ部品(アルミフレーム・鋼材・機械要素・部品のファイル、どれでも同じ)を、向き 1 つ(世界の軸か、成分で決めた斜めの向き)に、
 * 基準(原点の面か、ほかの部品)からの寸法が打った数になるように平行に動かす。次の文書を作るだけの純関数(形を作らない)。
 * 店はこれを 1 回で入れる(元に戻す 1 回で戻る)。
 *
 * - 範囲: 部品の「向きに沿った範囲」(向きとの内積の [最小, 最大])は、呼ぶ側が表示の形から測って渡す
 *   (統括の決定 2026-11-19: 外接箱を写すと丸い物・回した物で大きく出るので使わない。世界の軸の向きも同じ測り方。式で測れる形は式の値。
 *   式で測れない形を網で測った端は誤差を持ち、今の寸法の誤差の上限として計画と dimensionMeasureErrorMm で返す)。
 * - 寸法の取り方(P-B の言葉に揃える): 内側 = 向かい合う面どうしのすき間、芯 = 中心どうし、外側 = 外形の全体(基準の遠い面から部品の遠い面)。
 *   基準が原点の面(原点を通り、向きに垂直な面)の時は、面から部品の近い面・中心・遠い面まで。部品が基準のどちら側にあるかは中心で決め、
 *   その側で測る(同じなら + の側)。
 * - 動かすのは選んだ部品と、締結で 1 つの組になった部品(rigidGroupId が同じ物。一緒に動く)。位置は、向きの成分が 0 でない座標だけを
 *   数に置き換える(成分が 0 の座標の式はそのまま。世界の軸の時は 1 つだけ)。式を入れた座標が数になる事は、計画に載せて予告で見せる。
 * - 断る(何も変えずに理由を返す): 部品が無い・範囲が無い・基準が自分(か同じ組)・固定した部品・数が有限でない・向きの長さが 0 か
 *   有限でない・動かす量が 0・動く部品が合致・ジョイントなどに指されている(数。組の中の締結の記録は、組ごと動くので数えない)。
 */
import { expressionValueFromNumber, isNumericLiteral } from '@pointercad/expression';

import { withinMagnitude } from '../numericTolerance.js';
import { isFiniteVec3, lengthVec3, scaleVec3, type Vec3 } from '../sketch/vec3.js';
import { componentReferenceCount } from './frame/memberSplitMerge.js';
import { rigidGroupMemberIds } from './rigidGroups.js';
import type { AssemblyComponent, AssemblyDocument } from './types.js';

export type DimensionMoveAxis = 0 | 1 | 2;
export type DimensionMoveBasis = 'inner' | 'center' | 'outer';
/** 動かす向き: 世界の軸 1 つ、または成分で決めた向き(長さは問わず、長さ 1 に直して使う)。 */
export type DimensionMoveDirection = { readonly kind: 'axis'; readonly axis: DimensionMoveAxis }
  | { readonly kind: 'vector'; readonly vector: Vec3 };
/**
 * 部品の向きに沿った範囲(向きとの内積の [最小, 最大]。mm)。呼ぶ側が表示の形から測る(式で測れる形は式の値)。
 * 誤差は、式で測れない形(自由な曲面など)を網で測った端だけが持つ、真の端が外にあり得る量(mm)。無い・0 は式の値。
 */
export interface DimensionMoveExtent {
  readonly low: number;
  readonly high: number;
  readonly lowErrorMm?: number;
  readonly highErrorMm?: number;
}

/** 基準: 原点を通る面(向きに垂直)か、ほかの部品。 */
type DimensionMoveReference = { readonly kind: 'origin' } | { readonly kind: 'component'; readonly componentId: string };

interface DimensionMoveRequest {
  readonly componentId: string;
  readonly direction: DimensionMoveDirection;
  readonly reference: DimensionMoveReference;
  readonly basis: DimensionMoveBasis;
  /** 打った寸法(mm)。 */
  readonly target: number;
}

type DimensionMoveRejection = 'unknownComponent' | 'noBox' | 'sameComponent' | 'fixed' | 'nonFinite' | 'badDirection' | 'noChange'
  | 'referenced';

export type DimensionMovePlan =
  | { readonly ok: true; readonly document: AssemblyDocument; readonly current: number; readonly delta: number;
    readonly movedIds: readonly string[];
    /** 数で書き換える座標(向きの成分が 0 でない座標。X・Y・Z の順)。 */
    readonly rewrittenAxes: readonly DimensionMoveAxis[];
    /** そのうち、動く部品のどれかに式を入れていた座標(式が消えて数になる)。 */
    readonly formulaAxes: readonly DimensionMoveAxis[];
    /** 今の寸法の誤差の上限(mm。式で測れない形を網で測った端を使った時だけ 0 より大きい)。 */
    readonly meshErrorMm: number }
  | { readonly ok: false; readonly reason: DimensionMoveRejection; readonly count: number };

/** 動かす量が 0 とみなす量(mm)。部材の並べ・伸縮と同じ桁。 */
const MOVE_TOLERANCE_MM = 1e-6;
/** 長さ 1 に直した向きの成分を 0 とみなす量(この範囲の成分の座標は書き換えない)。 */
const COMPONENT_TOLERANCE = 1e-12;
const ROUNDING = 1e6;
const AXES: readonly DimensionMoveAxis[] = [0, 1, 2];
const round = (value: number): number => Math.round(value * ROUNDING) / ROUNDING;
const refused = (reason: DimensionMoveRejection, count = 0): DimensionMovePlan => ({ ok: false, reason, count });
const centerOf = (span: DimensionMoveExtent): number => (span.low + span.high) / 2;

/** 長さ 1 の向き。世界の軸はその軸、成分は長さ 1 に直す。長さが 0・有限でない時は null。 */
export function dimensionMoveUnitVector(direction: DimensionMoveDirection): Vec3 | null {
  if (direction.kind === 'axis') return [direction.axis === 0 ? 1 : 0, direction.axis === 1 ? 1 : 0, direction.axis === 2 ? 1 : 0];
  const length = lengthVec3(direction.vector);
  return isFiniteVec3(direction.vector) && Number.isFinite(length) && length > 0 ? scaleVec3(direction.vector, 1 / length) : null;
}

interface Measured {
  readonly value: number;
  readonly sign: 1 | -1;
  /** 使った端の誤差の和(芯は両端の平均どうしの和)。 */
  readonly errorMm: number;
}

/**
 * 今の寸法と、部品が基準の + 側か(+ 側なら寸法が増える向きは +、- 側なら -)と、使った端の誤差。基準の範囲は面なら [0, 0]。
 */
function measureDimension(moving: DimensionMoveExtent, reference: DimensionMoveExtent, basis: DimensionMoveBasis): Measured {
  const sign = centerOf(moving) >= centerOf(reference) ? 1 : -1;
  const [movingLow, movingHigh] = [moving.lowErrorMm ?? 0, moving.highErrorMm ?? 0];
  const [referenceLow, referenceHigh] = [reference.lowErrorMm ?? 0, reference.highErrorMm ?? 0];
  if (basis === 'center') {
    return { value: sign * (centerOf(moving) - centerOf(reference)), sign,
      errorMm: (movingLow + movingHigh) / 2 + (referenceLow + referenceHigh) / 2 };
  }
  if (sign === 1) {
    return basis === 'inner' ? { value: moving.low - reference.high, sign, errorMm: movingLow + referenceHigh }
      : { value: moving.high - reference.low, sign, errorMm: movingHigh + referenceLow };
  }
  return basis === 'inner' ? { value: reference.low - moving.high, sign, errorMm: referenceLow + movingHigh }
    : { value: reference.high - moving.low, sign, errorMm: referenceHigh + movingLow };
}

/** 向きの成分が 0 でない座標(X・Y・Z の順)。 */
const rewrittenAxesOf = (unit: Vec3): readonly DimensionMoveAxis[] =>
  AXES.filter((axis) => !withinMagnitude(unit[axis], COMPONENT_TOLERANCE));

function shifted(component: AssemblyComponent, unit: Vec3, rewritten: readonly DimensionMoveAxis[], delta: number): AssemblyComponent {
  const [x, y, z] = component.placement.position;
  const shift = (axis: DimensionMoveAxis, value: typeof x): typeof x =>
    (rewritten.includes(axis) ? expressionValueFromNumber(round(value.value + delta * unit[axis])) : value);
  return { ...component, placement: { ...component.placement, position: [shift(0, x), shift(1, y), shift(2, z)] } };
}

/** 基準の範囲(原点の面は [0, 0])。基準の部品の範囲が無い時は null。 */
function referenceExtent(reference: DimensionMoveReference, extents: ReadonlyMap<string, DimensionMoveExtent>): DimensionMoveExtent | null {
  return reference.kind === 'origin' ? { low: 0, high: 0 } : extents.get(reference.componentId) ?? null;
}

/** 今の寸法を測る。部品・範囲が無い時、向きが作れない時、基準が自分(か同じ組)の時は null。 */
function measuredFor(document: AssemblyDocument, request: Omit<DimensionMoveRequest, 'target'>,
  extents: ReadonlyMap<string, DimensionMoveExtent>): Measured | null {
  const moving = extents.get(request.componentId);
  if (moving === undefined || !document.components.some((candidate) => candidate.id === request.componentId)
    || dimensionMoveUnitVector(request.direction) === null) return null;
  if (request.reference.kind === 'component' && rigidGroupMemberIds(document, request.componentId).includes(request.reference.componentId)) {
    return null;
  }
  const reference = referenceExtent(request.reference, extents);
  return reference === null ? null : measureDimension(moving, reference, request.basis);
}

/** 今の寸法(数を打つ前に窓に出す)。部品・範囲が無い時、向きが作れない時、基準が自分(か同じ組)の時は null。 */
export function measureComponentDimension(document: AssemblyDocument, request: Omit<DimensionMoveRequest, 'target'>,
  extents: ReadonlyMap<string, DimensionMoveExtent>): number | null {
  const measured = measuredFor(document, request, extents);
  return measured === null ? null : round(measured.value);
}

/** 今の寸法の誤差の上限(mm)。式で測れない形を網で測った端を使った時だけ 0 より大きい。測れない時は 0。 */
export function dimensionMeasureErrorMm(document: AssemblyDocument, request: Omit<DimensionMoveRequest, 'target'>,
  extents: ReadonlyMap<string, DimensionMoveExtent>): number {
  return round(measuredFor(document, request, extents)?.errorMm ?? 0);
}

/** 寸法で動かす計画。作れない時は何も変えずに理由を返す。 */
export function planDimensionMove(document: AssemblyDocument, request: DimensionMoveRequest,
  extents: ReadonlyMap<string, DimensionMoveExtent>): DimensionMovePlan {
  const component = document.components.find((candidate) => candidate.id === request.componentId);
  if (component === undefined) return refused('unknownComponent');
  if (!Number.isFinite(request.target)) return refused('nonFinite');
  const unit = dimensionMoveUnitVector(request.direction);
  if (unit === null) return refused('badDirection');
  const movedIds = rigidGroupMemberIds(document, component.id);
  if (request.reference.kind === 'component' && movedIds.includes(request.reference.componentId)) return refused('sameComponent');
  const moving = extents.get(component.id);
  const reference = referenceExtent(request.reference, extents);
  if (moving === undefined || reference === null) return refused('noBox');
  const moved = document.components.filter((candidate) => movedIds.includes(candidate.id));
  if (moved.some((candidate) => candidate.fixed)) return refused('fixed');
  const current = measureDimension(moving, reference, request.basis);
  const delta = round(current.sign * (request.target - current.value));
  if (withinMagnitude(delta, MOVE_TOLERANCE_MM)) return refused('noChange');
  // 組の中の締結の記録は、組ごと動くので指し先として数えない(組の外の合致・ジョイントなどは数える)。
  const referenced = componentReferenceCount({ ...document, boltedJoints: undefined }, movedIds);
  if (referenced > 0) return refused('referenced', referenced);
  const rewrittenAxes = rewrittenAxesOf(unit);
  const formulaAxes = rewrittenAxes.filter((axis) => moved.some((candidate) => !isNumericLiteral(candidate.placement.position[axis].source)));
  const next: AssemblyDocument = { ...document,
    components: document.components.map((candidate) => (movedIds.includes(candidate.id) ? shifted(candidate, unit, rewrittenAxes, delta) : candidate)) };
  return { ok: true, document: next, current: round(current.value), delta, movedIds, rewrittenAxes, formulaAxes,
    meshErrorMm: round(current.errorMm) };
}
