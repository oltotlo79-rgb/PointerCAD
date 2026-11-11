import type { QrDecomposition } from '../../sketch/constraints/solve.js';
import { RANK_RELATIVE_TOLERANCE } from '../../sketch/constraints/solve.js';

/**
 * Cooperative work accounting for the assembly QR steps. `due(cost)` adds `cost` counted operations and returns the
 * point to yield when a slice boundary is reached, or null. The point type is chosen by the caller (solveRigidSteps).
 */
export interface QrWork<Point> {
  readonly due: (cost: number) => Point | null;
}

/**
 * The shared sketch `qrDecomposition` (packages/model/src/sketch/constraints/solve.ts 264-396) as cooperative steps.
 * Every numeric loop of the original runs in the same order with the same expressions; a checkpoint follows each row
 * of the input copy, each initial column norm, each pivot search, the reflector setup, the reflector normalisation,
 * each reflected column, each recomputed norm, the rank scan and each row of the final transpose. Draining it equals
 * qrDecomposition exactly (rigidQrSteps.test.ts compares both).
 * Indivisible allocations (no checkpoint inside): the `columnCount` arrays of `rowCount` zeros, `columnOrder`, each
 * reflector of `rowCount` zeros and each output row of `columnCount` values.
 */
export function* qrDecompositionSteps<Point>(
  matrix: readonly (readonly number[])[],
  columns: number,
  options: { readonly rankTolerance?: number } | undefined,
  work: QrWork<Point>,
): Generator<Point, QrDecomposition, void> {
  const rowCount = matrix.length;
  const columnCount = Math.max(0, Math.trunc(columns));
  if (rowCount > 0 && Number.isNaN(columnCount)) throw new RangeError('Invalid array length');
  const a = Array.from({ length: columnCount }, () => new Array<number>(rowCount).fill(0));
  for (let i = 0; i < rowCount; i += 1) {
    const row = matrix[i];
    const limit = Math.min(columnCount, row.length);
    for (let j = 0; j < limit; j += 1) {
      a[j][i] = row[j];
    }
    const point = work.due(limit + 1);
    if (point !== null) yield point;
  }
  const columnOrder = Array.from({ length: columnCount }, (_, index) => index);
  // Same sums in the same order as `a.map((column) => { for (const value of column) sum += value * value; })`.
  const remainingNorms: number[] = [];
  for (const column of a) {
    let sum = 0;
    for (const value of column) sum += value * value;
    remainingNorms.push(sum);
    const point = work.due(rowCount + 1);
    if (point !== null) yield point;
  }
  const steps = Math.min(rowCount, columnCount);
  const diagonal: number[] = [];
  const reflectors: number[][] = [];

  for (let k = 0; k < steps; k += 1) {
    let bestColumn = k;
    let bestNorm = -1;
    for (let j = k; j < columnCount; j += 1) {
      const sum = remainingNorms[j];
      if (sum > bestNorm) {
        bestNorm = sum;
        bestColumn = j;
      }
    }
    if (bestColumn !== k) {
      const swap = a[k];
      a[k] = a[bestColumn];
      a[bestColumn] = swap;
      const swapOrder = columnOrder[k];
      columnOrder[k] = columnOrder[bestColumn];
      columnOrder[bestColumn] = swapOrder;
      const swapNorm = remainingNorms[k];
      remainingNorms[k] = remainingNorms[bestColumn];
      remainingNorms[bestColumn] = swapNorm;
    }
    const pivotPoint = work.due(columnCount - k + 1);
    if (pivotPoint !== null) yield pivotPoint;

    const pivotColumn = a[k];
    const reflector = new Array<number>(rowCount).fill(0);
    const norm = Math.sqrt(remainingNorms[k]);
    let updatedNorms = false;
    if (norm > 0) {
      const alpha = pivotColumn[k] >= 0 ? -norm : norm;
      for (let i = k; i < rowCount; i += 1) {
        reflector[i] = pivotColumn[i];
      }
      reflector[k] -= alpha;
      let reflectorNorm = 0;
      for (let i = k; i < rowCount; i += 1) {
        reflectorNorm += reflector[i] * reflector[i];
      }
      reflectorNorm = Math.sqrt(reflectorNorm);
      const setupPoint = work.due(2 * (rowCount - k) + 1);
      if (setupPoint !== null) yield setupPoint;
      if (reflectorNorm > 0) {
        for (let i = k; i < rowCount; i += 1) {
          reflector[i] /= reflectorNorm;
        }
        const normalisePoint = work.due(rowCount - k + 1);
        if (normalisePoint !== null) yield normalisePoint;
        for (let j = k; j < columnCount; j += 1) {
          const column = a[j];
          let dot = 0;
          for (let i = k; i < rowCount; i += 1) {
            dot += reflector[i] * column[i];
          }
          dot *= 2;
          let nextNorm = 0;
          for (let i = k; i < rowCount; i += 1) {
            column[i] -= dot * reflector[i];
            if (i > k) nextNorm += column[i] * column[i];
          }
          remainingNorms[j] = nextNorm;
          const point = work.due(2 * (rowCount - k));
          if (point !== null) yield point;
        }
        updatedNorms = true;
      } else {
        for (let i = k; i < rowCount; i += 1) {
          reflector[i] = 0;
        }
      }
      pivotColumn[k] = alpha;
      for (let i = k + 1; i < rowCount; i += 1) {
        pivotColumn[i] = 0;
      }
    }
    if (!updatedNorms) {
      for (let j = k + 1; j < columnCount; j += 1) {
        let sum = 0;
        for (let i = k + 1; i < rowCount; i += 1) sum += a[j][i] * a[j][i];
        remainingNorms[j] = sum;
        const point = work.due(rowCount - k);
        if (point !== null) yield point;
      }
    }
    reflectors.push(reflector);
    diagonal.push(pivotColumn[k]);
  }

  const rankTolerance = options?.rankTolerance ?? RANK_RELATIVE_TOLERANCE;
  let maxDiagonal = 0;
  for (const value of diagonal) {
    maxDiagonal = Math.max(maxDiagonal, Math.abs(value));
  }
  const threshold = maxDiagonal * rankTolerance;
  let rank = 0;
  for (const value of diagonal) {
    const size = Math.abs(value);
    if (size > 0 && size > threshold) {
      rank += 1;
    } else {
      break;
    }
  }
  const rankPoint = work.due(2 * diagonal.length + 1);
  if (rankPoint !== null) yield rankPoint;

  // Same rows as `Array.from({ length: rowCount }, (_, i) => a.map((column) => column[i]))`.
  const r: number[][] = [];
  for (let i = 0; i < rowCount; i += 1) {
    r.push(a.map((column) => column[i]));
    const point = work.due(columnCount + 1);
    if (point !== null) yield point;
  }
  return { rowCount, columnCount, r, columnOrder, diagonal, rank, reflectors };
}

/**
 * The shared `solveLeastSquares` (solve.ts 412-460) over qrDecompositionSteps, with a checkpoint after each reflection
 * applied to the right side, each back-substitution row and the pivot restore. The same refusals, reflection order,
 * back substitution and restore; draining it equals solveLeastSquares exactly. Indivisible allocations: the copy of
 * `rhs`, `y` and `x`.
 */
export function* solveLeastSquaresSteps<Point>(
  matrix: readonly (readonly number[])[],
  rhs: readonly number[],
  columns: number,
  work: QrWork<Point>,
): Generator<Point, number[] | null, void> {
  const qr = yield* qrDecompositionSteps(matrix, columns, undefined, work);
  if (qr.rowCount !== rhs.length) {
    return null;
  }
  if (qr.columnCount === 0) {
    return [];
  }
  if (qr.rank < qr.columnCount) {
    return null;
  }
  const c = [...rhs];
  for (let k = 0; k < qr.reflectors.length; k += 1) {
    const reflector = qr.reflectors[k];
    let dot = 0;
    for (let i = k; i < qr.rowCount; i += 1) {
      dot += reflector[i] * c[i];
    }
    dot *= 2;
    for (let i = k; i < qr.rowCount; i += 1) {
      c[i] -= dot * reflector[i];
    }
    const point = work.due(2 * (qr.rowCount - k));
    if (point !== null) yield point;
  }
  const n = qr.columnCount;
  const y = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    let sum = c[i];
    for (let j = i + 1; j < n; j += 1) {
      sum -= qr.r[i][j] * y[j];
    }
    y[i] = sum / qr.r[i][i];
    const point = work.due(n - i);
    if (point !== null) yield point;
  }
  const x = new Array<number>(n).fill(0);
  for (let j = 0; j < n; j += 1) {
    x[qr.columnOrder[j]] = y[j];
  }
  for (const value of x) {
    if (!Number.isFinite(value)) {
      return null;
    }
  }
  return x;
}
