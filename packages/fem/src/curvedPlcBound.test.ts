import { describe, expect, it } from 'vitest';
import { boundCurvedPlc, CurvedPlcRefusal, originTriangleDistance2, pointTriangleDistance, triangleSurfaceBound,
  type CurvedSurface, type FreeformPlcSurface } from './curvedPlcBound.js';

// AUTHOR-ONLY, UNEXECUTED (GO-21). Product path packages/fem/src/curvedPlcBound.test.ts. Expected values are derived
// from the geometry before execution; the two Astra counterexamples against 9d417253 are kept as regressions.
type V3 = readonly [number, number, number];
const ROOT3 = Math.sqrt(3);
type Curved = Exclude<CurvedSurface, { kind: 'plane' }>;
const sphere: Curved = { kind: 'sphere', center: [0, 0, 0], radius: 1 };
const cylinder: Curved = { kind: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], radius: 1 };
const noCheckpoint = (): void => undefined;
function refusal(run: () => unknown): string {
  try { run(); } catch (error) { if (error instanceof CurvedPlcRefusal) return error.code; throw error; }
  throw new Error('expected a refusal');
}

describe('cone and ring-torus bounds from actual triangle coordinates', () => {
  const cone: Curved = { kind: 'cone', origin: [0, 0, 0], axis: [0, 0, 1], referenceRadius: 0, semiAngle: Math.PI / 4 };
  const torus: Curved = { kind: 'torus', origin: [0, 0, 0], axis: [0, 0, 1], majorRadius: 3, minorRadius: 1 };

  it('encloses the complete cone apex triangle, including its interior chord maximum', () => {
    // Radius=height=2; the base chord is at x=sqrt(2). Its midpoint distance is (2-sqrt(2))/sqrt(2).
    const nodes: [V3, V3, V3] = [[0, 0, 0], [Math.SQRT2, -Math.SQRT2, 2], [Math.SQRT2, Math.SQRT2, 2]];
    const value = triangleSurfaceBound(cone, nodes, 1e-12);
    expect(value.offset).toBeLessThan(1e-12);
    expect(value.bound).toBeCloseTo(Math.SQRT2 - 1, 12);
    expect(boundCurvedPlc(nodes.flat(), [0, 1, 2], [0], [cone], 1e-12, noCheckpoint).faces[0].kind).toBe('cone');
  });

  it('retains cone sign, translated/rotated axes and tiny rounded apex offsets without a second nappe', () => {
    const negative: Curved = { kind: 'cone', origin: [7, 8, 9], axis: [1, 0, 0], referenceRadius: 0, semiAngle: -Math.PI / 4 };
    const nodes: [V3, V3, V3] = [[7, 8, 9], [5, 8 + Math.SQRT2, 9 - Math.SQRT2], [5, 8 + Math.SQRT2, 9 + Math.SQRT2]];
    expect(triangleSurfaceBound(negative, nodes, 1e-12).bound).toBeCloseTo(Math.SQRT2 - 1, 12);
    expect(refusal(() => triangleSurfaceBound(cone, [[1, 0, -1], [0, 1, -1], [0, 0, 0]], 1e-12))).toBe('off-surface-node');
    const nearApex: [V3, V3, V3] = [[0, 0, -1e-14], [1, 0, 1], [0, 1, 1]];
    expect(triangleSurfaceBound(cone, nearApex, 1e-12).offset).toBeCloseTo(1e-14, 15);
  });

  it.each([0, 1e-15, 1e-9])('bounds a narrow cone triangle with an opposite radial apex offset %s without discarding it', epsilon => {
    const surface: Curved = { kind: 'cone', origin: [0, 0, 0], axis: [0, 0, 1],
      referenceRadius: 10, semiAngle: -Math.atan(0.5) };
    const radius = 1.25, halfAngle = 0.1;
    const nodes: [V3, V3, V3] = [[-epsilon, 0, 20],
      [radius * Math.cos(halfAngle), -radius * Math.sin(halfAngle), 17.5],
      [radius * Math.cos(halfAngle), radius * Math.sin(halfAngle), 17.5]];
    const value = triangleSurfaceBound(surface, nodes, 1e-6);
    // Independent meridian geometry: closest point on the generating RAY (r,q)=t*(1,2), q=20-z.
    // This includes the apex and rejects using the other cone nappe as a nearest point.
    const distance = (p: V3): number => {
      const r = Math.hypot(p[0], p[1]), q = 20 - p[2], t = Math.max(0, (r + 2 * q) / 5);
      return Math.hypot(r - t, q - 2 * t);
    };
    const midpoint: V3 = [(nodes[1][0] + nodes[2][0]) / 2, 0, 17.5];
    expect(distance(midpoint)).toBeGreaterThan(0.005);
    expect(value.bound).toBeGreaterThanOrEqual(distance(midpoint) - 1e-13);
    expect(value.bound).toBeLessThan(0.02); // Original native caller's 0.2 mm budget is unchanged.
    for (let i = 0; i <= 20; i += 1) for (let j = 0; j <= 20 - i; j += 1) {
      const a = i / 20, b = j / 20, c = 1 - a - b;
      const point: V3 = [a * nodes[0][0] + b * nodes[1][0] + c * nodes[2][0],
        a * nodes[0][1] + b * nodes[1][1] + c * nodes[2][1],
        a * nodes[0][2] + b * nodes[1][2] + c * nodes[2][2]];
      expect(distance(point)).toBeLessThanOrEqual(value.bound + 1e-13);
    }
    expect(triangleSurfaceBound(surface, [nodes[2], nodes[0], nodes[1]], 1e-6).bound).toBeCloseTo(value.bound, 12);
    const transform = (p: V3): V3 => [7 + p[2], 8 + p[0], 9 + p[1]];
    const placed: Curved = { ...surface, origin: [7, 8, 9], axis: [1, 0, 0] };
    expect(triangleSurfaceBound(placed, [transform(nodes[0]), transform(nodes[1]), transform(nodes[2])], 1e-6).bound)
      .toBeCloseTo(value.bound, 12);
  });

  it('keeps a genuinely wide apex chord above the budget and refuses an off-surface apex', () => {
    const surface: Curved = { kind: 'cone', origin: [0, 0, 0], axis: [0, 0, 1],
      referenceRadius: 10, semiAngle: -Math.atan(0.5) };
    const radius = 1.25, angle = Math.PI / 3;
    const wide: [V3, V3, V3] = [[-1e-15, 0, 20], [radius * Math.cos(angle), -radius * Math.sin(angle), 17.5],
      [radius * Math.cos(angle), radius * Math.sin(angle), 17.5]];
    // At the base chord midpoint, distance to the generating line is (1.25-0.625)*2/sqrt(5).
    const actualMidpointDistance = 0.625 * 2 / Math.sqrt(5);
    expect(actualMidpointDistance).toBeGreaterThan(0.2);
    expect(triangleSurfaceBound(surface, wide, 1e-6).bound).toBeGreaterThanOrEqual(actualMidpointDistance - 1e-13);
    expect(refusal(() => triangleSurfaceBound(surface, [[-0.01, 0, 20], wide[1], wide[2]], 1e-6))).toBe('off-surface-node');
  });

  it('handles torus periodic wrapping using actual coordinates, and encloses an interior deviation with exact vertices', () => {
    const angle = Math.PI / 6;
    const nodes: [V3, V3, V3] = [[4 * Math.cos(angle), -4 * Math.sin(angle), 0],
      [4 * Math.cos(angle), 4 * Math.sin(angle), 0], [3, 0, 1]];
    const value = triangleSurfaceBound(torus, nodes, 1e-12);
    const chordMidpointDeviation = 4 * (1 - Math.cos(angle));
    expect(value.offset).toBeLessThan(1e-12);
    expect(value.bound).toBeGreaterThanOrEqual(chordMidpointDeviation);
    expect(value.bound).toBeLessThan(1); // improve the old rectangle while retaining the independent midpoint lower bound
    const reversed = triangleSurfaceBound(torus, [nodes[2], nodes[1], nodes[0]], 1e-12);
    expect(reversed.bound).toBeCloseTo(value.bound, 12);
    expect(reversed.offset).toBeCloseTo(value.offset, 12);
  });

  it('encloses the concave inner torus chord and keeps placement/scale separate from its analytic axis', () => {
    const h = 0.1;
    const nodes: [V3, V3, V3] = [[2 * Math.cos(h), -2 * Math.sin(h), 0],
      [2 * Math.cos(h), 2 * Math.sin(h), 0], [3 - Math.cos(h), 0, Math.sin(h)]];
    // Inner equator: its chord midpoint is closer to the axis, farther from the tube center by 2*(1-cos(h)).
    const expected = 2 * (1 - Math.cos(h));
    const result = triangleSurfaceBound(torus, nodes, 1e-12);
    expect(result.bound).toBeGreaterThanOrEqual(expected - 1e-14);
    expect(result.bound).toBeLessThan(0.04);
    const transform = (p: V3): V3 => [11 + 3 * p[2], 13 + 3 * p[0], 17 + 3 * p[1]];
    const placed: Curved = { kind: 'torus', origin: [11, 13, 17], axis: [1, 0, 0], majorRadius: 9, minorRadius: 3 };
    const moved = triangleSurfaceBound(placed, [transform(nodes[0]), transform(nodes[1]), transform(nodes[2])], 1e-12);
    expect(moved.bound).toBeGreaterThanOrEqual(3 * expected - 1e-13);
    expect(moved.bound).toBeCloseTo(3 * result.bound, 11);
    expect(moved.offset).toBeLessThan(1e-12);
  });

  it('keeps the ring hole distinct from the tube and rejects absent/singular/nonfinite primitives', () => {
    expect(refusal(() => triangleSurfaceBound(torus, [[0, 0, 0], [4, 0, 0], [3, 0, 1]], 0.01))).toBe('off-surface-node');
    for (const bad of [
      { ...torus, majorRadius: 1 }, { ...torus, minorRadius: 0 }, { ...torus, minorRadius: Number.POSITIVE_INFINITY },
      { ...cone, semiAngle: 0 }, { ...cone, semiAngle: Math.PI / 2 }, { ...cone, referenceRadius: -1 },
    ]) {
      expect(refusal(() => triangleSurfaceBound(bad, [[0, 0, 0], [1, 0, 1], [0, 1, 1]], 1e-12))).toBe('invalid-surface');
    }
  });

  it('bounds an oblique torus patch quadratically under refinement, with an independent interior chord control', () => {
    const v = Math.PI / 4;
    const at = (u: number, w: number): V3 => [(3 + Math.cos(w)) * Math.cos(u), (3 + Math.cos(w)) * Math.sin(u), Math.sin(w)];
    const values = [0.04, 0.02].map(h => {
      const value = triangleSurfaceBound(torus, [at(-h, v), at(h, v), at(0, v + h)], 1e-12);
      // The midpoint of the first edge has these exact radial/axial coordinates, independent of the bound code.
      const midpointDistance = 1 - Math.hypot((3 + Math.cos(v)) * Math.cos(h) - 3, Math.sin(v));
      expect(midpointDistance).toBeGreaterThan(0);
      expect(value.bound).toBeGreaterThanOrEqual(midpointDistance);
      expect(value.offset).toBeLessThan(1e-12);
      return value.bound;
    });
    expect(values[0]).toBeLessThan(0.02);
    expect(values[1]).toBeLessThan(values[0] * 0.3);
  });


  it('encloses an oblique R10/r3 torus triangle below .2 where both old enclosures exceed .2', () => {
    const surface: Curved = { kind: 'torus', origin: [0, 0, 0], axis: [0, 0, 1], majorRadius: 10, minorRadius: 3 };
    const h = 0.12, v0 = Math.PI / 4 - 0.15, v1 = Math.PI / 4 + 0.15;
    const at = (u: number, v: number): V3 => [(10 + 3 * Math.cos(v)) * Math.cos(u),
      (10 + 3 * Math.cos(v)) * Math.sin(u), 3 * Math.sin(v)];
    const nodes: [V3, V3, V3] = [at(-h, v0), at(h, v0), at(0, v1)];
    // Analytic old bounds, independently derived for this symmetric triangle:
    // rho_min is at C; z_min is on AB. The rectangle combines these different points.
    const minTube = Math.hypot(3 * Math.cos(v1), 3 * Math.sin(v0));
    const longEdge = 2 * (10 + 3 * Math.cos(v0)) * Math.sin(h);
    expect(3 - minTube).toBeGreaterThan(0.2);
    expect(longEdge * longEdge / (6 * minTube)).toBeGreaterThan(0.2);
    // Whole-triangle independent geometric enclosure: the meridian-circle chord
    // loses <=3*(1-cos(.15)); azimuth projection loses <=rho_max*(1-cos(h)).
    const geometricCeiling = 3 * (1 - Math.cos(0.15)) + (10 + 3 * Math.cos(v0)) * (1 - Math.cos(h));
    expect(geometricCeiling).toBeLessThan(0.124);
    const value = triangleSurfaceBound(surface, nodes, 1e-12);
    expect(value.offset).toBeLessThan(1e-12);
    expect(value.bound).toBeLessThan(0.2);
    const mid: V3 = [(nodes[0][0] + nodes[1][0]) / 2, 0, nodes[0][2]];
    const actualMidOffset = Math.abs(Math.hypot(Math.hypot(mid[0], mid[1]) - 10, mid[2]) - 3);
    expect(actualMidOffset).toBeGreaterThan(0.01); // internal subdivision points are NOT surface nodes
    expect(value.bound).toBeGreaterThanOrEqual(actualMidOffset - 1e-13);
    // Independent barycentric controls validate locations throughout the triangle;
    // production proof remains the full-cell enclosure, never these samples.
    for (let i = 0; i <= 12; i += 1) for (let j = 0; j <= 12 - i; j += 1) {
      const weights = [i / 12, j / 12, (12 - i - j) / 12];
      const x = nodes.reduce((sum, p, k) => sum + weights[k] * p[0], 0);
      const y = nodes.reduce((sum, p, k) => sum + weights[k] * p[1], 0);
      const z = nodes.reduce((sum, p, k) => sum + weights[k] * p[2], 0);
      const distance = Math.abs(Math.hypot(Math.hypot(x, y) - 10, z) - 3);
      expect(distance).toBeLessThanOrEqual(geometricCeiling + 1e-12);
      expect(distance).toBeLessThanOrEqual(value.bound + 1e-12);
    }
    const orderings: readonly (readonly [V3, V3, V3])[] = [nodes, [nodes[0], nodes[2], nodes[1]],
      [nodes[1], nodes[0], nodes[2]], [nodes[1], nodes[2], nodes[0]],
      [nodes[2], nodes[0], nodes[1]], [nodes[2], nodes[1], nodes[0]]];
    for (const order of orderings) expect(triangleSurfaceBound(surface, order, 1e-12).bound).toBeCloseTo(value.bound, 11);
    const transform = (p: V3): V3 => [7 + 2 * p[2], -5 + 2 * p[0], 11 + 2 * p[1]];
    const placed: Curved = { ...surface, origin: [7, -5, 11], axis: [1, 0, 0], majorRadius: 20, minorRadius: 6 };
    const moved = triangleSurfaceBound(placed, [transform(nodes[0]), transform(nodes[1]), transform(nodes[2])], 1e-11);
    expect(moved.bound).toBeCloseTo(2 * value.bound, 10);
    expect(moved.offset).toBeLessThan(1e-11);
  });

  it('retains a genuinely excessive torus chord and rejects off-surface native nodes', () => {
    const surface: Curved = { kind: 'torus', origin: [0, 0, 0], axis: [0, 0, 1], majorRadius: 10, minorRadius: 3 };
    const at = (u: number, v: number): V3 => [(10 + 3 * Math.cos(v)) * Math.cos(u),
      (10 + 3 * Math.cos(v)) * Math.sin(u), 3 * Math.sin(v)];
    const nodes: [V3, V3, V3] = [at(-0.4, 0), at(0.4, 0), at(0, 0.2)];
    const actualMidOffset = 13 * (1 - Math.cos(0.4));
    expect(actualMidOffset).toBeGreaterThan(1);
    expect(triangleSurfaceBound(surface, nodes, 1e-12).bound).toBeGreaterThanOrEqual(actualMidOffset - 1e-12);
    expect(refusal(() => triangleSurfaceBound(surface, [[0, 0, 0], nodes[1], nodes[2]], 1e-12))).toBe('off-surface-node');
  });

  it('keeps axial bounds finite at extreme scales or refuses the actual nonfinite projection', () => {
    const nodes: [V3, V3, V3] = [[4, 0, 0], [3, 0, 1], [3, 1, 0]];
    // Third point is off the torus: scaling a bad physical point must not turn it into an admitted one.
    for (const factor of [1e-100, 1e100]) {
      const scaled: Curved = { ...torus, majorRadius: 3 * factor, minorRadius: factor };
      const multiply = (p: V3): V3 => [p[0] * factor, p[1] * factor, p[2] * factor];
      const points: [V3, V3, V3] = [multiply(nodes[0]), multiply(nodes[1]), multiply(nodes[2])];
      expect(refusal(() => triangleSurfaceBound(scaled, points, factor * 1e-12))).toBe('off-surface-node');
    }
    const far: Curved = { ...torus, origin: [-1.7e308, 0, 0] };
    expect(refusal(() => triangleSurfaceBound(far, [[1.7e308, 0, 0], [4, 0, 0], [3, 0, 1]], 1e-12))).toBe('invalid-input');
  });
});

describe('conservative chord-deviation bound from actual coordinates', () => {
  it.each(['bspline', 'bezier', 'extrusion'] as const)('consumes exact %s triangle evidence and rejects missing or mislabelled rows', surfaceKind => {
    // S(u,v)=(u,u^2,v); endpoint chord over u in [0,1] has maximum deviation 1/4.
    const coordinates = [0, 0, 2, 1, 1, 2, 0, 0, 5];
    const row = { triangleIndex: 0, maxNodeOffsetMm: 0, maxChordDeviationMm: 0.25 };
    const surface: FreeformPlcSurface = { kind: 'freeform', surfaceKind, triangles: [row] };
    const result = boundCurvedPlc(coordinates, [0, 1, 2], [0], [surface], 1e-12, noCheckpoint);
    expect(result.maxChordDeviationBoundMm).toBe(0.25);
    expect(result).toMatchObject({ estimateIsBound: false, exactProof: false, globalCertified: false });
    for (const triangles of [[], [row, row], [{ ...row, triangleIndex: 1 }],
      [{ ...row, maxChordDeviationMm: Number.POSITIVE_INFINITY }]]) {
      expect(refusal(() => boundCurvedPlc(coordinates, [0, 1, 2], [0], [{ ...surface, triangles }], 1e-12, noCheckpoint)))
        .toBe('invalid-surface');
    }
    expect(refusal(() => boundCurvedPlc(coordinates, [0, 1, 2], [1], [surface, { kind: 'plane' }], 1e-12, noCheckpoint)))
      .toBe('invalid-surface');
    const unknown: FreeformPlcSurface = { ...surface };
    Object.defineProperty(unknown, 'surfaceKind', { value: 'offset' });
    expect(refusal(() => boundCurvedPlc(coordinates, [0, 1, 2], [0], [unknown], 1e-12, noCheckpoint)))
      .toBe('invalid-surface');
  });

  it('Astra counterexample 1: vertices inside the tolerance band, centroid deviation 0.212 is enclosed', () => {
    const z = 0.788;
    const nodes: [V3, V3, V3] = [[0.6, 0, z], [-0.3, 0.3 * ROOT3, z], [-0.3, -0.3 * ROOT3, z]];
    const { offset, bound } = triangleSurfaceBound(sphere, nodes, 0.01);
    expect(offset).toBeCloseTo(1 - Math.sqrt(0.980944), 12);
    // The centroid (0, 0, 0.788) is the closest triangle point to the center: deviation 1 - 0.788 = 0.212.
    expect(bound).toBeGreaterThanOrEqual(0.212 - 1e-12);
    expect(bound).toBeCloseTo(0.212, 12);
    // The superseded ideal-sphere formula gave 0.21 here; the regression is that the bound never falls below 0.212.
    expect(bound).toBeGreaterThan(0.21);
  });

  it('Astra counterexample 2: inscribed regular tetrahedron chord bound is exactly 2/3 and the estimate is not a volume bound', () => {
    const v: V3[] = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]].map(p => [p[0] / ROOT3, p[1] / ROOT3, p[2] / ROOT3] as const);
    const coordinates = v.flat();
    const triangles = [0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2];
    const result = boundCurvedPlc(coordinates, triangles, [0, 0, 0, 0], [sphere], 1e-12, noCheckpoint);
    expect(result.maxChordDeviationBoundMm).toBeCloseTo(2 / 3, 12);
    expect(result.volumeDeviationEstimateMm3).toBeCloseTo((16 * ROOT3) / 9, 10);
    const trueGap = (4 * Math.PI) / 3 - 8 / (9 * ROOT3);
    expect(result.volumeDeviationEstimateMm3).toBeLessThan(trueGap); // why it is labelled an estimate
    expect(result).toMatchObject({ estimateIsBound: false, exactProof: false, globalCertified: false });
  });

  it('cylinder: a chord triangle bound equals r - (distance from the axis to the triangle)', () => {
    const a = Math.PI / 6; // nodes at angles 0 and 60 degrees: the chord midpoint is at distance cos(30 deg)
    const nodes: [V3, V3, V3] = [[1, 0, 0], [Math.cos(2 * a), Math.sin(2 * a), 0], [1, 0, 5]];
    const { bound } = triangleSurfaceBound(cylinder, nodes, 1e-12);
    expect(bound).toBeCloseTo(1 - Math.cos(a), 12);
    // A triangle whose projection contains the axis is bounded by the full radius, never underestimated.
    const across: [V3, V3, V3] = [[1, 0, 0], [-0.5, ROOT3 / 2, 1], [-0.5, -ROOT3 / 2, 2]];
    expect(triangleSurfaceBound(cylinder, across, 1e-12).bound).toBeCloseTo(1, 12);
  });

  it('refuses off-surface nodes, missing analytic parameters and unknown labels; planar labels are left to the planar contract', () => {
    const coordinates = [1, 0, 0, 0, 1, 0, 0, 0, 1.5];
    expect(refusal(() => boundCurvedPlc(coordinates, [0, 1, 2], [0], [sphere], 0.01, noCheckpoint))).toBe('off-surface-node');
    expect(refusal(() => boundCurvedPlc(coordinates, [0, 1, 2], [1], [sphere], 0.01, noCheckpoint))).toBe('invalid-input');
    expect(refusal(() => boundCurvedPlc(coordinates, [0, 1, 2], [0], [{ kind: 'sphere', center: [0, 0, 0], radius: 0 }], 0.01, noCheckpoint)))
      .toBe('invalid-surface');
    expect(refusal(() => boundCurvedPlc(coordinates, [0, 1, 2], [0], [sphere], 0, noCheckpoint))).toBe('invalid-input');
    expect(boundCurvedPlc(coordinates, [0, 1, 2], [0], [{ kind: 'plane' }], 0.01, noCheckpoint).faces).toEqual([]);
  });

  it('cancellation: a throwing checkpoint propagates its own value', () => {
    const sentinel = new Error('cancelled');
    expect(() => boundCurvedPlc([1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 1, 2], [0], [sphere], 0.01, () => { throw sentinel; })).toThrow(sentinel);
  });

  it('distance helpers: exact closest points', () => {
    expect(pointTriangleDistance([0, 0, 2], [0, 0, 0], [1, 0, 0], [0, 1, 0])).toBe(2);
    expect(pointTriangleDistance([2, 2, 0], [0, 0, 0], [1, 0, 0], [0, 1, 0])).toBeCloseTo(Math.hypot(1.5, 1.5), 12);
    expect(originTriangleDistance2([1, -1], [1, 1], [2, 0])).toBe(1);
    expect(originTriangleDistance2([-1, -1], [1, -1], [0, 1])).toBe(0);
  });
});

describe('independent 3D area and finite-product/accumulation guards', () => {
  it('keeps a positive-area 3D triangle whose axis-normal projection is only a segment', () => {
    // Right triangle area=5/sqrt(2); the projected chord has minimum radius=1/sqrt(2).
    const value = boundCurvedPlc([1, 0, 0, 0, 1, 0, 1, 0, 5], [0, 1, 2], [0], [cylinder], 1e-12, noCheckpoint);
    expect(value.maxChordDeviationBoundMm).toBeCloseTo(1 - Math.SQRT1_2, 12);
    expect(value.volumeDeviationEstimateMm3).toBeCloseTo(5 * Math.SQRT1_2 * (1 - Math.SQRT1_2), 12);
    expect(value).toMatchObject({ estimateIsBound: false, exactProof: false, globalCertified: false });
  });

  it('refuses zero 3D area despite distinct finite on-surface vertices', () => {
    expect(refusal(() => boundCurvedPlc([1, 0, 0, 1, 0, 1, 1, 0, 2], [0, 1, 2], [0], [cylinder], 1e-12, noCheckpoint)))
      .toBe('invalid-input');
  });

  it('refuses an overflowing area from finite on-surface coordinates', () => {
    // Cross=(H,H,0), H=1.7e308. Distance to the axis remains finite; its cross norm exceeds binary64 range.
    expect(refusal(() => boundCurvedPlc([1, 0, 0, 0, 1, 0, 1, 0, 1.7e308], [0, 1, 2], [0], [cylinder], 1e-12, noCheckpoint)))
      .toBe('invalid-input');
  });

  it('refuses a product overflow even when area and chord distance are individually finite', () => {
    const radius = 1e153, height = 1e153;
    const surface: CurvedSurface = { ...cylinder, radius };
    // Area~7.07e305 and distance~2.93e152 are finite, but their product is not.
    expect(refusal(() => boundCurvedPlc([radius, 0, 0, 0, radius, 0, radius, 0, height], [0, 1, 2], [0],
      [surface], 1e142, noCheckpoint))).toBe('invalid-input');
  });

  it.each([false, true])('refuses accumulation overflow across individually finite triangles (separate faces=%s)', separateFaces => {
    const radius = 1e100, height = 4e108;
    const surface: CurvedSurface = { ...cylinder, radius };
    const coordinates = [0, 1, 2].flatMap(k => [radius, 0, k * height, 0, radius, k * height, radius, 0, (k + 1) * height]);
    const triangles = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    const tags = separateFaces ? [0, 1, 2] : [0, 0, 0];
    // Each area*distance = 4e308*(1/sqrt(2)-1/2) ~8.28e307. One and two are finite; three overflow.
    const one = boundCurvedPlc(coordinates, [0, 1, 2], [0], [surface], 1e89, noCheckpoint);
    expect(Number.isFinite(one.volumeDeviationEstimateMm3)).toBe(true);
    expect(one.volumeDeviationEstimateMm3).toBeGreaterThan(8e307);
    expect(one.volumeDeviationEstimateMm3).toBeLessThan(9e307);
    expect(refusal(() => boundCurvedPlc(coordinates, triangles, tags, [surface, surface, surface], 1e89, noCheckpoint)))
      .toBe('invalid-input');
  });
});
