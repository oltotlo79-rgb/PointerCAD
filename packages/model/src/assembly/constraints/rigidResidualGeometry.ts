/** Shared trial geometry and analytic derivatives; independent of constraint IDs and storage. */
import { addVec3, crossVec3, dotVec3, lengthVec3, scaleVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import type { LinearizedRow } from '../../sketch/constraints/solve.js';
import type { RigidPlacement } from '../placementMath.js';
import type { MateVariableSet } from './mateVariables.js';

export interface TrialGeometry {
  readonly componentId: string;
  readonly center: Vec3;
  readonly delta: Vec3;
  readonly arm: Vec3;
  readonly rotationAxes: readonly Vec3[];
}
export interface ScaledResidualRow extends LinearizedRow { readonly scale: number }
export function validRigidPlacement(placement: RigidPlacement): boolean {
  return placement.position.every(Number.isFinite) && placement.rotation.every(Number.isFinite)
    && Math.hypot(...placement.rotation) > 1e-12;
}

export const CARTESIAN_AXES: readonly Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const TRANSLATION_AXES = ['tx', 'ty', 'tz'] as const;
const ROTATION_AXES = ['rx', 'ry', 'rz'] as const;

/**
 * exp(ω) の左ヤコビアン J_l = I + A[ω] + B[ω]² の列。
 * δ(Rv) = (J_l δω) × Rv。非ゼロ trial に零点の e×v を流用しない。
 * 小角では A=1/2−θ²/24+θ⁴/720、B=1/6−θ²/120+θ⁴/5040 で桁落ちを避ける。
 */
export function rotationDerivativeAxes(omega: Vec3): readonly Vec3[] {
  const theta = lengthVec3(omega);
  const square = theta * theta;
  const a = theta < 1e-3 ? 0.5 - square / 24 + square * square / 720
    : (1 - Math.cos(theta)) / square;
  const b = theta < 1e-3 ? 1 / 6 - square / 120 + square * square / 5040
    : (theta - Math.sin(theta)) / (square * theta);
  return CARTESIAN_AXES.map((axis) => {
    const first = crossVec3(omega, axis);
    return addVec3(axis, addVec3(scaleVec3(first, a), scaleVec3(crossVec3(omega, first), b)));
  });
}

/** 大きな世界座標へ微小な並進を足してから引くことを避ける。 */
export function pointSpan(a: TrialGeometry, b: TrialGeometry): Vec3 {
  return addVec3(addVec3(subVec3(a.center, b.center), subVec3(a.arm, b.arm)), subVec3(a.delta, b.delta));
}

export function addTerm(gradient: Map<number, number>, column: number | null, value: number): void {
  if (column !== null && value !== 0) gradient.set(column, (gradient.get(column) ?? 0) + value);
}

/** ∂f/∂v = g なら ∂f/∂ω_j = g·((J_l e_j)×v)。点は部品原点からの腕を回す。 */
export function directionTerms(
  gradient: Map<number, number>, target: TrialGeometry, vector: Vec3, g: Vec3,
  variables: MateVariableSet,
): void {
  ROTATION_AXES.forEach((axis, j) => {
    addTerm(gradient, variables.columnOf(target.componentId, axis),
      dotVec3(g, crossVec3(target.rotationAxes[j], vector)));
  });
}

export function pointTerms(
  gradient: Map<number, number>, target: TrialGeometry, g: Vec3, variables: MateVariableSet,
): void {
  TRANSLATION_AXES.forEach((axis, j) => addTerm(gradient, variables.columnOf(target.componentId, axis), g[j]));
  directionTerms(gradient, target, target.arm, g, variables);
}

export function scaledResidual(value: number, gradient: Map<number, number>, scale: number): ScaledResidualRow {
  for (const [column, coefficient] of gradient) {
    const scaled = coefficient * scale;
    if (scaled === 0) gradient.delete(column);
    else gradient.set(column, scaled);
  }
  return { value: value * scale, gradient, scale };
}

export function directionResidual(
  a: TrialGeometry, u: Vec3, b: TrialGeometry, v: Vec3, offset: number,
  variables: MateVariableSet,
): ScaledResidualRow {
  const gradient = new Map<number, number>();
  directionTerms(gradient, a, u, v, variables);
  directionTerms(gradient, b, v, u, variables);
  return scaledResidual(dotVec3(u, v) - offset, gradient, 1);
}

/** f=(p_a−p_b)·v_b−offset。bの点と方向の両方の微分を加える。 */
export function projectedResidual(
  a: TrialGeometry, b: TrialGeometry, v: Vec3, offset: number,
  variables: MateVariableSet, scale: number,
): ScaledResidualRow {
  const span = pointSpan(a, b);
  const gradient = new Map<number, number>();
  pointTerms(gradient, a, v, variables);
  pointTerms(gradient, b, scaleVec3(v, -1), variables);
  directionTerms(gradient, b, v, span, variables);
  return scaledResidual(dotVec3(span, v) - offset, gradient, scale);
}
