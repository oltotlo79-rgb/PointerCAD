/**
 * 締結の計画で使う、選択の照合と組立座標での穴の枠(EX-06)。
 *
 * 部品の中の穴の軸・合わせ面を、いまの文書の配置で組立の座標へ写し、同軸・向かい合わせ・
 * 合わせ面の接触を確かめる。配置の計算は `placementMath.ts` の既存の関数だけを使う。
 */

import { findComponent } from '../assemblyEdit.js';
import { applyPlacementToDirection, applyPlacementToPoint, type RigidPlacement } from '../placementMath.js';
import type { AssemblyComponent, AssemblyDocument, Placement } from '../types.js';
import {
  crossVec3, dotVec3, lengthVec3, scaleVec3, subVec3, type Vec3,
} from '../../sketch/vec3.js';
import {
  type BoltedJointRejection, FASTENING_DIRECTION_TOLERANCE, FASTENING_LENGTH_TOLERANCE_MM,
  type FasteningHoleSelection,
} from './types.js';

/** 組立の座標での穴1つ。`into` は合わせ面から板の中へ入る向き。 */
export interface WorldHole {
  readonly selection: FasteningHoleSelection;
  readonly component: AssemblyComponent;
  readonly matingPoint: Vec3;
  readonly into: Vec3;
}

function reject(code: BoltedJointRejection['code'], detail: BoltedJointRejection['detail']): BoltedJointRejection {
  return { code, detail };
}

function sortedOptions(options: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.keys(options).sort().map((key) => [key, options[key]]));
}

/**
 * 部品の出どころの鍵。抱き込んだ部品は呼び出し側が渡す内容の版(ハッシュ等)を含める。
 * 版の分からない部品は `null`(古い選択と区別できないので断る)。
 */
export function componentSourceKey(
  component: AssemblyComponent,
  partRevisions: ReadonlyMap<string, string>,
): string | null {
  const source = component.source;
  switch (source.kind) {
    case 'part': {
      const revision = partRevisions.get(source.partRef);
      // 空の版は内容を区別できないので、版が無いのと同じに断る。
      return revision === undefined || revision.trim() === '' ? null : `part:${source.partRef}@${revision}`;
    }
    case 'standardPart':
      return `standard:${source.catalog}:${source.size}:${source.catalogRevision}:`
        + `${source.generatorRevision}:${sortedOptions(source.options)}`;
    case 'subAssembly':
      return null;
  }
}

/** 配置の指紋。式ではなく評価値と向きの成分を並べる。 */
export function placementFingerprint(placement: Placement): string {
  return JSON.stringify([placement.position.map((value) => value.value), placement.rotation]);
}

export function rigidPlacementOf(placement: Placement): RigidPlacement {
  return {
    position: [placement.position[0].value, placement.position[1].value, placement.position[2].value],
    rotation: placement.rotation,
  };
}

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function finiteVector(vector: Vec3): boolean {
  return vector.every((value) => Number.isFinite(value));
}

function dimensionRejections(selection: FasteningHoleSelection): BoltedJointRejection[] {
  const hole = selection.hole;
  const values: Record<string, number> = hole.kind === 'clearance'
    ? { diameter: hole.diameter, length: hole.length }
    : hole.kind === 'throughThreaded'
      ? { pitch: hole.pitch, threadLength: hole.threadLength, length: hole.length }
      : { pitch: hole.pitch, usableThreadDepth: hole.usableThreadDepth, drillDepth: hole.drillDepth };
  const out: BoltedJointRejection[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (!positive(value)) out.push(reject('invalidDimension', { componentId: selection.componentId, name, value }));
  }
  if (out.length > 0) return out;
  if (hole.kind === 'throughThreaded' && (!Number.isFinite(hole.threadStart) || hole.threadStart < 0
    || hole.threadStart + hole.threadLength > hole.length + FASTENING_LENGTH_TOLERANCE_MM)) {
    out.push(reject('invalidDimension', { componentId: selection.componentId, name: 'threadLength', value: hole.threadLength }));
  }
  if (hole.kind === 'blindThreaded' && hole.usableThreadDepth > hole.drillDepth + FASTENING_LENGTH_TOLERANCE_MM) {
    out.push(reject('invalidDimension', { componentId: selection.componentId, name: 'usableThreadDepth', value: hole.usableThreadDepth }));
  }
  return out;
}

function unitRejection(selection: FasteningHoleSelection, name: string, vector: Vec3): BoltedJointRejection | null {
  if (!finiteVector(vector) || lengthVec3(vector) <= FASTENING_LENGTH_TOLERANCE_MM) {
    return reject('invalidAxis', { componentId: selection.componentId, name });
  }
  const size = lengthVec3(vector);
  return Math.abs(size - 1) > FASTENING_DIRECTION_TOLERANCE
    ? reject('axisNotNormalized', { componentId: selection.componentId, name, value: size }) : null;
}

/** 選択1つだけで決まる誤り(寸法・軸・面と軸の食い違い)。 */
export function localSelectionRejections(selection: FasteningHoleSelection): BoltedJointRejection[] {
  const out = dimensionRejections(selection);
  if (!finiteVector(selection.axisOrigin)) {
    out.push(reject('invalidAxis', { componentId: selection.componentId, name: 'axisOrigin' }));
  }
  const axis = unitRejection(selection, 'axisDirection', selection.axisDirection);
  const normal = unitRejection(selection, 'matingFaceNormal', selection.matingFaceNormal);
  if (axis !== null) out.push(axis);
  if (normal !== null) out.push(normal);
  if (axis === null && normal === null
    && dotVec3(selection.axisDirection, selection.matingFaceNormal) > -1 + FASTENING_DIRECTION_TOLERANCE) {
    out.push(reject('faceAxisMismatch', { componentId: selection.componentId, holeFeatureId: selection.holeFeatureId }));
  }
  return out;
}

/** 部品の存在・抑制・出どころの鍵の照合。合えば組立の座標の穴を返す。 */
export function resolveWorldHole(
  document: AssemblyDocument,
  selection: FasteningHoleSelection,
  partRevisions: ReadonlyMap<string, string>,
): { readonly hole: WorldHole } | { readonly rejection: BoltedJointRejection } {
  const component = findComponent(document, selection.componentId);
  if (component === undefined) return { rejection: reject('componentMissing', { componentId: selection.componentId }) };
  if (component.suppressed) return { rejection: reject('componentSuppressed', { componentId: component.id }) };
  if (component.source.kind === 'subAssembly') {
    return { rejection: reject('componentNotPlaceable', { componentId: component.id }) };
  }
  const key = componentSourceKey(component, partRevisions);
  if (key === null) return { rejection: reject('missingSourceRevision', { componentId: component.id }) };
  if (key !== selection.sourceKey) return { rejection: reject('staleSource', { componentId: component.id }) };
  if (!validPlacement(component.placement)) return { rejection: reject('invalidPlacement', { componentId: component.id }) };
  const placement = rigidPlacementOf(component.placement);
  const matingPoint = applyPlacementToPoint(placement, selection.axisOrigin);
  const into = applyPlacementToDirection(placement, selection.axisDirection);
  if (!finiteVector(matingPoint) || !finiteVector(into)
    || Math.abs(lengthVec3(into) - 1) > FASTENING_DIRECTION_TOLERANCE) {
    return { rejection: reject('invalidWorldFrame', { componentId: component.id }) };
  }
  return { hole: { selection, component, matingPoint, into } };
}

/**
 * 保存された配置が締結に使えるか。位置の評価値と四元数の全成分が有限で、四元数の長さが 1 に
 * 近いこと。`rotateVector` は壊れた四元数を黙って恒等へ落とすので、ここで先に断る。
 */
export function validPlacement(placement: Placement): boolean {
  const position = placement.position.map((value) => value.value);
  const size = Math.hypot(...placement.rotation);
  return position.every((value) => Number.isFinite(value)) && placement.rotation.every((value) => Number.isFinite(value))
    && Math.abs(size - 1) <= PLACEMENT_QUATERNION_TOLERANCE;
}

/** 保存形の四元数は `normalizeQuaternion` を通してあるので、長さ 1 からのずれはこの範囲に入る。 */
export const PLACEMENT_QUATERNION_TOLERANCE = 1e-9;

/**
 * 2つの穴が同じ軸の上で向かい合い、合わせ面が接している(隙間 0)かを確かめる。
 * 隙間は `first` の合わせ面から `second` へ向かう向きに測る。
 */
export function contactRejections(first: WorldHole, second: WorldHole): BoltedJointRejection[] {
  const ids = { first: first.component.id, second: second.component.id };
  if (dotVec3(first.into, second.into) > -1 + FASTENING_DIRECTION_TOLERANCE) {
    return [reject('axesNotOpposed', ids)];
  }
  const offset = subVec3(second.matingPoint, first.matingPoint);
  const towardSecond = scaleVec3(first.into, -1);
  const radial = lengthVec3(crossVec3(offset, towardSecond));
  if (radial > FASTENING_LENGTH_TOLERANCE_MM) return [reject('axesNotCoaxial', { ...ids, value: radial })];
  const gap = dotVec3(offset, towardSecond);
  if (gap > FASTENING_LENGTH_TOLERANCE_MM) return [reject('facesNotInContact', { ...ids, value: gap })];
  if (gap < -FASTENING_LENGTH_TOLERANCE_MM) return [reject('facesOverlap', { ...ids, value: gap })];
  return [];
}
