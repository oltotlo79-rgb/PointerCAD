/** P7-18: temporary position objective, followed by the existing hard-only LM. */
import {
  CONSTRAINT_INITIAL_DAMPING, CONSTRAINT_MAX_DAMPING, CONSTRAINT_STEP_TOLERANCE,
  qrDecomposition, RANK_RELATIVE_TOLERANCE,
} from '../../sketch/constraints/solve.js';
import { DRAG_PIN_WEIGHT } from '../../sketch/constraints/solveSketch.js';
import { crossVec3, type Vec3 } from '../../sketch/vec3.js';
import { exponentialMap, multiplyQuaternion, normalizeQuaternion, rotateVector, type RigidPlacement } from '../placementMath.js';
import type { MateVariableSet } from './mateVariables.js';
import { rotationDerivativeAxes } from './rigidResidualGeometry.js';
import {
  DEFAULT_RIGID_CHARACTERISTIC_LENGTH, DEFAULT_RIGID_LENGTH_TOLERANCE, DEFAULT_RIGID_ANGLE_TOLERANCE,
  rigidRowTolerance, scaledRigidJacobian, solveRigid, type RigidEvaluation, type RigidIterationRecord,
  type RigidResidualRow, type RigidSolveInput, type RigidSolveOptions,
} from './solveRigid.js';

type Placements = ReadonlyMap<string, RigidPlacement>;
/** 拘束面から遠い候補が棄却された後、3倍を12回繰り返さず安全な縮小値へ直接進む。 */
const DRAG_REJECTION_DAMPING_FLOOR = 1;
export interface PreparedMateDrag {
  readonly componentId: string;
  /**
   * 引く点の変数を持つ部品。互いに固定した組の部品を引くときは組の代表(`rigidGroups.ts`)で、
   * `componentId` の位置は代表の変数で動く。省略は `componentId` と同じ。
   */
  readonly variableComponentId?: string;
  readonly initial: Placements;
  readonly initialEvaluation: RigidEvaluation;
  readonly variableSet: MateVariableSet;
  readonly variables: readonly ('length' | 'angle')[];
  readonly options: RigidSolveOptions;
  /** All frames retain these local targets; only the accepted placements change. */
  readonly evaluate: RigidSolveInput<Placements>['evaluate'];
  readonly retract: RigidSolveInput<Placements>['retract'];
  readonly branchCandidates: NonNullable<RigidSolveInput<Placements>['branchCandidates']>;
}
export interface MateDragOptions {
  readonly phase: 'frame' | 'release';
  /** Last published hard-satisfied overlay. Omission starts from the drag snapshot. */
  readonly placements?: Placements;
  readonly maxIterations?: number;
  readonly maxTimeMs?: number;
  readonly now?: () => number;
  readonly shouldCancel?: () => boolean;
}
export type MateDragStop = 'targetReached' | 'stationary' | 'iterationLimit' | 'timeLimit'
  | 'cancelled' | 'invalidInput' | 'initialUnsatisfied' | 'numericalFailure' | 'dampingLimit' | 'stalled';
export interface MateDragCounts {
  softIterations: number;
  projectionIterations: number;
  totalIterations: number;
  linearTrials: number;
  qrFallbacks: number;
  evaluations: number;
  retractions: number;
  rejectedCandidates: number;
}
export interface MateDragTrace {
  readonly phase: 'soft' | 'projection';
  readonly cycle: number;
  readonly record: RigidIterationRecord;
}
export interface MateDragOutcome {
  readonly placements: Placements;
  readonly hardEvaluation: RigidEvaluation;
  readonly hardSatisfied: boolean;
  readonly driverError: number;
  readonly driverSquaredError: number;
  readonly stop: MateDragStop;
  readonly committable: boolean;
  readonly variableCount: number;
  /** A drag never reports the rank of its soft rows as hard constraint rank. */
  readonly rank: null;
  readonly counts: Readonly<MateDragCounts>;
  readonly trace: readonly MateDragTrace[];
}

/** Own dense indices are required: Array.every alone silently accepts holes. */
export function finiteDragVector(value: readonly number[], length: number): boolean {
  if (!Array.isArray(value) || value.length !== length) return false;
  for (let i = 0; i < length; i += 1) {
    if (!Object.hasOwn(value, i) || !Number.isFinite(value[i])) return false;
  }
  return true;
}
export function validDragPlacement(value: RigidPlacement): boolean {
  if (!finiteDragVector(value.position, 3) || !finiteDragVector(value.rotation, 4)) return false;
  const norm = Math.hypot(...value.rotation);
  return Number.isFinite(norm) && norm > 1e-12;
}
export function hardDragSatisfied(evaluation: RigidEvaluation, options: RigidSolveOptions): boolean {
  return evaluation.valid !== false && evaluation.constantConflict !== true
    && (evaluation.branchViolations?.length ?? 0) === 0
    && evaluation.rows.every((row) => {
      const tolerance = rigidRowTolerance(row, options);
      return Number.isFinite(row.value) && Number.isFinite(tolerance) && tolerance > 0
        && Math.abs(row.value) < tolerance;
    });
}

/** Validate the arithmetic consumed by LM, not just its unweighted input numbers. */
export function validDragEvaluation(
  evaluation: RigidEvaluation, variables: readonly ('length' | 'angle')[], options: RigidSolveOptions,
): boolean {
  if (evaluation.valid === false) return false;
  const norms = new Array<number>(variables.length).fill(0);
  const length = options.characteristicLength ?? DEFAULT_RIGID_CHARACTERISTIC_LENGTH;
  let objective = 0;
  for (const row of evaluation.rows) {
    const tolerance = rigidRowTolerance(row, options);
    if (!Number.isFinite(row.value) || !Number.isFinite(row.scale) || row.scale <= 0
      || !Number.isFinite(tolerance) || tolerance <= 0) return false;
    const weight = (options.angleTolerance ?? DEFAULT_RIGID_ANGLE_TOLERANCE) / tolerance;
    const residual = row.value * weight;
    objective += residual * residual;
    if (!Number.isFinite(weight) || !Number.isFinite(objective)) return false;
    for (const [index, value] of row.gradient) {
      if (!Number.isInteger(index) || index < 0 || index >= variables.length || !Number.isFinite(value)) return false;
      const scaled = value * (variables[index] === 'length' ? length : 1) * weight;
      const square = scaled * scaled;
      if (!Number.isFinite(square) || (value !== 0 && square === 0)) return false;
      norms[index] += square;
      if (!Number.isFinite(norms[index])) return false;
    }
  }
  return true;
}

/** The weight belongs to value/gradient, never to row.scale (which would cancel it). */
export function mateDragRows(
  position: Vec3, target: Vec3, columns: readonly [number, number, number], length: number,
  weight = DRAG_PIN_WEIGHT,
  gradients?: readonly ReadonlyMap<number, number>[],
): readonly RigidResidualRow[] {
  return columns.map((column, axis) => ({ unit: 'length', scale: 1 / length,
    value: weight * (position[axis] - target[axis]) / length,
    gradient: gradients?.[axis] ?? new Map([[column, weight / length]]) }));
}

class DragInterrupted extends Error {
  constructor(readonly reason: 'cancelled' | 'timeLimit' | 'numericalFailure') { super(reason); }
}

function errorAt(placements: Placements, componentId: string, target: Vec3) {
  const position = placements.get(componentId)?.position;
  if (position === undefined) return { max: Infinity, squared: Infinity };
  const error = position.map((value, axis) => value - target[axis]);
  if (!error.every(Number.isFinite)) return { max: Infinity, squared: Infinity };
  return { max: Math.max(...error.map(Math.abs)), squared: error.reduce((sum, value) => sum + value * value, 0) };
}
/** Difference of squares, before summing: a large blocked axis must not erase a small free-axis improvement. */
function objectiveImprovement(before: Placements, after: Placements, componentId: string, target: Vec3): number {
  const a = before.get(componentId)?.position, b = after.get(componentId)?.position;
  if (a === undefined || b === undefined) return NaN;
  let improvement = 0;
  for (let axis = 0; axis < 3; axis += 1) improvement += (a[axis] - b[axis]) * ((a[axis] - target[axis]) + (b[axis] - target[axis]));
  return improvement;
}
function poseDistance(a: Placements, b: Placements, ids: readonly string[], length: number): number {
  let distance = 0;
  for (const id of ids) {
    const before = a.get(id), after = b.get(id);
    if (before === undefined || after === undefined) return Infinity;
    for (let axis = 0; axis < 3; axis += 1) distance = Math.max(distance, Math.abs(after.position[axis] - before.position[axis]) / length);
    const [x, y, z, w] = before.rotation;
    const relative = multiplyQuaternion(after.rotation, [-x, -y, -z, w]);
    distance = Math.max(distance, 2 * Math.atan2(Math.hypot(relative[0], relative[1], relative[2]), Math.abs(relative[3])));
  }
  return distance;
}

/** Apply Q or Q-transpose from the existing Householder QR, without building a dense Q. */
function reflectDragVector(vector: number[], reflectors: readonly (readonly number[])[], transpose: boolean): void {
  for (let index = 0; index < reflectors.length; index += 1) {
    const reflector = reflectors[transpose ? index : reflectors.length - 1 - index];
    let dot = 0;
    for (let axis = 0; axis < vector.length; axis += 1) dot += reflector[axis] * vector[axis];
    for (let axis = 0; axis < vector.length; axis += 1) vector[axis] -= 2 * dot * reflector[axis];
  }
}

/** The same world-space member position and exponential-map derivative as the representative's retraction. */
function driverDragPoint(drag: PreparedMateDrag, placements: Placements, increments: readonly number[],
  columns: readonly [number, number, number], length: number):
  { readonly point: Vec3; readonly gradients: readonly ReadonlyMap<number, number>[] } {
  const representative = drag.variableComponentId ?? drag.componentId;
  const position = placements.get(drag.componentId)?.position, center = placements.get(representative)?.position;
  if (position === undefined || center === undefined) throw new DragInterrupted('numericalFailure');
  const arm: Vec3 = [position[0] - center[0], position[1] - center[1], position[2] - center[2]];
  const rotations = (['rx', 'ry', 'rz'] as const).map(axis => drag.variableSet.columnOf(representative, axis));
  const angle = (axis: number): number => rotations[axis] === null ? 0 : increments[rotations[axis]];
  const omega: Vec3 = [angle(0), angle(1), angle(2)];
  const trialArm = omega.every(value => value === 0) ? arm : rotateVector(exponentialMap(omega), arm);
  const point: Vec3 = [position[0] + increments[columns[0]] + (trialArm[0] - arm[0]),
    position[1] + increments[columns[1]] + (trialArm[1] - arm[1]),
    position[2] + increments[columns[2]] + (trialArm[2] - arm[2])];
  const gradients = columns.map(column => new Map([[column, DRAG_PIN_WEIGHT / length]]));
  const axes = rotationDerivativeAxes(omega);
  for (let axis = 0; axis < 3; axis += 1) {
    const column = rotations[axis];
    if (column === null) continue;
    const derivative = crossVec3(axes[axis], trialArm);
    for (let row = 0; row < 3; row += 1) {
      if (derivative[row] !== 0) gradients[row].set(column, DRAG_PIN_WEIGHT * derivative[row] / length);
    }
  }
  if (!finiteDragVector(point, 3) || !finiteDragVector(arm, 3)) throw new DragInterrupted('numericalFailure');
  return { point, gradients };
}

/**
 * At a feasible pose, only the component of the position error in range(C ker J) can decrease to first order.
 * J uses the existing hard-row/variable scales; C includes a rigid member's angular arm. Removing the
 * orthogonal error from the soft target prevents a blocked camera-plane Z from repeatedly tilting the mechanism
 * and then being undone by hard projection. Acceptance still compares the original position objective.
 */
function tangentDragTarget(drag: PreparedMateDrag, evaluation: RigidEvaluation, placements: Placements,
  gradients: readonly ReadonlyMap<number, number>[], target: Vec3, length: number): Vec3 {
  if (evaluation.rows.length === 0) return target;
  const rows = scaledRigidJacobian(evaluation.rows, drag.variables, drag.options);
  const transposed = drag.variables.map((_unit, column) => rows.map(row => row[column]));
  const hard = qrDecomposition(transposed, rows.length);
  if (!hard.diagonal.every(Number.isFinite) || !hard.reflectors.every(row => row.every(Number.isFinite))) {
    throw new DragInterrupted('numericalFailure');
  }
  // B = C Q_null, not its Gram matrix: squaring the singular values would change the existing rank cutoff.
  // Only three C rows and their Q-transformed tails are needed, never a dense nullspace basis.
  const driver = gradients.map(row => drag.variables.map((unit, column) =>
    (row.get(column) ?? 0) * (unit === 'length' ? length : 1) / DRAG_PIN_WEIGHT));
  const mobility = driver.map(row => {
    const vector = [...row];
    reflectDragVector(vector, hard.reflectors, true);
    return vector.slice(hard.rank);
  });
  const nullity = drag.variables.length - hard.rank;
  // A tiny tail can be QR roundoff rather than mobility. Do not declare it zero or invent a physical tolerance:
  // use the existing relative rank scale to fall back conservatively to the original target.
  const driverNorm = Math.max(...driver.map(row => Math.hypot(...row)));
  const mobilityNorm = Math.max(...mobility.map(row => Math.hypot(...row)));
  if (nullity > 0 && mobilityNorm <= RANK_RELATIVE_TOLERANCE * driverNorm) return target;
  const reachable = qrDecomposition(mobility, nullity);
  if (!reachable.diagonal.every(Number.isFinite) || !reachable.reflectors.every(row => row.every(Number.isFinite))) {
    throw new DragInterrupted('numericalFailure');
  }
  if (reachable.rank === 3) return target;
  const position = placements.get(drag.componentId)?.position;
  if (position === undefined) throw new DragInterrupted('numericalFailure');
  const error = position.map((value, axis) => value - target[axis]);
  reflectDragVector(error, reachable.reflectors, true);
  error.fill(0, reachable.rank);
  reflectDragVector(error, reachable.reflectors, false);
  const result: Vec3 = [position[0] - error[0], position[1] - error[1], position[2] - error[2]];
  if (!finiteDragVector(result, 3)) throw new DragInterrupted('numericalFailure');
  return result;
}

/** Pure synchronous request. Nothing is saved; rejected candidates never become warm starts. */
export function solveMateDrag(drag: PreparedMateDrag, target: Vec3, request: MateDragOptions): MateDragOutcome {
  const counts: MateDragCounts = { softIterations: 0, projectionIterations: 0, totalIterations: 0,
    linearTrials: 0, qrFallbacks: 0, evaluations: 0, retractions: 0, rejectedCandidates: 0 };
  const trace: MateDragTrace[] = [];
  let accepted = drag.initial;
  let acceptedEvaluation = drag.initialEvaluation;
  let stop: MateDragStop = 'iterationLimit';
  let warmStart = drag.initial;
  const finish = (): MateDragOutcome => {
    const error = errorAt(accepted, drag.componentId, target);
    const hardSatisfied = hardDragSatisfied(acceptedEvaluation, drag.options);
    return { placements: accepted, hardEvaluation: acceptedEvaluation, hardSatisfied,
      driverError: error.max, driverSquaredError: error.squared, stop,
      committable: request.phase === 'release' && hardSatisfied && (stop === 'targetReached' || stop === 'stationary'),
      variableCount: drag.variables.length, rank: null, counts, trace };
  };
  if (request.shouldCancel?.()) { stop = 'cancelled'; return finish(); }
  const ceiling = request.phase === 'frame' ? 5 : 50;
  const budget = request.maxIterations ?? ceiling;
  if (!finiteDragVector(target, 3) || (request.phase !== 'frame' && request.phase !== 'release')
    || !Number.isInteger(budget) || budget < 0 || budget > ceiling
    || (request.maxTimeMs !== undefined && (!Number.isFinite(request.maxTimeMs) || request.maxTimeMs < 0))) {
    stop = 'invalidInput'; return finish();
  }
  if (request.placements !== undefined) {
    const moving = new Set(drag.variableSet.movableComponentIds);
    const warm = new Map<string, RigidPlacement>();
    for (const [id, original] of drag.initial) {
      const placement = request.placements.get(id);
      if (placement === undefined || !validDragPlacement(placement)
        || (!moving.has(id) && (placement.position.some((v, i) => v !== original.position[i])
          || placement.rotation.some((v, i) => v !== original.rotation[i])))) {
        stop = 'invalidInput'; return finish();
      }
      warm.set(id, moving.has(id) ? { position: [...placement.position], rotation: normalizeQuaternion(placement.rotation) } : original);
    }
    warmStart = warm;
  }
  if (!Number.isFinite(errorAt(warmStart, drag.componentId, target).squared)) {
    accepted = drag.initial; stop = 'invalidInput'; return finish();
  }
  const length = drag.options.characteristicLength ?? DEFAULT_RIGID_CHARACTERISTIC_LENGTH;
  const tolerance = drag.options.lengthTolerance ?? DEFAULT_RIGID_LENGTH_TOLERANCE;
  // The position prior has the same physical scale as the actual pin, independently of L.
  // Rotation uses radians. A surface's arbitrary reference-point lever is not a pose prior.
  const translationCeiling = DRAG_PIN_WEIGHT * (drag.options.angleTolerance ?? DEFAULT_RIGID_ANGLE_TOLERANCE) / tolerance * length;
  const dampingCeilings = drag.variables.map((unit) => unit === 'length' ? translationCeiling : 1);
  if (!Number.isFinite(translationCeiling) || translationCeiling <= 0) { stop = 'invalidInput'; return finish(); }
  const zero = new Array<number>(drag.variables.length).fill(0);
  const now = request.now ?? (() => performance.now());
  const started = request.maxTimeMs === undefined ? 0 : now();
  const interrupt = (checkTime = true): void => {
    if (request.shouldCancel?.()) throw new DragInterrupted('cancelled');
    if (checkTime && request.maxTimeMs !== undefined && now() - started >= request.maxTimeMs) throw new DragInterrupted('timeLimit');
  };
  const evaluateHard = (base: Placements, increments: readonly number[], checkTime = true): RigidEvaluation => {
    interrupt(checkTime);
    if (!finiteDragVector(increments, drag.variables.length)) throw new DragInterrupted('numericalFailure');
    counts.evaluations += 1;
    const evaluation = drag.evaluate(base, increments);
    if (evaluation.rows.length !== drag.initialEvaluation.rows.length
      || !validDragEvaluation(evaluation, drag.variables, drag.options)) throw new DragInterrupted('numericalFailure');
    return evaluation;
  };
  const retract = (base: Placements, increments: readonly number[]): Placements => {
    interrupt();
    if (!finiteDragVector(increments, drag.variables.length)) throw new DragInterrupted('numericalFailure');
    counts.retractions += 1;
    const result = drag.retract(base, increments);
    if (![...result.values()].every(validDragPlacement)) throw new DragInterrupted('numericalFailure');
    return result;
  };
  let cycle = 0;
  let projectionStep: number | null = null;
  const observer = (phase: 'soft' | 'projection'): NonNullable<RigidSolveInput<Placements>['observer']> => ({
    iterationStarted: () => {
      counts.totalIterations += 1;
      if (phase === 'soft') counts.softIterations += 1; else counts.projectionIterations += 1;
      interrupt();
    },
    linearSolve: (_solver, fallback) => { counts.linearTrials += 1; if (fallback) counts.qrFallbacks += 1; interrupt(); },
    trial: (record) => {
      trace.push({ phase, cycle, record });
      if (phase === 'projection' && record.accepted) projectionStep = record.stepSize;
    },
  });
  let softDamping = CONSTRAINT_INITIAL_DAMPING;
  let projectionDamping = CONSTRAINT_INITIAL_DAMPING;
  try {
    // Even a zero iteration request checks the actual hard rows. Time is checked after this mandatory evaluation.
    const warmEvaluation = evaluateHard(warmStart, zero, false);
    if (!hardDragSatisfied(warmEvaluation, drag.options)) {
      stop = 'initialUnsatisfied'; return finish();
    }
    accepted = warmStart;
    acceptedEvaluation = warmEvaluation;
    interrupt();
    const columns = ['tx', 'ty', 'tz'].map((axis) =>
      drag.variableSet.variables.findIndex((variable) => variable.componentId === (drag.variableComponentId ?? drag.componentId)
        && variable.axis === axis));
    if (columns.some((column) => column < 0)) throw new DragInterrupted('numericalFailure');
    const driverColumns: [number, number, number] = [columns[0], columns[1], columns[2]];
    while (counts.totalIterations < budget) {
      const beforeError = errorAt(accepted, drag.componentId, target);
      if (beforeError.max < tolerance) { stop = 'targetReached'; break; }
      const hardRows = acceptedEvaluation.rows.length;
      if (hardRows > 0 && budget - counts.totalIterations < 2) break;
      cycle += 1;
      const previousDamping = softDamping;
      const driver = driverDragPoint(drag, accepted, zero, driverColumns, length);
      const softTarget = tangentDragTarget(drag, acceptedEvaluation, accepted, driver.gradients, target, length);
      interrupt();
      const soft = solveRigid({ initial: accepted, variables: drag.variables, retract,
        preserveZeroColumns: true, dampingCeilings,
        branchCandidates: drag.branchCandidates, observer: observer('soft'),
        canConverge: (base) => errorAt(base, drag.componentId, softTarget).max < tolerance,
        evaluate: (base, increments) => {
          const evaluation = evaluateHard(base, increments);
          const trial = driverDragPoint(drag, base, increments, driverColumns, length);
          const rows = mateDragRows(trial.point, softTarget, driverColumns, length, DRAG_PIN_WEIGHT, trial.gradients);
          const combined = { ...evaluation, rows: [...evaluation.rows, ...rows] };
          if (!validDragEvaluation(combined, drag.variables, drag.options)) throw new DragInterrupted('numericalFailure');
          return combined;
        }, options: { ...drag.options, maxIterations: 1, initialDamping: softDamping,
          rejectionDampingFloor: DRAG_REJECTION_DAMPING_FLOOR } });
      softDamping = soft.damping;
      // A stalled soft solve alone is not evidence of a completed projected stationary step.
      if (!soft.converged && !soft.trace.some((record) => record.accepted)) { stop = 'stalled'; break; }
      projectionStep = null;
      const projected = solveRigid({ initial: soft.base, variables: drag.variables, evaluate: evaluateHard, retract,
        preserveZeroColumns: true, dampingCeilings,
        branchCandidates: drag.branchCandidates, observer: observer('projection'),
        // A loose hard residual can falsely improve the drag objective and block the next tangential step.
        // Finish a started projection at the existing step precision; an already valid start needs no work.
        canConverge: (_base, evaluation) => projectionStep === null || projectionStep <= CONSTRAINT_STEP_TOLERANCE
          || evaluation.rows.every((row) => row.value === 0),
        options: { ...drag.options, maxIterations: Math.min(4, budget - counts.totalIterations), initialDamping: projectionDamping } });
      projectionDamping = projected.damping;
      const candidateEvaluation = evaluateHard(projected.base, zero);
      const error = errorAt(projected.base, drag.componentId, target);
      const improvement = objectiveImprovement(accepted, projected.base, drag.componentId, target);
      // Feasibility is proved by the actual hard rows, even when the optional settling work uses its budget.
      const good = hardDragSatisfied(candidateEvaluation, drag.options) && Number.isFinite(error.squared);
      const settled = projected.converged || (projected.trace.at(-1)?.stepSize ?? Infinity) <= CONSTRAINT_STEP_TOLERANCE;
      if (good && Number.isFinite(improvement) && improvement > 0) {
        accepted = projected.base; acceptedEvaluation = candidateEvaluation;
        if (error.max < tolerance) { stop = 'targetReached'; break; }
      } else {
        counts.rejectedCandidates += 1;
        if (good && settled && poseDistance(accepted, projected.base, drag.variableSet.movableComponentIds, length) <= CONSTRAINT_STEP_TOLERANCE) {
          stop = 'stationary'; break;
        }
        softDamping = previousDamping * 3;
      }
      if (softDamping > CONSTRAINT_MAX_DAMPING || projectionDamping > CONSTRAINT_MAX_DAMPING) { stop = 'dampingLimit'; break; }
    }
    acceptedEvaluation = evaluateHard(accepted, zero, false);
    interrupt();
    if (errorAt(accepted, drag.componentId, target).max < tolerance) stop = 'targetReached';
  } catch (error) {
    if (!(error instanceof DragInterrupted)) throw error;
    stop = error.reason;
    // Cancellation does no additional work. A time limit still accounts for the final hard check.
    if (stop === 'timeLimit' && !request.shouldCancel?.()) {
      counts.evaluations += 1;
      acceptedEvaluation = drag.evaluate(accepted, zero);
    }
  }
  return finish();
}
