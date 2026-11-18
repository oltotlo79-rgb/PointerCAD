/**
 * 安全柵(E-12 第 2 段の ③)の側から E-07 の窓(柵の接続にまとめて板を付ける)へ渡す物: 柵の部材どうしの T の接続の id(十字は E-07 と
 * 同じく T に分けた id)と、同じ形の接続の組。組の鍵は、当たられる部材の呼び・当てる部材の呼び(同じ鍵の接続は同じ板の行の候補が
 * 並ぶので、E-07 の窓が 1 つの候補をまとめて選べる)。E-07 の窓の側は規格部品の担当が作る(統括の決定 2026-11-18 15:4x)。
 */
import {
  classifyFrameJoints, placedFrameMembers, splitCrossJoints, type AssemblyDocument, type FrameJoint, type RigidPlacement,
} from '@pointercad/model';

/** 同じ形の接続の組: 鍵と、その組の接続の id(接続の id の順)。 */
export interface SafetyFenceJointGroup {
  readonly key: string;
  readonly jointIds: readonly string[];
}

/** 柵の T の接続の id の全部(接続の id の順)と、同じ形の組(鍵の順)。 */
export interface SafetyFenceJoints {
  readonly jointIds: readonly string[];
  readonly groups: readonly SafetyFenceJointGroup[];
}

/** 部材の呼び(族の部品は族と行、鋼材は形と寸法)。 */
function rowKeyOf(document: AssemblyDocument, componentId: string): string {
  const source = document.components.find((component) => component.id === componentId)?.source;
  if (source?.kind !== 'standardPart') return componentId;
  return source.catalog === 'catalogItem' ? `${source.options.family ?? ''}/${source.options.item ?? ''}` : `${source.catalog}/${source.size}`;
}

/**
 * 接続の形の鍵: 当たられる部材(途中)の呼び・当てる部材(端)の呼び。面は鍵に入れない(柱の両側から当たる横の材は、局所の面の名前が
 * 違っても同じ板の行が合うため。面ごとの置き方は E-07 の候補が接続ごとに決める)。
 */
function shapeKey(document: AssemblyDocument, joint: FrameJoint): string {
  const side = joint.members.find((member) => member.part === 'side');
  const end = joint.members.find((member) => member.part !== 'side');
  return [side === undefined ? '' : rowKeyOf(document, side.componentId), end === undefined ? '' : rowKeyOf(document, end.componentId)].join('|');
}

/**
 * 柵の部材(memberIds)どうしの T の接続と、同じ形の組。配置は表示中の配置を渡す(E-07 の窓と同じ)。柵の外の部材との接続は入れない。
 */
export function safetyFenceJoints(document: AssemblyDocument, placements: ReadonlyMap<string, RigidPlacement>,
  memberIds: readonly string[]): SafetyFenceJoints {
  const ids = new Set(memberIds);
  const members = placedFrameMembers(document, placements).filter((member) => ids.has(member.componentId));
  const joints = splitCrossJoints(classifyFrameJoints(members)).filter((joint) => joint.kind === 'T'
    && joint.members.every((member) => ids.has(member.componentId)));
  const groups = new Map<string, string[]>();
  for (const joint of joints) {
    const key = shapeKey(document, joint);
    groups.set(key, [...(groups.get(key) ?? []), joint.id]);
  }
  const byId = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
  return { jointIds: joints.map((joint) => joint.id).sort(byId),
    groups: [...groups].sort(([left], [right]) => byId(left, right)).map(([key, jointIds]) => ({ key, jointIds: [...jointIds].sort(byId) })) };
}
