import type { ResidualRow } from './residuals.js';
import type { LinearizedRow } from './solve.js';

/** Test-only binary arithmetic: products and cancellation happen before conversion to double. */
export function auditExactSum(terms: readonly (readonly number[])[]): number {
  const view = new DataView(new ArrayBuffer(8));
  const products: { integer: bigint; exponent: number }[] = [];
  let leastExponent = Infinity;
  for (const factors of terms) {
    let integer = 1n, exponent = 0;
    for (const factor of factors) {
      if (!Number.isFinite(factor)) throw new Error('Nonfinite audit factor');
      view.setFloat64(0, factor);
      const bits = view.getBigUint64(0), biased = Number((bits >> 52n) & 2047n);
      const fraction = bits & ((1n << 52n) - 1n);
      integer *= (bits >> 63n ? -1n : 1n) * (biased === 0 ? fraction : fraction + (1n << 52n));
      exponent += biased === 0 ? -1074 : biased - 1075;
    }
    if (integer !== 0n) {
      products.push({ integer, exponent });
      leastExponent = Math.min(leastExponent, exponent);
    }
  }
  if (products.length === 0) return 0;
  let integer = 0n;
  for (const product of products) integer += product.integer << BigInt(product.exponent - leastExponent);
  // These fixtures use bounded normal doubles; reject unsupported conversion ranges.
  const result = Number(integer) * 2 ** leastExponent;
  if (!Number.isFinite(result) || (result === 0 && integer !== 0n)) throw new Error('Audit conversion range');
  return result;
}

/** Half the larger adjacent spacing, obtained from neighbors, not the solver's exponent formula. */
export function auditRoundingRadius(value: number): number {
  const magnitude = Math.abs(value);
  if (!Number.isFinite(magnitude) || magnitude === 0) throw new Error('Audit requires nonzero normal coordinates');
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, magnitude);
  const bits = view.getBigUint64(0);
  view.setBigUint64(0, bits + 1n);
  const above = view.getFloat64(0);
  view.setBigUint64(0, bits - 1n);
  const below = view.getFloat64(0);
  const radius = Math.max(above - magnitude, magnitude - below) / 2;
  if (!Number.isFinite(radius) || radius === 0) throw new Error('Audit radius outside bounded normal range');
  return radius;
}

export interface SparseAuditFixture {
  readonly name: string;
  readonly damping: number;
  readonly rows: readonly LinearizedRow[];
  readonly rhs: readonly number[];
  readonly expected: readonly number[];
}

/** Two 1000-node stars; each axis is coupled to its root by an exact +/-g row. */
export function sparseAuditStar(nonunit: boolean, damping: number): SparseAuditFixture {
  const count = 1000, weight = 0.01, gradients = nonunit ? [0.6, 0.8] : [1, 1];
  const pinValues = [-weight * 40, -weight * 30];
  // Preparation rounds -g*f once. Each root has one nonzero observation,
  // so these are the actual stored RHS doubles, independently known in advance.
  const rhs = Array.from({ length: 2 * count }, (_, i) => i < 2 ? -weight * pinValues[i] : 0);
  const rows: LinearizedRow[] = [];
  for (let point = 1; point < count; point += 1) {
    for (let axis = 0; axis < 2; axis += 1) {
      rows.push({ value: 0, gradient: new Map([[axis, -gradients[axis]], [2 * point + axis, gradients[axis]]]) });
    }
  }
  for (let axis = 0; axis < 2; axis += 1) rows.push({ value: pinValues[axis], gradient: new Map([[axis, weight]]) });
  // Eliminate the identical leaves. Multiplying through by g²+lambda gives
  // determinant = w²*g²+w²*lambda+1000*lambda*g²+lambda², without cancellation.
  // This is a closed two-equation solution, not a call to a numerical solver.
  const roots = gradients.map((g, axis) => {
    const numerator = auditExactSum([[rhs[axis], g, g], [rhs[axis], damping]]);
    const determinant = auditExactSum([[weight, weight, g, g], [weight, weight, damping],
      [count, damping, g, g], [damping, damping]]);
    return numerator / determinant;
  });
  const leaves = gradients.map((g, axis) => roots[axis] * (g * g / (g * g + damping)));
  const expected = Array.from({ length: 2 * count }, (_, i) => i < 2 ? roots[i] : leaves[i % 2]);
  return { name: `${nonunit ? 'nonunit' : 'unit'} lambda=${damping}`, damping, rows, rhs, expected };
}

export interface SparseAuditResidual {
  readonly coordinateError: number;
  readonly rawInfinity: number;
  readonly rawRelative: number;
  readonly representationBound: number;
  readonly representationExcess: number;
  readonly componentwise: number;
  readonly residuals: readonly number[];
  readonly envelopes: readonly number[];
  readonly componentErrors: readonly number[];
}

/** Expand ORIGINAL J^T J entries as exact products, without paired-dot or production helpers. */
export function auditSparseResidual(fixture: SparseAuditFixture, candidate: ArrayLike<number>): SparseAuditResidual {
  const { damping, rows, rhs, expected } = fixture, n = expected.length;
  if (candidate.length !== n) throw new Error('Audit dimension mismatch');
  const residualTerms = Array.from({ length: n }, (_, i) => [[rhs[i]], [-damping, candidate[i]]]);
  const diagonalTerms = Array.from({ length: n }, () => [[damping]]);
  const radii = Array.from(candidate, auditRoundingRadius);
  const envelopeTerms = radii.map(radius => [[damping, radius]]);
  const absoluteTerms = Array.from({ length: n }, (_, i) => [[damping, Math.abs(candidate[i])]]);
  for (const row of rows) {
    for (const [i, gi] of row.gradient) {
      diagonalTerms[i].push([gi, gi]);
      for (const [j, gj] of row.gradient) {
        residualTerms[i].push([-gi, gj, candidate[j]]);
        envelopeTerms[i].push([Math.abs(gi), Math.abs(gj), radii[j]]);
        absoluteTerms[i].push([Math.abs(gi), Math.abs(gj), Math.abs(candidate[j])]);
      }
    }
  }
  const residuals = residualTerms.map(auditExactSum), envelopes = envelopeTerms.map(auditExactSum);
  const diagonals = diagonalTerms.map(auditExactSum), absolutes = absoluteTerms.map(auditExactSum);
  const componentErrors = residuals.map((value, i) => Math.abs(value) / (Math.abs(rhs[i]) + absolutes[i]));
  let coordinateError = 0, rawInfinity = 0, rawNorm = 0, rhsNorm = 0, boundNorm = 0, excessNorm = 0;
  for (let i = 0; i < n; i += 1) {
    const rootDiagonal = Math.sqrt(diagonals[i]), residual = Math.abs(residuals[i]);
    coordinateError = Math.max(coordinateError, Math.abs(candidate[i] - expected[i]));
    rawInfinity = Math.max(rawInfinity, residual);
    rawNorm = Math.max(rawNorm, residual / rootDiagonal);
    rhsNorm = Math.max(rhsNorm, Math.abs(rhs[i]) / rootDiagonal);
    boundNorm = Math.max(boundNorm, envelopes[i] / rootDiagonal);
    excessNorm = Math.max(excessNorm, Math.max(0, residual - envelopes[i]) / rootDiagonal);
  }
  return { coordinateError, rawInfinity, rawRelative: rawNorm / rhsNorm,
    representationBound: boundNorm / rhsNorm, representationExcess: excessNorm / rhsNorm,
    componentwise: Math.max(...componentErrors), residuals, envelopes, componentErrors };
}

export interface SparseAuditRankFixture {
  readonly rows: readonly ResidualRow[];
  readonly columnCount: number;
  readonly rank: number;
  readonly closures: readonly { readonly rowIndex: number; readonly weights: readonly number[] }[];
}

/** Difference chains have exactly two translations; each root pin removes one. */
export function sparseAuditRank(deficiency: 0 | 1 | 2): SparseAuditRankFixture {
  const count = 1000, rows: ResidualRow[] = [], closures: { rowIndex: number; weights: number[] }[] = [];
  const append = (entries: readonly (readonly [number, number])[], value: number): void => {
    rows.push({ constraintId: `audit-${rows.length}`, gradient: new Map(entries), value });
  };
  for (let axis = 0; axis < 2; axis += 1) {
    const weights: number[] = [];
    for (let point = 0; point < count - 1; point += 1) {
      const scale = 2 ** ((point % 9) - 4);
      weights.push(1 / scale);
      append([[2 * point + axis, scale], [2 * (point + 1) + axis, -scale]], scale);
    }
    closures.push({ rowIndex: rows.length, weights });
    append([[axis, 1], [2 * (count - 1) + axis, -1]], count - 1);
  }
  for (let axis = 0; axis < 2 - deficiency; axis += 1) append([[axis, 1]], 0);
  return { rows, columnCount: 2 * count, rank: 2 * count - deficiency, closures };
}
