import { describe, expect, it, vi } from 'vitest';
import { intervalUnion } from './mathIntervalUnion.js';
import { certifySplineAgainstMesh, smoothFunctionSurface, type FunctionSurfaceSpline, type SmoothSurfaceOptions, type SmoothSurfaceSource,
  type SurfaceMeshEvidence } from './smoothFunctionSurface.js';
import type { SurfaceLeaf } from './surfaceParameterGrid.js';

type Point = readonly [number, number, number];
type Surface = (u: number, v: number) => Point;
/** Exact surface sources: point evaluation is exact, so the node error is zero and only geometry is tested. */
function source(f: Surface): SmoothSurfaceSource {
  return {
    point: ([u, v]) => f(u, v),
    enclosure: (lower, upper) => {
      if (lower[0] !== upper[0] || lower[1] !== upper[1]) throw new Error('Smoothing must only enclose single points');
      const p = f(lower[0], lower[1]);
      return [intervalUnion(p[0]), intervalUnion(p[1]), intervalUnion(p[2])];
    },
  };
}
/** Nonuniform quadtree on a non-square rectangle: grid of 8 units, parameters u in [-1, 2], v in [0, 1]. */
const lower = [-1, 0] as const, upper = [2, 1] as const;
const parameter = (index: number, axis: 0 | 1) => lower[axis] + (upper[axis] - lower[axis]) * (index / 8);
const cells: readonly (readonly [number, number, number])[] = [[0, 0, 4], [4, 0, 2], [6, 0, 2], [4, 2, 2], [6, 2, 1], [7, 2, 1],
  [6, 3, 1], [7, 3, 1], [0, 4, 4], [4, 4, 4]];
/** Leaf bound: for f with second derivatives bounded by m (in parameter units), |f - affine| <= m * diag^2 on any triangle. */
function leaves(m: number, list = cells): SurfaceLeaf[] {
  return list.map(([u, v, span]) => {
    const du = parameter(u + span, 0) - parameter(u, 0), dv = parameter(v + span, 1) - parameter(v, 1);
    return { u, v, span, depth: 0, interpolationError: m * (du * du + dv * dv) };
  });
}
/** A certified mesh of the leaves: two triangles per leaf through its corners (non-conforming, which is allowed). */
function mesh(f: Surface, list: readonly SurfaceLeaf[]): SurfaceMeshEvidence {
  const vertices: { parameters: readonly [number, number]; point: Point }[] = [], triangles: [number, number, number][] = [];
  for (const leaf of list) {
    const base = vertices.length;
    for (const [du, dv] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const parameters = [parameter(leaf.u + du * leaf.span, 0), parameter(leaf.v + dv * leaf.span, 1)] as const;
      vertices.push({ parameters, point: f(parameters[0], parameters[1]) });
    }
    triangles.push([base, base + 1, base + 2], [base, base + 2, base + 3]);
  }
  return { vertices, triangles, bound: Math.max(...list.map(leaf => leaf.interpolationError)) };
}
const box = { minimum: [-10, -10, -10] as Point, maximum: [10, 10, 10] as Point };
function options(f: Surface, m: number, tolerance: number, extra: Partial<SmoothSurfaceOptions> = {}, list = leaves(m)): SmoothSurfaceOptions {
  return { ...box, tolerance, parameter, remainingSamples: 10_000, remainingCells: 10_000, mesh: mesh(f, list), stop: () => false, ...extra };
}

/** Independent Bezier extraction of the double-knot layout per direction. */
function control(knots: readonly number[], s: number, r: number): readonly (readonly [number, number])[] {
  const junction = (node: number): readonly (readonly [number, number])[] => {
    if (node === 0) return [[0, 1]];
    if (node === knots.length - 1) return [[2 * knots.length - 1, 1]];
    const share = (knots[node] - knots[node - 1]) / (knots[node + 1] - knots[node - 1]);
    return [[2 * node, 1 - share], [2 * node + 1, share]];
  };
  return r === 0 ? junction(s) : r === 3 ? junction(s + 1) : [[2 * s + r, 1]];
}
/** Independent evaluation: tensor Bernstein sum over the extracted net. */
function evaluate(spline: Pick<FunctionSurfaceSpline, 'uKnots' | 'vKnots' | 'poles'>, u: number, v: number): Point {
  const span = (knots: readonly number[], t: number) => Math.min(knots.length - 2, Math.max(0, knots.findIndex((knot, n) => n > 0 && t <= knot) - 1));
  const i = span(spline.uKnots, u), j = span(spline.vKnots, v), columns = 2 * spline.vKnots.length;
  const a = (u - spline.uKnots[i]) / (spline.uKnots[i + 1] - spline.uKnots[i]), b = (v - spline.vKnots[j]) / (spline.vKnots[j + 1] - spline.vKnots[j]);
  const bernstein = (t: number) => [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
  const wa = bernstein(a), wb = bernstein(b), out = [0, 0, 0];
  for (let r = 0; r < 4; r++) for (let s = 0; s < 4; s++) for (const [p, x] of control(spline.uKnots, i, r)) for (const [q, y] of control(spline.vKnots, j, s)) {
    const weight = wa[r] * wb[s] * x * y, point = spline.poles[p * columns + q];
    for (let axis = 0; axis < 3; axis++) out[axis] += weight * point[axis];
  }
  return [out[0], out[1], out[2]];
}
/** Independent mesh evaluation: the triangle containing (u, v), by barycentric coordinates. */
function meshAt(evidence: SurfaceMeshEvidence, u: number, v: number): Point {
  for (const [ia, ib, ic] of evidence.triangles) {
    const [a, b, c] = [ia, ib, ic].map(index => evidence.vertices[index]);
    const d = (b.parameters[0] - a.parameters[0]) * (c.parameters[1] - a.parameters[1]) - (c.parameters[0] - a.parameters[0]) * (b.parameters[1] - a.parameters[1]);
    const beta = ((u - a.parameters[0]) * (c.parameters[1] - a.parameters[1]) - (c.parameters[0] - a.parameters[0]) * (v - a.parameters[1])) / d;
    const gamma = ((b.parameters[0] - a.parameters[0]) * (v - a.parameters[1]) - (u - a.parameters[0]) * (b.parameters[1] - a.parameters[1])) / d;
    if (beta >= -1e-12 && gamma >= -1e-12 && beta + gamma <= 1 + 1e-12) {
      const at = (axis: number) => a.point[axis] + beta * (b.point[axis] - a.point[axis]) + gamma * (c.point[axis] - a.point[axis]);
      return [at(0), at(1), at(2)];
    }
  }
  throw new Error(`No triangle at ${u}, ${v}`);
}
const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function ready(outcome: ReturnType<typeof smoothFunctionSurface>): FunctionSurfaceSpline {
  if (outcome.status !== 'ready') throw new Error(JSON.stringify(outcome));
  return outcome.spline;
}
/** Knot indices of the synthetic grid: u [0, 4, 6, 7, 8], v [0, 2, 3, 4, 8]; 25 nodes, 16 product cells. */
const NODES = 25, CELLS = 16;

describe('reuse of already certified sampler nodes', () => {
  const quadratic: Surface = (u, v) => [u, v, u * u + u * v - 2 * v * v];
  const knownSample: NonNullable<SmoothSurfaceOptions['knownSample']> = grid => {
    const parameters = [parameter(grid[0], 0), parameter(grid[1], 1)] as const;
    return { vertex: { parameters, point: quadratic(...parameters) }, error: 0 };
  };

  it('produces the identical poles, certificate and conservative charges without repeating node arithmetic', () => {
    const original = source(quadratic), list = leaves(4), settings = options(quadratic, 4, 100);
    const expected = smoothFunctionSurface(original, list, settings);
    const point = vi.fn(original.point), enclosure = vi.fn(original.enclosure);
    const actual = smoothFunctionSurface({ point, enclosure }, list, { ...settings, knownSample });
    expect(actual).toEqual(expected);
    expect(actual.status).toBe('ready');
    expect(actual.used).toEqual({ samples: NODES, cells: CELLS });
    expect(point).not.toHaveBeenCalled();
    expect(enclosure).not.toHaveBeenCalled();
  });

  it('evaluates every missing node normally while reusing an exact nonuniform-grid node', () => {
    const original = source(quadratic), point = vi.fn(original.point), enclosure = vi.fn(original.enclosure);
    const settings = options(quadratic, 4, 100);
    const actual = smoothFunctionSurface({ point, enclosure }, leaves(4), { ...settings,
      knownSample: grid => grid[0] === 6 && grid[1] === 3 ? knownSample(grid) : undefined });
    expect(actual).toEqual(smoothFunctionSurface(original, leaves(4), settings));
    expect(point).toHaveBeenCalledTimes(NODES - 1);
    expect(enclosure).toHaveBeenCalledTimes(NODES - 1);
  });

  it('rejects stale parameter provenance, nonfinite points and invalid interval evidence', () => {
    const invalid: NonNullable<SmoothSurfaceOptions['knownSample']>[] = [
      () => ({ vertex: { parameters: [0, 0], point: [0, 0, 0] }, error: 0 }),
      () => ({ vertex: { parameters: lower, point: [NaN, 0, 0] }, error: 0 }),
      () => ({ vertex: { parameters: lower, point: quadratic(...lower) }, error: Infinity }),
      () => ({ vertex: { parameters: lower, point: quadratic(...lower) }, error: -1 }),
    ];
    for (const lookup of invalid) {
      expect(smoothFunctionSurface(source(quadratic), leaves(4), options(quadratic, 4, 100, { knownSample: lookup })))
        .toEqual({ status: 'declined', reason: 'samples', used: { samples: 1, cells: 0 } });
    }
  });

  it('keeps original budget, stop and full mesh coverage requirements despite a complete cache', () => {
    const lookup = vi.fn(knownSample), original = source(quadratic);
    expect(smoothFunctionSurface(original, leaves(4), options(quadratic, 4, 100,
      { knownSample: lookup, remainingSamples: NODES - 1 })))
      .toEqual({ status: 'declined', reason: 'budget', used: { samples: 0, cells: 0 } });
    expect(lookup).not.toHaveBeenCalled();
    expect(smoothFunctionSurface(original, leaves(4), options(quadratic, 4, 100, { knownSample: lookup, stop: () => true })))
      .toEqual({ status: 'stopped', used: { samples: 0, cells: 0 } });
    expect(lookup).not.toHaveBeenCalled();
    const settings = options(quadratic, 4, 100);
    const missing = { ...settings.mesh, triangles: settings.mesh.triangles.slice(1) };
    expect(smoothFunctionSurface(original, leaves(4), { ...settings, knownSample, mesh: missing }))
      .toMatchObject({ status: 'declined', reason: 'coverage' });
  });
});

describe('関数曲面の証明付きC1双3次Bスプライン（不等間隔の積格子）', () => {
  const quadratic: Surface = (u, v) => [u, v, u * u + u * v - 2 * v * v];
  const wave: Surface = (u, v) => [u, v, Math.sin(2 * u) * Math.cos(3 * v)];

  it('2次の曲面は不等間隔の格子でも3点の微分とねじれが厳密で、曲面そのものを再現する', () => {
    const outcome = smoothFunctionSurface(source(quadratic), leaves(4), options(quadratic, 4, 100));
    expect(outcome.used).toEqual({ samples: NODES, cells: CELLS });
    const spline = ready(outcome);
    expect(spline.uKnots).toEqual([0, 4, 6, 7, 8].map(index => parameter(index, 0)));
    expect(spline.vKnots).toEqual([0, 2, 3, 4, 8].map(index => parameter(index, 1)));
    expect(spline.poles).toHaveLength(4 * spline.uKnots.length * spline.vKnots.length);
    for (let a = 0; a <= 30; a++) for (let b = 0; b <= 30; b++) {
      const u = lower[0] + 3 * a / 30, v = b / 30, point = evaluate(spline, u, v), exact = quadratic(u, v);
      point.forEach((value, axis) => expect(Math.abs(value - exact[axis])).toBeLessThanOrEqual(1e-12));
    }
  });

  it('内部の節点線をまたいで位置と1階微分が一致する（物理的な媒介変数の単位）', () => {
    const spline = ready(smoothFunctionSurface(source(wave), leaves(13), options(wave, 13, 100)));
    const h = 1e-7;
    for (const knot of spline.uKnots.slice(1, -1)) for (const v of [0.11, 0.37, 0.8]) {
      const left = evaluate(spline, knot - h, v), right = evaluate(spline, knot + h, v), at = evaluate(spline, knot, v);
      const slopeLeft = (at[2] - left[2]) / h, slopeRight = (right[2] - at[2]) / h;
      expect(Math.abs(slopeLeft - slopeRight)).toBeLessThan(1e-4);
    }
    for (const knot of spline.vKnots.slice(1, -1)) for (const u of [-0.7, 0.4, 1.9]) {
      const below = evaluate(spline, u, knot - h), above = evaluate(spline, u, knot + h), at = evaluate(spline, u, knot);
      expect(Math.abs((at[2] - below[2]) / h - (above[2] - at[2]) / h)).toBeLessThan(1e-4);
    }
  });

  it('密な点で、面と三角形の差は証明した面とメッシュの差以下、元の関数との差は合計の上限以下（標本による確認）', () => {
    // |f_uu| <= 4, |f_vv| <= 9, |f_uv| <= 6: m = 13 is a safe bound for the affine-interpolation estimate used here.
    const settings = options(wave, 13, 100), spline = ready(smoothFunctionSurface(source(wave), leaves(13), settings));
    const certificate = certifySplineAgainstMesh(spline, settings.mesh, box);
    if (certificate.status !== 'certified') throw new Error(JSON.stringify(certificate));
    expect(certificate).toMatchObject({ coveredCells: CELLS, outsideCells: 0 });
    // The claim is exactly the sampler's mesh bound plus the recomputed spline-to-mesh part, never a separate scalar.
    expect(spline.errorBound).toBe(settings.mesh.bound + certificate.splineToMesh);
    for (let a = 0; a <= 24; a++) for (let b = 0; b <= 24; b++) {
      const u = lower[0] + 3 * a / 24, v = b / 24, point = evaluate(spline, u, v);
      expect(distance(point, meshAt(settings.mesh, u, v))).toBeLessThanOrEqual(certificate.splineToMesh);
      expect(Math.abs(point[2] - wave(u, v)[2])).toBeLessThanOrEqual(spline.errorBound);
    }
  });

  it('精度に収まらない・点が求まらない場合を、それぞれ理由と実際に使った数付きで断る', () => {
    expect(smoothFunctionSurface(source(wave), leaves(13), options(wave, 13, 1e-3)))
      .toEqual({ status: 'declined', reason: 'bound', used: { samples: NODES, cells: CELLS } });
    // First non-finite node: u index 3 (u = 1.625 > 1.5), v index 4 (v = 1 > 0.5), after 3 * 5 + 5 evaluations.
    const hole: Surface = (u, v) => (u > 1.5 && v > 0.5 ? [Number.NaN, v, 0] : [u, v, 0]);
    expect(smoothFunctionSurface(source(hole), leaves(0), options((u, v) => [u, v, 0], 0, 100)))
      .toEqual({ status: 'declined', reason: 'samples', used: { samples: 20, cells: 0 } });
  });

  it('標本と面の予算は採取の残りを共有し、ちょうど足りる時は作り、1つ足りない時は何も使わずに断る', () => {
    const run = (extra: Partial<SmoothSurfaceOptions>) => smoothFunctionSurface(source(quadratic), leaves(4), options(quadratic, 4, 100, extra));
    expect(run({ remainingSamples: NODES, remainingCells: CELLS })).toMatchObject({ status: 'ready', used: { samples: NODES, cells: CELLS } });
    expect(run({ remainingSamples: NODES - 1 })).toEqual({ status: 'declined', reason: 'budget', used: { samples: 0, cells: 0 } });
    expect(run({ remainingCells: CELLS - 1 })).toEqual({ status: 'declined', reason: 'budget', used: { samples: 0, cells: 0 } });
    expect(run({ remainingSamples: 0, remainingCells: 0 })).toEqual({ status: 'declined', reason: 'budget', used: { samples: 0, cells: 0 } });
  });

  it('節点・微分とねじれ・極・平面判定・証明の全ての中止確認で、その場で止まる', () => {
    let checks = 0;
    ready(smoothFunctionSurface(source(quadratic), leaves(4), options(quadratic, 4, 100, { stop: () => { checks++; return false; } })));
    // Node loop 1, derivative loops 5 + 5 + 5, poles 10, certificate triangles 1 (every 256) + rows 4; its work counter
    // (every 1024 clip/overlap tests) does not reach 1024 on this small mesh.
    expect(checks).toBe(1 + 15 + 10 + 1 + 4);
    for (let at = 1; at <= checks; at++) {
      let calls = 0;
      const outcome = smoothFunctionSurface(source(quadratic), leaves(4), options(quadratic, 4, 100, { stop: () => ++calls >= at }));
      expect(outcome.status).toBe('stopped');
      if (at === 1) expect(outcome.used).toEqual({ samples: 0, cells: 0 });
      // The second check is the first derivative column: every node was evaluated and counted, no cell yet.
      if (at === 2) expect(outcome.used).toEqual({ samples: NODES, cells: 0 });
    }
  });

  it('葉の無い格子は、制御網全体が箱の1面の外にある時だけ許し、範囲を橋渡ししない', () => {
    // The upper-right leaf is missing: the sampler skipped that region and drew no triangles there.
    const someLeaves = leaves(4).filter(leaf => !(leaf.u === 4 && leaf.v === 4));
    // Inside the box there: no certificate, so no spline.
    expect(smoothFunctionSurface(source(quadratic), someLeaves, options(quadratic, 4, 100, {}, someLeaves)))
      .toMatchObject({ status: 'declined', reason: 'coverage' });
    // Wholly above z = 10 there: the convex hull of each control net keeps those patches outside, so CAD clips them away.
    const high: Surface = (u, v) => [u, v, 50 + u * u];
    const settings = options(high, 2, 100, {}, someLeaves), spline = ready(smoothFunctionSurface(source(high), someLeaves, settings));
    expect(certifySplineAgainstMesh(spline, settings.mesh, box)).toMatchObject({ status: 'certified', coveredCells: 13, outsideCells: 3 });
  });

  it('全ての標本の網が平面なら、既に厳密な平面三角形を残す（平面の断面などの既存の形を変えない）', () => {
    const plane: Surface = (u, v) => [u, v, 0.5 * u - 0.25 * v + 1];
    expect(smoothFunctionSurface(source(plane), leaves(0), options(plane, 0, 1)))
      .toEqual({ status: 'declined', reason: 'affine', used: { samples: NODES, cells: CELLS } });
  });
});

describe('面とメッシュの証明は制御網全体を見て、節点の一致だけでは通さない', () => {
  // Second derivatives at most 0.02 in size: honest spline-to-mesh gaps stay near 0.01, far below the 0.3 / 1 tampering.
  const gentle: Surface = (u, v) => [u, v, 0.005 * (u * u + u * v - 2 * v * v)];
  function fixture() {
    const settings = options(gentle, 0.02, 1), spline = ready(smoothFunctionSurface(source(gentle), leaves(0.02), settings));
    const honest = certifySplineAgainstMesh(spline, settings.mesh, box);
    if (honest.status !== 'certified') throw new Error(JSON.stringify(honest));
    return { mesh: settings.mesh, spline, honest };
  }
  const columns = (spline: FunctionSurfaceSpline) => 2 * spline.vKnots.length;

  it('メッシュの頂点に無い節点（大きな葉を横切る節点線）だけを動かした面は、節点の照合を通っても拒否される', () => {
    const { mesh: evidence, spline, honest } = fixture();
    // Node (u index 0, v index 2/8 = knot 1) lies on the left edge of the big leaf [0, 0, 4]: not a mesh vertex.
    const l = 1, sparse = { ...spline, poles: spline.poles.map((pole, index): Point =>
      index === 2 * l || index === 2 * l + 1 ? [pole[0], pole[1], pole[2] + 0.3] : pole) };
    expect(evidence.vertices.some(({ parameters }) => parameters[0] === spline.uKnots[0] && parameters[1] === spline.vKnots[l])).toBe(false);
    // Every product node that is a mesh vertex keeps its exact position, so a node-matching check would accept this.
    for (const vertex of evidence.vertices) {
      const k = spline.uKnots.indexOf(vertex.parameters[0]), m = spline.vKnots.indexOf(vertex.parameters[1]);
      if (k >= 0 && m >= 0) expect(evaluate(sparse, vertex.parameters[0], vertex.parameters[1])).toEqual(evaluate(spline, vertex.parameters[0], vertex.parameters[1]));
    }
    // Exact expectation: the moved node is 0.3 away from the honest spline, which is within honest.splineToMesh of the
    // mesh there; that node is a vertex of the clip of the leaf's upper-left triangle with cell (0, 0), so the mesh gap
    // there alone is at least 0.3 - honest.splineToMesh (> 0.25 here).
    const tampered = certifySplineAgainstMesh(sparse, evidence, box);
    expect(honest.splineToMesh).toBeLessThan(0.05);
    expect(tampered).toMatchObject({ status: 'certified' });
    if (tampered.status === 'certified') expect(tampered.splineToMesh).toBeGreaterThanOrEqual(0.3 - honest.splineToMesh);
  });

  it('内部の極を膨らませた面は、全ての節点を保っても網の差が膨らみ分だけ増える', () => {
    const { mesh: evidence, spline, honest } = fixture(), c = columns(spline);
    // Pole (1, 1) is the inner control of the first cell and feeds no junction: every node is unchanged.
    const bulged = { ...spline, poles: spline.poles.map((pole, index): Point => index === c + 1 ? [pole[0], pole[1], pole[2] + 1] : pole) };
    for (const u of spline.uKnots) for (const v of spline.vKnots) expect(evaluate(bulged, u, v)).toEqual(evaluate(spline, u, v));
    const tampered = certifySplineAgainstMesh(bulged, evidence, box);
    if (tampered.status !== 'certified') throw new Error(JSON.stringify(tampered));
    // The moved control alone is 1 away from the unchanged bilinear net: netDiff >= 1 - honest.splineToMesh.
    expect(tampered.splineToMesh).toBeGreaterThanOrEqual(1 - honest.splineToMesh);
    // Independent check: the first cell's centre really moved by (3/8)^2 = 9/64 off the mesh.
    const u = (spline.uKnots[0] + spline.uKnots[1]) / 2, v = (spline.vKnots[0] + spline.vKnots[1]) / 2;
    expect(evaluate(bulged, u, v)[2] - evaluate(spline, u, v)[2]).toBeCloseTo(9 / 64, 12);
  });

  // Leaf [0, 4, 4] (u in [-1, 0.5], v in [0.5, 1]) is exactly one product cell: no other knot line crosses it. Its two
  // triangles are 16 (A, B, C) and 17 (A, C, D); vertices 32..35 are A, B, C, D.
  const A = 32, B = 33, C = 34, D = 35;
  const withVertices = (evidence: SurfaceMeshEvidence, added: readonly (readonly [number, number])[]) => ({ ...evidence,
    vertices: [...evidence.vertices, ...added.map(([u, v]) => ({ parameters: [u, v] as const, point: gentle(u, v) }))] });
  const replaceTriangles = (evidence: SurfaceMeshEvidence, drop: readonly number[], add: readonly (readonly [number, number, number])[]) =>
    ({ ...evidence, triangles: [...evidence.triangles.filter((_, index) => !drop.includes(index)), ...add] });

  it('同じ半分を別の頂点番号・逆向きで重ね、残り半分を欠いた面積の釣り合う覆いを、重なりとして拒否する', () => {
    const { mesh: evidence, spline } = fixture();
    expect(evidence.vertices.slice(A, D + 1).map(vertex => vertex.parameters)).toEqual([[-1, 0.5], [0.5, 0.5], [0.5, 1], [-1, 1]]);
    // New vertex indices at A, B, C; triangle 17 (the upper half) is replaced by the lower half again, reversed.
    const copies = withVertices(evidence, [[-1, 0.5], [0.5, 0.5], [0.5, 1]]), n = evidence.vertices.length;
    const balanced = replaceTriangles(copies, [17], [[n + 2, n + 1, n]]);
    // Exact expectation: the clip areas still sum to the cell area 1.5 * 0.5 = 0.75 (two halves of 0.375), so an area sum
    // alone accepts it; the pairwise test finds an overlap of 0.375 > 1e-9 * 0.75 and rejects.
    expect(certifySplineAgainstMesh(spline, balanced, box)).toMatchObject({ status: 'rejected', reason: 'overlap' });
  });

  it('重複の無い三角形でも、欠けと同じ面積の重なりを足して釣り合わせた覆いを拒否する', () => {
    const { mesh: evidence, spline } = fixture(), n = evidence.vertices.length;
    // E = (-1, 0.75) on AD and F = (0.5, 0.75) on BC. (A, C, E) covers half of the upper half and leaves (E, C, D)
    // uncovered (area 0.1875); (A, B, F) adds 0.1875 inside the lower half (A, B, C), which stays.
    const extra = withVertices(evidence, [[-1, 0.75], [0.5, 0.75]]), E = n, F = n + 1;
    const balanced = replaceTriangles(extra, [17], [[A, C, E], [A, B, F]]);
    // Exact expectation: 0.375 + 0.1875 + 0.1875 = 0.75 equals the cell area; the overlap of (A, B, C) and (A, B, F) is
    // 0.1875, so the certificate rejects with 'overlap'.
    expect(certifySplineAgainstMesh(spline, balanced, box)).toMatchObject({ status: 'rejected', reason: 'overlap' });
    // The same gap without the compensating triangle is plain missing coverage.
    expect(certifySplineAgainstMesh(spline, replaceTriangles(extra, [17], [[A, C, E]]), box)).toMatchObject({ status: 'rejected', reason: 'coverage' });
  });

  it('辺を共有する正しい細分・逆向きの三角形・不等間隔の切り分けは、重なり無しとして通す', () => {
    const { mesh: evidence, spline, honest } = fixture(), n = evidence.vertices.length;
    expect(honest).toMatchObject({ status: 'certified', coveredCells: CELLS, outsideCells: 0 });
    // The single-cell leaf as a fan of four triangles around its centre G, sharing edges; (G, A, D) is clockwise.
    const fan = replaceTriangles(withVertices(evidence, [[-0.25, 0.75]]), [16, 17], [[A, B, n], [B, C, n], [n, C, D], [n, A, D]]);
    expect(certifySplineAgainstMesh(spline, fan, box)).toMatchObject({ status: 'certified', coveredCells: CELLS, outsideCells: 0 });
    // Reversed winding of an original triangle changes nothing.
    const reversed = replaceTriangles(evidence, [16], [[C, B, A]]);
    expect(certifySplineAgainstMesh(spline, reversed, box)).toMatchObject({ status: 'certified', coveredCells: CELLS });
  });

  it('覆いの欠け・重なり・範囲外の三角形・非有限の延長・極や節点の不正を、それぞれの理由で拒否する', () => {
    const { mesh: evidence, spline } = fixture();
    const without = (drop: number) => ({ ...evidence, triangles: evidence.triangles.filter((_, index) => index !== drop) });
    expect(certifySplineAgainstMesh(spline, without(0), box)).toMatchObject({ status: 'rejected', reason: 'coverage' });
    expect(certifySplineAgainstMesh(spline, { ...evidence, triangles: [...evidence.triangles, evidence.triangles[3]] }, box))
      .toMatchObject({ status: 'rejected', reason: 'overlap' });
    // A drawn triangle beyond the spline rectangle.
    const outside = { ...evidence, vertices: [...evidence.vertices, { parameters: [5, 5] as const, point: [5, 5, 0] as Point }],
      triangles: [...evidence.triangles, [0, 1, evidence.vertices.length] as [number, number, number]] };
    expect(certifySplineAgainstMesh(spline, outside, box)).toMatchObject({ status: 'rejected' });
    // Affine extension of a triangle to a cell corner overflows.
    const huge = { ...evidence, vertices: evidence.vertices.map((vertex, index): SurfaceMeshEvidence['vertices'][number] =>
      index === 0 ? { ...vertex, point: [1e308, 0, 0] } : index === 1 ? { ...vertex, point: [-1e308, 0, 0] } : vertex) };
    expect(certifySplineAgainstMesh(spline, huge, box)).toMatchObject({ status: 'rejected', reason: 'nonfinite' });
    expect(certifySplineAgainstMesh({ ...spline, poles: spline.poles.map((pole, index): Point => index === 7 ? [pole[0], Number.NaN, pole[2]] : pole) },
      evidence, box)).toMatchObject({ status: 'rejected', reason: 'nonfinite' });
    expect(certifySplineAgainstMesh({ ...spline, poles: spline.poles.slice(1) }, evidence, box)).toMatchObject({ status: 'rejected', reason: 'structure' });
    expect(certifySplineAgainstMesh({ ...spline, uKnots: [spline.uKnots[1], spline.uKnots[0], ...spline.uKnots.slice(2)] }, evidence, box))
      .toMatchObject({ status: 'rejected', reason: 'structure' });
  });
});
