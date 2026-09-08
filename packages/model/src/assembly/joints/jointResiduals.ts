/** 4種のジョイント。受理済み姿勢を変えずにtrialの残差と解析Jacobianを作る。 */
import type { LinearizedRow } from '../../sketch/constraints/solve.js';
import {
  addVec3, crossVec3, dotVec3, lengthVec3, scaleVec3, type Vec3,
} from '../../sketch/vec3.js';
import { exponentialMap, normalizeQuaternion, rotateVector, type Quaternion, type RigidPlacement } from '../placementMath.js';
import type { Joint, JointKind } from '../types.js';
import type { MateVariableSet } from '../constraints/mateVariables.js';
import {
  addTerm, CARTESIAN_AXES, directionResidual, pointSpan, pointTerms, projectedResidual,
  rotationDerivativeAxes, scaledResidual, type TrialGeometry,
} from '../constraints/rigidResidualGeometry.js';
import { DEFAULT_RIGID_CHARACTERISTIC_LENGTH } from '../constraints/solveRigid.js';
import { validJointFrame, validJointPlacement, type JointFrame, type JointFramePair } from './jointFrames.js';

export interface JointResidualRow extends LinearizedRow {
  readonly jointId: string;
  /** 生の式へ適用済み。lengthだけ1/L₀。 */
  readonly scale: number;
  readonly measure: 'length' | 'direction' | 'rotation';
}
export type JointResidualSkipReason =
  | 'missingFrame' | 'dangling' | 'invalidFrame' | 'invalidScale' | 'invalidIncrement' | 'rotationBranch';
export interface SkippedJointResidual {
  readonly jointId: string;
  readonly reason: JointResidualSkipReason;
  readonly message: string;
}
export interface PreparedJointResidual {
  readonly jointId: string;
  readonly kind: JointKind;
  readonly componentA: string;
  readonly componentB: string;
  readonly frames: JointFramePair;
}
export interface JointResidualPreparationInput {
  readonly joints: readonly Joint[];
  readonly frames: ReadonlyMap<string, JointFramePair>;
  readonly placements: ReadonlyMap<string, RigidPlacement>;
}
export interface JointResidualPreparationReport {
  readonly joints: readonly PreparedJointResidual[];
  readonly skipped: readonly SkippedJointResidual[];
}
export interface JointResidualInput {
  readonly joints: readonly PreparedJointResidual[];
  readonly variableSet: MateVariableSet;
  readonly placements: ReadonlyMap<string, RigidPlacement>;
  readonly increments?: readonly number[];
  readonly characteristicLength?: number;
}
export interface JointResidualReport {
  readonly rows: readonly JointResidualRow[];
  readonly skipped: readonly SkippedJointResidual[];
  /** revolute/cylindricalの逆向きの軸。行を消さず収束を断る。 */
  readonly branchViolations: readonly string[];
}

function refusal(jointId: string, reason: JointResidualSkipReason): SkippedJointResidual {
  const messages: Readonly<Record<JointResidualSkipReason, string>> = {
    missingFrame: 'ジョイントの取り付け位置と向きがまだ指定されていません。',
    dangling: 'ジョイントが指している部品が見つかりません。',
    invalidFrame: 'ジョイントの取り付け位置または向きが不正です。',
    invalidScale: 'ジョイントの代表長さは有限の正の数にしてください。',
    invalidIncrement: 'ジョイントの増分の数または値が不正です。',
    rotationBranch: 'この回転の試行ではジョイントの向きを連続に評価できません。',
  };
  return { jointId, reason, message: messages[reason] };
}

/** 局所フレームの控えを取る。min/maxの評価・clampや保存形式の変更はしない。 */
export function prepareJointResiduals(input: JointResidualPreparationInput): JointResidualPreparationReport {
  const joints: PreparedJointResidual[] = [];
  const skipped: SkippedJointResidual[] = [];
  const copy = (f: JointFrame): JointFrame => ({ origin: [...f.origin], x: [...f.x], y: [...f.y], z: [...f.z] });
  for (const joint of input.joints) {
    if (joint.suppressed) continue;
    const a = input.placements.get(joint.a.componentId);
    const b = input.placements.get(joint.b.componentId);
    const frames = input.frames.get(joint.id);
    const error = a === undefined || b === undefined ? 'dangling' : frames === undefined ? 'missingFrame'
      : !validJointFrame(frames.a) || !validJointFrame(frames.b) || !validJointPlacement(a) || !validJointPlacement(b)
        ? 'invalidFrame' : null;
    if (error !== null || frames === undefined) {
      skipped.push(refusal(joint.id, error ?? 'missingFrame'));
      continue;
    }
    joints.push({ jointId: joint.id, kind: joint.kind, componentA: joint.a.componentId,
      componentB: joint.b.componentId, frames: { a: copy(frames.a), b: copy(frames.b) } });
  }
  return { joints, skipped };
}

interface TrialJointFrame extends TrialGeometry {
  readonly x: Vec3;
  readonly y: Vec3;
  readonly z: Vec3;
}

function trialFrame(frame: JointFrame, componentId: string, placement: RigidPlacement,
  input: JointResidualInput, baseOnly = false): TrialJointFrame {
  const value = (axis: 'tx' | 'ty' | 'tz' | 'rx' | 'ry' | 'rz'): number => {
    const column = input.variableSet.columnOf(componentId, axis);
    return baseOnly || column === null ? 0 : input.increments?.[column] ?? 0;
  };
  const omega: Vec3 = [value('rx'), value('ry'), value('rz')];
  const rotation = exponentialMap(omega);
  // 基準回転とtrial回転を順に掛け、微小trialを四元数の合成丸めで失わない。
  const rotate = (v: Vec3): Vec3 => rotateVector(rotation, rotateVector(placement.rotation, v));
  return { componentId, center: placement.position, delta: [value('tx'), value('ty'), value('tz')],
    arm: rotate(frame.origin), x: rotate(frame.x), y: rotate(frame.y), z: rotate(frame.z),
    rotationAxes: rotationDerivativeAxes(omega) };
}

/** FbᵀFaを最大対角成分から四元数にする。πでtrace由来のsinθを分母にしない。 */
function relativeQuaternion(a: TrialJointFrame, b: TrialJointFrame): Quaternion {
  const m00 = dotVec3(b.x, a.x), m01 = dotVec3(b.x, a.y), m02 = dotVec3(b.x, a.z);
  const m10 = dotVec3(b.y, a.x), m11 = dotVec3(b.y, a.y), m12 = dotVec3(b.y, a.z);
  const m20 = dotVec3(b.z, a.x), m21 = dotVec3(b.z, a.y), m22 = dotVec3(b.z, a.z);
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 2 * Math.sqrt(1 + trace);
    return normalizeQuaternion([(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]);
  }
  if (m00 >= m11 && m00 >= m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    return normalizeQuaternion([s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]);
  }
  if (m11 >= m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    return normalizeQuaternion([(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]);
  }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
  return normalizeQuaternion([(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]);
}

/**
 * SO(3) Logの局所chart。基準姿勢の四元数へ符号を揃えてπをまたぐtrialを連続に扱う。
 * qと-qの決定性は既存の正規化に従う。2πの特異点へ近づくchartは断る。
 * 基準は毎評価の引数から作り、試行順に依存する状態や隠れたunwrap履歴を持たない。
 */
function rotationLog(a: TrialJointFrame, b: TrialJointFrame, reference: Quaternion): Vec3 | null {
  const q = relativeQuaternion(a, b);
  const alignment = q.reduce((sum, v, i) => sum + v * reference[i], 0);
  // 基準からちょうど半回転のtrialは二つの持ち上げが同距離。偽の微分を返さない。
  // 基準自身がπのときはalignment=1なので、π付近の通常の検算・求解はそのまま通る。
  if (Math.abs(alignment) <= 1e-12) return null;
  const sign = alignment < 0 ? -1 : 1;
  const v: Vec3 = [sign * q[0], sign * q[1], sign * q[2]];
  const w = sign * q[3];
  const size = lengthVec3(v);
  const theta = 2 * Math.atan2(size, w);
  if (!Number.isFinite(theta) || theta >= 2 * Math.PI - 1e-6) return null;
  const square = size * size;
  const factor = size < 1e-4 && w >= 0 ? 2 + square / 3 + 3 * square * square / 20 : theta / size;
  return scaleVec3(v, factor);
}

/** J_l(φ)⁻¹ v = v − φ×v/2 + c φ×(φ×v)。θ≈0ではcの級数を使う。 */
function logDerivative(phi: Vec3, v: Vec3): Vec3 {
  const theta = lengthVec3(phi);
  const square = theta * theta;
  const c = theta < 1e-3 ? 1 / 12 + square / 720 + square * square / 30240
    : 1 / square - Math.cos(theta / 2) / (2 * theta * Math.sin(theta / 2));
  const cross = crossVec3(phi, v);
  return addVec3(v, addVec3(scaleVec3(cross, -0.5), scaleVec3(crossVec3(phi, cross), c)));
}

function rotationRows(jointId: string, phi: Vec3, a: TrialJointFrame, b: TrialJointFrame,
  variables: MateVariableSet): readonly JointResidualRow[] {
  const gradients = CARTESIAN_AXES.map(() => new Map<number, number>());
  for (const [target, sign] of [[a, 1], [b, -1]] as const) {
    for (const [j, axis] of (['rx', 'ry', 'rz'] as const).entries()) {
      const world = target.rotationAxes[j];
      const local: Vec3 = [dotVec3(b.x, world), dotVec3(b.y, world), dotVec3(b.z, world)];
      const derivative = logDerivative(phi, local);
      gradients.forEach((gradient, row) => addTerm(gradient, variables.columnOf(target.componentId, axis), sign * derivative[row]));
    }
  }
  return gradients.map((gradient, i) => ({ jointId, measure: 'rotation', ...scaledResidual(phi[i], gradient, 1) }));
}

function validIncrements(increments: readonly number[], variableCount: number): boolean {
  if (increments.length !== variableCount) return false;
  // everyは疎配列の穴を飛ばすため、継承値も含め全添字の所有と有限値を直接確認する。
  for (let column = 0; column < increments.length; column += 1) {
    if (!Object.hasOwn(increments, column)) return false;
    const value = increments[column];
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  }
  return true;
}

export function buildJointResidualReport(input: JointResidualInput): JointResidualReport {
  const rows: JointResidualRow[] = [];
  const skipped: SkippedJointResidual[] = [];
  const branchViolations: string[] = [];
  const length = input.characteristicLength ?? DEFAULT_RIGID_CHARACTERISTIC_LENGTH;
  const invalid = !Number.isFinite(length) || length <= 0 || !Number.isFinite(1 / length) ? 'invalidScale'
    : input.increments !== undefined && !validIncrements(input.increments, input.variableSet.variables.length)
      ? 'invalidIncrement' : null;
  for (const joint of input.joints) {
    const pa = input.placements.get(joint.componentA), pb = input.placements.get(joint.componentB);
    const error = invalid ?? (pa === undefined || pb === undefined ? 'dangling'
      : !validJointPlacement(pa) || !validJointPlacement(pb) || !validJointFrame(joint.frames.a)
        || !validJointFrame(joint.frames.b) ? 'invalidFrame' : null);
    if (error !== null || pa === undefined || pb === undefined) {
      skipped.push(refusal(joint.jointId, error ?? 'dangling'));
      continue;
    }
    const a = trialFrame(joint.frames.a, joint.componentA, pa, input);
    const b = trialFrame(joint.frames.b, joint.componentB, pb, input);
    const result: JointResidualRow[] = [];
    const id = joint.jointId, variables = input.variableSet;
    if (joint.kind === 'ball') {
      for (const axis of CARTESIAN_AXES) {
        const gradient = new Map<number, number>();
        pointTerms(gradient, a, axis, variables);
        pointTerms(gradient, b, scaleVec3(axis, -1), variables);
        result.push({ jointId: id, measure: 'length', ...scaledResidual(dotVec3(pointSpan(a, b), axis), gradient, 1 / length) });
      }
    } else {
      if (joint.kind === 'slider') {
        const reference = relativeQuaternion(trialFrame(joint.frames.a, joint.componentA, pa, input, true),
          trialFrame(joint.frames.b, joint.componentB, pb, input, true));
        const phi = rotationLog(a, b, reference);
        if (phi === null) { skipped.push(refusal(id, 'rotationBranch')); continue; }
        result.push(...rotationRows(id, phi, a, b, variables));
      } else {
        for (const axis of [b.x, b.y]) result.push({ jointId: id, measure: 'direction',
          ...directionResidual(a, a.z, b, axis, 0, variables) });
      }
      for (const axis of joint.kind === 'revolute' ? [b.x, b.y, b.z] : [b.x, b.y]) {
        result.push({ jointId: id, measure: 'length', ...projectedResidual(a, b, axis, 0, variables, 1 / length) });
      }
    }
    if (result.some((row) => !Number.isFinite(row.value) || [...row.gradient.values()].some((v) => !Number.isFinite(v)))) {
      skipped.push(refusal(id, 'invalidFrame'));
      continue;
    }
    rows.push(...result);
    if ((joint.kind === 'revolute' || joint.kind === 'cylindrical') && dotVec3(a.z, b.z) < 0) branchViolations.push(id);
  }
  return { rows, skipped, branchViolations };
}

/** 解法はrowsだけでなくskipped/branchViolationsも判定すること。 */
export function buildJointResiduals(input: JointResidualInput): readonly JointResidualRow[] {
  return buildJointResidualReport(input).rows;
}
