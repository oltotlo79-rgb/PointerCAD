import { describe, expect, it } from 'vitest';

import type { ResidualRow } from './residuals.js';
import { analyzeSparseRows } from './sparseRank.js';
import { RANK_RELATIVE_TOLERANCE } from './solve.js';
import { auditExactSum, sparseAuditRank } from './sparseAudit.testSupport.js';
import { stdout } from 'node:process';

function row(entries: readonly (readonly [number, number])[], value = 0): ResidualRow {
  return { constraintId: 'row', gradient: new Map(entries), value };
}

describe('sparse orthogonal rank and original-row provenance', () => {
  it('ranks a 1000-point shared-anchor triangle fan and reconstructs a dense-head conflict', () => {
    const count = 1000;
    const point = (index: number): readonly [number, number] => index === 0 ? [0, 0]
      : index === 1 ? [8, 6] : [20 + ((index - 2) % 32) / 4, 30 + Math.floor((index - 2) / 32) / 4];
    const rows: ResidualRow[] = [];
    const distance = (first: number, second: number): void => {
      const a = point(first), b = point(second);
      const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
      rows.push(row([[2 * first, dx / length], [2 * first + 1, dy / length],
        [2 * second, -dx / length], [2 * second + 1, -dy / length]]));
    };
    distance(0, 1);
    for (let index = 2; index < count; index += 1) { distance(0, index); distance(1, index); }
    expect(rows).toHaveLength(1997);
    rows.push(row([[1, -1], [3, 1]]));
    // Each outer point has two nonparallel anchor directions. The anchor
    // distance plus signed rise fix orientation; only two translations remain.
    // The last distance is independent, but its triangular head is dense.
    const sourceIndex = 1996;
    rows.push(row(Array.from(rows[sourceIndex].gradient, ([column, value]) => [column, 2 * value] as const), 1));
    const result = analyzeSparseRows(rows, 2 * count, RANK_RELATIVE_TOLERANCE);
    expect(result.failure).toBeNull();
    expect(result.rank).toBe(2 * count - 2);
    expect(result.dependents).toHaveLength(1);
    const dependent = result.dependents[0];
    expect(dependent.rowIndex).toBe(1998);
    expect(dependent.combination).toHaveLength(1);
    expect(dependent.combination[0].rowIndex).toBe(sourceIndex);
    expect(dependent.combination[0].weight).toBeCloseTo(2, 8);
    expect(dependent.mismatch).toBe(1);
    expect(dependent.empty).toBe(false);
    expect(result.storedEntries).toBeLessThanOrEqual(32 * count);
  });

  it('a 2000-column connected chain has one translation freedom and linear factor storage', () => {
    const n = 2000;
    const rows = Array.from({ length: n - 1 }, (_, i) => row([[i, 1], [i + 1, -1]], 1));
    rows.push(row([[0, 1], [n - 1, -1]], n - 1));
    const result = analyzeSparseRows(rows, n, RANK_RELATIVE_TOLERANCE);
    expect(result.failure).toBeNull();
    expect(result.rank).toBe(n - 1);
    expect(result.dependents).toHaveLength(1);
    const dependent = result.dependents[0];
    // Telescoping sum: e0-e1999 = sum(e_i-e_{i+1}); all partners are required.
    expect(dependent.combination).toHaveLength(n - 1);
    for (let i = 0; i < n - 1; i += 1) {
      expect(dependent.combination[i].rowIndex).toBe(i);
      expect(dependent.combination[i].weight).toBeCloseTo(1, 9);
    }
    expect(Math.abs(dependent.mismatch)).toBeLessThan(1e-8);
    expect(result.storedEntries).toBeLessThanOrEqual(4 * n);
    expect(result.work).toBeLessThanOrEqual(2 * n * n);
  });

  it('retains contradictory residual and every independent partner', () => {
    const result = analyzeSparseRows([
      row([[0, 1], [1, -1]], 2),
      row([[1, 1], [2, -1]], 3),
      row([[0, 1], [2, -1]], 6),
    ], 2000, RANK_RELATIVE_TOLERANCE);
    expect(result.rank).toBe(2);
    expect(result.dependents[0].combination.map((term) => term.rowIndex)).toEqual([0, 1]);
    expect(result.dependents[0].mismatch).toBeCloseTo(1, 12);
    expect(result.dependents[0].scale).toBeCloseTo(11, 12);
  });

  it.each([-1000, 0, 1000])('row scale 2^%i preserves rank and unscaled provenance', (exponent) => {
    const magnitude = 2 ** exponent;
    const result = analyzeSparseRows([
      row([[0, magnitude], [1, -magnitude]], magnitude),
      row([[0, 2 * magnitude], [1, -2 * magnitude]], 2 * magnitude),
    ], 2000, RANK_RELATIVE_TOLERANCE);
    expect(result.failure).toBeNull();
    expect(result.rank).toBe(1);
    expect(result.dependents[0].combination[0].weight).toBeCloseTo(2, 12);
    // The exact mismatch is zero; two floating Givens operations can round it.
    expect(Math.abs(result.dependents[0].mismatch) / magnitude).toBeLessThan(1e-14);
  });

  it('uses the original Euclidean row-relative threshold on both sides of 1e-9', () => {
    for (const [tail, expectedRank] of [[0.5e-9, 1], [2e-9, 2]]) {
      const result = analyzeSparseRows([
        row([[0, 1]]), row([[0, 1], [1, tail]]),
      ], 2000, RANK_RELATIVE_TOLERANCE);
      expect(result.failure).toBeNull();
      expect(result.rank).toBe(expectedRank);
    }
  });

  it('does not call resource-limited or non-finite analysis fully constrained', () => {
    const rows = [row([[0, 1]], 1), row([[0, 1]], 2), row([[1, 1]], 3)];
    const exhausted = analyzeSparseRows(rows, 2, RANK_RELATIVE_TOLERANCE, { work: 6 });
    expect(exhausted.failure).toBe('workLimit');
    expect(exhausted.rank).toBeNull();
    const storage = analyzeSparseRows(rows, 2, RANK_RELATIVE_TOLERANCE, { storedEntries: 0 });
    expect(storage.failure).toBe('storageLimit');
    expect(storage.rank).toBeNull();
    const invalid = analyzeSparseRows([
      ...rows.slice(0, 2), row([[1, Number.NaN]]),
    ], 2, RANK_RELATIVE_TOLERANCE);
    expect(invalid.failure).toBe('nonFinite');
    expect(invalid.rank).toBeNull();
    expect(invalid.dependents).toHaveLength(1);
    expect(invalid.dependents[0].mismatch).toBe(1);
  });

  it('rejects invalid columns and residuals without silently dropping them', () => {
    for (const invalid of [row([[2000, 1]]), row([[-1, 1]]), row([[0, 1]], Infinity)]) {
      expect(analyzeSparseRows([invalid], 2000, RANK_RELATIVE_TOLERANCE).failure).toBe('nonFinite');
    }
  });
});

describe('independent sparse rank audit (EX-13 W04)', () => {
  it.each([0, 1, 2] as const)('has exactly %i missing ranks in two scaled difference chains', deficiency => {
    const fixture = sparseAuditRank(deficiency);
    expect(RANK_RELATIVE_TOLERANCE).toBe(1e-9);
    expect(fixture.columnCount).toBe(2000);
    expect(fixture.rows).toHaveLength(2002 - deficiency);
    const result = analyzeSparseRows(fixture.rows, fixture.columnCount, RANK_RELATIVE_TOLERANCE);
    expect(result.failure).toBeNull();
    expect(result.rank).toBe(fixture.rank);
    expect(result.dependents).toHaveLength(2);
    for (let axis = 0; axis < 2; axis += 1) {
      const closure = fixture.closures[axis], dependent = result.dependents[axis];
      expect(dependent.rowIndex).toBe(closure.rowIndex);
      expect(dependent.empty).toBe(false);
      expect(dependent.combination).toHaveLength(999);
      // The closure is the telescoping sum of edges, undoing each power-of-two
      // scale. This gives both rank and provenance without numerical elimination.
      const reconstructed = Array.from({ length: fixture.columnCount }, () => [] as number[][]);
      for (let edge = 0; edge < 999; edge += 1) {
        const term = dependent.combination[edge];
        expect(term.rowIndex).toBe(axis * 1000 + edge);
        expect(Math.abs(term.weight / closure.weights[edge] - 1)).toBeLessThanOrEqual(1e-10);
        for (const [column, coefficient] of fixture.rows[term.rowIndex].gradient) {
          reconstructed[column].push([term.weight, coefficient]);
        }
      }
      for (let column = 0; column < fixture.columnCount; column += 1) {
        const expected = fixture.rows[closure.rowIndex].gradient.get(column) ?? 0;
        expect(Math.abs(auditExactSum(reconstructed[column]) - expected)).toBeLessThanOrEqual(1e-10);
      }
      expect(Math.abs(dependent.mismatch)).toBeLessThanOrEqual(1e-8);
    }
    stdout.write('[sparse rank audit] ' + JSON.stringify({ deficiency, expected: fixture.rank,
      actual: result.rank, failure: result.failure, work: result.work, storedEntries: result.storedEntries }) + '\n');
  });

  it('returns unknown after accepting a proper prefix when its work budget is exhausted', () => {
    const fixture = sparseAuditRank(0), workLimit = fixture.columnCount + 2;
    const prefix = analyzeSparseRows(fixture.rows.slice(0, 1), fixture.columnCount, RANK_RELATIVE_TOLERANCE,
      { work: workLimit });
    expect(prefix.failure).toBeNull();
    expect(prefix.rank).toBe(1);
    const result = analyzeSparseRows(fixture.rows, fixture.columnCount, RANK_RELATIVE_TOLERANCE, { work: workLimit });
    expect(result.failure).toBe('workLimit');
    expect(result.rank).toBeNull();
    expect(result.work).toBeGreaterThan(workLimit);
    expect(result.storedEntries).toBe(prefix.storedEntries);
    stdout.write('[sparse rank exhausted] ' + JSON.stringify({ expected: fixture.rank, actual: result.rank,
      failure: result.failure, work: result.work, workLimit, acceptedPrefixRank: prefix.rank }) + '\n');
  });
});
