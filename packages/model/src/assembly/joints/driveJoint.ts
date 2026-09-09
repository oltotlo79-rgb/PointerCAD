/** P7 §2.6/タスク20。角度の履歴と限界は呼出しの一時入力。文書と配置を変更しない。 */
import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { crossVec3, dotVec3, scaleVec3, subVec3 } from '../../sketch/vec3.js';
import type { RigidPlacement } from '../placementMath.js';
import type { Joint } from '../types.js';
import type { MateVariableSet } from '../constraints/mateVariables.js';
import { directionTerms, projectedResidual, scaledResidual } from '../constraints/rigidResidualGeometry.js';
import { DEFAULT_RIGID_CHARACTERISTIC_LENGTH, type RigidResidualRow } from '../constraints/solveRigid.js';
import { jointCoordinateNames, type JointCoordinate, type JointFramePair } from './jointFrames.js';
import { jointTrialFrames, prepareJointResiduals, type JointResidualInput, type JointResidualSkipReason,
  type PreparedJointResidual } from './jointResiduals.js';

export type JointDriveFailureReason = JointResidualSkipReason | 'missingJoint' | 'suppressed' | 'unsupported'
  | 'invalidReference' | 'invalidValue' | 'invalidRange' | 'invalidExpression' | 'ambiguousRange' | 'duplicateJoint';
export interface JointDriveFailure { readonly ok: false; readonly reason: JointDriveFailureReason }
export interface JointValueInput extends Omit<JointResidualInput, 'joints'> {
  readonly joint: PreparedJointResidual;
  readonly coordinate: JointCoordinate;
  /** 角度は受理済みの参照値(deg)を必須とする。配置だけから周回数を復元しない。 */
  readonly referenceAngle?: number;
}
export type JointValueResult = JointDriveFailure | {
  readonly ok: true; readonly value: number; readonly unit: 'deg' | 'mm';
};
export interface JointDriveBounds { readonly min: ExpressionValue | null; readonly max: ExpressionValue | null }
export interface JointDriveRequest {
  readonly jointId: string;
  readonly coordinate: JointCoordinate;
  readonly value: number;
  readonly referenceAngle?: number;
  /** cylindricalでは選択した座標だけの範囲。保存された一組を推測しない。 */
  readonly bounds?: JointDriveBounds;
}
export interface PreparedJointDrive {
  readonly joint: PreparedJointResidual;
  readonly coordinate: JointCoordinate;
  readonly requested: number;
  readonly target: number;
  readonly referenceAngle?: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly atLimit: boolean;
  readonly outOfRange: boolean;
}
export interface JointDriveRow extends RigidResidualRow {
  readonly jointId: string;
  readonly coordinate: JointCoordinate;
}
export type JointDriveRowsResult = JointDriveFailure | {
  readonly ok: true; readonly rows: readonly JointDriveRow[]; readonly actual: number;
};

const NO_VARIABLES: MateVariableSet = { variables: [], initial: [], movableComponentIds: [], frozen: new Map(),
  tooMany: false, columnOf: () => null, componentOf: () => null };
const finite = (value: number): boolean => typeof value === 'number' && Number.isFinite(value);
const canonicalZero = (value: number): number => value === 0 ? 0 : value;

/** (-180,180]の最短差。ちょうど半回転は正方向を選ぶ。 */
function unwrap(principal: number, reference: number): number {
  const difference = ((principal - reference) % 360 + 540) % 360 - 180;
  return reference + (difference === -180 ? 180 : difference);
}

function coordinateRow(input: JointValueInput): JointDriveFailure | {
  readonly ok: true; readonly value: number; readonly gradient: Map<number, number>;
} {
  if (!jointCoordinateNames(input.joint.kind).includes(input.coordinate)) return { ok: false, reason: 'unsupported' };
  if (input.coordinate === 'angle' && (input.referenceAngle === undefined || !finite(input.referenceAngle))) {
    return { ok: false, reason: 'invalidReference' };
  }
  const frames = jointTrialFrames({ ...input, joints: [input.joint] }, input.joint);
  if (!frames.ok) return frames;
  const { a, b } = frames;
  if (input.coordinate === 'translation') {
    const row = projectedResidual(a, b, b.z, 0, input.variableSet, 1);
    return { ok: true, value: row.value, gradient: new Map(row.gradient) };
  }
  const s = dotVec3(crossVec3(a.x, b.x), b.z), c = dotVec3(a.x, b.x);
  const denominator = s * s + c * c;
  if (!Number.isFinite(denominator) || denominator <= 1e-24) return { ok: false, reason: 'rotationBranch' };
  const gradient = new Map<number, number>();
  // d atan2(s,c) = (c ds - s dc)/(s²+c²)。bの軸の回転も含める。
  directionTerms(gradient, a, a.x, scaleVec3(subVec3(scaleVec3(crossVec3(b.x, b.z), c), scaleVec3(b.x, s)), 1 / denominator), input.variableSet);
  directionTerms(gradient, b, b.x, scaleVec3(subVec3(scaleVec3(crossVec3(b.z, a.x), c), scaleVec3(a.x, s)), 1 / denominator), input.variableSet);
  directionTerms(gradient, b, b.z, scaleVec3(crossVec3(a.x, b.x), c / denominator), input.variableSet);
  const value = unwrap(Math.atan2(s, c) * 180 / Math.PI, input.referenceAngle ?? 0);
  return { ok: true, value, gradient };
}

export function jointValue(input: JointValueInput): JointValueResult {
  const row = coordinateRow(input);
  if (!row.ok) return row;
  if (!finite(row.value)) return { ok: false, reason: 'invalidFrame' };
  return { ok: true, value: canonicalZero(row.value), unit: input.coordinate === 'angle' ? 'deg' : 'mm' };
}

export function clampToRange(value: number, min: number | null, max: number | null): JointDriveFailure | {
  readonly ok: true; readonly value: number; readonly atLimit: boolean; readonly outOfRange: boolean;
} {
  if (!finite(value)) return { ok: false, reason: 'invalidValue' };
  if ((min !== null && !finite(min)) || (max !== null && !finite(max))
    || (min !== null && max !== null && min > max)) return { ok: false, reason: 'invalidRange' };
  const applied = min !== null && value < min ? min : max !== null && value > max ? max : value;
  return { ok: true, value: canonicalZero(applied), atLimit: applied === min || applied === max, outOfRange: applied !== value };
}

/** 通常求解後の範囲違反は報告だけ。実際の値はclampしない。 */
export function inspectJointRange(value: number, min: number | null, max: number | null): ReturnType<typeof clampToRange> {
  const range = clampToRange(value, min, max);
  return range.ok ? { ...range, value: canonicalZero(value), atLimit: value === min || value === max } : range;
}

export function prepareJointDrive(input: {
  readonly joint: Joint | undefined;
  readonly frames: JointFramePair | undefined;
  readonly placements: ReadonlyMap<string, RigidPlacement>;
  readonly request: JointDriveRequest;
  readonly parameters?: ReadonlyMap<string, number>;
  readonly exactVariables?: ReadonlyMap<string, string>;
  /** inch節内で換算しない角度・無次元の名前。省略時は既存の数値Map契約を保つ。 */
  readonly nonLengthVariables?: ReadonlySet<string>;
}): JointDriveFailure | { readonly ok: true; readonly drive: PreparedJointDrive } {
  const { joint, frames, request } = input;
  if (joint === undefined || joint.id !== request.jointId) return { ok: false, reason: 'missingJoint' };
  if (joint.suppressed) return { ok: false, reason: 'suppressed' };
  if (!jointCoordinateNames(joint.kind).includes(request.coordinate)) return { ok: false, reason: 'unsupported' };
  const preparation = prepareJointResiduals({ joints: [joint], placements: input.placements,
    frames: frames === undefined ? new Map() : new Map([[joint.id, frames]]) });
  const prepared = preparation.joints[0];
  if (prepared === undefined) return { ok: false, reason: preparation.skipped[0]?.reason ?? 'invalidFrame' };
  const current = jointValue({ joint: prepared, coordinate: request.coordinate, referenceAngle: request.referenceAngle,
    placements: input.placements, variableSet: NO_VARIABLES });
  if (!current.ok) return current;
  if (joint.kind === 'cylindrical' && request.bounds === undefined && (joint.minValue !== null || joint.maxValue !== null)) {
    return { ok: false, reason: 'ambiguousRange' };
  }
  const bounds = request.bounds ?? { min: joint.minValue, max: joint.maxValue };
  const values: (number | null)[] = [];
  for (const expression of [bounds.min, bounds.max]) {
    if (expression === null) { values.push(null); continue; }
    const evaluated = evaluateExpression(expression.source, {
      variables: input.parameters, exactVariables: input.exactVariables, nonLengthVariables: input.nonLengthVariables,
    });
    if (!evaluated.ok || !finite(evaluated.value.value)) return { ok: false, reason: 'invalidExpression' };
    values.push(canonicalZero(evaluated.value.value));
  }
  const range = clampToRange(request.value, values[0], values[1]);
  if (!range.ok) return range;
  return { ok: true, drive: { joint: prepared, coordinate: request.coordinate, requested: canonicalZero(request.value),
    target: range.value, referenceAngle: request.coordinate === 'angle' ? current.value : undefined,
    min: values[0], max: values[1], atLimit: range.atLimit, outOfRange: range.outOfRange } };
}

export function driveJointRows(input: JointValueInput & { readonly target: number }): JointDriveRowsResult {
  if (!finite(input.target)) return { ok: false, reason: 'invalidValue' };
  const length = input.characteristicLength ?? DEFAULT_RIGID_CHARACTERISTIC_LENGTH;
  if (!finite(length) || length <= 0 || !finite(1 / length)) return { ok: false, reason: 'invalidScale' };
  const row = coordinateRow(input);
  if (!row.ok) return row;
  // 受理済み参照から半回転以上進む試行は周回が曖昧。減衰して短い試行へ戻す。
  if (input.coordinate === 'angle' && input.increments !== undefined) {
    const sizes = [input.joint.componentA, input.joint.componentB].map((id) => Math.hypot(...(['rx', 'ry', 'rz'] as const).map((axis) => {
      const column = input.variableSet.columnOf(id, axis);
      return column === null ? 0 : input.increments?.[column] ?? 0;
    })));
    if (sizes[0] + sizes[1] >= Math.PI) return { ok: false, reason: 'rotationBranch' };
  }
  const delta = (row.value - input.target) * (input.coordinate === 'angle' ? Math.PI / 180 : 1);
  const scaled = scaledResidual(delta, row.gradient, input.coordinate === 'angle' ? 1 : 1 / length);
  if (!finite(scaled.value) || [...scaled.gradient.values()].some((v) => !finite(v))) return { ok: false, reason: 'invalidFrame' };
  const constant = input.variableSet.columnOf(input.joint.componentA, 'tx') === null
    && input.variableSet.columnOf(input.joint.componentB, 'tx') === null;
  return { ok: true, actual: canonicalZero(row.value), rows: [{ ...scaled, jointId: input.joint.jointId,
    coordinate: input.coordinate, unit: input.coordinate === 'angle' ? 'angle' : 'length', constant }] };
}
