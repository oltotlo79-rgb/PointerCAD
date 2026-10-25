import { describe, expect, it } from 'vitest';
import { boundFreeformDerivatives, freeformTriangleDistance, partitionedFreeformTriangleDistance, reduceAffineFreeformFans,
  type FreeformCoefficients, type FreeformPatchGrid } from './analysisFreeformBound.js';

const checkpoint = (): void => undefined;
type UV = readonly [number, number];
type Point = readonly [number, number, number];
type Triangle = readonly [number, number, number];
describe('affine native-cell interior fan reduction', () => {
  const uv: readonly UV[] = [[0.5, 0.5], [0, 0], [1, 0], [1, 1], [0, 1]];
  const triangles: readonly Triangle[] = [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 1]];
  const grid: FreeformPatchGrid = { u: [0, 1], v: [0, 1], uPeriodic: false, vPeriodic: false,
    patches: [{ u: [0, 1], v: [0, 1], uu: 0, uv: 0, vv: 0 }], point: ([u, v]) => [11, 13 + u, 17 + v] };
  const reduce = (input = triangles, params = uv, chart = grid, protectedNodes: ReadonlySet<number> = new Set(),
    point: (node: number) => Point = node => chart.point(params[node])): readonly Triangle[] =>
    reduceAffineFreeformFans(chart, input, params, point, protectedNodes, 2048, 0.02, 0.15, checkpoint);
  const boundary = (input: readonly Triangle[]): string[] => {
    const uses = new Map<string, number>();
    for (const [a, b, c] of input) for (const [x, y] of [[a, b], [b, c], [c, a]]) {
      const reverse = `${y}:${x}`, key = `${x}:${y}`;
      if (uses.has(reverse)) uses.delete(reverse); else uses.set(key, 1);
    }
    return [...uses.keys()].sort();
  };
  it.each([false, true])('preserves the square area, directed boundary and native placement (reversed=%s)', reversed => {
    const input: readonly Triangle[] = reversed ? triangles.map(([a, b, c]) => [a, c, b]) : triangles;
    const result = reduce(input);
    expect(result).toHaveLength(2);
    expect(boundary(result)).toEqual(boundary(input));
    expect(new Set(result.flat())).toEqual(new Set([1, 2, 3, 4]));
    let signedArea = 0;
    for (const [a, b, c] of result) {
      signedArea += ((uv[b][0] - uv[a][0]) * (uv[c][1] - uv[a][1])
        - (uv[b][1] - uv[a][1]) * (uv[c][0] - uv[a][0])) / 2;
      const bound = partitionedFreeformTriangleDistance(grid, [uv[a], uv[b], uv[c]],
        [grid.point(uv[a]), grid.point(uv[b]), grid.point(uv[c])], checkpoint);
      expect(bound).toEqual({ maxNodeOffsetMm: 0, maxChordDeviationMm: 0 });
    }
    expect(signedArea).toBe(reversed ? -1 : 1);
  });
  it('keeps protected shared nodes, C0-line nodes, cross-cell fans and non-affine cells', () => {
    expect(reduce(triangles, uv, grid, new Set([0]))).toBe(triangles);
    const split: FreeformPatchGrid = { ...grid, u: [0, 0.5, 1], patches: [
      { u: [0, 0.5], v: [0, 1], uu: 0, uv: 0, vv: 0 },
      { u: [0.5, 1], v: [0, 1], uu: 0, uv: 0, vv: 0 }] };
    expect(reduce(triangles, uv, split)).toBe(triangles);
    expect(reduce(triangles, [[0.25, 0.5], ...uv.slice(1)], split)).toBe(triangles);
    expect(reduce(triangles, uv, { ...grid, patches: [{ ...grid.patches[0], uv: Number.EPSILON }] })).toBe(triangles);
  });
  it('retains both uses of a shared boundary when simplifying two disjoint interior stars', () => {
    const params: readonly UV[] = [...uv, [1.5, 0.5], [2, 0], [2, 1]];
    const input: readonly Triangle[] = [...triangles, [5, 2, 6], [5, 6, 7], [5, 7, 3], [5, 3, 2]];
    const chart: FreeformPatchGrid = { ...grid, u: [0, 2], patches: [{ ...grid.patches[0], u: [0, 2] }] };
    const result = reduce(input, params, chart, new Set([2, 3]));
    expect(result).toHaveLength(4);
    expect(boundary(result)).toEqual(boundary(input));
    const edges = result.flatMap(([a, b, c]) => [[a, b], [b, c], [c, a]]);
    expect(edges.filter(([a, b]) => a === 2 && b === 3)).toHaveLength(1);
    expect(edges.filter(([a, b]) => a === 3 && b === 2)).toHaveLength(1);
    expect(new Set(result.flat())).toEqual(new Set([1, 2, 3, 4, 6, 7]));
  });
  it('does not conceal a concave, crossing, disconnected, duplicated or incomplete fan', () => {
    for (const params of [
      [[0.2, 0.2], [0, 0], [1, 0], [0.25, 0.25], [0, 1]],
      [[0.5, 0.5], [0, 0], [1, 1], [1, 0], [0, 1]],
      [[0.5, 0.5], [0, 0], [1, 0], [1, 0], [0, 1]],
    ] satisfies UV[][]) expect(reduce(triangles, params)).toBe(triangles);
    for (const input of [triangles.slice(1), [...triangles, triangles[0]],
      [[0, 1, 2], [0, 2, 1], [0, 3, 4], [0, 4, 3]], [[0, 0, 1], ...triangles]] satisfies (readonly Triangle[])[]) {
      expect(reduce(input)).toBe(input);
    }
  });
  it('retains old triangles on uncertain floating signs, node offsets and angular error', () => {
    const translated = uv.map(([u, v]): UV => [1e15 + u, 1e15 + v]);
    const large: FreeformPatchGrid = { ...grid, u: [1e15, 1e15 + 1], v: [1e15, 1e15 + 1],
      patches: [{ u: [1e15, 1e15 + 1], v: [1e15, 1e15 + 1], uu: 0, uv: 0, vv: 0 }],
      point: ([u, v]) => [u, v, 0] };
    expect(reduce(triangles, translated, large)).toBe(triangles);
    const enormous = uv.map(([u, v]): UV => [(u - 0.5) * 1e200, (v - 0.5) * 1e200]);
    expect(reduce(triangles, enormous, { ...large, u: [-1e200, 1e200], v: [-1e200, 1e200],
      patches: [{ u: [-1e200, 1e200], v: [-1e200, 1e200], uu: 0, uv: 0, vv: 0 }] })).toBe(triangles);
    expect(reduce(triangles, uv, grid, new Set(), node => {
      const p = grid.point(uv[node]); return [p[0] + 0.021, p[1], p[2]];
    })).toBe(triangles);
    expect(reduce(triangles, uv, grid, new Set(), node => {
      const p = grid.point(uv[node]); return [p[0] + (node === 0 ? 0.021 : 0), p[1], p[2]];
    })).toBe(triangles);
    // Small physical square: an offset inside the distance budget can still violate the angle budget.
    const small: FreeformPatchGrid = { ...grid, point: ([u, v]) => [0.01 * u, 0.01 * v, 0] };
    for (const scale of [0.01, 1e-100]) {
      const chart: FreeformPatchGrid = { ...grid, point: ([u, v]) => [scale * u, scale * v, 0] };
      expect(reduce(triangles, uv, chart, new Set(), node => {
        const p = chart.point(uv[node]); return [p[0], p[1], node === 3 ? scale : 0];
      })).toBe(triangles);
    }
    // UV convexity alone cannot justify crossed physical edges, even inside the distance allowance.
    expect(reduce(triangles, uv, small, new Set(), node =>
      small.point(uv[node === 2 ? 3 : node === 3 ? 2 : node]))).toBe(triangles);
  });
  it('preserves the existing allocation cap and cancellation object', () => {
    expect(reduceAffineFreeformFans(grid, triangles, uv, node => grid.point(uv[node]), new Set(), 3, 0.02, 0.15, checkpoint))
      .toBe(triangles);
    const stopped = new Error('owned deadline');
    expect(() => reduceAffineFreeformFans(grid, triangles, uv, node => grid.point(uv[node]), new Set(), 2048, 0.02, 0.15,
      () => { throw stopped; })).toThrow(stopped);
  });
});
// Tensor Bezier S(u,v)=(u,v,u^2), independently polynomial, not values produced by the bound implementation.
const parabola: FreeformCoefficients = {
  u: { degree: 2, knots: [0, 0, 0, 1, 1, 1] }, v: { degree: 1, knots: [0, 0, 1, 1] },
  poles: [[0, 0, 0], [0, 1, 0], [0.5, 0, 0], [0.5, 1, 0], [1, 0, 1], [1, 1, 1]],
  weights: [1, 1, 1, 1, 1, 1],
};
describe('freeform control-net distance bounds', () => {
  it('retains the two actual V endpoints and affine placement of a quadratic extrusion tensor', () => {
    // S(u,v)=(u,u^2,v), v in [2,5], followed by 3*(z,x,y)+(11,13,17).
    const poles: [number, number, number][] = [];
    for (const [x, y] of [[0, 0], [0.5, 0], [1, 1]]) for (const v of [2, 5]) {
      poles.push([11 + 3 * v, 13 + 3 * x, 17 + 3 * y]);
    }
    const tensor: FreeformCoefficients = { u: parabola.u, v: { degree: 1, knots: [2, 2, 5, 5] },
      poles, weights: [1, 1, 1, 1, 1, 1] };
    const bound = boundFreeformDerivatives(tensor, checkpoint);
    expect(bound).toMatchObject({ uu: 6, uv: 0, vv: 0, v: [2, 5] });
    expect(freeformTriangleDistance(bound, [[0, 2], [1, 2], [0, 5]], 0)).toBe(0.75);
    expect(() => boundFreeformDerivatives({ ...tensor, v: { degree: 1, knots: [2, 2, 2, 2] } }, checkpoint))
      .toThrow('invalid chart domain');
  });

  it('encloses the interior parabola chord missed by a zero vertex-offset test, and converges quadratically', () => {
    const bound = boundFreeformDerivatives(parabola, checkpoint);
    expect(bound).toMatchObject({ uu: 2, uv: 0, vv: 0 });
    expect(freeformTriangleDistance(bound, [[0, 0], [1, 0], [0, 1]], 0)).toBe(0.25);
    expect(freeformTriangleDistance(bound, [[0, 0], [0.5, 0], [0, 0.5]], 0)).toBe(0.0625);
    expect(freeformTriangleDistance(bound, [[0, 0], [1, 0], [0, 1]], 0.01)).toBe(0.26);
  });
  it('retains positive rational weight variation and is invariant to a common weight scale', () => {
    const rational = { ...parabola, weights: [1, 1, 2, 2, 4, 4] };
    const bound = boundFreeformDerivatives(rational, checkpoint);
    // S(1/2,0)=(2/3,0,4/9), while its endpoint chord midpoint=(1/2,0,1/2).
    const actual = Math.hypot(1 / 6, 1 / 18);
    expect(freeformTriangleDistance(bound, [[0, 0], [1, 0], [0, 1]], 0)).toBeGreaterThanOrEqual(actual);
    expect(boundFreeformDerivatives({ ...rational, weights: rational.weights.map(w => w * 1e100) }, checkpoint)).toEqual(bound);
  });
  it('keeps the polynomial bound across a genuine C1 interior B-spline knot', () => {
    // Exact knot insertion of u=1/2 into u^2: x control values 0,1/4,3/4,1; z values 0,0,1/2,1.
    const spline: FreeformCoefficients = { u: { degree: 2, knots: [0, 0, 0, 0.5, 1, 1, 1] }, v: parabola.v,
      poles: [[0, 0, 0], [0, 1, 0], [0.25, 0, 0], [0.25, 1, 0],
        [0.75, 0, 0.5], [0.75, 1, 0.5], [1, 0, 1], [1, 1, 1]], weights: new Array<number>(8).fill(1) };
    const bound = boundFreeformDerivatives(spline, checkpoint);
    expect(bound).toMatchObject({ uu: 2, uv: 0, vv: 0 });
    expect(freeformTriangleDistance(bound, [[0.25, 0], [0.75, 0], [0.25, 1]], 0)).toBe(0.0625);
  });
  it('normalizes knot units, preserves geometry placement and refuses extrapolated UV', () => {
    const mapped = { ...parabola, u: { degree: 2, knots: [3, 3, 3, 7, 7, 7] },
      poles: parabola.poles.map(p => [p[0] + 1000, p[1] - 1000, p[2] + 2000] as const) };
    const bound = boundFreeformDerivatives(mapped, checkpoint);
    expect(freeformTriangleDistance(bound, [[3, 0], [7, 0], [3, 1]], 0)).toBe(0.25);
    expect(() => freeformTriangleDistance(bound, [[2.99, 0], [7, 0], [3, 1]], 0)).toThrow('outside chart');
  });
  it('rejects nonpositive weights, mismatched control counts, nonfinite arithmetic and an unchecked C0 knot', () => {
    expect(() => boundFreeformDerivatives({ ...parabola, weights: [1, 1, 0, 1, 1, 1] }, checkpoint)).toThrow('weight');
    expect(() => boundFreeformDerivatives({ ...parabola, poles: parabola.poles.slice(1) }, checkpoint)).toThrow('pole');
    expect(() => boundFreeformDerivatives({ ...parabola, poles: [[1e308, 0, 0], ...parabola.poles.slice(1, 5), [-1e308, 1, 1]] }, checkpoint)).toThrow('nonfinite');
    expect(() => boundFreeformDerivatives({ ...parabola, u: { degree: 2, knots: [0, 0, 0, 0.5, 0.5, 1, 1, 1] } }, checkpoint)).toThrow('C1');
  });
  it('propagates the existing cancellation/deadline checkpoint without inventing a second allowance', () => {
    const aborted = new Error('owned operation cancelled');
    expect(() => boundFreeformDerivatives(parabola, () => { throw aborted; })).toThrow(aborted);
  });
});

describe('whole original triangle over C0 and periodic native patch grids', () => {
  const folded: FreeformPatchGrid = { u: [0, 0.5, 1], v: [0, 1], uPeriodic: false, vPeriodic: false,
    patches: [[0, 0.5], [0.5, 1]].map(([a, b]) => ({ u: [a, b] as const, v: [0, 1] as const, uu: 0, uv: 0, vv: 0 })),
    point: ([u, v]) => [u, v, Math.abs(u - 0.5)] };
  it('keeps the half-unit internal offset of a C0 fold although all original vertices have zero offset', () => {
    const result = partitionedFreeformTriangleDistance(folded, [[0, 0], [1, 0], [0, 1]],
      [[0, 0, 0.5], [1, 0, 0.5], [0, 1, 0.5]], checkpoint);
    expect(result).toEqual({ maxNodeOffsetMm: 0, maxChordDeviationMm: 0.5 });
  });
  it('covers a knot crossing in both UV axes, including the central split vertex', () => {
    const grid: FreeformPatchGrid = { u: [0, 0.5, 1], v: [0, 0.5, 1], uPeriodic: false, vPeriodic: false,
      patches: [0, 0.5].flatMap(u => [0, 0.5].map(v => ({ u: [u, u + 0.5] as const,
        v: [v, v + 0.5] as const, uu: 0, uv: 0, vv: 0 }))),
      point: ([u, v]) => [u, v, Math.abs(u - 0.5) + Math.abs(v - 0.5)] };
    const result = partitionedFreeformTriangleDistance(grid, [[0, 0], [1, 0], [0, 1]],
      [[0, 0, 1], [1, 0, 1], [0, 1, 1]], checkpoint);
    expect(result.maxChordDeviationMm).toBe(1);
  });
  it('uses integer-period copies without choosing a different triangle or losing the seam offset', () => {
    const knots = [0, 1, 2, 3, 4];
    const grid: FreeformPatchGrid = { u: knots, v: [0, 1], uPeriodic: true, vPeriodic: false,
      patches: knots.slice(0, -1).map(u => ({ u: [u, u + 1] as const, v: [0, 1] as const, uu: 0, uv: 0, vv: 0 })),
      point: ([u, v]) => {
        const t = ((u % 4) + 4) % 4, edge = Math.floor(t), q = t - edge;
        const corners = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 0]];
        return [(1 - q) * corners[edge][0] + q * corners[edge + 1][0],
          (1 - q) * corners[edge][1] + q * corners[edge + 1][1], v];
      } };
    const points = [[0.5, -0.5, 0], [0.5, 0.5, 0], [0.5, -0.5, 1]] as const;
    for (const shift of [0, -8, 12]) {
      const result = partitionedFreeformTriangleDistance(grid,
        [[3.5 + shift, 0], [4.5 + shift, 0], [3.5 + shift, 1]], points, checkpoint);
      expect(result).toEqual({ maxNodeOffsetMm: 0, maxChordDeviationMm: 0.5 });
    }
    expect(() => partitionedFreeformTriangleDistance(grid, [[0, 0], [20_000, 0], [0, 1]], points, checkpoint))
      .toThrow('periodic copy budget');
  });
  it('does not double-count a rank-deficient UV triangle lying exactly on a knot', () => {
    const result = partitionedFreeformTriangleDistance(folded, [[0.5, 0], [0.5, 1], [0.5, 0.5]],
      [[0.5, 0, 0], [0.5, 1, 0], [0.5, 0.5, 0]], checkpoint);
    expect(result).toEqual({ maxNodeOffsetMm: 0, maxChordDeviationMm: 0 });
  });
  it('refuses missing cells, mismatched domains, nonfinite arithmetic, and preserves the owned deadline', () => {
    const uv = [[0, 0], [1, 0], [0, 1]] as const, points = [[0, 0, 0.5], [1, 0, 0.5], [0, 1, 0.5]] as const;
    expect(() => partitionedFreeformTriangleDistance({ ...folded, patches: folded.patches.slice(1) }, uv, points, checkpoint))
      .toThrow('partition budget');
    expect(() => partitionedFreeformTriangleDistance({ ...folded, u: [0, 0.6, 1] }, uv, points, checkpoint))
      .toThrow('patch parameter mismatch');
    expect(() => partitionedFreeformTriangleDistance(folded, [[0, 0], [Infinity, 0], [0, 1]], points, checkpoint))
      .toThrow('nonfinite UV');
    expect(() => partitionedFreeformTriangleDistance(folded, uv, points, () => { throw new Error('owned-deadline'); }))
      .toThrow('owned-deadline');
  });
});
