import { describe, expect, it } from 'vitest';
import { diagnoseTetraMeshQuality, readTetraMeshQualityLimits } from './tetraMeshQuality.js';
import { TETRA_LIMITS } from './tetraMesh.js';

const permissive = { minimumMeanRatio: 0, maximumEdgeRatio: 1e10 };
const regular = () => ({ coordinates: [1, 1, 1, 1, -1, -1, -1, -1, 1, -1, 1, -1], tetrahedra: [0, 1, 2, 3] });
const right = (x: number, y: number, z: number) => ({ coordinates: [0, 0, 0, x, 0, 0, 0, y, 0, 0, 0, z],
  tetrahedra: [0, 1, 2, 3] });

describe('independent tetrahedral shape diagnostics', () => {
  it('normalizes an analytic regular tetrahedron to one with explicit dimensional quantities', () => {
    const result = diagnoseTetraMeshQuality(regular(), { minimumMeanRatio: 1, maximumEdgeRatio: 1 });
    expect(result.elements[0].meanRatio).toBeCloseTo(1, 14);
    expect(result.elements[0].edgeRatio).toBe(1);
    expect(result.elements[0].volumeMm3).toBeCloseTo(8 / 3, 14);
    expect(result.elements[0].minimumEdgeMm).toBeCloseTo(Math.sqrt(8), 14);
    expect(result.meetsRequestedLimits).toBe(true);
    expect(result.physicsValidated).toBe(false);
    expect(result.boundaryValidated).toBe(false);
  });
  it('detects flattening with independent height formulas despite strictly positive volume', () => {
    let previous = Infinity;
    for (const h of [1, 0.1, 0.01]) {
      const result = diagnoseTetraMeshQuality(right(1, 1, h), { minimumMeanRatio: 0.5, maximumEdgeRatio: 10 });
      const cell = result.elements[0];
      expect(cell.volumeMm3).toBeCloseTo(h / 6, 14);
      expect(cell.meanRatio).toBeCloseTo(12 * (h / 2) ** (2 / 3) / (6 + 3 * h * h), 13);
      expect(cell.edgeRatio).toBeCloseTo(Math.sqrt(2) / h, 12);
      expect(cell.meanRatio).toBeLessThan(previous); previous = cell.meanRatio;
      expect(result.failingElements).toEqual(h === 1 ? [] : [0]);
    }
  });
  it('detects needle elements with independent length formulas', () => {
    let previous = Infinity;
    for (const length of [1, 10, 100]) {
      const cell = diagnoseTetraMeshQuality(right(length, 1, 1), permissive).elements[0];
      expect(cell.meanRatio).toBeCloseTo(12 * (length / 2) ** (2 / 3) / (3 * length * length + 6), 13);
      expect(cell.edgeRatio).toBeCloseTo(Math.sqrt(length * length + 1), 12);
      expect(cell.meanRatio).toBeLessThan(previous); previous = cell.meanRatio;
    }
  });
  it('preserves dimensionless shape under translation proper rotation and wide finite scales', () => {
    for (const scale of [1e-50, 1, 1e50]) {
      const mesh = regular();
      // (x,y,z) -> (-y,x,z) is a proper quarter-turn; translation is scale-relative.
      for (let i = 0; i < mesh.coordinates.length; i += 3) {
        const x = mesh.coordinates[i], y = mesh.coordinates[i + 1], z = mesh.coordinates[i + 2];
        mesh.coordinates.splice(i, 3, (8 - y) * scale, (16 + x) * scale, (32 + z) * scale);
      }
      const cell = diagnoseTetraMeshQuality(mesh, permissive).elements[0];
      expect(cell.meanRatio).toBeCloseTo(1, 12);
      expect(cell.edgeRatio).toBeCloseTo(1, 12);
      expect(cell.volumeMm3 / (scale * scale * scale)).toBeCloseTo(8 / 3, 11);
    }
  });
  it('keeps inclusive threshold equality and reports distinct violated criteria', () => {
    const equal = diagnoseTetraMeshQuality(regular(), { minimumMeanRatio: 1, maximumEdgeRatio: 1 });
    expect(equal.failingElements).toEqual([]);
    expect(diagnoseTetraMeshQuality(right(1, 1, 1), { minimumMeanRatio: 1, maximumEdgeRatio: 1 })
      .elements[0].violations).toEqual(['mean-ratio', 'edge-ratio']);
    expect(diagnoseTetraMeshQuality(right(1, 1, 1), { minimumMeanRatio: 0, maximumEdgeRatio: 1 })
      .elements[0].violations).toEqual(['edge-ratio']);
  });
  it('rejects malformed limits instead of silently installing a default', () => {
    for (const value of [null, {}, { minimumMeanRatio: -1, maximumEdgeRatio: 2 },
      { minimumMeanRatio: 1.01, maximumEdgeRatio: 2 }, { minimumMeanRatio: 0, maximumEdgeRatio: 0.9 },
      { minimumMeanRatio: NaN, maximumEdgeRatio: 2 }, { minimumMeanRatio: 0, maximumEdgeRatio: Infinity }]) {
      expect(() => readTetraMeshQualityLimits(value)).toThrow(/tetra-quality/u);
    }
  });
  it('rejects sparse nonfinite fractional repeated and out of range geometry', () => {
    const sparse = regular(), originalCoordinates = sparse.coordinates;
    sparse.coordinates = new Array<number>(originalCoordinates.length);
    for (let index = 0; index < originalCoordinates.length; index += 1) {
      if (index !== 2) sparse.coordinates[index] = originalCoordinates[index];
    }
    const nonfinite = regular(); nonfinite.coordinates[0] = Infinity;
    for (const mesh of [sparse, nonfinite, { ...regular(), tetrahedra: [0, 1, 2, 4] },
      { ...regular(), tetrahedra: [0, 1, 2, 2] }, { ...regular(), tetrahedra: [0, 1, 2, 2.5] },
      { ...regular(), tetrahedra: [0, 1, 2, 3, 1, 0, 3, 2] }]) {
      expect(() => diagnoseTetraMeshQuality(mesh, permissive)).toThrow(/tetra-quality/u);
    }
  });
  it('rejects zero or reversed volume without repairing the input ordering', () => {
    expect(() => diagnoseTetraMeshQuality(right(1, 1, 0), permissive)).toThrow(/zero or reversed/u);
    expect(() => diagnoseTetraMeshQuality({ ...regular(), tetrahedra: [0, 2, 1, 3] }, permissive))
      .toThrow(/zero or reversed/u);
  });
  it('refuses overflow underflow and coordinates rounded into a collapsed element', () => {
    for (const scale of [1e-200, 1e200]) {
      expect(() => diagnoseTetraMeshQuality(right(scale, scale, scale), permissive)).toThrow(/unrepresentable/u);
    }
    const collapsed = right(1, 1, 1);
    collapsed.coordinates = collapsed.coordinates.map(value => value + 1e20);
    expect(() => diagnoseTetraMeshQuality(collapsed, permissive)).toThrow(/zero or reversed/u);
    const overflow = right(Number.MAX_VALUE, 1, 1); overflow.coordinates[0] = -Number.MAX_VALUE;
    expect(() => diagnoseTetraMeshQuality(overflow, permissive)).toThrow(/coordinate difference/u);
  });
  it('rejects oversized input before reading any indexed value', () => {
    const coordinates = new Array<number>(TETRA_LIMITS.nodes * 3 + 3);
    Object.defineProperty(coordinates, 0, { get() { throw new Error('index must not be read'); } });
    expect(() => diagnoseTetraMeshQuality({ coordinates, tetrahedra: [0, 1, 2, 3] }, permissive))
      .toThrow('bounded dense dimensions');
    const tetrahedra = new Array<number>(TETRA_LIMITS.tetrahedra * 4 + 4);
    Object.defineProperty(tetrahedra, 0, { get() { throw new Error('index must not be read'); } });
    expect(() => diagnoseTetraMeshQuality({ ...regular(), tetrahedra }, permissive)).toThrow('bounded dense dimensions');
  });
  it('accepts the exact node allocation boundary and preserves even index permutation', () => {
    const mesh = regular();
    while (mesh.coordinates.length < TETRA_LIMITS.nodes * 3) mesh.coordinates.push(0, 0, 0);
    mesh.tetrahedra = [1, 0, 3, 2];
    const result = diagnoseTetraMeshQuality(mesh, permissive);
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0].meanRatio).toBe(1);
    expect(result.boundaryValidated).toBe(false);
  });
  it('never mutates or aliases input arrays or caller limits', () => {
    const mesh = regular(), before = structuredClone(mesh), policy = { minimumMeanRatio: 0, maximumEdgeRatio: 2 };
    Object.freeze(mesh.coordinates); Object.freeze(mesh.tetrahedra);
    const result = diagnoseTetraMeshQuality(mesh, policy);
    policy.minimumMeanRatio = 1;
    expect(mesh).toEqual(before);
    expect(result.limits.minimumMeanRatio).toBe(0);
  });
});
