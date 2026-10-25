import type { LinearizedRow } from './solve.js';

/** Linear accuracy only; nonlinear convergence still uses the original residuals in solve.ts. */
export const SPARSE_LINEAR_RELATIVE_TOLERANCE = 1e-12;

export interface SparseLinearOutcome {
  /** Only a strict or explicitly representation-bounded linear step is usable. */
  readonly step: Float64Array | null;
  readonly stop: 'converged' | 'roundoffLimited' | 'invalidInput' | 'breakdown' | 'maxIterations';
  readonly iterations: number;
  /** Infinity norm after symmetric diagonal scaling, relative to the scaled right-hand side. */
  readonly relativeResidual: number;
  /** Scaled |J|^T|J|q+lambda*q bound, present only for roundoffLimited. */
  readonly representationBound?: number;
}

export interface SparseNormalSystem {
  /** Optional budget may shorten, but not exceed, the fixed 2*n linear-iteration bound. */
  solve(damping: number, maxIterations?: number): SparseLinearOutcome;
  /** Preparation is already snapshotted; this job owns all mutable solve state. */
  createSolveJob(damping: number, maxIterations?: number): SparseLinearJob;
}

/** productEntries counts completed sparse operator visits, separately from scheduling units. */
export type SparseLinearProgress = { readonly productEntries: number } & (
  | { readonly status: 'pending' | 'cancelled'; readonly outcome: null; readonly work: number; readonly totalWork: number }
  | { readonly status: 'completed'; readonly outcome: SparseLinearOutcome; readonly work: number; readonly totalWork: number });

export interface SparseLinearJob {
  /** At most maxWork original scalar work units; returns even inside one matrix-vector product. */
  step(maxWork: number): SparseLinearProgress;
  /** Terminal and idempotent. A pending job never exposes a partial numerical step. */
  cancel(): void;
}

type SparseWork<T> = Generator<undefined, T, void>;

/** Shared by every nested numerical loop. A suspension costs no extra arithmetic unit. */
interface SparseWorkBudget {
  limit: number;
  used: number;
  productEntries: number;
}

function createLinearJob(create: (budget: SparseWorkBudget) => SparseWork<SparseLinearOutcome>): SparseLinearJob {
  const budget: SparseWorkBudget = { limit: 0, used: 0, productEntries: 0 };
  let iterator: SparseWork<SparseLinearOutcome> | null = create(budget);
  let totalWork = 0;
  let terminal: SparseLinearProgress | null = null;
  return {
    step(maxWork): SparseLinearProgress {
      if (!Number.isSafeInteger(maxWork) || maxWork < 1) throw new RangeError('maxWork must be a positive safe integer');
      if (terminal !== null) return { ...terminal, work: 0 };
      // Cancellation drops the entire generator stack without executing another arithmetic operation.
      if (iterator === null) return { status: 'cancelled', outcome: null, work: 0, totalWork, productEntries: budget.productEntries };
      budget.limit = maxWork;
      budget.used = 0;
      const next = iterator.next();
      // The old iterator protocol also charged one unit for the terminal return.
      const used = budget.used + (next.done ? 1 : 0);
      totalWork += used;
      if (next.done) {
        terminal = { status: 'completed', outcome: next.value, work: used, totalWork, productEntries: budget.productEntries };
        iterator = null;
        return terminal;
      }
      return { status: 'pending', outcome: null, work: used, totalWork, productEntries: budget.productEntries };
    },
    cancel(): void {
      if (terminal !== null) return;
      iterator = null;
      terminal = { status: 'cancelled', outcome: null, work: 0, totalWork, productEntries: budget.productEntries };
    },
  };
}

function drainLinearJob(job: SparseLinearJob): SparseLinearOutcome {
  for (;;) {
    const progress = job.step(Number.MAX_SAFE_INTEGER);
    if (progress.status === 'completed') return progress.outcome;
    if (progress.status === 'cancelled') throw new Error('Private synchronous job was cancelled');
  }
}

interface SparseRows {
  readonly offsets: readonly number[];
  readonly columns: readonly number[];
  readonly values: readonly number[];
  /** Exact opposite-gradient entries share a difference before multiplication. */
  readonly opposite: readonly number[];
}

/**
 * Snapshot sparse J and prepare -J^T f and diag(J^T J), never J^T J itself.
 * Column ordering is canonical within each row; row ordering remains the caller's ordering.
 * The type-only import of LinearizedRow introduces no runtime import cycle.
 */
export function prepareSparseNormalSystem(
  rows: readonly LinearizedRow[],
  variableCount: number,
): SparseNormalSystem | null {
  if (!Number.isSafeInteger(variableCount) || variableCount < 0 || variableCount > 0xffffffff) {
    return null;
  }
  const offsets = [0];
  const columns: number[] = [];
  const values: number[] = [];
  const rhs = new Float64Array(variableCount);
  const diagonal = new Float64Array(variableCount);
  for (const row of rows) {
    if (!Number.isFinite(row.value)) return null;
    const entries = [...row.gradient].sort(([a], [b]) => a - b);
    for (const [column, value] of entries) {
      if (!Number.isInteger(column) || column < 0 || column >= variableCount || !Number.isFinite(value)) {
        return null;
      }
      if (value === 0) continue;
      columns.push(column);
      values.push(value);
      rhs[column] -= value * row.value;
      diagonal[column] += value * value;
    }
    offsets.push(columns.length);
  }
  for (let i = 0; i < variableCount; i += 1) {
    if (!Number.isFinite(rhs[i]) || !Number.isFinite(diagonal[i])) return null;
  }
  const opposite = new Array<number>(values.length).fill(-1);
  for (let row = 0; row + 1 < offsets.length; row += 1) {
    for (let entry = offsets[row]; entry < offsets[row + 1]; entry += 1) {
      if (opposite[entry] !== -1) continue;
      for (let other = entry + 1; other < offsets[row + 1]; other += 1) {
        if (opposite[other] === -1 && values[other] === -values[entry]) {
          opposite[entry] = other; opposite[other] = entry; break;
        }
      }
    }
  }
  const sparse = { offsets, columns, values, opposite };
  const createSolveJob = (damping: number, maxIterations?: number): SparseLinearJob =>
    createLinearJob(budget => solvePrepared(budget, sparse, rhs, diagonal, damping, maxIterations));
  return { createSolveJob, solve: (damping, maxIterations) => drainLinearJob(createSolveJob(damping, maxIterations)) };
}

/** (J^T J + damping I)v using two passes over each row; O(n + nnz(J)) storage. */
function* multiply(
  budget: SparseWorkBudget,
  rows: SparseRows,
  damping: number,
  vector: Float64Array,
  output: Float64Array,
  correction: Float64Array,
  absoluteProduct?: Float64Array,
): SparseWork<void> {
  for (let i = 0; i < correction.length; i += 1) { if (++budget.used === budget.limit) yield; correction[i] = 0; }
  for (let i = 0; i < vector.length; i += 1) {
    if (++budget.used === budget.limit) yield;
    output[i] = damping * vector[i];
    if (absoluteProduct !== undefined) absoluteProduct[i] = Math.abs(output[i]);
  }
  for (let row = 0; row + 1 < rows.offsets.length; row += 1) {
    if (++budget.used === budget.limit) yield;
    const begin = rows.offsets[row], end = rows.offsets[row + 1];
    let product = 0, productCorrection = 0, absolute = 0;
    for (let entry = begin; entry < end; entry += 1) {
      const raw = rows.values[entry] * vector[rows.columns[entry]];
      if (absoluteProduct !== undefined) absolute += Math.abs(raw);
      const other = rows.opposite[entry];
      if (other >= 0 && other < entry) { budget.productEntries += 1; if (++budget.used === budget.limit) yield; continue; }
      // Distance/relative constraints contain exact +g/-g pairs. Evaluating
      // g*(v_i-v_j) retains rigid-translation cancellation before rounding two
      // large products. This is the same J, not equation scaling or a new pin.
      const difference = other < 0 ? 0 : vector[rows.columns[entry]] - vector[rows.columns[other]];
      const term = other < 0 ? raw : Number.isFinite(difference)
        ? rows.values[entry] * difference : raw + rows.values[other] * vector[rows.columns[other]];
      const next = product + term;
      productCorrection += Math.abs(product) >= Math.abs(term)
        ? (product - next) + term : (term - next) + product;
      product = next;
      budget.productEntries += 1; if (++budget.used === budget.limit) yield;
    }
    product += productCorrection;
    for (let entry = begin; entry < end; entry += 1) {
      const column = rows.columns[entry], term = rows.values[entry] * product;
      const previous = output[column], next = previous + term;
      correction[column] += Math.abs(previous) >= Math.abs(term)
        ? (previous - next) + term : (term - next) + previous;
      output[column] = next;
      if (absoluteProduct !== undefined) absoluteProduct[column] += Math.abs(rows.values[entry]) * absolute;
      budget.productEntries += 1; if (++budget.used === budget.limit) yield;
    }
  }
  for (let i = 0; i < output.length; i += 1) { if (++budget.used === budget.limit) yield; output[i] += correction[i]; }
}
function* maxMagnitude(budget: SparseWorkBudget, vector: Float64Array): SparseWork<number> {
  let maximum = 0;
  for (const value of vector) { if (++budget.used === budget.limit) yield; maximum = Math.max(maximum, Math.abs(value)); }
  return maximum;
}

/** Dot products of independently normalized vectors cannot overflow by squaring a scale. */
function* normalizedDot(budget: SparseWorkBudget, a: Float64Array, aScale: number, b: Float64Array, bScale: number): SparseWork<number> {
  let sum = 0, correction = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (++budget.used === budget.limit) yield;
    const term = (a[i] / aScale) * (b[i] / bScale);
    const next = sum + term;
    correction += Math.abs(sum) >= Math.abs(term) ? (sum - next) + term : (term - next) + sum;
    sum = next;
  }
  return sum + correction;
}

/** Positive a*b/(c*d), without an overflowing/underflowing intermediate ratio. */
function positiveRatio(a: number, b: number, c: number, d: number): number {
  const exponent = (value: number): number => Math.min(1023, Math.floor(Math.log2(value)));
  const ea = exponent(a), eb = exponent(b), ec = exponent(c), ed = exponent(d);
  let power = ea + eb - ec - ed;
  let fraction = ((a / 2 ** ea) * (b / 2 ** eb)) / ((c / 2 ** ec) * (d / 2 ** ed));
  while (fraction >= 2) { fraction /= 2; power += 1; }
  while (fraction < 1) { fraction *= 2; power -= 1; }
  if (power > 1023) return Infinity;
  if (power < -1075) return 0;
  // Form subnormals in two stages: 2**-1075 alone rounds to zero too early.
  return power < -1022 ? (fraction * 2 ** (power + 1022)) * 2 ** -1022 : fraction * 2 ** power;
}

/** ||D^(-1/2)r||_infinity avoids squaring residual magnitudes just to check convergence. */
function* scaledNorm(budget: SparseWorkBudget, vector: Float64Array, diagonal: Float64Array): SparseWork<number> {
  let norm = 0;
  for (let i = 0; i < vector.length; i += 1) {
    if (++budget.used === budget.limit) yield;
    const magnitude = Math.abs(vector[i]) / Math.sqrt(diagonal[i]);
    // A nonzero component disappearing during scaling is not evidence of a zero residual.
    if (magnitude === 0 && vector[i] !== 0) return Infinity;
    norm = Math.max(norm, magnitude);
  }
  return norm;
}

/** Prevent a large equation from hiding an unsolved, independently small coordinate. */
function* componentwiseConverged(budget: SparseWorkBudget, rhs: Float64Array, residual: Float64Array, absoluteProduct: Float64Array): SparseWork<boolean> {
  for (let i = 0; i < rhs.length; i += 1) {
    if (++budget.used === budget.limit) yield;
    const scale = Math.max(Math.abs(rhs[i]), absoluteProduct[i]);
    if (!Number.isFinite(scale) || !Number.isFinite(residual[i])) return false;
    if (scale === 0) {
      if (residual[i] !== 0) return false;
    } else if (Math.abs(residual[i]) / scale > SPARSE_LINEAR_RELATIVE_TOLERANCE
      * (Math.abs(rhs[i]) / scale + absoluteProduct[i] / scale)) {
      return false;
    }
  }
  return true;
}

/** Next greater nonnegative double; used only to bound positive arithmetic outward. */
function upward(value: number, bits: DataView): number {
  if (!Number.isFinite(value)) return value;
  if (value === 0) return Number.MIN_VALUE;
  bits.setFloat64(0, value);
  const low = bits.getUint32(4), high = bits.getUint32(0);
  bits.setUint32(4, (low + 1) >>> 0);
  bits.setUint32(0, high + (low === 0xffffffff ? 1 : 0));
  return bits.getFloat64(0);
}

/**
 * For rounding a real vector to x, |delta_j| <= q_j, where q is half the larger
 * neighboring spacing (one minimum subnormal when half is unrepresentable).
 * Thus |A delta| <= lambda*q + |J|^T |J| q. All positive operations round outward.
 * This is a representation bound, not a condition-number-dependent tolerance.
 */
function* representationEnvelope(budget: SparseWorkBudget, rows: SparseRows, damping: number, step: Float64Array): SparseWork<Float64Array> {
  const bits = new DataView(new ArrayBuffer(8));
  const radii = new Float64Array(step.length), envelope = new Float64Array(step.length);
  const product = (a: number, b: number): number => a === 0 || b === 0 ? 0 : upward(a * b, bits);
  const sum = (a: number, b: number): number => a === 0 ? b : b === 0 ? a : upward(a + b, bits);
  for (let i = 0; i < step.length; i += 1) {
    if (++budget.used === budget.limit) yield;
    bits.setFloat64(0, Math.abs(step[i]));
    const exponent = (bits.getUint32(0) >>> 20) & 0x7ff;
    radii[i] = exponent <= 1 ? Number.MIN_VALUE : 2 ** (exponent - 1076);
    envelope[i] = product(damping, radii[i]);
  }
  for (let row = 0; row + 1 < rows.offsets.length; row += 1) {
    if (++budget.used === budget.limit) yield;
    const begin = rows.offsets[row], end = rows.offsets[row + 1];
    let rowRadius = 0;
    for (let entry = begin; entry < end; entry += 1) {
      if (++budget.used === budget.limit) yield;
      rowRadius = sum(rowRadius, product(Math.abs(rows.values[entry]), radii[rows.columns[entry]]));
    }
    for (let entry = begin; entry < end; entry += 1) {
      if (++budget.used === budget.limit) yield;
      const column = rows.columns[entry];
      envelope[column] = sum(envelope[column], product(Math.abs(rows.values[entry]), rowRadius));
    }
  }
  return envelope;
}

/** Keep the original global residual target after explicitly accounting for representation. */
function* representationConverged(
  budget: SparseWorkBudget,
  residual: Float64Array, envelope: Float64Array, diagonal: Float64Array, rhsNorm: number,
): SparseWork<boolean> {
  for (let i = 0; i < residual.length; i += 1) {
    if (++budget.used === budget.limit) yield;
    if (!Number.isFinite(envelope[i]) || !Number.isFinite(residual[i])) return false;
    const excess = Math.max(0, Math.abs(residual[i]) - envelope[i]);
    const scaled = excess / Math.sqrt(diagonal[i]);
    if ((scaled === 0 && excess !== 0) || scaled / rhsNorm > SPARSE_LINEAR_RELATIVE_TOLERANCE) return false;
  }
  return true;
}

/**
 * Zero-start CG in the ORIGINAL Euclidean coordinates, for the same SPD system as dense LM.
 * Reference: Barrett et al., Templates (SIAM), sections 2.3.1 and 4.2:
 * https://www.netlib.org/templates/templates.html
 *
 * b=-J^T f and A=J^T J+lambda I preserve Range(J^T). Thus zero-start Krylov steps do not
 * add an arbitrary nullspace displacement. Diagonal preconditioning would change that
 * subspace and can pass a backward-residual test with a large, wrong nullspace step.
 * Only whole VECTOR magnitudes are normalized; neither equations nor coordinates are weighted.
 *
 * For unit-infinity direction p and q=Ap, t=(p^T r)/(p^T q). The next direction is the
 * A-orthogonalization of the normalized new residual against p. This is the ordinary CG
 * three-term recurrence in exact arithmetic, without ever forming r^T r or its ratio.
 * The recursive residual is only a trigger: every successful return recomputes b-Ax.
 * Strict convergence requires the original scaled residual and componentwise error at1e-12.
 * A separate roundoffLimited outcome admits only the explicitly bounded representation
 * residual after a recursive1e-12 trigger and the unchanged componentwise check. The raw
 * residual is reported honestly. Otherwise restart within the SAME total iteration budget.
 * Poor conditioning/roundoff can still prevent convergence; failure returns no usable step.
 */
function* solvePrepared(
  budget: SparseWorkBudget,
  rows: SparseRows,
  rhs: Float64Array,
  undampedDiagonal: Float64Array,
  damping: number,
  maxIterations = 2 * rhs.length,
): SparseWork<SparseLinearOutcome> {
  const n = rhs.length;
  const failure = (stop: SparseLinearOutcome['stop'], iterations: number, relativeResidual = Infinity): SparseLinearOutcome =>
    ({ step: null, stop, iterations, relativeResidual });
  if (!Number.isFinite(damping) || damping <= 0 || !Number.isSafeInteger(maxIterations)
    || maxIterations < 0 || maxIterations > 2 * n) {
    return failure('invalidInput', 0);
  }
  const diagonal = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    if (++budget.used === budget.limit) yield;
    diagonal[i] = undampedDiagonal[i] + damping;
    if (!Number.isFinite(diagonal[i]) || diagonal[i] <= 0) return failure('breakdown', 0);
  }
  const step = new Float64Array(n);
  const residual = new Float64Array(n);
  for (let i = 0; i < n; i += 1) { if (++budget.used === budget.limit) yield; residual[i] = rhs[i]; }
  const rhsNorm = yield* scaledNorm(budget, rhs, diagonal);
  if (!Number.isFinite(rhsNorm)) return failure('breakdown', 0);
  if (rhsNorm === 0) return { step, stop: 'converged', iterations: 0, relativeResidual: 0 };
  const direction = new Float64Array(n);
  const product = new Float64Array(n);
  const trueProduct = new Float64Array(n);
  const productCorrection = new Float64Array(n);
  const absoluteProduct = new Float64Array(n);
  let residualScale = yield* maxMagnitude(budget, residual);
  for (let i = 0; i < n; i += 1) { if (++budget.used === budget.limit) yield; direction[i] = residual[i] / residualScale; }
  let relativeResidual = 1;
  let refining = false;

  const recomputeResidual = function* (): SparseWork<number> {
    yield* multiply(budget, rows, damping, step, trueProduct, productCorrection, absoluteProduct);
    for (let i = 0; i < n; i += 1) { if (++budget.used === budget.limit) yield; residual[i] = rhs[i] - trueProduct[i]; }
    return (yield* scaledNorm(budget, residual, diagonal)) / rhsNorm;
  };

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    if (++budget.used === budget.limit) yield;
    yield* multiply(budget, rows, damping, direction, product, productCorrection);
    const productScale = yield* maxMagnitude(budget, product);
    if (!Number.isFinite(productScale) || productScale <= 0) return failure('breakdown', iteration - 1);
    const curvature = yield* normalizedDot(budget, direction, 1, product, productScale);
    const slope = yield* normalizedDot(budget, direction, 1, residual, residualScale);
    if (!Number.isFinite(curvature) || curvature <= 0 || !Number.isFinite(slope) || slope <= 0) {
      return failure('breakdown', iteration - 1);
    }
    const alpha = positiveRatio(residualScale, slope, productScale, curvature);
    if (!Number.isFinite(alpha) || alpha <= 0) return failure('breakdown', iteration - 1);
    for (let i = 0; i < n; i += 1) {
      if (++budget.used === budget.limit) yield;
      step[i] += alpha * direction[i];
      residual[i] -= alpha * product[i];
      if (!Number.isFinite(step[i]) || !Number.isFinite(residual[i])) return failure('breakdown', iteration);
    }
    relativeResidual = (yield* scaledNorm(budget, residual, diagonal)) / rhsNorm;
    const recursiveConverged = relativeResidual <= SPARSE_LINEAR_RELATIVE_TOLERANCE;
    // After a failed true-residual check, solve the correction until its
    // small components are also resolved. The last absolute product is only
    // a trigger; acceptance always recomputes it for the current step below.
    // Restarting on the global norm alone discards conjugacy every iteration
    // when a small tail has not yet met the componentwise accuracy target.
    const verify = (recursiveConverged && (!refining
      || (yield* componentwiseConverged(budget, rhs, residual, absoluteProduct))))
      || iteration === maxIterations;
    if (verify) {
      relativeResidual = yield* recomputeResidual();
      if (Number.isFinite(relativeResidual) && relativeResidual <= SPARSE_LINEAR_RELATIVE_TOLERANCE
        && (yield* componentwiseConverged(budget, rhs, residual, absoluteProduct))) {
        return { step, stop: 'converged', iterations: iteration, relativeResidual };
      }
      if (recursiveConverged && Number.isFinite(relativeResidual)
        && (yield* componentwiseConverged(budget, rhs, residual, absoluteProduct))) {
        const envelope = yield* representationEnvelope(budget, rows, damping, step);
        const representationBound = (yield* scaledNorm(budget, envelope, diagonal)) / rhsNorm;
        if (Number.isFinite(representationBound) && (yield* representationConverged(budget, residual, envelope, diagonal, rhsNorm))) {
          return { step, stop: 'roundoffLimited', iterations: iteration, relativeResidual, representationBound };
        }
      }
      refining = true;
    }
    if (!Number.isFinite(relativeResidual)) return failure('breakdown', iteration);
    residualScale = yield* maxMagnitude(budget, residual);
    if (!Number.isFinite(residualScale) || residualScale <= 0) return failure('breakdown', iteration);
    const beta = verify ? 0 : -(yield* normalizedDot(budget, residual, residualScale, product, productScale)) / curvature;
    if (!Number.isFinite(beta)) return failure('breakdown', iteration);
    for (let i = 0; i < n; i += 1) { if (++budget.used === budget.limit) yield; direction[i] = residual[i] / residualScale + beta * direction[i]; }
    const directionScale = yield* maxMagnitude(budget, direction);
    if (!Number.isFinite(directionScale) || directionScale <= 0) return failure('breakdown', iteration);
    for (let i = 0; i < n; i += 1) { if (++budget.used === budget.limit) yield; direction[i] /= directionScale; }
  }
  return failure('maxIterations', maxIterations, relativeResidual);
}
