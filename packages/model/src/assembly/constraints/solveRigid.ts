/** 剛体用LMの受理/棄却。基準の更新はこのdriverだけで行う(P7 §2.5.6)。 */
import {
  CONSTRAINT_INITIAL_DAMPING, CONSTRAINT_MAX_DAMPING, CONSTRAINT_MAX_ITERATIONS,
  CONSTRAINT_MIN_DAMPING, CONSTRAINT_STEP_TOLERANCE, DAMPING_ATTEMPT_LIMIT,
  eliminate, solveLeastSquares, type LinearizedRow,
} from '../../sketch/constraints/solve.js';

export type RigidSolveStopReason =
  | 'converged' | 'iterationLimit' | 'stalled' | 'provenConstantConflict' | 'suspectedConflict';

export interface RigidResidualRow extends LinearizedRow {
  /** valueとgradientには適用済み。二重には掛けない。 */
  readonly scale: number;
  readonly unit: 'length' | 'angle';
  /** 生の式の許容。cos(theta)など角度そのものではない行で指定する。 */
  readonly tolerance?: number;
  /** 構造的に動かせない行だけ。ある点のgradient=0は証明にならない。 */
  readonly constant?: boolean;
}

export interface RigidEvaluation {
  readonly rows: readonly RigidResidualRow[];
  readonly branchViolations?: readonly string[];
  /** 動かせない対象間の分岐違反など、呼び手が構造から証明したもの。 */
  readonly constantConflict?: boolean;
  /** 行を作れなかった対象があればfalse。消えた行による見せかけの改善を断る。 */
  readonly valid?: boolean;
}

export interface RigidSolveOptions {
  readonly characteristicLength?: number;
  readonly lengthTolerance?: number;
  readonly angleTolerance?: number;
  readonly maxIterations?: number;
  /** 省略時は時間で打ち切らず、同じ入力の決定性を保つ。 */
  readonly maxTimeMs?: number;
  readonly now?: () => number;
  readonly initialDamping?: number;
  readonly stepTolerance?: number;
  readonly linearSolver?: 'auto' | 'normal' | 'qr';
}

export interface RigidSolveInput<Base> {
  readonly initial: Base;
  /** Δt/L₀の列はlength、Δωの列はangle。 */
  readonly variables: readonly ('length' | 'angle')[];
  readonly evaluate: (base: Base, increments: readonly number[]) => RigidEvaluation;
  /** 純関数。呼ぶのは受理する候補だけ。 */
  readonly retract: (base: Base, increments: readonly number[]) => Base;
  /** 明示反転の離れた分岐への候補。基準を変えずに評価し、違反が減った候補だけ受理。 */
  readonly branchCandidates?: (base: Base, violations: readonly string[]) => readonly (readonly number[])[];
  readonly options?: RigidSolveOptions;
}

export interface RigidIterationRecord {
  readonly iteration: number;
  readonly attempt: number;
  readonly damping: number;
  readonly accepted: boolean;
  readonly residualNorm: number;
  readonly trialResidualNorm: number;
  readonly stepSize: number;
  readonly linearSolver: 'normal' | 'qr' | 'branch';
}

export interface RigidSolveOutcome<Base> {
  readonly base: Base;
  readonly converged: boolean;
  /** LMの外側の反復数。棄却候補の数はtraceに残る。 */
  readonly iterations: number;
  /** 行尺度を適用済みの ‖f‖₂ と ‖f‖∞。 */
  readonly residualNorm: number;
  readonly maxResidual: number;
  readonly stop: RigidSolveStopReason;
  readonly limit: 'iterations' | 'time' | null;
  readonly damping: number;
  readonly trace: readonly RigidIterationRecord[];
  readonly evaluation: RigidEvaluation;
}

export const DEFAULT_RIGID_LENGTH_TOLERANCE = 1e-9;
export const DEFAULT_RIGID_ANGLE_TOLERANCE = 1e-9;
export const DEFAULT_RIGID_CHARACTERISTIC_LENGTH = 100;

function rowTolerance(row: RigidResidualRow, options: RigidSolveOptions): number {
  return row.scale * (row.tolerance ?? (row.unit === 'length'
    ? options.lengthTolerance ?? DEFAULT_RIGID_LENGTH_TOLERANCE
    : Math.sin(options.angleTolerance ?? DEFAULT_RIGID_ANGLE_TOLERANCE)));
}

function rowWeight(row: RigidResidualRow, options: RigidSolveOptions): number {
  // 許容の比だけで重み付けする。1/tolを直に掛けて1e18の正規方程式を作らない。
  return (options.angleTolerance ?? DEFAULT_RIGID_ANGLE_TOLERANCE) / rowTolerance(row, options);
}

function columnScales(variables: RigidSolveInput<unknown>['variables'], options: RigidSolveOptions): number[] {
  return variables.map((unit) => unit === 'length'
    ? options.characteristicLength ?? DEFAULT_RIGID_CHARACTERISTIC_LENGTH : 1);
}

/** 診断にも同じWと列尺度を使う。row.scaleは既に適用済み。 */
export function scaledRigidJacobian(
  rows: readonly RigidResidualRow[], variables: RigidSolveInput<unknown>['variables'],
  options: RigidSolveOptions = {},
): number[][] {
  const scales = columnScales(variables, options);
  return rows.map((row) => {
    const result = new Array<number>(variables.length).fill(0);
    const weight = rowWeight(row, options);
    for (const [column, value] of row.gradient) result[column] = value * weight * scales[column];
    return result;
  });
}

function measure(evaluation: RigidEvaluation, options: RigidSolveOptions) {
  let sum = 0;
  let weightedSum = 0;
  let max = 0;
  let satisfied = evaluation.valid !== false && (evaluation.branchViolations?.length ?? 0) === 0;
  let constantConflict = evaluation.constantConflict === true;
  for (const row of evaluation.rows) {
    const tolerance = rowTolerance(row, options);
    const finite = Number.isFinite(row.value) && Number.isFinite(tolerance) && tolerance > 0;
    const good = finite && Math.abs(row.value) < tolerance;
    satisfied = satisfied && good;
    constantConflict ||= row.constant === true && finite && !good;
    sum += row.value * row.value;
    weightedSum += (row.value * rowWeight(row, options)) ** 2;
    max = Math.max(max, Math.abs(row.value));
  }
  return { norm: Math.sqrt(sum), weightedSum, max, satisfied, constantConflict };
}

/**
 * (J_sᵀ W²J_s + λD²)z = −J_sᵀW²r、Δ = columnScale*z。
 * Dで列を平衡化してから既存の消去法を呼ぶ。QRも同じ問題の
 * [WJ_s D⁻¹; √λ I] y = [−Wr;0] を解くので、切替で目的を変えない。
 */
export function solveRigid<Base>(input: RigidSolveInput<Base>): RigidSolveOutcome<Base> {
  const options = input.options ?? {};
  const n = input.variables.length;
  const scales = columnScales(input.variables, options);
  const zero = new Array<number>(n).fill(0);
  const trace: RigidIterationRecord[] = [];
  const now = options.now ?? (() => performance.now());
  const start = options.maxTimeMs === undefined ? 0 : now();
  const expired = () => options.maxTimeMs !== undefined && now() - start >= options.maxTimeMs;
  const maxIterations = Math.max(0, Math.trunc(options.maxIterations ?? CONSTRAINT_MAX_ITERATIONS));
  let damping = Math.max(CONSTRAINT_MIN_DAMPING, options.initialDamping ?? CONSTRAINT_INITIAL_DAMPING);
  let base = input.initial;
  let evaluation = input.evaluate(base, zero);
  let current = measure(evaluation, options);
  const finish = (stop: RigidSolveStopReason, iterations: number,
    limit: RigidSolveOutcome<Base>['limit'] = null): RigidSolveOutcome<Base> => ({
    base, converged: stop === 'converged', iterations, residualNorm: current.norm,
    maxResidual: current.max, stop, limit, damping, trace, evaluation,
  });
  if (current.constantConflict) return finish('provenConstantConflict', 0);
  if (current.satisfied) return finish('converged', 0);
  if (evaluation.valid === false || !Number.isFinite(current.weightedSum)
    || scales.some((scale) => !Number.isFinite(scale) || scale <= 0)) return finish('stalled', 0);

  const normal = new Float64Array(n * n);
  const gradient = new Float64Array(n);
  const diagonal = new Float64Array(n);
  const work = new Float64Array(n * n);
  const rhs = new Float64Array(n);
  let madeProgress = false;
  const stopped = (): RigidSolveStopReason => madeProgress ? 'suspectedConflict' : 'stalled';

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    if (expired()) return finish('iterationLimit', iteration - 1, 'time');
    const branches = evaluation.branchViolations ?? [];
    if (branches.length > 0 && input.branchCandidates !== undefined) {
      let accepted = false;
      let attempt = 0;
      for (const step of input.branchCandidates(base, branches)) {
        if (expired()) return finish('iterationLimit', iteration - 1, 'time');
        attempt += 1;
        if (step.length !== n || !step.every(Number.isFinite)) continue;
        const trialEvaluation = input.evaluate(base, step);
        const trial = measure(trialEvaluation, options);
        // 分岐は離散条件。まず違反数、同じ分岐では残差の二乗和を減らす。
        accepted = trialEvaluation.valid !== false && trialEvaluation.rows.length === evaluation.rows.length
          && Number.isFinite(trial.weightedSum)
          && (trialEvaluation.branchViolations?.length ?? 0) < branches.length;
        trace.push({ iteration, attempt, damping, accepted, residualNorm: current.norm,
          trialResidualNorm: trial.norm, stepSize: Math.max(0, ...step.map((v, j) => Math.abs(v / scales[j]))),
          linearSolver: 'branch' });
        if (accepted) {
          base = input.retract(base, step);
          evaluation = input.evaluate(base, zero);
          current = measure(evaluation, options);
          madeProgress = true;
          break;
        }
      }
      if (accepted) {
        if (current.satisfied) return finish('converged', iteration);
        continue;
      }
    }

    normal.fill(0);
    gradient.fill(0);
    for (const row of evaluation.rows) {
      const weight = rowWeight(row, options);
      const entries = [...row.gradient].map(([j, value]) => [j, value * scales[j] * weight] as const);
      for (const [j, gj] of entries) {
        gradient[j] += gj * row.value * weight;
        for (const [k, gk] of entries) normal[j * n + k] += gj * gk;
      }
    }
    let smallest = Infinity;
    let largest = 0;
    for (let j = 0; j < n; j += 1) {
      const value = normal[j * n + j];
      if (value > 0) { smallest = Math.min(smallest, value); largest = Math.max(largest, value); }
      diagonal[j] = value > 0 ? Math.sqrt(value) : 1;
    }
    let illConditioned = largest / smallest > 1e12;
    // ほぼ同じ列の桁落ちを、正規方程式を解く前に検出する。
    for (let j = 0; j < n && !illConditioned; j += 1) {
      for (let k = j + 1; k < n; k += 1) {
        const correlation = Math.abs(normal[j * n + k] / (diagonal[j] * diagonal[k]));
        if (correlation > 1 - 1e-8 && correlation < 1 - 1e-14) { illConditioned = true; break; }
      }
    }
    let accepted = false;
    for (let attempt = 1; attempt <= DAMPING_ATTEMPT_LIMIT; attempt += 1) {
      if (expired()) return finish('iterationLimit', iteration - 1, 'time');
      let linearSolver: 'normal' | 'qr' = options.linearSolver === 'qr'
        || (options.linearSolver !== 'normal' && illConditioned) ? 'qr' : 'normal';
      let solved: readonly number[] | Float64Array | null = null;
      if (linearSolver === 'normal') {
        for (let j = 0; j < n; j += 1) {
          rhs[j] = -gradient[j] / diagonal[j];
          for (let k = 0; k < n; k += 1) work[j * n + k] = normal[j * n + k] / (diagonal[j] * diagonal[k]);
          work[j * n + j] += damping;
        }
        solved = eliminate(work, rhs, n);
      }
      if (solved === null) {
        linearSolver = 'qr';
        const matrix = scaledRigidJacobian(evaluation.rows, input.variables, options)
          .map((row) => row.map((value, j) => value / diagonal[j]));
        const right = evaluation.rows.map((row) => -row.value * rowWeight(row, options));
        for (let j = 0; j < n; j += 1) {
          const row = new Array<number>(n).fill(0);
          row[j] = Math.sqrt(damping);
          matrix.push(row);
          right.push(0);
        }
        solved = solveLeastSquares(matrix, right, n);
      }
      const step = solved === null ? null : Array.from(solved, (value, j) => value * scales[j] / diagonal[j]);
      const stepSize = step === null ? 0 : Math.max(0, ...step.map((value, j) => Math.abs(value / scales[j])));
      const trialEvaluation = step === null ? null : input.evaluate(base, step);
      const trial = trialEvaluation === null ? null : measure(trialEvaluation, options);
      accepted = trial !== null && trialEvaluation !== null && trialEvaluation.valid !== false
        && trialEvaluation.rows.length === evaluation.rows.length
        && (trialEvaluation.branchViolations?.length ?? 0) <= branches.length
        && Number.isFinite(trial.weightedSum) && trial.weightedSum < current.weightedSum;
      trace.push({ iteration, attempt, damping, accepted, residualNorm: current.norm,
        trialResidualNorm: trial?.norm ?? Infinity, stepSize, linearSolver });
      if (accepted && step !== null) {
        base = input.retract(base, step);
        evaluation = input.evaluate(base, zero);
        current = measure(evaluation, options);
        madeProgress = true;
        damping = Math.max(CONSTRAINT_MIN_DAMPING, damping / 3);
        if (current.constantConflict) return finish('provenConstantConflict', iteration);
        if (current.satisfied) return finish('converged', iteration);
        if (evaluation.valid === false || !Number.isFinite(current.weightedSum)) return finish('stalled', iteration);
        if (stepSize < (options.stepTolerance ?? CONSTRAINT_STEP_TOLERANCE)) return finish(stopped(), iteration);
        break;
      }
      if (step !== null && stepSize < (options.stepTolerance ?? CONSTRAINT_STEP_TOLERANCE)) return finish(stopped(), iteration);
      damping *= 3;
      if (damping > CONSTRAINT_MAX_DAMPING) return finish(stopped(), iteration);
    }
    if (!accepted) return finish(stopped(), iteration);
  }
  return finish('iterationLimit', maxIterations, 'iterations');
}
