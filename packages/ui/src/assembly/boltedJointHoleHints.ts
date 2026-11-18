/**
 * ボルト締結の窓の当たり(J-02c。統括の決定 2026-11-18 17:0x): 1 組目の 4 面を選んだ後、頭側・相手側の穴と同じ穴フィーチャーの
 * ほかの穴を当たりとして示す。押すと今の「2 組目からの穴を足す」と同じに足す(どの穴どうしが組になるかは予告の自動の対応付け)。
 * 「同じ穴を全部足す」は、足す前に数を予告で見せ、組が 1 つに決まらない(対応付けが断る・数が合わない)時は足さずに理由を出す。
 *
 * 当たりの穴は、選んだ穴の面の今の番地から model の `sameHoleFeatureWalls` で引く(由来が 1 つに決まる面だけ)。参照は画面でその面を
 * 押した時と同じ規則(`subShapeRefOf`)で作る。印の位置は、穴の面の重心と軸と径を、表示中の配置で世界へ写した物。
 */
import {
  applyPlacementToDirection, applyPlacementToPoint, findComponent, isSameSubShape, resolveSubShapeReference, sameHoleFeatureWalls,
  type AssemblyDocument, type MateTarget, type Vec3,
} from '@pointercad/model';

import type { AssemblyView } from '../store/assemblySlice.js';
import { subShapeElementId, subShapeRefOf } from '../solid/subShapeSelection.js';
import type { AssemblyBoltedJointDraft } from './boltedJointDraft.js';

type HoleFaceTarget = Extract<MateTarget, { readonly kind: 'subShape' }>;

/** 当たりの穴 1 つ: 足す側(頭側・相手側)、足す時の選択、印の世界の中心・軸・径。 */
export interface BoltedJointHoleHint {
  readonly side: 'first' | 'second';
  readonly target: HoleFaceTarget;
  readonly center: Vec3;
  readonly normal: Vec3;
  readonly radius: number;
}

/** 4 面が揃った新しい締結の、頭側・相手側の 1 つ目の穴(面の選択の時だけ)。 */
function baseHoles(draft: AssemblyBoltedJointDraft): { readonly first: HoleFaceTarget; readonly second: HoleFaceTarget } | null {
  if (draft.editRecordId !== undefined || draft.picks.length < 4) return null;
  const [first, , second] = draft.picks;
  return first?.kind === 'subShape' && second?.kind === 'subShape' ? { first, second } : null;
}

/** 1 つの側の当たり(選んだ穴と、もう足した穴は入れない)。 */
function sideHints(document: AssemblyDocument, view: AssemblyView, base: HoleFaceTarget, taken: readonly HoleFaceTarget[],
  side: BoltedJointHoleHint['side']): BoltedJointHoleHint[] {
  const component = findComponent(document, base.componentId);
  const key = view.resolved.partKeys.get(base.componentId), placement = view.resolved.placements.get(base.componentId);
  const bodies = key === undefined ? undefined : view.bodies.get(key);
  const body = bodies?.find((candidate) => candidate.featureId === base.ref.bodyFeatureId);
  if (component === undefined || placement === undefined || bodies === undefined || body === undefined) return [];
  const resolution = resolveSubShapeReference(body, base.ref);
  if (resolution.status !== 'matched') return [];
  return sameHoleFeatureWalls(body.origins, resolution.match.reference.index).flatMap((index): BoltedJointHoleHint[] => {
    const face = body.faces.find((candidate) => candidate.index === index);
    const ref = subShapeRefOf(bodies, subShapeElementId(body.featureId, 'face', index));
    if (face === undefined || ref === null || face.axis === null || face.radius === null) return [];
    if ([base, ...taken].some((hole) => hole.componentId === base.componentId && isSameSubShape(hole.ref, ref))) return [];
    return [{ side, target: { kind: 'subShape', componentId: base.componentId, ref }, center: applyPlacementToPoint(placement, face.centroid),
      normal: applyPlacementToDirection(placement, face.axis), radius: face.radius }];
  });
}

/** 今の打ちかけの当たりの全部(頭側を先に、同じ側は番地の小さい順)。4 面が揃っていない・直す時は無い。 */
export function boltedJointHoleHints(document: AssemblyDocument, view: AssemblyView, draft: AssemblyBoltedJointDraft): readonly BoltedJointHoleHint[] {
  const base = baseHoles(draft);
  if (base === null || view.sourceDocument !== document) return [];
  return [...sideHints(document, view, base.first, draft.extraHoles?.first ?? [], 'first'),
    ...sideHints(document, view, base.second, draft.extraHoles?.second ?? [], 'second')];
}

const NO_HINTS: readonly BoltedJointHoleHint[] = [];

/** 店の今の状態の当たり(締結の窓が無い時は、いつも同じ空の並び。3D の層が作り直さない)。 */
export function holeHintsOf(state: { readonly assembly: AssemblyDocument | null; readonly assemblyView: AssemblyView | null;
  readonly assemblyBoltedJointDraft: AssemblyBoltedJointDraft | null }): readonly BoltedJointHoleHint[] {
  const { assembly, assemblyView, assemblyBoltedJointDraft } = state;
  if (assembly === null || assemblyView === null || assemblyBoltedJointDraft === null) return NO_HINTS;
  const hints = boltedJointHoleHints(assembly, assemblyView, assemblyBoltedJointDraft);
  return hints.length === 0 ? NO_HINTS : hints;
}

/** 「同じ穴を全部足す」の数(頭側・相手側。足した後の 1 つ目の穴を含む数)と、全部を足した打ちかけ。当たりが無い時は null。 */
export function boltedJointAllSameHoles(draft: AssemblyBoltedJointDraft, hints: readonly BoltedJointHoleHint[]):
{ readonly first: number; readonly second: number; readonly draft: AssemblyBoltedJointDraft } | null {
  if (hints.length === 0) return null;
  const extra = draft.extraHoles ?? { first: [], second: [] };
  const first = [...extra.first, ...hints.filter((hint) => hint.side === 'first').map((hint) => hint.target)];
  const second = [...extra.second, ...hints.filter((hint) => hint.side === 'second').map((hint) => hint.target)];
  return { first: 1 + first.length, second: 1 + second.length, draft: { ...draft, extraHoles: { first, second } } };
}
