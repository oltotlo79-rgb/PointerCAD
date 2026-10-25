import { describe, expect, it } from 'vitest';

import { absoluteCoordinate } from '../createSketchDocument.js';
import { WORK_PLANES } from '../planeMath.js';
import { resolveSketch } from '../resolveSketch.js';
import type { SketchDocument, SketchFeature } from '../types.js';
import { buildResiduals } from './residuals.js';
import { solveLinearSystem, type LinearizedRow } from './solve.js';
import { prepareSparseNormalSystem, SPARSE_LINEAR_RELATIVE_TOLERANCE } from './sparseSolve.js';
import type { SketchConstraint } from './types.js';
import { collectVariables } from './variables.js';
import { requiredPoint, triangleFanOracle } from './independentGeometry.testSupport.js';
import { vi } from 'vitest';
import { auditExactSum, auditRoundingRadius, auditSparseResidual, sparseAuditStar, type SparseAuditFixture } from './sparseAudit.testSupport.js';
import type { SparseLinearOutcome } from './sparseSolve.js';
import { stdout } from 'node:process';

function row(value: number, entries: readonly (readonly [number, number])[]): LinearizedRow {
  return { value, gradient: new Map(entries) };
}

/** Independent dense construction for small test problems only. */
function denseStep(rows: readonly LinearizedRow[], n: number, damping: number): number[] | null {
  const matrix = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) =>
    rows.reduce((sum, entry) => sum + (entry.gradient.get(i) ?? 0) * (entry.gradient.get(j) ?? 0), i === j ? damping : 0)));
  const rhs = Array.from({ length: n }, (_, i) => -rows.reduce((sum, entry) => sum + (entry.gradient.get(i) ?? 0) * entry.value, 0));
  return solveLinearSystem(matrix, rhs);
}

function expectVector(actual: Float64Array | null | undefined, expected: readonly number[], tolerance = 1e-10): void {
  expect(actual).toBeInstanceOf(Float64Array);
  expect(actual?.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    expect(Math.abs((actual?.[i] ?? NaN) - expected[i]), `coordinate ${i}`).toBeLessThanOrEqual(tolerance);
  }
}

/** Evaluate the original damped normal equation without using the production operator. */
function expectLinearResidual(rows: readonly LinearizedRow[], step: Float64Array | null | undefined, damping: number): void {
  expect(step).not.toBeNull();
  if (step === null || step === undefined) throw new Error('missing converged step');
  let rhsNorm = 0, residualNorm = 0;
  for (let i = 0; i < step.length; i += 1) {
    let rhs = 0, product = damping * step[i], diagonal = damping;
    for (const entry of rows) {
      const gi = entry.gradient.get(i) ?? 0;
      rhs -= gi * entry.value;
      diagonal += gi * gi;
      if (gi !== 0) {
        let rowProduct = 0;
        for (const [j, gj] of entry.gradient) rowProduct += gj * step[j];
        product += gi * rowProduct;
      }
    }
    rhsNorm = Math.max(rhsNorm, Math.abs(rhs) / Math.sqrt(diagonal));
    residualNorm = Math.max(residualNorm, Math.abs(rhs - product) / Math.sqrt(diagonal));
  }
  expect(residualNorm / rhsNorm).toBeLessThanOrEqual(SPARSE_LINEAR_RELATIVE_TOLERANCE);
}

describe('sparse damped normal equations', () => {
  it('solves a hand-derived coupled system with the actual +lambda I convention', () => {
    expect(SPARSE_LINEAR_RELATIVE_TOLERANCE).toBe(1e-12);
    const rows = [row(-5, [[0, 2], [1, 1]]), row(-10, [[0, 1], [1, 3]])];
    const outcome = prepareSparseNormalSystem(rows, 2)?.solve(1);
    // A=[[6,5],[5,11]], b=[20,35], determinant=41.
    expect(outcome?.stop).toBe('converged');
    expectVector(outcome?.step, [45 / 41, 110 / 41], 1e-12);
    expectLinearResidual(rows, outcome?.step, 1);
  });

  it.each([2, 7, 17, 129])('agrees with an independent dense solve for %i coupled variables', (n) => {
    const rows = Array.from({ length: n }, (_, i) => row((i % 7) - 3, [[i, 2 + (i % 3)], [(i + 1) % n, -1]]));
    rows.push(row(0.3, [[0, 0.7], [n - 1, -0.2]]));
    const outcome = prepareSparseNormalSystem(rows, n)?.solve(0.25);
    const expected = denseStep(rows, n, 0.25);
    expect(expected).not.toBeNull();
    expect(outcome?.stop).toBe('converged');
    expectVector(outcome?.step, expected ?? []);
    expectLinearResidual(rows, outcome?.step, 0.25);
  });

  it('handles rank deficiency under damping and preserves the undetermined direction', () => {
    const rows = [row(-3, [[0, 1], [1, 2]])];
    const outcome = prepareSparseNormalSystem(rows, 3)?.solve(0.25);
    // 3*[1,2]/(1^2+2^2+0.25); the third coordinate has no gradient.
    expect(outcome?.stop).toBe('converged');
    expectVector(outcome?.step, [4 / 7, 8 / 7, 0], 1e-12);
    expect(Math.abs(2 * (outcome?.step?.[0] ?? NaN) - (outcome?.step?.[1] ?? NaN))).toBeLessThan(1e-12);
    expectLinearResidual(rows, outcome?.step, 0.25);
  });

  it('solves redundant and contradictory rows as a linear step without claiming nonlinear feasibility', () => {
    const rows = [row(-2, [[0, 1]]), row(-4, [[0, 1]]), row(7, [])];
    const outcome = prepareSparseNormalSystem(rows, 1)?.solve(2);
    expect(outcome?.stop).toBe('converged');
    expectVector(outcome?.step, [1.5], 1e-12);
    expectLinearResidual(rows, outcome?.step, 2);
    expect(Math.max(...rows.map(entry => Math.abs(entry.value + (entry.gradient.get(0) ?? 0) * 1.5)))).toBe(7);
  });

  it('solves a twelve-order gradient scale difference without dropping the small coordinate', () => {
    const rows = [row(-1e-6, [[0, 1e-6]]), row(-1e6, [[1, 1e6]])];
    const outcome = prepareSparseNormalSystem(rows, 2)?.solve(1e-9);
    expect(outcome?.stop).toBe('converged');
    expectVector(outcome?.step, [1 / 1001, 1], 1e-12);
    expectLinearResidual(rows, outcome?.step, 1e-9);
  });

  it.each([1e-6, 1e-9])('refines a localized chain perturbation at damping %s without losing its small tail', damping => {
    const n = 129;
    const rows = [row(0, [[0, 1]])];
    for (let i = 1; i < n; i += 1) {
      rows.push(row(i === 1 ? 0.125 : i === 2 ? -0.125 : 0, [[i - 1, -1], [i, 1]]));
    }
    const expected = denseStep(rows, n, damping);
    const outcome = prepareSparseNormalSystem(rows, n)?.solve(damping);
    expect(outcome?.stop).toBe('converged');
    expect(expected).not.toBeNull();
    expectVector(outcome?.step, expected ?? [], 1e-9);
    expectLinearResidual(rows, outcome?.step, damping);
    // The distant coordinates have zero RHS and a small nonzero solution.
    // Check each original equation separately so the large first entries
    // cannot mask a tail which has only met a global residual threshold.
    const step = outcome?.step;
    if (step === null || step === undefined) throw new Error('Missing chain step');
    for (let i = 3; i < n; i += 1) {
      const diagonal = (i === n - 1 ? 1 : 2) + damping;
      const left = step[i - 1], right = i === n - 1 ? 0 : step[i + 1];
      const residual = diagonal * step[i] - left - right;
      const scale = Math.abs(diagonal * step[i]) + Math.abs(left) + Math.abs(right);
      expect(Math.abs(residual) / scale).toBeLessThanOrEqual(1e-12);
    }
  });

  it('accepts empty dimensions, empty equations and an exactly zero right-hand side', () => {
    expectVector(prepareSparseNormalSystem([], 0)?.solve(1).step, []);
    expectVector(prepareSparseNormalSystem([], 3)?.solve(1).step, [0, 0, 0]);
    const outcome = prepareSparseNormalSystem([row(0, [[0, 3]])], 2)?.solve(1);
    expect(outcome?.iterations).toBe(0);
    expect(outcome?.relativeResidual).toBe(0);
    expectVector(outcome?.step, [0, 0]);
  });

  it('snapshots caller rows and orders gradient columns deterministically', () => {
    const gradient = new Map([[1, 2], [0, 1]]);
    const prepared = prepareSparseNormalSystem([{ value: -3, gradient }], 2);
    const first = prepared?.solve(0.25);
    gradient.set(0, 100);
    gradient.set(9, NaN);
    expect(prepared?.solve(0.25)).toEqual(first);
    expect(prepareSparseNormalSystem([row(-3, [[0, 1], [1, 2]])], 2)?.solve(0.25)).toEqual(first);
  });

  it.each([0, 1])('returns no usable step when the %i-iteration budget is exhausted', (budget) => {
    const rows = [row(-5, [[0, 2], [1, 1]]), row(-10, [[0, 1], [1, 3]])];
    const outcome = prepareSparseNormalSystem(rows, 2)?.solve(1, budget);
    expect(outcome?.stop).toBe('maxIterations');
    expect(outcome?.iterations).toBe(budget);
    expect(outcome?.relativeResidual).toBeGreaterThan(SPARSE_LINEAR_RELATIVE_TOLERANCE);
    expect(outcome?.step).toBeNull();
  });
});

describe('independent triangle-fan linearization (EX-13 W03)', () => {
  it.each([1e-6, 1e-9])('recovers a manufactured 2000-component solution at damping %s', damping => {
    const fixture = triangleFanOracle(false), n = 2000;
    const expected = Array.from({ length: n }, (_, i) => ((i % 17) - 8) / 16);
    const rows: LinearizedRow[] = [];
    // Differentiate elementary Euclidean length here, without asking the
    // production residual builder for either expected values or gradients.
    for (const constraint of fixture.document.constraints ?? []) {
      if (constraint.kind !== 'distance' && constraint.kind !== 'verticalDistance') throw new Error('Unexpected fan dimension');
      if (constraint.a.kind !== 'point' || constraint.b.kind !== 'point') throw new Error('Expected two free points');
      const a = requiredPoint(fixture.expected, constraint.a.pointId), b = requiredPoint(fixture.expected, constraint.b.pointId);
      const first = Number(constraint.a.pointId.slice(4)) * 2, second = Number(constraint.b.pointId.slice(4)) * 2;
      const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
      const gradient = constraint.kind === 'verticalDistance'
        ? new Map([[first + 1, -1], [second + 1, 1]])
        : new Map([[first, -dx / length], [first + 1, -dy / length], [second, dx / length], [second + 1, dy / length]]);
      let value = 0;
      for (const [column, coefficient] of gradient) value -= coefficient * expected[column];
      rows.push({ gradient, value });
    }
    // Identity observations make the normal matrix positive definite. With
    // values -(1+lambda)*t their RHS is exactly the missing (I+lambda*I)t.
    for (let i = 0; i < n; i += 1) rows.push(row(-(1 + damping) * expected[i], [[i, 1]]));
    expect(rows).toHaveLength(3998);
    const outcome = prepareSparseNormalSystem(rows, n)?.solve(damping);
    expect(outcome?.stop).toBe('converged');
    expectVector(outcome?.step, expected, 1e-9);
    const step = outcome?.step;
    if (step === null || step === undefined) throw new Error('No real fan step');
    // Independently accumulate the original normal equation in O(nnz+n).
    const rawResidual = (candidate: Float64Array): number => {
      const rhs = new Float64Array(n), product = Float64Array.from(candidate, value => damping * value);
      const diagonal = new Float64Array(n).fill(damping);
      for (const observation of rows) {
        let projected = 0;
        for (const [column, coefficient] of observation.gradient) projected += coefficient * candidate[column];
        for (const [column, coefficient] of observation.gradient) {
          rhs[column] -= coefficient * observation.value;
          product[column] += coefficient * projected;
          diagonal[column] += coefficient * coefficient;
        }
      }
      let rhsNorm = 0, errorNorm = 0;
      for (let i = 0; i < n; i += 1) {
        rhsNorm = Math.max(rhsNorm, Math.abs(rhs[i]) / Math.sqrt(diagonal[i]));
        errorNorm = Math.max(errorNorm, Math.abs(rhs[i] - product[i]) / Math.sqrt(diagonal[i]));
      }
      return errorNorm / rhsNorm;
    };
    expect(rawResidual(step)).toBeLessThanOrEqual(1e-12);
    const wrong = step.slice(); wrong[1001] += 1e-6;
    expect(rawResidual(wrong)).toBeGreaterThan(1e-12);
  });
});

describe('sparse input admission and arithmetic failure', () => {
  it.each([-1, 0.5, NaN, Infinity, 2 ** 32])('rejects invalid dimension %s before allocation', (n) => {
    expect(prepareSparseNormalSystem([], n)).toBeNull();
  });

  it.each([-1, 0.5, 2, NaN, Infinity])('rejects invalid column %s, including zero coefficients', (column) => {
    expect(prepareSparseNormalSystem([row(1, [[column, 0]])], 2)).toBeNull();
  });

  it.each([NaN, Infinity, -Infinity])('rejects nonfinite row values or gradients %s', (value) => {
    expect(prepareSparseNormalSystem([row(value, [[0, 1]])], 1)).toBeNull();
    expect(prepareSparseNormalSystem([row(1, [[0, value]])], 1)).toBeNull();
  });

  it('rejects accumulated diagonal and right-hand-side overflow', () => {
    expect(prepareSparseNormalSystem([row(1, [[0, 1e200]])], 1)).toBeNull();
    expect(prepareSparseNormalSystem([row(1e200, [[0, 1e150]])], 1)).toBeNull();
  });

  it.each([0, -1, NaN, Infinity])('refuses invalid damping %s instead of solving a different system', (damping) => {
    const outcome = prepareSparseNormalSystem([row(-1, [[0, 1]])], 1)?.solve(damping);
    expect(outcome?.stop).toBe('invalidInput');
    expect(outcome?.step).toBeNull();
  });

  it.each([-1, 0.5, NaN, Infinity, 3])('rejects invalid or enlarged linear budget %s', (budget) => {
    const outcome = prepareSparseNormalSystem([row(-1, [[0, 1]])], 1)?.solve(1, budget);
    expect(outcome?.stop).toBe('invalidInput');
    expect(outcome?.step).toBeNull();
  });

  it.each([
    { value: -1e155, gradient: 1e150, expected: 1e5 },
    { value: -1e-300, gradient: 1, expected: 5e-301 },
  ])('solves finite scalar division despite unrepresentable CG energy: $value', ({ value, gradient, expected }) => {
    const outcome = prepareSparseNormalSystem([row(value, [[0, gradient]])], 1)?.solve(1);
    // These inputs were incorrectly classified as breakdown merely because rho overflowed/underflowed.
    // Both original normal equations and their independently divided solutions are finite.
    expect(outcome?.stop).toBe('converged');
    expect(Math.abs((outcome?.step?.[0] ?? NaN) / expected - 1)).toBeLessThanOrEqual(1e-12);
    expectLinearResidual([row(value, [[0, gradient]])], outcome?.step, 1);
  });

  it('refuses underflow in the scaled norm instead of calling a nonzero right-hand side zero', () => {
    const rows = [row(-1e-300, [[0, 1]]), row(0, [[0, 1e150]])];
    const outcome = prepareSparseNormalSystem(rows, 1)?.solve(1);
    expect(outcome?.stop).toBe('breakdown');
    expect(outcome?.step).toBeNull();
  });
});

describe('Euclidean movement and finite scaled arithmetic regressions', () => {
  it.each([1, 1024, 2 ** 20])('retains the row-space minimum step at row scale %s', (scale) => {
    const damping = 1e-6;
    const rows = [row(-3 * scale, [[0, scale], [1, 2 * scale]])];
    const outcome = prepareSparseNormalSystem(rows, 129)?.solve(damping);
    const expected = new Array<number>(129).fill(0);
    expected[0] = 3 / (5 + damping / (scale * scale));
    expected[1] = 2 * expected[0];
    expect(outcome?.stop).toBe('converged');
    expectVector(outcome?.step, expected, 1e-12);
    // Independent null vector [2,-1]: backward residual alone cannot certify this condition.
    expect(Math.abs(2 * (outcome?.step?.[0] ?? NaN) - (outcome?.step?.[1] ?? NaN))).toBeLessThanOrEqual(1e-12);
    expectLinearResidual(rows, outcome?.step, damping);
  });

  it.each([2 ** 400, 2 ** 500])('solves a finite condition-one diagonal system with gradient %s', (gradient) => {
    const target = 2 ** 20;
    const rows = Array.from({ length: 129 }, (_, i) => row(i === 0 ? -gradient * target : 0, [[i, gradient]]));
    const outcome = prepareSparseNormalSystem(rows, 129)?.solve(1e-6);
    expect(outcome?.stop).toBe('converged');
    expectVector(outcome?.step, [target, ...new Array<number>(128).fill(0)], 0);
    expectLinearResidual(rows, outcome?.step, 1e-6);
  });

  it.each([1, 1 / 1024])('keeps minimum movement for actual perpendicular-constraint rows at length %s', (length) => {
    const line = (id: string, u: number, v: number): SketchFeature => ({
      id, name: id, kind: 'line', planeId: 'xy', construction: false,
      from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(u, v, 0),
    });
    const constraint: SketchConstraint = {
      id: 'perpendicular', name: 'perpendicular', kind: 'perpendicular',
      a: { kind: 'curve', element: { featureId: 'a' } },
      b: { kind: 'curve', element: { featureId: 'b' } },
    };
    const document: SketchDocument = {
      id: 'real-rows', name: 'real-rows', constraints: [constraint],
      features: [line('a', length, 0), line('b', 3 * length, 4 * length)],
    };
    const variables = collectVariables(document, resolveSketch(document), WORK_PLANES.xy);
    const rows = buildResiduals([constraint], variables, variables.initial);
    expect(variables.initial).toHaveLength(8);
    expect(rows).toHaveLength(1);
    expect(Math.abs(rows[0].value - 0.6)).toBeLessThanOrEqual(1e-15);
    // Differentiate (1,0) dot (3/5,4/5), independently of the runtime gradient.
    const gradients = new Map<string, number>([
      ['a:start.u', 0], ['a:start.v', -0.8 / length],
      ['a:end.u', 0], ['a:end.v', 0.8 / length],
      ['b:start.u', -0.128 / length], ['b:start.v', 0.096 / length],
      ['b:end.u', 0.128 / length], ['b:end.v', -0.096 / length],
    ]);
    const damping = 1e-6;
    const denominator = 1.3312 / (length * length) + damping;
    const expected = new Array<number>(129).fill(0);
    for (const [key, gradient] of gradients) {
      const column = variables.index.get(key);
      expect(column, key).toBeDefined();
      if (column === undefined) throw new Error(`missing actual variable ${key}`);
      expect(Math.abs((rows[0].gradient.get(column) ?? 0) - gradient)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(gradient)));
      expected[column] = -0.6 * gradient / denominator;
    }
    const outcome = prepareSparseNormalSystem(rows, 129)?.solve(damping);
    expect(outcome?.stop).toBe('converged');
    expectVector(outcome?.step, expected, 1e-12);
    expectLinearResidual(rows, outcome?.step, damping);
  });
});

/** Exact dyadic products/sum for the bounded finite values in the star oracle.
 * Conversion to double occurs once, after cancellation, independently of the solver.
 */
function exactStarSum(terms: readonly (readonly number[])[]): number {
  const view = new DataView(new ArrayBuffer(8));
  const products: { coefficient: bigint; exponent: number }[] = [];
  let minimumExponent = Infinity;
  for (const factors of terms) {
    let coefficient = 1n, exponent = 0;
    for (const factor of factors) {
      if (!Number.isFinite(factor)) throw new Error('Nonfinite exact-star factor');
      view.setFloat64(0, factor);
      const bits = view.getBigUint64(0);
      const biasedExponent = Number((bits >> 52n) & 0x7ffn);
      const fraction = bits & ((1n << 52n) - 1n);
      const significand = biasedExponent === 0 ? fraction : fraction + (1n << 52n);
      coefficient *= (bits >> 63n) === 0n ? significand : -significand;
      exponent += biasedExponent === 0 ? -1074 : biasedExponent - 1075;
    }
    if (coefficient !== 0n) {
      products.push({ coefficient, exponent });
      minimumExponent = Math.min(minimumExponent, exponent);
    }
  }
  if (products.length === 0) return 0;
  let total = 0n;
  for (const product of products) total += product.coefficient << BigInt(product.exponent - minimumExponent);
  const result = Number(total) * 2 ** minimumExponent;
  if (!Number.isFinite(result)) throw new Error('Exact-star conversion outside bounded range');
  return result;
}

/** Independent graph equations and exact dyadic products; no production operator/bound call. */
function starRepresentationResidual(
  step: Float64Array, gradients: readonly number[], damping: number, rhs: readonly number[],
): number {
  const pointCount = step.length / 2, weight = 0.01;
  // These fixtures have nonzero normal coordinates strictly inside known binades.
  const radius = (value: number): number => 2 ** (Math.floor(Math.log2(Math.abs(value))) - 53);
  let rhsNorm = 0, excessNorm = 0;
  for (let axis = 0; axis < 2; axis += 1) {
    const g = gradients[axis], center = step[axis], centerRadius = radius(center);
    const rootDiagonal = (pointCount - 1) * g * g + weight * weight + damping;
    const rootTerms: number[][] = [[rhs[axis]], [-weight, weight, center], [-damping, center]];
    const rootBound: number[][] = [[weight, weight, centerRadius], [damping, centerRadius]];
    for (let point = 1; point < pointCount; point += 1) {
      const leaf = step[2 * point + axis], leafRadius = radius(leaf);
      rootTerms.push([g, g, leaf], [-g, g, center]);
      rootBound.push([g, g, centerRadius], [g, g, leafRadius]);
      const residual = exactStarSum([[g, g, center], [-g, g, leaf], [-damping, leaf]]);
      const bound = exactStarSum([[g, g, centerRadius], [g, g, leafRadius], [damping, leafRadius]]);
      excessNorm = Math.max(excessNorm, Math.max(0, Math.abs(residual) - bound) / Math.sqrt(g * g + damping));
    }
    rhsNorm = Math.max(rhsNorm, Math.abs(rhs[axis]) / Math.sqrt(rootDiagonal));
    excessNorm = Math.max(excessNorm,
      Math.max(0, Math.abs(exactStarSum(rootTerms)) - exactStarSum(rootBound)) / Math.sqrt(rootDiagonal));
  }
  return excessNorm / rhsNorm;
}

describe('weak-pin connected-star independent normal-equation oracle', () => {
  it.each([1e-6, 1e-9])('solves all 1000 connected points at original damping %s', damping => {
    const pointCount = 1000, variableCount = 2 * pointCount, weight = 0.01;
    const target = [40, 30] as const;
    const rows: LinearizedRow[] = [];
    for (let point = 1; point < pointCount; point += 1) {
      for (let axis = 0; axis < 2; axis += 1) {
        rows.push(row(0, [[axis, -1], [2 * point + axis, 1]]));
      }
    }
    for (let axis = 0; axis < 2; axis += 1) rows.push(row(-weight * target[axis], [[axis, weight]]));
    expect(rows).toHaveLength(2000);
    // Every point shares the root, so these are not disconnected pairs. The two
    // coordinate blocks are independent by construction and have the same exact
    // scalar derivation: leaf=root/(1+lambda), then the root equation gives
    // root=w^2*T/[w^2+lambda+(N-1)*lambda/(1+lambda)].
    const denominator = weight * weight + damping + (pointCount - 1) * damping / (1 + damping);
    const root = target.map(value => weight * weight * value / denominator);
    const expected = Array.from({ length: variableCount }, (_, column) =>
      column < 2 ? root[column] : root[column % 2] / (1 + damping));
    const outcome = prepareSparseNormalSystem(rows, variableCount)?.solve(damping);
    expect(['converged', 'roundoffLimited']).toContain(outcome?.stop);
    if (damping === 1e-9) expect(outcome?.stop).toBe('roundoffLimited');
    expect(outcome?.iterations).toBeLessThanOrEqual(2 * variableCount);
    expect(outcome?.relativeResidual).toBeLessThanOrEqual(SPARSE_LINEAR_RELATIVE_TOLERANCE + (outcome?.representationBound ?? 0));
    expectVector(outcome?.step, expected, 1e-9);
    // Independently reconstruct the ORIGINAL row products and normal equation;
    // the production paired-dot implementation is not used as its own oracle.
    if (outcome?.stop === 'converged') expectLinearResidual(rows, outcome.step, damping);
    const step = outcome?.step;
    if (step === undefined || step === null) throw new Error('No admissible star step');
    const rhs = target.map(value => -weight * (-weight * value));
    expect(starRepresentationResidual(step, [1, 1], damping, rhs)).toBeLessThanOrEqual(1e-12);
    const wrong = step.slice();
    wrong[2] += 1e-6;
    expect(starRepresentationResidual(wrong, [1, 1], damping, rhs)).toBeGreaterThan(1e-12);
    for (let point = 1; point < pointCount; point += 1) {
      for (let axis = 0; axis < 2; axis += 1) {
        expect(Math.abs((1 + damping) * step[2 * point + axis] - step[axis]))
          .toBeLessThanOrEqual(1e-12);
      }
    }
  });
});

describe('nonunit paired-gradient cancellation with an exact residual oracle', () => {
  it('evaluates product cancellation before rounding in the independent oracle', () => {
    expect(exactStarSum([[0.6, 2 ** 52], [-0.6, 2 ** 52 - 1]])).toBe(0.6);
    expect(exactStarSum([[0.5, 0.25], [-0.125]])).toBe(0);
  });

  it.each([1e-6, 1e-9])('retains the original equation for 1000 connected points at damping %s', damping => {
    const pointCount = 1000, variableCount = 2 * pointCount, weight = 0.01;
    const gradients = [0.6, 0.8] as const, target = [40, 30] as const;
    // Match the stored residual and the separately rounded RHS actually passed
    // to CG; expanding these into exact w*w*T would change that binary input.
    const pinValues = target.map(value => -weight * value);
    const pinRhs = pinValues.map(value => -weight * value);
    const rows: LinearizedRow[] = [];
    for (let point = 1; point < pointCount; point += 1) {
      for (let axis = 0; axis < 2; axis += 1) {
        rows.push(row(0, [[axis, -gradients[axis]], [2 * point + axis, gradients[axis]]]));
      }
    }
    for (let axis = 0; axis < 2; axis += 1) rows.push(row(pinValues[axis], [[axis, weight]]));
    expect(rows).toHaveLength(2000);
    // Eliminate each leaf from (g^2+lambda)*leaf=g^2*root. Substitution into
    // the root equation gives b/[w^2+lambda+(N-1)*lambda*g^2/(g^2+lambda)].
    const root = gradients.map((gradient, axis) => pinRhs[axis]
      / (weight * weight + damping + (pointCount - 1) * damping * gradient * gradient / (gradient * gradient + damping)));
    const expected = Array.from({ length: variableCount }, (_, column) => {
      const axis = column % 2, squared = gradients[axis] * gradients[axis];
      return column < 2 ? root[axis] : root[axis] * squared / (squared + damping);
    });
    const outcome = prepareSparseNormalSystem(rows, variableCount)?.solve(damping);
    expect(['converged', 'roundoffLimited']).toContain(outcome?.stop);
    if (damping === 1e-9) expect(outcome?.stop).toBe('roundoffLimited');
    expect(outcome?.iterations).toBeLessThanOrEqual(2 * variableCount);
    expect(outcome?.relativeResidual).toBeLessThanOrEqual(1e-12 + (outcome?.representationBound ?? 0));
    expectVector(outcome?.step, expected, 1e-9);
    const step = outcome?.step;
    if (step === undefined || step === null) throw new Error('No admissible nonunit star step');
    let rhsNorm = 0, residualNorm = 0;
    for (let axis = 0; axis < 2; axis += 1) {
      const gradient = gradients[axis], center = step[axis];
      const rootDiagonal = (pointCount - 1) * gradient * gradient + weight * weight + damping;
      const rhs = pinRhs[axis];
      const rootTerms: number[][] = [[rhs], [-weight, weight, center], [-damping, center]];
      for (let point = 1; point < pointCount; point += 1) {
        const leaf = step[2 * point + axis];
        rootTerms.push([gradient, gradient, leaf], [-gradient, gradient, center]);
        const residual = exactStarSum([[gradient, gradient, center], [-gradient, gradient, leaf], [-damping, leaf]]);
        residualNorm = Math.max(residualNorm, Math.abs(residual) / Math.sqrt(gradient * gradient + damping));
      }
      rhsNorm = Math.max(rhsNorm, Math.abs(rhs) / Math.sqrt(rootDiagonal));
      residualNorm = Math.max(residualNorm, Math.abs(exactStarSum(rootTerms)) / Math.sqrt(rootDiagonal));
    }
    // This independently evaluates the original matrix on the returned double
    // vector, not an internal low part or the production paired-dot operator.
    if (outcome?.stop === 'converged') expect(residualNorm / rhsNorm).toBeLessThanOrEqual(1e-12);
    else {
      expect(residualNorm / rhsNorm).toBeGreaterThan(1e-12);
      expect(outcome?.representationBound).toBeGreaterThan(0);
    }
    expect(starRepresentationResidual(step, gradients, damping, pinRhs)).toBeLessThanOrEqual(1e-12);
    const wrong = step.slice();
    wrong[3] -= 1e-6;
    expect(starRepresentationResidual(wrong, gradients, damping, pinRhs)).toBeGreaterThan(1e-12);
  });

  it('does not hide an unsolved small independent equation behind a representation bound', () => {
    const rows = [row(-1e12, [[0, 1e12]]), row(-1e-12, [[1, 1e-12]])];
    const outcome = prepareSparseNormalSystem(rows, 129)?.solve(1e-9, 1);
    expect(outcome?.stop).toBe('maxIterations');
    expect(outcome?.step).toBeNull();
    expect(outcome?.representationBound).toBeUndefined();
  });
});

/**
 * Observe the real job's allocations, without replacing arithmetic or acceptance.
 * The cooperative scalar boundary lets a fault enter the candidate just before
 * true J^T J multiplication reads its last coordinate. A control run proves this
 * observer leaves the ordinary answer unchanged. No production test hook is used.
 */
function auditCandidateAdmission(fixture: SparseAuditFixture, reference: SparseLinearOutcome, perturb: boolean): {
  readonly outcome: SparseLinearOutcome; readonly candidate: readonly number[]; readonly perturbation: number;
} {
  const prepared = prepareSparseNormalSystem(fixture.rows, fixture.expected.length);
  const expectedStep = reference.step;
  if (prepared === null || expectedStep === null) throw new Error('Missing audit reference');
  const job = prepared.createSolveJob(fixture.damping, reference.iterations);
  const allocated: Float64Array[] = [];
  const NativeArray = Float64Array;
  class ObservedArray extends NativeArray {
    constructor(length: number) {
      super(length);
      allocated.push(this);
    }
  }
  let candidate: number[] | null = null, perturbation = 0, previousProduct = 0;
  vi.stubGlobal('Float64Array', ObservedArray);
  try {
    for (;;) {
      const progress = job.step(1);
      // solvePrepared allocates diagonal, step, residual, direction, product,
      // trueProduct, correction, absoluteProduct. Fail if that layout changes.
      const step = allocated[1], product = allocated[5], absolute = allocated[7];
      if (step !== undefined && product !== undefined && absolute !== undefined) {
        const first = product[0];
        if (candidate === null && first !== previousProduct && first !== 0
          && first === fixture.damping * step[0] && absolute[0] === Math.abs(first)
          && expectedStep.every((value, i) => value === step[i])) {
          expect(allocated.slice(0, 8)).toHaveLength(8);
          expect(new Set(allocated.slice(0, 8)).size).toBe(8);
          for (const array of allocated) expect(array).toHaveLength(fixture.expected.length);
          // Earlier representation checks can allocate an additional radius/envelope pair.
          expect((allocated.length - 8) % 2).toBe(0);
          expect(Array.from(step)).toEqual(Array.from(expectedStep));
          const last = step.length - 1, before = step[last];
          if (perturb) step[last] += 1e-6;
          perturbation = step[last] - before;
          candidate = Array.from(step);
        }
        previousProduct = first;
      }
      if (progress.status === 'cancelled') throw new Error('Audit job unexpectedly cancelled');
      if (progress.status === 'completed') {
        if (candidate === null) throw new Error('Did not observe the original candidate before verification');
        if (!perturb) expect(progress.outcome.step).toBe(allocated[1]);
        return { outcome: progress.outcome, candidate, perturbation };
      }
    }
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('independent sparse acceptance audit (EX-13 W04)', () => {
  const fixtures = [false, true].flatMap(nonunit => [1e-6, 1e-9].map(damping => sparseAuditStar(nonunit, damping)));

  it('checks exact cancellation and both neighboring spacings independently', () => {
    expect(auditExactSum([[0.6, 2 ** 52], [-0.6, 2 ** 52 - 1]])).toBe(0.6);
    expect(auditExactSum([[0.5, 0.25], [-0.125]])).toBe(0);
    expect(auditExactSum([[1, 2 ** -60], [1], [-1]])).toBe(2 ** -60);
    expect(auditRoundingRadius(1)).toBe(2 ** -53);
    expect(auditRoundingRadius(-1)).toBe(2 ** -53);
    expect(auditRoundingRadius(2 - 2 ** -52)).toBe(2 ** -53);
    expect(auditRoundingRadius(2)).toBe(2 ** -52);
  });

  it.each(fixtures)('$name separates raw, representation and every component of the accepted solution', fixture => {
    expect(fixture.rows).toHaveLength(2000);
    expect(fixture.expected).toHaveLength(2000);
    const outcome = prepareSparseNormalSystem(fixture.rows, fixture.expected.length)?.solve(fixture.damping);
    if (outcome === undefined || outcome.step === null) throw new Error('Missing accepted audit solution');
    expect(['converged', 'roundoffLimited']).toContain(outcome.stop);
    expect(outcome.iterations).toBeLessThanOrEqual(4000);
    const audit = auditSparseResidual(fixture, outcome.step);
    expect(audit.coordinateError).toBeLessThanOrEqual(1e-9);
    expect(audit.rawInfinity).toBeGreaterThan(0);
    expect(audit.representationBound).toBeGreaterThan(0);
    expect(audit.representationExcess).toBeLessThanOrEqual(1e-12);
    for (const error of audit.componentErrors) expect(error).toBeLessThanOrEqual(1e-12);
    if (outcome.stop === 'converged') {
      expect(audit.rawRelative).toBeLessThanOrEqual(1e-12);
      expect(outcome.representationBound).toBeUndefined();
    } else {
      // This explicitly FAILS the former raw-only contract. It is a different,
      // representation-bounded admission, still subject to every component.
      expect(audit.rawRelative).toBeGreaterThan(1e-12);
      expect(outcome.relativeResidual).toBeGreaterThan(1e-12);
      const bound = outcome.representationBound;
      if (bound === undefined) throw new Error('Missing representation bound');
      // Positive accumulation has fewer than 8*(n+m) rounding operations.
      // This compares outward accumulation against a once-rounded exact sum;
      // it is not a relaxation of any solver acceptance threshold.
      const rounding = 8 * (fixture.expected.length + fixture.rows.length) * Number.EPSILON;
      expect(bound).toBeGreaterThanOrEqual(audit.representationBound * (1 - rounding));
      expect(bound).toBeLessThanOrEqual(audit.representationBound / (1 - rounding));
    }
    stdout.write('[sparse audit accepted] ' + JSON.stringify({ name: fixture.name, stop: outcome.stop,
      iterations: outcome.iterations, coordinateError: audit.coordinateError, rawInfinity: audit.rawInfinity,
      rawRelative: audit.rawRelative, reportedRawRelative: outcome.relativeResidual,
      representationBound: audit.representationBound, reportedBound: outcome.representationBound,
      representationExcess: audit.representationExcess, componentwise: audit.componentwise }) + '\n');
  });

  it.each(fixtures)('$name rejects a 1e-6 candidate perturbation through the real residual admission', fixture => {
    const reference = prepareSparseNormalSystem(fixture.rows, fixture.expected.length)?.solve(fixture.damping);
    if (reference === undefined || reference.step === null) throw new Error('Missing perturbation reference');
    const control = auditCandidateAdmission(fixture, reference, false);
    expect(control.outcome.stop).toBe(reference.stop);
    expect(control.outcome.iterations).toBe(reference.iterations);
    expect(control.outcome.relativeResidual).toBe(reference.relativeResidual);
    expect(control.outcome.representationBound).toBe(reference.representationBound);
    expect(Array.from(control.outcome.step ?? [])).toEqual(Array.from(reference.step));
    expect(control.perturbation).toBe(0);
    const wrong = auditCandidateAdmission(fixture, reference, true);
    expect(Math.abs(wrong.perturbation - 1e-6)).toBeLessThanOrEqual(1e-14);
    expect(wrong.outcome.iterations).toBe(reference.iterations);
    expect(wrong.outcome.stop).toBe('maxIterations');
    expect(wrong.outcome.step).toBeNull();
    expect(wrong.outcome.representationBound).toBeUndefined();
    const audit = auditSparseResidual(fixture, wrong.candidate);
    expect(audit.coordinateError).toBeGreaterThan(9.99e-7);
    expect(audit.rawRelative).toBeGreaterThan(1e-12);
    expect(audit.representationExcess).toBeGreaterThan(1e-12);
    expect(audit.componentwise).toBeGreaterThan(1e-12);
    // Matching the independent residual also proves the mutated candidate was
    // evaluated, rather than merely reaching an unrelated iteration limit.
    expect(Math.abs(wrong.outcome.relativeResidual - audit.rawRelative))
      .toBeLessThanOrEqual(1e-8 * audit.rawRelative);
    stdout.write('[sparse audit rejected] ' + JSON.stringify({ name: fixture.name, perturbation: wrong.perturbation,
      stop: wrong.outcome.stop, iterations: wrong.outcome.iterations, rawInfinity: audit.rawInfinity,
      rawRelative: audit.rawRelative, reportedRawRelative: wrong.outcome.relativeResidual,
      representationBound: audit.representationBound, representationExcess: audit.representationExcess,
      componentwise: audit.componentwise }) + '\n');
  });
});
