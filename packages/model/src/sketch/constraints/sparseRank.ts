import type { ResidualRow } from './residuals.js';

export interface SparseDependentRow {
  readonly rowIndex: number;
  readonly combination: readonly { readonly rowIndex: number; readonly weight: number }[];
  readonly mismatch: number;
  readonly scale: number;
  readonly empty: boolean;
}

export interface SparseRowAnalysis {
  readonly rank: number | null;
  readonly dependents: readonly SparseDependentRow[];
  readonly failure: 'nonFinite' | 'workLimit' | 'storageLimit' | null;
  readonly work: number;
  readonly storedEntries: number;
}

interface Rotation {
  readonly left: number;
  readonly right: number;
  readonly cosine: number;
  readonly sine: number;
}

interface FactorRow {
  readonly rowIndex: number;
  readonly exponent: number;
  readonly diagonal: number;
  /** Dense heads are replayed from this original row and rotation prefix on demand. */
  readonly head: readonly (readonly [number, number])[] | null;
  readonly rotationCount: number;
}

/** Resource ceilings, independent of numerical rank/residual tolerances. */
export interface SparseRankLimits {
  readonly work?: number;
  readonly storedEntries?: number;
}

/** Scale in monotone finite steps, including subnormal original row magnitudes. */
function powerScale(value: number, exponent: number): number {
  let result = value;
  let remaining = exponent;
  while (remaining > 512) {
    result *= 2 ** 512;
    remaining -= 512;
  }
  while (remaining < -512) {
    result *= 2 ** -512;
    remaining += 512;
  }
  return result * 2 ** remaining;
}

/**
 * Incremental sparse LQ, preserving original row order and Euclidean rank test.
 * Right Givens rotations make accepted rows lower triangular. The unoccupied
 * tail is the orthogonal distance from the preceding row span; its norm uses
 * exactly the caller's original relative rank tolerance. No normal equations,
 * pivot threshold, dense orthonormal basis, or eager provenance inverse.
 *
 * A dependent row obtains its original-row weights by L^T w = head. Row scaling
 * is an exact power of two and is undone before residual/provenance evaluation.
 * Heads no denser than their input row are cheap caches. Denser heads are not
 * retained: the same rotation prefix reconstructs them only if provenance is
 * needed. Thus a sparse shared-anchor fan does not require a dense L cache.
 * For a difference chain the factor and rotations have O(n) entries and visits
 * are O(n^2). General fill can be larger: deterministic work/storage ceilings
 * return explicit incompleteness, never a guessed rank or discarded conflict.
 */
export function analyzeSparseRows(
  rows: readonly ResidualRow[],
  columnCount: number,
  relativeTolerance: number,
  limits: SparseRankLimits = {},
): SparseRowAnalysis {
  const dependents: SparseDependentRow[] = [];
  let work = 0;
  let storedEntries = 0;
  const failed = (failure: Exclude<SparseRowAnalysis['failure'], null>): SparseRowAnalysis =>
    ({ rank: null, dependents, failure, work, storedEntries });
  if (!Number.isSafeInteger(columnCount) || columnCount < 0 ||
      !Number.isFinite(relativeTolerance) || relativeTolerance <= 0) {
    return failed('nonFinite');
  }
  const inputEntries = rows.reduce((sum, row) => sum + row.gradient.size, 0);
  const size = columnCount + rows.length + inputEntries + 1;
  const workLimit = limits.work ?? 8 * Math.max(1, columnCount) * size;
  const storageLimit = limits.storedEntries ?? 64 * size;
  if (!Number.isFinite(workLimit) || workLimit < 0 ||
      !Number.isFinite(storageLimit) || storageLimit < 0) {
    return failed('workLimit');
  }
  const rotations: Rotation[] = [];
  const factor: FactorRow[] = [];
  const vector = new Float64Array(columnCount);
  const replayed = new Float64Array(columnCount);

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    work += columnCount + row.gradient.size;
    if (work > workLimit) return failed('workLimit');
    if (!Number.isFinite(row.value)) return failed('nonFinite');
    vector.fill(0);
    let maximum = 0;
    for (const [column, value] of row.gradient) {
      if (!Number.isInteger(column) || column < 0 || column >= columnCount ||
          !Number.isFinite(value)) return failed('nonFinite');
      maximum = Math.max(maximum, Math.abs(value));
    }
    const exponent = maximum === 0 ? 0 : Math.floor(Math.log2(maximum));
    for (const [column, value] of row.gradient) {
      vector[column] += powerScale(value, -exponent);
    }
    let originalNorm = 0;
    for (const value of vector) {
      if (value !== 0) originalNorm = Math.hypot(originalNorm, value);
    }
    if (!Number.isFinite(originalNorm)) return failed('nonFinite');
    if (originalNorm === 0) {
      dependents.push({ rowIndex, combination: [], mismatch: row.value,
        scale: Math.abs(row.value), empty: true });
      continue;
    }
    work += rotations.length;
    if (work > workLimit) return failed('workLimit');
    for (const rotation of rotations) {
      const left = vector[rotation.left];
      const right = vector[rotation.right];
      if (left === 0 && right === 0) continue;
      vector[rotation.left] = rotation.cosine * left + rotation.sine * right;
      vector[rotation.right] = -rotation.sine * left + rotation.cosine * right;
    }
    const rank = factor.length;
    const rotationCount = rotations.length;
    let tailNorm = 0;
    for (let column = rank; column < columnCount; column += 1) {
      if (vector[column] !== 0) tailNorm = Math.hypot(tailNorm, vector[column]);
    }
    if (!Number.isFinite(tailNorm)) return failed('nonFinite');
    if (tailNorm > relativeTolerance * originalNorm) {
      const head: [number, number][] = [];
      for (let column = 0; column < rank; column += 1) {
        if (!Number.isFinite(vector[column])) return failed('nonFinite');
        if (vector[column] !== 0) head.push([column, vector[column]]);
      }
      for (let column = rank + 1; column < columnCount; column += 1) {
        const right = vector[column];
        if (right === 0) continue;
        const left = vector[rank];
        const diagonal = Math.hypot(left, right);
        const cosine = left / diagonal;
        const sine = right / diagonal;
        if (++storedEntries > storageLimit) return failed('storageLimit');
        rotations.push({ left: rank, right: column, cosine, sine });
        vector[rank] = diagonal;
        vector[column] = 0;
      }
      const cachedHead = head.length <= row.gradient.size ? head : null;
      storedEntries += (cachedHead?.length ?? 0) + 1;
      if (storedEntries > storageLimit) return failed('storageLimit');
      factor.push({ rowIndex, exponent, diagonal: vector[rank], head: cachedHead, rotationCount });
      continue;
    }

    // Backward substitution also subtracts each sparse row from earlier columns.
    const weights = new Float64Array(rank);
    for (let index = rank - 1; index >= 0; index -= 1) {
      const accepted = factor[index];
      let head = accepted.head;
      if (head === null) {
        const original = rows[accepted.rowIndex];
        // Replay exactly the same scaling, insertion order and Givens prefix.
        // The accepted row's own later rotations only touch its tail, not head.
        work += columnCount + original.gradient.size + accepted.rotationCount + index;
        if (work > workLimit) return failed('workLimit');
        replayed.fill(0);
        for (const [column, value] of original.gradient) {
          replayed[column] += powerScale(value, -accepted.exponent);
        }
        for (let rotationIndex = 0; rotationIndex < accepted.rotationCount; rotationIndex += 1) {
          const rotation = rotations[rotationIndex];
          const left = replayed[rotation.left], right = replayed[rotation.right];
          if (left === 0 && right === 0) continue;
          replayed[rotation.left] = rotation.cosine * left + rotation.sine * right;
          replayed[rotation.right] = -rotation.sine * left + rotation.cosine * right;
        }
        const reconstructed: [number, number][] = [];
        for (let column = 0; column < index; column += 1) {
          if (!Number.isFinite(replayed[column])) return failed('nonFinite');
          if (replayed[column] !== 0) reconstructed.push([column, replayed[column]]);
        }
        head = reconstructed;
      }
      work += head.length + 1;
      if (work > workLimit) return failed('workLimit');
      const weight = vector[index] / accepted.diagonal;
      weights[index] = powerScale(weight, exponent - accepted.exponent);
      if (!Number.isFinite(weight) || !Number.isFinite(weights[index])) {
        return failed('nonFinite');
      }
      for (const [column, value] of head) vector[column] -= weight * value;
    }
    let largest = 0;
    for (const weight of weights) largest = Math.max(largest, Math.abs(weight));
    const combination: { rowIndex: number; weight: number }[] = [];
    let expected = 0;
    let scale = Math.abs(row.value);
    for (let index = 0; index < rank; index += 1) {
      const weight = weights[index];
      if (Math.abs(weight) <= largest * relativeTolerance) continue;
      const source = factor[index].rowIndex;
      const term = weight * rows[source].value;
      expected += term;
      scale += Math.abs(term);
      combination.push({ rowIndex: source, weight });
    }
    const mismatch = row.value - expected;
    if (!Number.isFinite(mismatch) || !Number.isFinite(scale)) return failed('nonFinite');
    storedEntries += combination.length;
    if (storedEntries > storageLimit) return failed('storageLimit');
    dependents.push({ rowIndex, combination, mismatch, scale, empty: false });
  }
  return { rank: factor.length, dependents, failure: null, work, storedEntries };
}
