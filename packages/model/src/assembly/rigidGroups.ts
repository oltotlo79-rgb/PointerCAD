/**
 * 互いに固定した部品の組(`AssemblyComponent.rigidGroupId`。追加要件6 のボルト締結)。
 *
 * 組の相対姿勢は保存せず、いまの配置どうしから導く。合致の連立では組を代表の部品 1 つへ畳み、
 * 組の内外の合致・ジョイントは代表の部品を指すように読み替える。内部の拘束も残し、
 * 相対姿勢との不整合を診断する。解いた後は代表の配置から他の部品の配置を戻す。
 *
 * 代表は、組の中に固定の部品があればその最初のもの、無ければ並びの最初の部品。組の中に固定が
 * あれば組ごと動かない(全体の固定 `fixed` の意味は変えない)。抑制した部品は組から外して数える。
 */

import { composePlacement, multiplyQuaternion, normalizeQuaternion, rotateVector, type RigidPlacement } from './placementMath.js';
import type { AssemblyComponent, AssemblyDocument } from './types.js';
import { nextSerialId } from '../sketch/createSketchDocument.js';
import { scaleVec3, subVec3 } from '../sketch/vec3.js';

/** 組の id → 抑制していない部品(文書の並び順)。2 つ以上の部品を持つ組だけを返す。 */
export function rigidGroupsOf(document: AssemblyDocument): ReadonlyMap<string, readonly AssemblyComponent[]> {
  const groups = new Map<string, AssemblyComponent[]>();
  for (const component of document.components) {
    if (component.suppressed || component.rigidGroupId === undefined || component.rigidGroupId === '') continue;
    const list = groups.get(component.rigidGroupId) ?? [];
    list.push(component);
    groups.set(component.rigidGroupId, list);
  }
  return new Map([...groups].filter(([, members]) => members.length >= 2));
}

/** 組の代表。固定の部品があればその最初、無ければ並びの最初。 */
export function rigidGroupAnchor(members: readonly AssemblyComponent[]): AssemblyComponent | undefined {
  return members.find((member) => member.fixed) ?? members[0];
}

/** `anchor` から見た `member` の姿勢 `anchor⁻¹ ∘ member`。 */
export function relativePlacement(anchor: RigidPlacement, member: RigidPlacement): RigidPlacement {
  const [x, y, z, w] = normalizeQuaternion(anchor.rotation);
  const inverse = [-x, -y, -z, w] as const;
  return {
    position: rotateVector(inverse, subVec3(member.position, anchor.position)),
    rotation: multiplyQuaternion(inverse, member.rotation),
  };
}

/** 逆の配置。`p = R·q + t` を `q = Rᵀ·(p − t)` へ戻す。 */
export function inversePlacement(placement: RigidPlacement): RigidPlacement {
  const [x, y, z, w] = normalizeQuaternion(placement.rotation);
  const inverse = [-x, -y, -z, w] as const;
  return { position: scaleVec3(rotateVector(inverse, placement.position), -1), rotation: normalizeQuaternion(inverse) };
}

export interface RigidGroupCollapse {
  /** 組を代表の部品へ畳んだ文書。保存しない(連立のためだけに作る)。 */
  readonly document: AssemblyDocument;
  /** 代表でない部品 → 代表の部品。 */
  readonly anchorOf: ReadonlyMap<string, string>;
  /** 代表でない部品 → 代表から見た姿勢。 */
  readonly relative: ReadonlyMap<string, RigidPlacement>;
}

/**
 * 組を畳む。組が 1 つも無ければ `null`(呼び出し側は元の文書のまま解く)。
 * 相対姿勢は `placements`(解く前の配置)から導く。配置の無い部品を含む組は畳まない。
 */
export function collapseRigidGroups(
  document: AssemblyDocument, placements: ReadonlyMap<string, RigidPlacement>,
): RigidGroupCollapse | null {
  const groups = rigidGroupsOf(document);
  if (groups.size === 0) return null;
  const anchorOf = new Map<string, string>();
  const relative = new Map<string, RigidPlacement>();
  const fixedAnchors = new Set<string>();
  for (const members of groups.values()) {
    const anchor = rigidGroupAnchor(members);
    const anchorPlacement = anchor === undefined ? undefined : placements.get(anchor.id);
    if (anchor === undefined || anchorPlacement === undefined) continue;
    if (members.some((member) => member.fixed)) fixedAnchors.add(anchor.id);
    for (const member of members) {
      const placement = placements.get(member.id);
      if (member.id === anchor.id || placement === undefined) continue;
      anchorOf.set(member.id, anchor.id);
      relative.set(member.id, relativePlacement(anchorPlacement, placement));
    }
  }
  if (anchorOf.size === 0) return null;
  const mapped = (id: string): string => anchorOf.get(id) ?? id;
  return {
    anchorOf, relative,
    document: {
      ...document,
      components: document.components.filter((component) => !anchorOf.has(component.id))
        .map((component) => (fixedAnchors.has(component.id) ? { ...component, fixed: true } : component)),
      // Internal rows remain: shared columns cancel, while an incompatible constant residual remains visible.
      mates: document.mates.map((mate) => ({
        ...mate, a: { ...mate.a, componentId: mapped(mate.a.componentId) }, b: { ...mate.b, componentId: mapped(mate.b.componentId) },
      })),
      joints: document.joints.map((joint) => ({
        ...joint, a: { ...joint.a, componentId: mapped(joint.a.componentId) }, b: { ...joint.b, componentId: mapped(joint.b.componentId) },
      })),
    },
  };
}

/** 畳んだ配置から、代表でない部品の配置を `代表 ∘ 相対姿勢` で戻す。 */
export function expandRigidGroupPlacements(
  collapse: RigidGroupCollapse, placements: ReadonlyMap<string, RigidPlacement>,
): Map<string, RigidPlacement> {
  const result = new Map(placements);
  for (const [member, anchor] of collapse.anchorOf) {
    const anchorPlacement = placements.get(anchor);
    const relative = collapse.relative.get(member);
    if (anchorPlacement !== undefined && relative !== undefined) result.set(member, composePlacement(anchorPlacement, relative));
  }
  return result;
}

/** 代表でない部品を除いた配置(畳んだ連立へ渡す)。 */
export function collapseRigidGroupPlacements(
  collapse: RigidGroupCollapse, placements: ReadonlyMap<string, RigidPlacement>,
): Map<string, RigidPlacement> {
  return new Map([...placements].filter(([id]) => !collapse.anchorOf.has(id)));
}

/** 組の id の接頭辞。番号は再利用しない(`nextSerialId` と同じ方式)。 */
export const RIGID_GROUP_ID_PREFIX = 'fastening-';

/** 次の組の id。`fastening-<n>`。 */
export function nextRigidGroupId(document: AssemblyDocument): string {
  return nextSerialId(document.components.flatMap((component) =>
    component.rigidGroupId === undefined ? [] : [component.rigidGroupId]), RIGID_GROUP_ID_PREFIX);
}

/**
 * 部品を 1 つの組へまとめる。既に組に属している部品があれば、その組の他の部品もまとめて
 * 同じ組に入れる(組どうしをつなぐ)。組の id は最初に見つかった既存の組、無ければ新しい id。
 * 配置は変えない(相対姿勢は今の配置のまま固定される)。
 */
export function joinRigidGroup(document: AssemblyDocument, componentIds: readonly string[]): AssemblyDocument {
  const requested = new Set(componentIds);
  const existing = document.components.flatMap((component) => requested.has(component.id)
    && component.rigidGroupId !== undefined && component.rigidGroupId !== '' ? [component.rigidGroupId] : []);
  const merged = new Set(existing);
  const groupId = existing[0] ?? nextRigidGroupId(document);
  return {
    ...document,
    components: document.components.map((component) => (requested.has(component.id)
      || (component.rigidGroupId !== undefined && merged.has(component.rigidGroupId))
      ? { ...component, rigidGroupId: groupId } : component)),
  };
}

/** 組を解く(締結を外す)。配置は変えない。無い組なら元の文書をそのまま返す(Undo に空の段を作らない)。 */
export function releaseRigidGroup(document: AssemblyDocument, groupId: string): AssemblyDocument {
  if (!document.components.some((component) => component.rigidGroupId === groupId)) return document;
  return {
    ...document,
    // 欄を消さずに undefined を書く(`setComponentAppearance` と同じ流儀。保存の JSON からは消える)。
    components: document.components.map((component) => (component.rigidGroupId === groupId
      ? { ...component, rigidGroupId: undefined } : component)),
    // 締結を外すと、その組の締結の記録も消える(直す相手が無くなる)。
    ...(document.boltedJoints === undefined ? {} : {
      boltedJoints: document.boltedJoints.filter((record) => !document.components.some((component) =>
        component.rigidGroupId === groupId && component.id === record.first.componentId)),
    }),
  };
}

/** 同じ組の部品の id(自分を含む)。組に属さなければ自分だけ。抑制した部品は含めない。 */
export function rigidGroupMemberIds(document: AssemblyDocument, componentId: string): readonly string[] {
  const component = document.components.find((candidate) => candidate.id === componentId);
  const group = component?.rigidGroupId;
  if (component === undefined || group === undefined || group === '') return [componentId];
  return document.components.filter((candidate) => !candidate.suppressed && candidate.rigidGroupId === group)
    .map((candidate) => candidate.id);
}
