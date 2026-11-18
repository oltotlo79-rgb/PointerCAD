/**
 * まとめて締結する穴の組の自動の対応付け(J-02 第 3 の版。設計は 1 組目を基準にする形)。
 *
 * 1 組目(頭側・相手側の 0 番)は利用者が選んだ組のまま基準にし、その組の計画の整列(相手の板を動かす変位)を当てた後の
 * 位置で、頭側の 1 番目からの穴ごとに「同じ軸の上で向かい合う」相手側の穴をちょうど 1 つ選ぶ。合う相手が 0 か 2 つ以上・
 * 取り合い・余った相手は断る(近さで当て推量の組を作らない)。判定の許容差は計画の同軸の確かめ(frames.ts の
 * contactRejections)と同じ。組み合わせた後の計画と確定は、今の一括の口(previewBoltedJointSet・commitBoltedJointSet)が行う。
 */
import type { AssemblyDocument } from '../types.js';
import { applyPlacementToDirection, applyPlacementToPoint } from '../placementMath.js';
import { crossVec3, dotVec3, lengthVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import { withinMagnitude } from '../../numericTolerance.js';
import { bindHoleSelection, type FasteningGeometryContext, type FasteningHolePick } from './bindHoleSelection.js';
import type { BoltedJointHoleFailure, BoltedJointSetPicks } from './boltedJointSetTypes.js';
import { resolveWorldHole } from './frames.js';
import type { EntryHoleSelection, FasteningExtensionRejection } from './holeEntryTypes.js';
import { planEntryBoltedJoint } from './planEntryBoltedJoint.js';
import { isRejection } from './selectFastener.js';
import { FASTENING_DIRECTION_TOLERANCE, FASTENING_LENGTH_TOLERANCE_MM, type BoltedJointPlan } from './types.js';

interface AlignedAxis {
  readonly point: Vec3;
  readonly direction: Vec3;
}

/** 頭側 i 番と組む相手側の元の番号(0 番は 0 番)、か、組めない穴の断り。 */
type BoltedJointHolePairing =
  | { readonly ok: true; readonly order: readonly number[] }
  | { readonly ok: false; readonly holes: readonly BoltedJointHoleFailure[] };

function alignedAxis(document: AssemblyDocument, selection: EntryHoleSelection, alignment: BoltedJointPlan['alignment'],
  partRevisions: ReadonlyMap<string, string>): AlignedAxis | null {
  const resolved = resolveWorldHole(document, selection, partRevisions);
  if ('rejection' in resolved) return null;
  const moved = alignment.movedComponentIds.includes(selection.componentId);
  return { point: moved ? applyPlacementToPoint(alignment.delta, resolved.hole.matingPoint) : resolved.hole.matingPoint,
    direction: moved ? applyPlacementToDirection(alignment.delta, resolved.hole.into) : resolved.hole.into };
}

/** 2 つの穴が向かい合い、軸の間の距離が許容差の中(計画の同軸の確かめと同じ)。 */
function sameAxis(head: AlignedAxis, far: AlignedAxis): boolean {
  return withinMagnitude(dotVec3(head.direction, far.direction) + 1, FASTENING_DIRECTION_TOLERANCE)
    && withinMagnitude(lengthVec3(crossVec3(subVec3(far.point, head.point), head.direction)), FASTENING_LENGTH_TOLERANCE_MM);
}

function missing(side: 'first' | 'second', index: number, reason?: 'ambiguous' | 'shared'): BoltedJointHoleFailure {
  const rejection: FasteningExtensionRejection = { code: 'holePairMissing', detail: { side, index, ...(reason === undefined ? {} : { reason }) } };
  return { index, rejections: [], entryRejections: [rejection] };
}

/**
 * 基準の組(0 番)の整列を当てた後の位置で、相手側の穴を頭側の並びに合わせる。両側の数は同じで 2 以上、全部の穴が
 * 組立の座標へ写せる事を、呼ぶ側が確かめてから渡す(写せない穴があれば、元の順のまま返す。計画がその理由で断る)。
 */
function pairBoltedJointHoles(document: AssemblyDocument, first: readonly EntryHoleSelection[],
  second: readonly EntryHoleSelection[], alignment: BoltedJointPlan['alignment'],
  partRevisions: ReadonlyMap<string, string>): BoltedJointHolePairing {
  const identity: BoltedJointHolePairing = { ok: true, order: [...second.keys()] };
  const heads = first.map((selection) => alignedAxis(document, selection, alignment, partRevisions));
  const fars = second.map((selection) => alignedAxis(document, selection, alignment, partRevisions));
  if (first.length !== second.length || [...heads, ...fars].some((axis) => axis === null)) return identity;
  const order = [0], used = new Set([0]), holes: BoltedJointHoleFailure[] = [];
  for (const [index, head] of heads.entries()) {
    if (index === 0 || head === null) continue;
    const matches = fars.flatMap((far, candidate) => candidate !== 0 && far !== null && sameAxis(head, far) ? [candidate] : []);
    const [match] = matches;
    if (match === undefined) holes.push(missing('first', index));
    else if (matches.length > 1) holes.push(missing('first', index, 'ambiguous'));
    else if (used.has(match)) holes.push(missing('first', index, 'shared'));
    else { order.push(match); used.add(match); }
  }
  // 頭側に断りがある時は、余った相手はその結果なので重ねて出さない。頭側が全部組めて余った相手だけを断る。
  if (holes.length === 0) for (const index of second.keys()) if (!used.has(index)) holes.push(missing('second', index));
  return holes.length > 0 ? { ok: false, holes } : { ok: true, order };
}

/** 組み合わせた後の選び方と、頭側 i 番と組む相手側の元の番号。 */
type BoltedJointSetArrangement =
  | { readonly ok: true; readonly picks: BoltedJointSetPicks; readonly order: readonly number[] }
  | { readonly ok: false; readonly holes: readonly BoltedJointHoleFailure[] };

/**
 * 面の選択から、相手側の穴を自動で組み合わせた選び方を作る(画面の予告と確定の前に通す)。2 組より少ない・数が違う・
 * 結び付けや基準の組の計画が断られる時は、元の順のまま返す(断りは一括の口が今までどおり出す)。
 */
export function arrangeBoltedJointSetPicks(context: FasteningGeometryContext, picks: BoltedJointSetPicks): BoltedJointSetArrangement {
  const unchanged: BoltedJointSetArrangement = { ok: true, picks, order: [...picks.second.keys()] };
  if (picks.first.length < 2 || picks.first.length !== picks.second.length) return unchanged;
  const bind = (pick: FasteningHolePick): EntryHoleSelection | null => {
    if (pick.holeGroup !== undefined) return null;
    const bound = bindHoleSelection(context, pick);
    return isRejection(bound) ? null : bound;
  };
  const first = picks.first.map(bind), second = picks.second.map(bind);
  const bound = (values: readonly (EntryHoleSelection | null)[]): values is readonly EntryHoleSelection[] => values.every((value) => value !== null);
  if (!bound(first) || !bound(second) || first[0] === undefined || second[0] === undefined) return unchanged;
  const base = planEntryBoltedJoint(context.document, { ...picks.choices, first: first[0], second: second[0] }, context.partRevisions);
  if (!base.ok) return unchanged;
  const pairing = pairBoltedJointHoles(context.document, first, second, base.plan.joint.alignment, context.partRevisions);
  if (!pairing.ok) return pairing;
  const arranged = pairing.order.flatMap((index) => picks.second[index] ?? []);
  return arranged.length === picks.second.length ? { ok: true, picks: { ...picks, second: arranged }, order: pairing.order } : unchanged;
}
