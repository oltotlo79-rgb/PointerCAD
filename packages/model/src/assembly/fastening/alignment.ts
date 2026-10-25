/**
 * 締結の前に、相手の部品(またはその組)を動かして 2 つの穴の軸と合わせ面を一致させる(EX-06)。
 *
 * 動かすのは、固定されていない側の部品とその組(`rigidGroups.ts`)全体。回転は、動かす穴の
 * 「板の中へ入る向き」を基準の穴の向きの逆へ写す最小の回転で、軸まわりのひねりは今のまま残す。
 * その後、動かす穴の合わせ面上の軸の点を基準の点へ平行移動する(隙間 0)。
 */

import { applyPlacementToDirection, applyPlacementToPoint, composePlacement,
  normalizeQuaternion, type Quaternion, type RigidPlacement } from '../placementMath.js';
import { rigidGroupMemberIds } from '../rigidGroups.js';
import type { AssemblyDocument } from '../types.js';
import { crossVec3, dotVec3, lengthVec3, scaleVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import { rigidPlacementOf, type WorldHole } from './frames.js';

/** `u` に垂直な長さ 1 の軸。`u` と最も直交に近い座標軸との外積で決める(決定的)。 */
export function perpendicularAxis(u: Vec3): Vec3 {
  const absolute = u.map((value) => Math.abs(value));
  const basis: Vec3 = absolute[0] <= absolute[1] && absolute[0] <= absolute[2] ? [1, 0, 0]
    : absolute[1] <= absolute[2] ? [0, 1, 0] : [0, 0, 1];
  const axis = crossVec3(u, basis);
  return scaleVec3(axis, 1 / lengthVec3(axis));
}

/**
 * 長さ 1 の `u` を長さ 1 の `v` へ写す最小の回転。半角の公式 `(u×v, 1+u·v)` を使い、
 * 逆向きの近傍は外積の軸と atan2 で角度を求め、`1+u·v` の桁落ちを避ける。
 * 外積がゼロの反対向きだけ、決定的な垂直軸を選ぶ。
 */
export function rotationBetween(u: Vec3, v: Vec3): Quaternion {
  if (dotVec3(u, v) >= 0) {
    const axis = crossVec3(u, v);
    return normalizeQuaternion([axis[0], axis[1], axis[2], 1 + dotVec3(u, v)]);
  }
  const axis = crossVec3(u, v);
  const sine = lengthVec3(axis);
  if (sine === 0) {
    const flipAxis = perpendicularAxis(u);
    return [flipAxis[0], flipAxis[1], flipAxis[2], 0];
  }
  const half = Math.atan2(sine, dotVec3(u, v)) / 2;
  const halfSine = Math.sin(half);
  return normalizeQuaternion([axis[0] / sine * halfSine, axis[1] / sine * halfSine,
    axis[2] / sine * halfSine, Math.cos(half)]);
}

export interface AlignmentPlan {
  /** 動かす部品(組全体)。空なら既に一致している。 */
  readonly movedComponentIds: readonly string[];
  /** 組立の座標で掛ける変位(`新しい配置 = 変位 ∘ いまの配置`)。 */
  readonly delta: RigidPlacement;
  /** 動かす側の穴を変位で写した後の穴。 */
  readonly moved: WorldHole;
  /** 基準のまま動かない側の穴。 */
  readonly anchor: WorldHole;
}

function groupFixed(document: AssemblyDocument, componentId: string): boolean {
  return rigidGroupMemberIds(document, componentId)
    .some((id) => document.components.find((component) => component.id === id)?.fixed === true);
}

function sameGroup(document: AssemblyDocument, a: string, b: string): boolean {
  return rigidGroupMemberIds(document, a).includes(b);
}

/**
 * 動かす側を決めて変位を求める。2 番目に選んだ穴の側を優先して動かし、固定なら 1 番目を動かす。
 * 両方が固定、または既に同じ組の部品どうしなら動かさない計画を返す(勝手に固定や組を外さない)。
 * その場合に一致していなければ、呼び出し側の接触の確かめが断る。
 */
export function planAlignment(
  document: AssemblyDocument, first: WorldHole, second: WorldHole,
): AlignmentPlan {
  const together = sameGroup(document, first.component.id, second.component.id);
  const movable = together ? null : !groupFixed(document, second.component.id) ? second
    : !groupFixed(document, first.component.id) ? first : null;
  const anchor = movable === second ? first : second;
  if (movable === null) {
    return { movedComponentIds: [], delta: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, moved: first, anchor: second };
  }
  const rotation = rotationBetween(movable.into, scaleVec3(anchor.into, -1));
  const rotationOnly: RigidPlacement = { position: [0, 0, 0], rotation };
  const rotatedPoint = applyPlacementToPoint(rotationOnly, movable.matingPoint);
  const delta: RigidPlacement = { position: subVec3(anchor.matingPoint, rotatedPoint), rotation };
  const moved: WorldHole = {
    ...movable,
    matingPoint: applyPlacementToPoint(delta, movable.matingPoint),
    into: applyPlacementToDirection(delta, movable.into),
  };
  return { movedComponentIds: rigidGroupMemberIds(document, movable.component.id), delta, moved, anchor };
}

/** 変位を部品の保存形の配置へ掛ける(新しい配置 = 変位 ∘ いまの配置)。 */
export function movedPlacement(delta: RigidPlacement, document: AssemblyDocument, componentId: string): RigidPlacement | null {
  const component = document.components.find((candidate) => candidate.id === componentId);
  return component === undefined ? null : composePlacement(delta, rigidPlacementOf(component.placement));
}
