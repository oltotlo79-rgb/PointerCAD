/** 明示的な部品局所フレーム(P7訂正0.69)。長さmm、右手系の単位基底。 */
import {
  addVec3, crossVec3, dotVec3, lengthVec3, scaleVec3, subVec3, type Vec3,
} from '../../sketch/vec3.js';
import { QUATERNION_TOLERANCE, rotateVector, type RigidPlacement } from '../placementMath.js';
import type { JointKind } from '../types.js';
import { createMateFrame, mateUnitDirection } from '../constraints/mateFrames.js';

export interface JointFrame {
  readonly origin: Vec3;
  readonly x: Vec3;
  readonly y: Vec3;
  readonly z: Vec3;
}
export interface JointFramePair { readonly a: JointFrame; readonly b: JointFrame }
export type JointCoordinate = 'angle' | 'translation';

export const JOINT_FRAME_TOLERANCE = 1e-12;

/** everyは疎配列の穴を飛ばすため、形と各indexを検査する。 */
function validJointVector(vector: Vec3): boolean {
  return Array.isArray(vector) && vector.length === 3
    && Number.isFinite(vector[0]) && Number.isFinite(vector[1]) && Number.isFinite(vector[2]);
}

/** jointの新しい入口で検証する。既存mateの不正入力時の互換は変更しない。 */
export function validJointPlacement(placement: RigidPlacement): boolean {
  if (placement === null || typeof placement !== 'object' || !validJointVector(placement.position)) return false;
  const rotation = placement.rotation;
  if (!Array.isArray(rotation) || rotation.length !== 4
    || !Number.isFinite(rotation[0]) || !Number.isFinite(rotation[1])
    || !Number.isFinite(rotation[2]) || !Number.isFinite(rotation[3])) return false;
  const norm = Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3]);
  return Number.isFinite(norm) && norm > QUATERNION_TOLERANCE;
}

/** 反射や壊れた基底を回転として扱わない。入力は修正しない。 */
export function validJointFrame(frame: JointFrame): boolean {
  if (frame === null || typeof frame !== 'object') return false;
  const { origin, x, y, z } = frame;
  return [origin, x, y, z].every(validJointVector)
    && [x, y, z].every((v) => Math.abs(lengthVec3(v) - 1) <= JOINT_FRAME_TOLERANCE)
    && [dotVec3(x, y), dotVec3(y, z), dotVec3(z, x)].every((v) => Math.abs(v) <= JOINT_FRAME_TOLERANCE)
    && Math.abs(dotVec3(crossVec3(x, y), z) - 1) <= JOINT_FRAME_TOLERANCE;
}

/** 補助軸は局所で一度だけ決める。明示接線が軸と平行なら別軸へ黙って替えない。 */
export function createJointFrame(origin: Vec3, axis: Vec3, referenceTangent?: Vec3): JointFrame | null {
  if (!validJointVector(origin) || !validJointVector(axis)
    || (referenceTangent !== undefined && !validJointVector(referenceTangent))) return null;
  const z = mateUnitDirection(axis);
  if (z === null) return null;
  const reference = referenceTangent === undefined ? undefined : mateUnitDirection(referenceTangent);
  if (reference === null) return null;
  const x = reference === undefined ? createMateFrame(z)?.t ?? null
    : mateUnitDirection(subVec3(reference, scaleVec3(z, dotVec3(reference, z))));
  if (x === null) return null;
  const frame: JointFrame = { origin: [...origin], x, y: crossVec3(z, x), z };
  return validJointFrame(frame) ? frame : null;
}

/** 配置のたびに世界フレームを作る。保存するのは局所の幾何で、世界補助軸を選び直さない。 */
export function transformJointFrame(frame: JointFrame, placement: RigidPlacement): JointFrame | null {
  if (!validJointFrame(frame) || !validJointPlacement(placement)) return null;
  const transformed = {
    origin: addVec3(placement.position, rotateVector(placement.rotation, frame.origin)),
    x: rotateVector(placement.rotation, frame.x), y: rotateVector(placement.rotation, frame.y),
    z: rotateVector(placement.rotation, frame.z),
  };
  return validJointFrame(transformed) ? transformed : null;
}

/** 球の向き3自由度を単一angleへ押し込まない。値の読取/unwrap/driverはタスク20。 */
export function jointCoordinateNames(kind: JointKind): readonly JointCoordinate[] {
  switch (kind) {
    case 'revolute': return ['angle'];
    case 'slider': return ['translation'];
    case 'cylindrical': return ['angle', 'translation'];
    case 'ball': return [];
  }
}
