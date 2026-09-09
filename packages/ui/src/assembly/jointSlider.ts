/** P7 タスク22。ジョイントのつまみの範囲と入力値を決める純関数。 */
import { evaluateExpression } from '@pointercad/expression';
import {
  assemblyExpressionContext,
  clampToRange,
  collectMateVariables,
  jointValue,
  jointCoordinateNames,
  prepareJointResiduals,
  type AssemblyDocument,
  type Joint,
  type JointCoordinate,
  type JointFramePair,
  type RigidPlacement,
} from '@pointercad/model';

export interface JointSliderBounds {
  readonly min: number | null;
  readonly max: number | null;
}

export type JointSliderBoundsResult =
  | { readonly ok: true; readonly bounds: JointSliderBounds }
  | { readonly ok: false; readonly reason: 'unsupported' | 'invalidExpression' | 'invalidRange' };

export interface JointSliderDomain {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly disabled: boolean;
}

/** 周回する角度を、保存された範囲に最も近い枝で最初に読むための基準。 */
export function jointSliderReference(bounds: JointSliderBounds): number {
  if (bounds.min !== null && bounds.max !== null) return bounds.min / 2 + bounds.max / 2;
  return bounds.min ?? bounds.max ?? 0;
}

/** 保存した式を現在のアセンブリパラメータで評価する。入力や文書は変更しない。 */
export function jointSliderBounds(
  document: AssemblyDocument,
  joint: Joint,
  coordinate: JointCoordinate,
): JointSliderBoundsResult {
  if (!jointCoordinateNames(joint.kind).includes(coordinate)) {
    return { ok: false, reason: 'unsupported' };
  }
  const context = assemblyExpressionContext(document);
  const values: (number | null)[] = [];
  for (const expression of [joint.minValue, joint.maxValue]) {
    if (expression === null) {
      values.push(null);
      continue;
    }
    const evaluated = evaluateExpression(expression.source, context);
    if (!evaluated.ok || !Number.isFinite(evaluated.value.value)) {
      return { ok: false, reason: 'invalidExpression' };
    }
    values.push(evaluated.value.value === 0 ? 0 : evaluated.value.value);
  }
  const checked = clampToRange(0, values[0], values[1]);
  if (!checked.ok) return { ok: false, reason: 'invalidRange' };
  return { ok: true, bounds: { min: values[0], max: values[1] } };
}

/**
 * HTML の range に渡す有限区間。無制限の自由度は現在値を中心に窓だけを移し、
 * 数値入力では窓の外も受け付けるので、保存上の限界にはしない。
 */
export function jointSliderDomain(
  coordinate: JointCoordinate,
  value: number,
  bounds: JointSliderBounds,
): JointSliderDomain | null {
  if (!Number.isFinite(value) ||
    (bounds.min !== null && !Number.isFinite(bounds.min)) ||
    (bounds.max !== null && !Number.isFinite(bounds.max)) ||
    (bounds.min !== null && bounds.max !== null && bounds.min > bounds.max)) return null;
  const span = coordinate === 'angle' ? 360 : 100;
  const min = bounds.min ?? (bounds.max === null ? value - span / 2 : bounds.max - span);
  const max = bounds.max ?? (bounds.min === null ? value + span / 2 : bounds.min + span);
  return { min, max, step: coordinate === 'angle' ? 1 : 0.1, disabled: min === max };
}

export type JointSliderValueResult =
  | { readonly ok: true; readonly value: number; readonly atLimit: boolean; readonly outOfRange: boolean }
  | { readonly ok: false; readonly reason: 'invalidValue' | 'invalidRange' };

/** つまみと数値欄が同じ clamp を通る入口。 */
export function jointSliderValue(
  value: number,
  bounds: JointSliderBounds,
): JointSliderValueResult {
  const result = clampToRange(value, bounds.min, bounds.max);
  return result.ok ? result : { ok: false, reason: result.reason === 'invalidValue' ? 'invalidValue' : 'invalidRange' };
}

export function jointSliderCoordinates(joint: Joint): readonly JointCoordinate[] {
  return jointCoordinateNames(joint.kind);
}

/** 解決済み配置からつまみの初期値を読む。角度の周回は呼出し側の直前値を基準にする。 */
export function currentJointSliderValue(input: {
  readonly document: AssemblyDocument;
  readonly joint: Joint;
  readonly coordinate: JointCoordinate;
  readonly placements: ReadonlyMap<string, RigidPlacement>;
  readonly frames: JointFramePair | undefined;
  readonly referenceAngle?: number;
}): number | null {
  if (input.frames === undefined) return null;
  const prepared = prepareJointResiduals({ joints: [input.joint],
    frames: new Map([[input.joint.id, input.frames]]), placements: input.placements });
  const joint = prepared.joints[0];
  if (joint === undefined) return null;
  const value = jointValue({ joint, coordinate: input.coordinate,
    referenceAngle: input.coordinate === 'angle' ? input.referenceAngle ?? 0 : undefined,
    placements: input.placements, variableSet: collectMateVariables(input.document) });
  return value.ok ? value.value : null;
}
