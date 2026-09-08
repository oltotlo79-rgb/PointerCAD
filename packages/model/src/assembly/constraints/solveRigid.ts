/** 剛体用LMの受理/棄却。基準の更新はこのdriverだけで行う(P7 §2.5.6)。 */
import {
  CONSTRAINT_INITIAL_DAMPING, CONSTRAINT_MAX_DAMPING, CONSTRAINT_MAX_ITERATIONS,
  CONSTRAINT_MIN_DAMPING, CONSTRAINT_STEP_TOLERANCE, DAMPING_ATTEMPT_LIMIT,
  eliminate, qrDecomposition, solveLeastSquares, type LinearizedRow,
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
  /** Opt-in driver convergence, in addition to all existing residual checks. */
  readonly canConverge?: (base: Base, evaluation: RigidEvaluation) => boolean;
  /** Opt-in: an exactly zero Jacobian column has the exact damped solution Δ=0. */
  readonly preserveZeroColumns?: boolean;
  /** Opt-in physical pose metric. Apply the existing null/span protection in this metric, then bound observed-column damping. */
  readonly dampingCeilings?: readonly number[];
  /** Counts started work, including an iteration interrupted before a trial finishes. */
  readonly observer?: {
    readonly iterationStarted: () => void;
    readonly linearSolve: (solver: 'normal' | 'qr', fallback: boolean) => void;
    readonly trial: (record: RigidIterationRecord) => void;
  };
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

/** value/gradientと同じ尺度の許容。solverと表示用診断で判定を共有する。 */
export function rigidRowTolerance(row: RigidResidualRow, options: RigidSolveOptions = {}): number {
  return row.scale * (row.tolerance ?? (row.unit === 'length'
    ? options.lengthTolerance ?? DEFAULT_RIGID_LENGTH_TOLERANCE
    : Math.sin(options.angleTolerance ?? DEFAULT_RIGID_ANGLE_TOLERANCE)));
}

function rowWeight(row: RigidResidualRow, options: RigidSolveOptions): number {
  // 許容の比だけで重み付けする。1/tolを直に掛けて1e18の正規方程式を作らない。
  return (options.angleTolerance ?? DEFAULT_RIGID_ANGLE_TOLERANCE) / rigidRowTolerance(row, options);
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
    const tolerance = rigidRowTolerance(row, options);
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

/** 減衰Dだけを構成する。階数用Jsとnormal/QR切替用の生normは変更しない。 */
function dampingDiagonal(
  rows: readonly RigidResidualRow[], scales: readonly number[], options: RigidSolveOptions,
  columnNorms: Float64Array, diagonal: Float64Array,
): void {
  let largestNorm = 0;
  for (const norm of columnNorms) largestNorm = Math.max(largestNorm, norm);
  const protectedNorm = largestNorm > 0 ? Math.min(1, largestNorm) : 1;
  const weak: number[] = [];
  for (let j = 0; j < columnNorms.length; j += 1) {
    const norm = columnNorms[j];
    // 絶対的に小さい感度も独立なら解に必要。非零列を大きさだけで保護しない。
    diagonal[j] = norm === 0 ? protectedNorm : norm;
    if (norm > 0 && norm < protectedNorm) weak.push(j);
  }
  if (weak.length === 0) return;

  // 元のWJsの列ピボットで、強い独立方向から基底を選ぶ。強列をnorm>=1などの
  // 固定境界で選ぶと、単位法線の正規化だけで必要な列が候補から落ちてしまう。
  const weights = rows.map((row) => rowWeight(row, options));
  const valueAt = (i: number, j: number): number =>
    (rows[i].gradient.get(j) ?? 0) * scales[j] * weights[i];
  const roundoff = 8 * Number.EPSILON * Math.max(1, rows.length, columnNorms.length);
  const qr = qrDecomposition(rows.map((_row, i) => Array.from(columnNorms, (_norm, j) => valueAt(i, j))),
    columnNorms.length, { rankTolerance: roundoff });
  const independent = new Set(qr.columnOrder.slice(0, qr.rank));
  for (const j of weak) {
    if (independent.has(j)) continue;
    const projected = rows.map((_row, i) => valueAt(i, j) / columnNorms[j]);
    // rank判定で落ちた小列も、正規化して独立成分を再確認する。Qᵀを掛けた後の
    // rank以降が基底に表せない成分なので、小さいだけの独立列は生normを保てる。
    for (let k = 0; k < qr.rank; k += 1) {
      const reflector = qr.reflectors[k];
      let dot = 0;
      for (let i = k; i < rows.length; i += 1) dot += reflector[i] * projected[i];
      for (let i = k; i < rows.length; i += 1) projected[i] -= 2 * dot * reflector[i];
    }
    let outsideSquared = 0;
    for (let i = qr.rank; i < rows.length; i += 1) outsideSquared += projected[i] ** 2;
    if (Math.sqrt(outsideSquared) <= roundoff) diagonal[j] = protectedNorm;
  }
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
  const dampingCeilings = input.dampingCeilings;
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
  if (dampingCeilings !== undefined && (dampingCeilings.length !== n
    || Array.from(dampingCeilings).some((value, index) => !Object.hasOwn(dampingCeilings, index)
      || !Number.isFinite(value) || value <= 0))) return finish('stalled', 0);
  if (current.constantConflict) return finish('provenConstantConflict', 0);
  if (current.satisfied && (input.canConverge?.(base, evaluation) ?? true)) return finish('converged', 0);
  if (evaluation.valid === false || !Number.isFinite(current.weightedSum)
    || scales.some((scale) => !Number.isFinite(scale) || scale <= 0)) return finish('stalled', 0);

  const normal = new Float64Array(n * n);
  const gradient = new Float64Array(n);
  const diagonal = new Float64Array(n);
  const columnNorms = new Float64Array(n);
  const work = new Float64Array(n * n);
  const rhs = new Float64Array(n);
  const rowColumns: number[] = [];
  const rowValues: number[] = [];
  const metricScales = dampingCeilings?.map((value, j) => scales[j] / value);
  const metricNorms = dampingCeilings === undefined ? null : new Float64Array(n);
  let madeProgress = false;
  const stopped = (): RigidSolveStopReason => madeProgress ? 'suspectedConflict' : 'stalled';

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    input.observer?.iterationStarted();
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
        input.observer?.trial(trace[trace.length - 1]);
        if (accepted) {
          base = input.retract(base, step);
          evaluation = input.evaluate(base, zero);
          current = measure(evaluation, options);
          madeProgress = true;
          break;
        }
      }
      if (accepted) {
        if (current.satisfied && (input.canConverge?.(base, evaluation) ?? true)) return finish('converged', iteration);
        continue;
      }
    }

    normal.fill(0);
    gradient.fill(0);
    for (const row of evaluation.rows) {
      const weight = rowWeight(row, options);
      // 同じMap順・累算順のまま作業配列を使い回し、行ごとのタプル列と内側のiteratorを省く。
      let count = 0;
      for (const [j, value] of row.gradient) {
        rowColumns[count] = j;
        rowValues[count] = value * scales[j] * weight;
        count += 1;
      }
      for (let p = 0; p < count; p += 1) {
        const j = rowColumns[p];
        const gj = rowValues[p];
        gradient[j] += gj * row.value * weight;
        const offset = j * n;
        for (let q = 0; q < count; q += 1) normal[offset + rowColumns[q]] += gj * rowValues[q];
      }
    }
    let smallest = Infinity;
    let largest = 0;
    for (let j = 0; j < n; j += 1) {
      const value = normal[j * n + j];
      if (value > 0) { smallest = Math.min(smallest, value); largest = Math.max(largest, value); }
      columnNorms[j] = Math.sqrt(value);
    }
    if (dampingCeilings !== undefined && metricScales !== undefined && metricNorms !== null) {
      // Protect null/span directions in physical pose units as well. Applying the old floor before
      // this change of coordinates would make the same translation depend on the arbitrary L.
      for (let j = 0; j < n; j += 1) metricNorms[j] = columnNorms[j] / dampingCeilings[j];
      dampingDiagonal(evaluation.rows, metricScales, options, metricNorms, diagonal);
      for (let j = 0; j < n; j += 1) {
        diagonal[j] = Math.min(diagonal[j], 1) * dampingCeilings[j];
      }
    } else dampingDiagonal(evaluation.rows, scales, options, columnNorms, diagonal);
    let illConditioned = largest / smallest > 1e12;
    // ほぼ同じ列の桁落ちを、正規方程式を解く前に検出する。
    for (let j = 0; j < n && !illConditioned; j += 1) {
      for (let k = j + 1; k < n; k += 1) {
        const product = columnNorms[j] * columnNorms[k];
        if (product === 0) continue;
        const correlation = Math.abs(normal[j * n + k] / product);
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
        input.observer?.linearSolve('normal', false);
        for (let j = 0; j < n; j += 1) {
          rhs[j] = -gradient[j] / diagonal[j];
          for (let k = 0; k < n; k += 1) work[j * n + k] = normal[j * n + k] / (diagonal[j] * diagonal[k]);
          work[j * n + j] += damping;
        }
        solved = eliminate(work, rhs, n);
      }
      if (solved === null) {
        input.observer?.linearSolve('qr', options.linearSolver !== 'qr');
        linearSolver = 'qr';
        // Exact zero columns have the independent regularized solution zero. The drag opt-in
        // may omit that work; every finite nonzero derivative remains in the linear system.
        const qrColumns = Array.from({ length: n }, (_value, j) => j).filter((j) =>
          dampingCeilings === undefined || !input.preserveZeroColumns || columnNorms[j] !== 0
          || evaluation.rows.some((row) => (row.gradient.get(j) ?? 0) !== 0));
        const matrix = scaledRigidJacobian(evaluation.rows, input.variables, options)
          .map((row) => qrColumns.map((j) => row[j] / diagonal[j]));
        const right = evaluation.rows.map((row) => -row.value * rowWeight(row, options));
        for (let j = 0; j < qrColumns.length; j += 1) {
          const row = new Array<number>(qrColumns.length).fill(0);
          row[j] = Math.sqrt(damping);
          if (dampingCeilings === undefined) {
            matrix.push(row);
            right.push(0);
          } else {
            // Same least-squares objective, with diagonal regularization first. Its zero RHS
            // prevents cancellation in a strong residual from leaking into a tiny span column.
            matrix.splice(j, 0, row);
            right.splice(j, 0, 0);
          }
        }
        const reduced = solveLeastSquares(matrix, right, qrColumns.length);
        if (reduced !== null) {
          const expanded = new Float64Array(n);
          for (let j = 0; j < qrColumns.length; j += 1) expanded[qrColumns[j]] = reduced[j];
          solved = expanded;
        }
      }
      const step = solved === null ? null : Array.from(solved, (value, j) => value * scales[j] / diagonal[j]);
      if (input.preserveZeroColumns && step !== null) {
        for (let j = 0; j < n; j += 1) {
          // Inspect the actual derivatives too: a nonzero norm can underflow when squared.
          if (columnNorms[j] === 0 && evaluation.rows.every((row) => (row.gradient.get(j) ?? 0) === 0)) step[j] = 0;
        }
      }
      const stepSize = step === null ? 0 : Math.max(0, ...step.map((value, j) => Math.abs(value / scales[j])));
      const trialEvaluation = step === null ? null : input.evaluate(base, step);
      const trial = trialEvaluation === null ? null : measure(trialEvaluation, options);
      accepted = trial !== null && trialEvaluation !== null && trialEvaluation.valid !== false
        && trialEvaluation.rows.length === evaluation.rows.length
        && (trialEvaluation.branchViolations?.length ?? 0) <= branches.length
        && Number.isFinite(trial.weightedSum) && trial.weightedSum < current.weightedSum;
      trace.push({ iteration, attempt, damping, accepted, residualNorm: current.norm,
        trialResidualNorm: trial?.norm ?? Infinity, stepSize, linearSolver });
      input.observer?.trial(trace[trace.length - 1]);
      if (accepted && step !== null) {
        base = input.retract(base, step);
        evaluation = input.evaluate(base, zero);
        current = measure(evaluation, options);
        madeProgress = true;
        damping = Math.max(CONSTRAINT_MIN_DAMPING, damping / 3);
        if (current.constantConflict) return finish('provenConstantConflict', iteration);
        if (current.satisfied && (input.canConverge?.(base, evaluation) ?? true)) return finish('converged', iteration);
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
