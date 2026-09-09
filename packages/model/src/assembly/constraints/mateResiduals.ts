/**
 * 合致6種の純粋な残差と解析ヤコビアン(P7 §2.5.6、R6-2〜R6-4)。
 * prepareMateResiduals は初期の世界幾何を部品局所へ固定する。build は受理済み配置と
 * 増分だけを読み、配置を更新しない。受理・棄却と再パラメータ化はタスク15の責務。
 */
import type { LinearizedRow } from '../../sketch/constraints/solve.js';
import {
  addVec3, dotVec3, lengthVec3, scaleVec3, subVec3, type Vec3,
} from '../../sketch/vec3.js';
import {
  exponentialMap, rotateVector, type Quaternion, type RigidPlacement,
} from '../placementMath.js';
import type { Mate, MateKind } from '../types.js';
import {
  createMateFrame, mateAlignmentSign, mateUnitDirection, rotateMateFrame, type MateFrame,
} from './mateFrames.js';
import { MISSING_AXIS_MESSAGE, type ResolvedMateTarget } from './mateTargets.js';
import { mateValueOf, type MateVariableSet } from './mateVariables.js';

import {
  CARTESIAN_AXES, directionResidual, pointSpan, pointTerms, projectedResidual,
  rotationDerivativeAxes, scaledResidual, validRigidPlacement,
} from './rigidResidualGeometry.js';

export const DEFAULT_MATE_CHARACTERISTIC_LENGTH = 100;
export const MATE_ANGLE_REFUSAL_MESSAGE =
  'この角度では合致を付けられません。『平行』を使ってください。';
export const MATE_DISTANCE_REFUSAL_MESSAGE =
  '距離は 0 以上にしてください。向きは『裏返す』で変えられます。';

/** 解析軸の原点は初期の世界座標。円筒/円錐の面重心から推定しない(14bへの接続口)。 */
export interface MateResidualTarget extends ResolvedMateTarget {
  readonly axisOrigin?: Vec3;
}

export interface MateResidualTargetPair {
  readonly a: MateResidualTarget;
  readonly b: MateResidualTarget;
}

export interface MateResidualRow extends LinearizedRow {
  readonly mateId: string;
  /** 生の式へ掛けた係数。長さ行は 1/L₀、方向行は1。value/gradientへ適用済み。 */
  readonly scale: number;
}

export type MateResidualSkipReason =
  | 'dangling' | 'degenerate' | 'missingAxis' | 'unsupportedTarget'
  | 'invalidValue' | 'angleNearParallel' | 'negativeDistance' | 'invalidScale' | 'invalidIncrement';

export interface SkippedMateResidual {
  readonly mateId: string;
  readonly reason: MateResidualSkipReason;
  readonly message: string;
}

/** 幾何は部品の局所座標。軸/円筒の point は必ず解析軸上の点。 */
export interface LocalMateResidualTarget extends ResolvedMateTarget {
  readonly frame: MateFrame | null;
}

export interface PreparedMateResidual {
  readonly mateId: string;
  readonly kind: MateKind;
  readonly componentA: string;
  readonly componentB: string;
  readonly a: LocalMateResidualTarget;
  readonly b: LocalMateResidualTarget;
  /** 長さmm、角度rad。式評価/度→rad変換は準備時の1回だけ。 */
  readonly value: number;
  readonly alignmentSign: 1 | -1;
  readonly tangentSide: 1 | -1;
}

export interface MateResidualPreparationInput {
  readonly mates: readonly Mate[];
  readonly targets: ReadonlyMap<string, MateResidualTargetPair>;
  readonly placements: ReadonlyMap<string, RigidPlacement>;
  readonly parameters?: ReadonlyMap<string, number>;
  readonly exactVariables?: ReadonlyMap<string, string>;
  readonly nonLengthVariables?: ReadonlySet<string>;
}

export interface MateResidualPreparationReport {
  readonly mates: readonly PreparedMateResidual[];
  readonly skipped: readonly SkippedMateResidual[];
}

export interface MateResidualInput {
  readonly mates: readonly PreparedMateResidual[];
  readonly variableSet: MateVariableSet;
  /** 受理済み基準姿勢。固定部品も含める。 */
  readonly placements: ReadonlyMap<string, RigidPlacement>;
  /** variableSet の列順の Δt(mm), Δω(rad)。省略時はゼロ。 */
  readonly increments?: readonly number[];
  readonly characteristicLength?: number;
}

export interface MateResidualReport {
  readonly rows: readonly MateResidualRow[];
  readonly skipped: readonly SkippedMateResidual[];
  /**
   * 内積の2行は ± の両方でゼロになるため、別途追跡する半球の違反。
   * 行は消さない。driver はこれが残った trial を収束として受理しないこと。
   */
  readonly branchViolations: readonly string[];
}

function refusal(mateId: string, reason: MateResidualSkipReason): SkippedMateResidual {
  const messages: Readonly<Record<MateResidualSkipReason, string>> = {
    dangling: '合致が指している部品または対象が見つかりません。',
    degenerate: '法線・点・半径が不正なため、この合致を計算できません。',
    missingAxis: MISSING_AXIS_MESSAGE,
    unsupportedTarget: 'この合致は、選んだ要素の組み合わせには付けられません。',
    invalidValue: '合致の値を数にできません。',
    angleNearParallel: MATE_ANGLE_REFUSAL_MESSAGE,
    negativeDistance: MATE_DISTANCE_REFUSAL_MESSAGE,
    invalidScale: '合致の代表長さは有限の正の数にしてください。',
    invalidIncrement: '合致の増分の数または値が不正です。',
  };
  return { mateId, reason, message: messages[reason] };
}

function finitePoint(point: Vec3): boolean {
  return point.every(Number.isFinite);
}

function axisTarget(target: ResolvedMateTarget): boolean {
  return target.kind === 'axis' || target.kind === 'cylinder';
}

function geometryError(target: MateResidualTarget): MateResidualSkipReason | null {
  if (!finitePoint(target.point)) return 'degenerate';
  if (axisTarget(target) && (target.axisOrigin === undefined || !finitePoint(target.axisOrigin))) {
    return 'missingAxis';
  }
  if (target.kind !== 'point' && mateUnitDirection(target.direction) === null) {
    return axisTarget(target) ? 'missingAxis' : 'degenerate';
  }
  if (target.kind === 'cylinder'
    && (target.radius === null || !Number.isFinite(target.radius) || target.radius <= 0)) {
    return 'degenerate';
  }
  return null;
}

function localTarget(target: MateResidualTarget, placement: RigidPlacement): LocalMateResidualTarget {
  const [x, y, z, w] = placement.rotation;
  const inverse: Quaternion = [-x, -y, -z, w];
  const direction = target.kind === 'point' ? null : mateUnitDirection(target.direction);
  const localDirection = direction === null ? null : rotateVector(inverse, direction);
  return {
    kind: target.kind,
    point: rotateVector(inverse, subVec3(
      axisTarget(target) ? (target.axisOrigin ?? target.point) : target.point, placement.position)),
    direction: localDirection,
    radius: target.radius,
    frame: localDirection === null ? null : createMateFrame(localDirection),
  };
}

function supported(kind: MateKind, a: ResolvedMateTarget, b: ResolvedMateTarget): boolean {
  switch (kind) {
    case 'parallel':
    case 'angle': return a.kind !== 'point' && b.kind !== 'point';
    case 'concentric': return axisTarget(a) && axisTarget(b);
    case 'tangent': return a.kind === 'cylinder' && b.kind === 'plane';
    case 'coincident':
    case 'distance': return (a.kind === 'point' && b.kind === 'point')
      || ((a.kind === 'point' || a.kind === 'plane') && b.kind === 'plane');
  }
}

/** 初期姿勢で1度呼ぶ。受理後も局所幾何・補助基底・向き分岐・接線の側を再選択しない。 */
export function prepareMateResiduals(input: MateResidualPreparationInput): MateResidualPreparationReport {
  const mates: PreparedMateResidual[] = [];
  const skipped: SkippedMateResidual[] = [];
  for (const mate of input.mates) {
    if (mate.suppressed) continue;
    const pair = input.targets.get(mate.id);
    const pa = input.placements.get(mate.a.componentId);
    const pb = input.placements.get(mate.b.componentId);
    if (pair === undefined || pa === undefined || pb === undefined) {
      skipped.push(refusal(mate.id, 'dangling'));
      continue;
    }
    const error = geometryError(pair.a) ?? geometryError(pair.b)
      ?? (!validRigidPlacement(pa) || !validRigidPlacement(pb) ? 'degenerate' : null);
    if (error !== null) {
      skipped.push(refusal(mate.id, error));
      continue;
    }
    // 点-面と円筒-面は、選択順に依らず面を b にそろえる。
    const swap = (pair.a.kind === 'plane' && pair.b.kind === 'point')
      || (mate.kind === 'tangent' && pair.a.kind === 'plane' && pair.b.kind === 'cylinder');
    const a = swap ? pair.b : pair.a;
    const b = swap ? pair.a : pair.b;
    if (!supported(mate.kind, a, b)) {
      skipped.push(refusal(mate.id, 'unsupportedTarget'));
      continue;
    }
    const needsValue = mate.kind === 'angle' || mate.kind === 'distance'
      || (mate.kind === 'coincident' && a.kind === 'plane' && mate.value !== undefined);
    const rawValue = needsValue ? mateValueOf(mate.value, input.parameters ?? new Map(), input) : 0;
    if (rawValue === null) {
      skipped.push(refusal(mate.id, 'invalidValue'));
      continue;
    }
    if (mate.kind === 'distance' && rawValue < 0) {
      skipped.push(refusal(mate.id, 'negativeDistance'));
      continue;
    }
    if (mate.kind === 'angle' && (rawValue <= 1 || rawValue >= 179)) {
      skipped.push(refusal(mate.id, 'angleNearParallel'));
      continue;
    }
    const alignmentSign = a.direction === null || b.direction === null ? 1
      : mateAlignmentSign(a.direction, b.direction, mate.flipped);
    const signedHeight = b.direction === null ? 0
      : dotVec3(subVec3(a.axisOrigin ?? a.point, b.point), b.direction);
    const side = signedHeight < 0 ? -1 : 1;
    mates.push({
      mateId: mate.id, kind: mate.kind,
      componentA: swap ? mate.b.componentId : mate.a.componentId,
      componentB: swap ? mate.a.componentId : mate.b.componentId,
      a: localTarget(a, swap ? pb : pa), b: localTarget(b, swap ? pa : pb),
      value: mate.kind === 'angle' ? rawValue * Math.PI / 180 : rawValue * (mate.flipped ? -1 : 1),
      alignmentSign,
      tangentSide: mate.flipped ? (side === 1 ? -1 : 1) : side,
    });
  }
  return { mates, skipped };
}

interface TrialTarget extends ResolvedMateTarget {
  readonly componentId: string;
  readonly center: Vec3;
  readonly delta: Vec3;
  readonly arm: Vec3;
  readonly rotationAxes: readonly Vec3[];
  readonly frame: MateFrame | null;
}

interface TrialMotion {
  readonly placement: RigidPlacement;
  readonly delta: Vec3;
  readonly rotation: Quaternion;
  readonly rotate: (vector: Vec3) => Vec3;
  readonly rotationAxes: readonly Vec3[];
}

function trialMotion(componentId: string, placement: RigidPlacement, input: MateResidualInput): TrialMotion {
  const increment = (axis: 'tx' | 'ty' | 'tz' | 'rx' | 'ry' | 'rz'): number => {
    const column = input.variableSet.columnOf(componentId, axis);
    return column === null ? 0 : (input.increments?.[column] ?? 0);
  };
  const dt: Vec3 = [increment('tx'), increment('ty'), increment('tz')];
  const omega: Vec3 = [increment('rx'), increment('ry'), increment('rz')];
  const rotation = exponentialMap(omega);
  // 基準の回転を先に掛け、増分を最後に掛ける。微小なtrialを四元数の合成/再正規化で失わない。
  const zeroRotation = omega[0] === 0 && omega[1] === 0 && omega[2] === 0;
  const rotate = zeroRotation ? (vector: Vec3): Vec3 => rotateVector(placement.rotation, vector)
    : (vector: Vec3): Vec3 => rotateVector(rotation, rotateVector(placement.rotation, vector));
  return { placement, delta: dt, rotation, rotate, rotationAxes: rotationDerivativeAxes(omega) };
}

function trialTarget(target: LocalMateResidualTarget, componentId: string, motion: TrialMotion): TrialTarget {
  const { placement, delta, rotation, rotate, rotationAxes } = motion;
  const arm = rotate(target.point);
  return {
    kind: target.kind, componentId, arm, center: placement.position, delta, radius: target.radius,
    point: addVec3(addVec3(placement.position, delta), arm),
    direction: target.direction === null ? null : rotate(target.direction),
    frame: target.frame === null ? null : rotateMateFrame(rotateMateFrame(target.frame, placement.rotation), rotation),
    rotationAxes,
  };
}

function rowOf(mateId: string, value: number, gradient: Map<number, number>, scale: number): MateResidualRow {
  return { mateId, ...scaledResidual(value, gradient, scale) };
}
function directionRow(id: string, a: TrialTarget, u: Vec3, b: TrialTarget, v: Vec3,
  offset: number, variables: MateVariableSet): MateResidualRow {
  return { mateId: id, ...directionResidual(a, u, b, v, offset, variables) };
}
function projectedRow(id: string, a: TrialTarget, b: TrialTarget, v: Vec3, offset: number,
  variables: MateVariableSet, scale: number): MateResidualRow {
  return { mateId: id, ...projectedResidual(a, b, v, offset, variables, scale) };
}

function parallelRows(mate: PreparedMateResidual, a: TrialTarget, b: TrialTarget,
  variables: MateVariableSet): readonly MateResidualRow[] {
  if (a.direction === null || b.frame === null) return [];
  const direction = a.direction;
  return [b.frame.t, b.frame.s].map((v) => directionRow(mate.mateId, a,
    direction, b, v, 0, variables));
}

function mateRows(mate: PreparedMateResidual, a: TrialTarget, b: TrialTarget,
  variables: MateVariableSet, scale: number): readonly MateResidualRow[] | MateResidualSkipReason {
  switch (mate.kind) {
    case 'parallel': return parallelRows(mate, a, b, variables);
    case 'coincident': {
      if (a.kind === 'point' && b.kind === 'point') {
        return CARTESIAN_AXES.map((axis) => {
          const gradient = new Map<number, number>();
          pointTerms(gradient, a, axis, variables);
          pointTerms(gradient, b, scaleVec3(axis, -1), variables);
          return rowOf(mate.mateId, dotVec3(pointSpan(a, b), axis), gradient, scale);
        });
      }
      if (b.direction === null) return 'degenerate';
      return [...(a.kind === 'plane' ? parallelRows(mate, a, b, variables) : []),
        projectedRow(mate.mateId, a, b, b.direction, mate.value, variables, scale)];
    }
    case 'concentric': {
      if (b.frame === null) return 'missingAxis';
      return [...parallelRows(mate, a, b, variables),
        ...[b.frame.t, b.frame.s].map((v) => projectedRow(mate.mateId, a, b, v, 0, variables, scale))];
    }
    case 'distance': {
      if (a.kind === 'point' && b.kind === 'point') {
        const span = pointSpan(a, b);
        const length = lengthVec3(span);
        // 重なった点のノルムは微分不能。架空の向きを選んで解法へ渡さない。
        if (length <= 1e-12 || !Number.isFinite(length)) return 'degenerate';
        const unit = scaleVec3(span, 1 / length);
        const gradient = new Map<number, number>();
        pointTerms(gradient, a, unit, variables);
        pointTerms(gradient, b, scaleVec3(unit, -1), variables);
        const row = rowOf(mate.mateId, 0, gradient, scale);
        // ノルムを尺度化してから取る。大きなmm値で丸めてから割る二重丸めを避ける。
        return [{ ...row, value: lengthVec3(scaleVec3(span, scale)) - Math.abs(mate.value) * scale }];
      }
      return b.direction === null ? 'degenerate'
        : [projectedRow(mate.mateId, a, b, b.direction, mate.value, variables, scale)];
    }
    case 'angle': return a.direction === null || b.direction === null ? 'degenerate'
      : [directionRow(mate.mateId, a, a.direction, b, b.direction, Math.cos(mate.value), variables)];
    case 'tangent': {
      if (a.direction === null || b.direction === null || a.radius === null) return 'degenerate';
      return [directionRow(mate.mateId, a, a.direction, b, b.direction, 0, variables),
        projectedRow(mate.mateId, a, b, b.direction, mate.tangentSide * a.radius, variables, scale)];
    }
  }
}

/** 断った合致と向き分岐も返す。固定同士の行は診断に必要なので消さない。 */
export function buildMateResidualReport(input: MateResidualInput): MateResidualReport {
  const rows: MateResidualRow[] = [];
  const skipped: SkippedMateResidual[] = [];
  const branchViolations: string[] = [];
  // 同じ部品に複数の合致が付いても、増分の指数写像と回転微分は評価1回につき1回。
  // 局所の対象点/面は共有せず、受理姿勢や増分が変わる次の評価へキャッシュを持ち越さない。
  const motions = new Map<string, TrialMotion>();
  const motionFor = (id: string, placement: RigidPlacement): TrialMotion => {
    let motion = motions.get(id);
    if (motion === undefined) { motion = trialMotion(id, placement, input); motions.set(id, motion); }
    return motion;
  };
  const length = input.characteristicLength ?? DEFAULT_MATE_CHARACTERISTIC_LENGTH;
  const invalid: MateResidualSkipReason | null = !Number.isFinite(length) || length <= 0
    || !Number.isFinite(1 / length) ? 'invalidScale'
    : input.increments !== undefined && (input.increments.length !== input.variableSet.variables.length
      || !input.increments.every(Number.isFinite)) ? 'invalidIncrement' : null;
  for (const mate of input.mates) {
    if (invalid !== null) {
      skipped.push(refusal(mate.mateId, invalid));
      continue;
    }
    const pa = input.placements.get(mate.componentA);
    const pb = input.placements.get(mate.componentB);
    if (pa === undefined || pb === undefined) {
      skipped.push(refusal(mate.mateId, 'dangling'));
      continue;
    }
    if ((!motions.has(mate.componentA) && !validRigidPlacement(pa)) || (!motions.has(mate.componentB) && !validRigidPlacement(pb))) {
      skipped.push(refusal(mate.mateId, 'degenerate'));
      continue;
    }
    const a = trialTarget(mate.a, mate.componentA, motionFor(mate.componentA, pa));
    const b = trialTarget(mate.b, mate.componentB, motionFor(mate.componentB, pb));
    const result = mateRows(mate, a, b, input.variableSet, 1 / length);
    if (typeof result === 'string') {
      skipped.push(refusal(mate.mateId, result));
      continue;
    }
    if (result.some((row) => !Number.isFinite(row.value) || [...row.gradient.values()].some((v) => !Number.isFinite(v)))) {
      skipped.push(refusal(mate.mateId, 'degenerate'));
      continue;
    }
    rows.push(...result);
    if ((mate.kind === 'parallel' || mate.kind === 'concentric'
      || (mate.kind === 'coincident' && a.kind === 'plane'))
      && a.direction !== null && b.direction !== null
      && mate.alignmentSign * dotVec3(a.direction, b.direction) < 0) {
      branchViolations.push(mate.mateId);
    }
  }
  return { rows, skipped, branchViolations };
}

/** 行だけを要る呼び手用。解法は report の skipped/branchViolations も確認すること。 */
export function buildMateResiduals(input: MateResidualInput): readonly MateResidualRow[] {
  return buildMateResidualReport(input).rows;
}
