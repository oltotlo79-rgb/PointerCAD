/** 合致の補助基底。初期姿勢で局所座標に固定し、試行中に選び直さない(P7 §2.5.6)。 */
import { crossVec3, dotVec3, lengthVec3, scaleVec3, type Vec3 } from '../../sketch/vec3.js';
import { rotateVector, type Quaternion } from '../placementMath.js';

export interface MateFrame {
  readonly t: Vec3;
  readonly s: Vec3;
}

export const MATE_DIRECTION_TOLERANCE = 1e-12;

export function mateUnitDirection(direction: Vec3 | null): Vec3 | null {
  if (direction === null || !direction.every(Number.isFinite)) return null;
  const length = lengthVec3(direction);
  return !Number.isFinite(length) || length <= MATE_DIRECTION_TOLERANCE
    ? null
    : scaleVec3(direction, 1 / length);
}

/** 入力は部品の局所法線。絶対値最小の成分との外積で t、t × n で s。 */
export function createMateFrame(localDirection: Vec3): MateFrame | null {
  const n = mateUnitDirection(localDirection);
  if (n === null) return null;
  const [x, y, z] = n.map(Math.abs);
  const axis: Vec3 = x <= y && x <= z ? [1, 0, 0] : y <= z ? [0, 1, 0] : [0, 0, 1];
  const t = mateUnitDirection(crossVec3(n, axis));
  return t === null ? null : { t, s: crossVec3(t, n) };
}

/** 法線と同じ試行回転を掛ける。世界軸を選び直す処理はここに入れない。 */
export function rotateMateFrame(frame: MateFrame, rotation: Quaternion): MateFrame {
  return { t: rotateVector(rotation, frame.t), s: rotateVector(rotation, frame.s) };
}

/** 明示の反転が無ければ初期の半球を追跡する。直角の同点は + 側で決定的に選ぶ。 */
export function mateAlignmentSign(first: Vec3, second: Vec3, flipped: boolean): 1 | -1 {
  const initial = dotVec3(first, second) < 0 ? -1 : 1;
  return flipped ? (initial === 1 ? -1 : 1) : initial;
}
