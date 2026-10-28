/**
 * A C1 tensor-product bicubic B-spline for an explicit/parametric function surface, certified against its certified
 * triangle mesh over the complete control net.
 *
 * Grid: the union of all quadtree leaf boundary lines in each parameter direction. Values at every grid node; first
 * derivatives and the twist from nonuniform three-point differences in physical parameter units, shared by all cells
 * at a node, so value and first derivatives agree across every patch edge (double interior knots: C1, never C2).
 *
 * Certificate (certifySplineAgainstMesh), computed from the transported poles alone, so the reply decoder repeats it
 * independently: for every grid cell, either
 * - the mesh triangles cover the whole cell: no two of their clips to the cell overlap in positive parameter area
 *   (every pair is intersected; the summed pairwise overlap must stay within a relative 1e-9 of the cell), so the sum
 *   of the clip areas is the area of their union, and that sum must equal the cell area within the same relative 1e-9
 *   (an area sum alone would accept a duplicated half plus a missing half); and on each clip T ∩ cell |S - L_T| <= netDiff + meshGap, where netDiff is the
 *   largest distance between the cell's actual Bezier control net and the net of the bilinear patch B through its
 *   corners (Bernstein weights are a partition of unity, so |S - B| <= netDiff on the whole cell), and meshGap bounds
 *   |B - L_T| on the clip: every component of B - L_T is bilinear minus affine, hence harmonic, so its extreme values on
 *   the convex clip lie on the clip's edges, where it is an exact quadratic (maximised in closed form). L_T is only
 *   evaluated inside its own triangle, never extrapolated; or
 * - no triangle meets the cell and its whole control net lies strictly beyond one box face (convex hull), so CAD clips
 *   that patch away.
 * Then |S - f| <= splineToMesh + meshBound on the covered part, up to the tolerance-sized coverage slack above. The
 * spline-to-mesh part is computed here from the poles and the mesh alone. The original-function part is the sampler's
 * mesh bound: in the Worker it is the sampler's own certificate; in a received reply it is a Worker-origin claimed scalar
 * with exactly the trust the existing triangle route already gives it. The decoder checks spline-to-mesh consistency;
 * it does not evaluate the original formula, so jointly altered mesh, bound and poles are outside what it can detect.
 * Matching a few node points proves nothing about the interior and is not used.
 *
 * Work: every triangle/cell clip and every pairwise overlap test counts against one ceiling
 * (FUNCTION_SURFACE_SPLINE_PAIR_LIMIT), with cancellation checked every 1024 units, every 256 triangles and every cell
 * row; exceeding it rejects with 'budget'. The decoder runs this synchronously on the receiving thread without a stop,
 * so that ceiling is also its worst-case work.
 */
import { functionPointError, type FunctionPoint, type FunctionPointRanges } from './functionGeometryBounds.js';
import type { SurfaceParameter, SurfaceLeaf } from './surfaceParameterGrid.js';
import type { FunctionSurfaceSampleLookup } from './adaptiveFunctionSurface.js';

/** Distinct increasing knots per direction; (2 * uKnots.length) x (2 * vKnots.length) poles, row-major in u. */
export interface FunctionSurfaceSpline {
  readonly uKnots: readonly number[];
  readonly vKnots: readonly number[];
  readonly poles: readonly FunctionPoint[];
  /** meshBound + splineToMesh; the decoder recomputes it from the poles, the mesh and its bound and requires equality. */
  readonly errorBound: number;
}
export interface SurfaceMeshEvidence {
  readonly vertices: readonly { readonly parameters: SurfaceParameter; readonly point: FunctionPoint }[];
  readonly triangles: readonly (readonly [number, number, number])[];
  /**
   * The sampler's bound on |mesh - f| over every drawn triangle. In a received reply this is the Worker's claimed
   * scalar, trusted exactly as the triangle route trusts it; nothing here evaluates f.
   */
  readonly bound: number;
}
export type SplineMeshRejection = 'structure' | 'nonfinite' | 'coverage' | 'overlap' | 'budget';
/** `visitedCells`: product cells the certificate examined (each once); `work`: clip and overlap tests performed. */
export type SplineMeshCertificate = (
  | { readonly status: 'certified'; readonly splineToMesh: number; readonly coveredCells: number; readonly outsideCells: number;
      /** False when every cell net is flat bilinear up to rounding (the data are planar). */
      readonly curved: boolean; readonly work: number }
  | { readonly status: 'rejected'; readonly reason: SplineMeshRejection }
  | { readonly status: 'stopped' }) & { readonly visitedCells: number };
export interface SmoothSurfaceUsage { readonly samples: number; readonly cells: number }
export type SmoothSurfaceOutcome = (
  | { readonly status: 'ready'; readonly spline: FunctionSurfaceSpline }
  /** 'affine': every grid cell is planar up to rounding, so the certified planar triangles are already exact. */
  | { readonly status: 'declined'; readonly reason: 'coverage' | 'budget' | 'samples' | 'bound' | 'affine' }
  | { readonly status: 'stopped' }) & { readonly used: SmoothSurfaceUsage };
export interface SmoothSurfaceSource {
  readonly point: (parameters: SurfaceParameter) => FunctionPoint | null;
  readonly enclosure: (lower: SurfaceParameter, upper: SurfaceParameter) => FunctionPointRanges;
}
export interface SmoothSurfaceOptions {
  readonly minimum: FunctionPoint;
  readonly maximum: FunctionPoint;
  readonly tolerance: number;
  /** Grid-index to parameter map of the sampler (exactly the parameters its vertices used). */
  readonly parameter: (index: number, axis: 0 | 1) => number;
  /** Same completed sampler and parameter map only. Missing grid nodes use ordinary point/interval evaluation. */
  readonly knownSample?: FunctionSurfaceSampleLookup;
  /** What the sampler left of the request's shared sample and cell budgets; never reset. */
  readonly remainingSamples: number;
  readonly remainingCells: number;
  readonly mesh: SurfaceMeshEvidence;
  readonly stop: () => boolean;
}
/** Shared with the triangle route's vertex ceiling. */
export const FUNCTION_SURFACE_SPLINE_POLE_LIMIT = 200_000;
/** Triangle/cell overlaps examined by one certificate. */
export const FUNCTION_SURFACE_SPLINE_PAIR_LIMIT = 4_000_000;
const ROUNDING = 1e-12;
/** Relative tolerance of the per-cell coverage area sum (exact clips, computed in cell-local coordinates). */
const AREA_TOLERANCE = 1e-9;
/** Native knot margin (kernel functionSurfaceSpline.ts KNOT_GAP). */
const KNOT_GAP = 64 * Number.EPSILON;

type Vector = readonly [number, number, number];
type Planar = readonly [number, number];
const add = (a: Vector, b: Vector): Vector => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const subtract = (a: Vector, b: Vector): Vector => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vector, factor: number): Vector => [a[0] * factor, a[1] * factor, a[2] * factor];
const length = (a: Vector): number => Math.hypot(a[0], a[1], a[2]);
const finite = (a: readonly number[]): boolean => a.every(Number.isFinite);

/** Nonuniform three-point derivative at index `node` of values on `knots` (end nodes use the same parabola). */
function derivative(values: readonly Vector[], knots: readonly number[], node: number): Vector {
  const count = values.length;
  const slope = (a: number, b: number) => scale(subtract(values[b], values[a]), 1 / (knots[b] - knots[a]));
  if (count === 2) return slope(0, 1);
  if (node === 0 || node === count - 1) {
    const [end, near, far] = node === 0 ? [0, 1, 2] : [count - 1, count - 2, count - 3];
    const first = knots[near] - knots[end], second = knots[far] - knots[near];
    return scale(subtract(scale(slope(end, near), 2 * first + second), scale(slope(near, far), first)), 1 / (first + second));
  }
  const left = knots[node] - knots[node - 1], right = knots[node + 1] - knots[node];
  return scale(add(scale(slope(node - 1, node), right), scale(slope(node, node + 1), left)), 1 / (left + right));
}

/** Pole index along one direction -> (node, signed offset as a fraction of the adjacent span). */
function poleSource(index: number, knots: readonly number[]): { readonly node: number; readonly offset: number } {
  const last = 2 * knots.length - 1;
  if (index === 0) return { node: 0, offset: 0 };
  if (index === last) return { node: knots.length - 1, offset: 0 };
  const span = Math.floor((index - 1) / 2), width = knots[span + 1] - knots[span];
  return index % 2 === 1 ? { node: span, offset: width / 3 } : { node: span + 1, offset: -width / 3 };
}

/**
 * Bezier control r (0..3) of span s along one direction as weighted pole indices, exactly as OCCT evaluates a
 * double-knot cubic: interior junctions are the combination of the two poles beside the knot.
 */
function controls(knots: readonly number[], s: number, r: number): readonly (readonly [number, number])[] {
  const junction = (node: number): readonly (readonly [number, number])[] => {
    if (node === 0) return [[0, 1]];
    if (node === knots.length - 1) return [[2 * knots.length - 1, 1]];
    const share = (knots[node] - knots[node - 1]) / (knots[node + 1] - knots[node - 1]);
    return [[2 * node, 1 - share], [2 * node + 1, share]];
  };
  return r === 0 ? junction(s) : r === 3 ? junction(s + 1) : [[2 * s + r, 1]];
}

/** The 4 x 4 Bezier net of grid cell (i, j), indexed [u control][v control]. */
function cellNet(spline: Pick<FunctionSurfaceSpline, 'uKnots' | 'vKnots' | 'poles'>, i: number, j: number): Vector[][] {
  const columns = 2 * spline.vKnots.length;
  const u = [0, 1, 2, 3].map(r => controls(spline.uKnots, i, r));
  const v = [0, 1, 2, 3].map(s => controls(spline.vKnots, j, s));
  return u.map(uc => v.map(vc => {
    // Same pole order and multiply/add grouping, without intermediate scaled vectors.
    let x = 0, y = 0, z = 0;
    for (const [p, a] of uc) for (const [q, b] of vc) {
      const pole = spline.poles[p * columns + q], weight = a * b;
      x += pole[0] * weight; y += pole[1] * weight; z += pole[2] * weight;
    }
    return [x, y, z] as Vector;
  }));
}

/** Largest distance between a cell net and the net of the bilinear patch through its four corners. */
function bilinearGap(net: readonly (readonly Vector[])[]): number {
  const c00 = net[0][0], c10 = net[3][0], c01 = net[0][3], c11 = net[3][3];
  let gap = 0;
  for (let r = 0; r < 4; r++) for (let s = 0; s < 4; s++) {
    const a = r / 3, b = s / 3;
    const w00 = (1 - a) * (1 - b), w10 = a * (1 - b), w01 = (1 - a) * b, w11 = a * b;
    const point = net[r][s];
    const dx = point[0] - ((c00[0] * w00 + c10[0] * w10) + (c01[0] * w01 + c11[0] * w11));
    const dy = point[1] - ((c00[1] * w00 + c10[1] * w10) + (c01[1] * w01 + c11[1] * w11));
    const dz = point[2] - ((c00[2] * w00 + c10[2] * w10) + (c01[2] * w01 + c11[2] * w11));
    gap = Math.max(gap, Math.hypot(dx, dy, dz));
  }
  return gap;
}

/**
 * Per-certificate scratch storage for Sutherland-Hodgman clipping. The millions of area-only clips and
 * intersections must not allocate a polygon/point array at every edge. Only cell members retained for
 * the later error proof are copied out. Each generator owns its workspace; input points never alias it.
 */
class PolygonWorkspace {
  private points: [number, number][] = [];
  private spare: [number, number][] = [];
  private count = 0;

  private put(target: [number, number][], index: number, x: number, y: number): void {
    const point = target[index];
    if (point === undefined) target.push([x, y]);
    else { point[0] = x; point[1] = y; }
  }

  /** Same edge order, signed distances, interpolation and >= 0 boundary rule as the allocating clip. */
  private clip(axis: 0 | 1 | null, limit: number, orientation: number, ax = 0, ay = 0, bx = 0, by = 0): void {
    let count = 0;
    for (let index = 0; index < this.count; index++) {
      const a = this.points[index], b = this.points[(index + 1) % this.count];
      const da = axis === null ? orientation * ((bx - ax) * (a[1] - ay) - (by - ay) * (a[0] - ax))
        : orientation === 1 ? a[axis] : limit - a[axis];
      const db = axis === null ? orientation * ((bx - ax) * (b[1] - ay) - (by - ay) * (b[0] - ax))
        : orientation === 1 ? b[axis] : limit - b[axis];
      if (da >= 0) this.put(this.spare, count++, a[0], a[1]);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        this.put(this.spare, count++, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
      }
    }
    const previous = this.points; this.points = this.spare; this.spare = previous; this.count = count;
  }

  private area(): number {
    let twice = 0;
    for (let index = 0; index < this.count; index++) {
      const a = this.points[index], b = this.points[(index + 1) % this.count];
      twice += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(twice / 2);
  }

  rectangleArea(triangle: readonly Planar[], u0: number, v0: number, u1: number, v1: number): number {
    this.count = triangle.length;
    for (let index = 0; index < triangle.length; index++) {
      const point = triangle[index]; this.put(this.points, index, point[0] - u0, point[1] - v0);
    }
    for (let edge = 0; edge < 4; edge++) {
      this.clip(edge < 2 ? 0 : 1, edge < 2 ? u1 - u0 : v1 - v0, edge % 2 === 0 ? 1 : -1);
      if (this.count < 3) { this.count = 0; return 0; }
    }
    return this.area();
  }

  /** Retained clips own their points, including across subsequent calls and generator resumptions. */
  copy(): Planar[] {
    const polygon: Planar[] = [];
    for (let index = 0; index < this.count; index++) polygon.push([this.points[index][0], this.points[index][1]]);
    return polygon;
  }

  intersectionArea(subject: readonly Planar[], clipper: readonly Planar[]): number {
    const orientation = Math.sign(signedArea(clipper));
    if (orientation === 0) return 0;
    this.count = subject.length;
    for (let index = 0; index < subject.length; index++) this.put(this.points, index, subject[index][0], subject[index][1]);
    for (let index = 0; index < clipper.length && this.count >= 3; index++) {
      const a = clipper[index], b = clipper[(index + 1) % clipper.length];
      this.clip(null, 0, orientation, a[0], a[1], b[0], b[1]);
    }
    return this.count >= 3 ? this.area() : 0;
  }
}
function signedArea(polygon: readonly Planar[]): number {
  let twice = 0;
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index], b = polygon[(index + 1) % polygon.length];
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return twice / 2;
}
const polygonArea = (polygon: readonly Planar[]): number => Math.abs(signedArea(polygon));
/** Largest |q(t)| on [0, 1] of the quadratic through q(0), q(1/2), q(1). */
function quadraticMaximum(start: number, middle: number, end: number): number {
  const linear = -3 * start + 4 * middle - end, square = 2 * start - 4 * middle + 2 * end;
  let maximum = Math.max(Math.abs(start), Math.abs(end));
  if (square !== 0) {
    const t = -linear / (2 * square);
    if (t > 0 && t < 1) maximum = Math.max(maximum, Math.abs(start + linear * t + square * t * t));
  }
  return maximum;
}

/** First index i with knots[i + 1] > value (cells are [knots[i], knots[i + 1]]). */
function firstCell(knots: readonly number[], value: number): number {
  let low = 0, high = knots.length - 2;
  while (low < high) { const middle = (low + high) >> 1; if (knots[middle + 1] > value) high = middle; else low = middle + 1; }
  return low;
}

/** Proof work units between two resumption points of the stepped certificate. */
const STEP_UNITS = 256;
/** Like Array.every, including its length snapshot and skipped holes, with bounded preparation steps. */
function* everySteps<T>(values: readonly T[], check: (value: T, index: number) => boolean): Generator<void, boolean, void> {
  const count = values.length;
  for (let index = 0; index < count; index++) {
    if (index % STEP_UNITS === 0) yield;
    if (index in values && !check(values[index], index)) return false;
  }
  return true;
}
function* increasingSteps(knots: readonly number[]): Generator<void, boolean, void> {
  return knots.length >= 2 && (yield* everySteps(knots, Number.isFinite))
    && (yield* everySteps(knots, (knot, index) => index === 0 || knot > knots[index - 1]));
}

/** Run stepped work to its end on the current thread (the Worker and every synchronous caller). */
export function completeSteps<T>(steps: Generator<void, T, void>): T {
  for (;;) { const step = steps.next(); if (step.done === true) return step.value; }
}

/** Independent, complete-net certificate of a spline against the certified mesh (see the module comment). */
export function certifySplineAgainstMesh(spline: Pick<FunctionSurfaceSpline, 'uKnots' | 'vKnots' | 'poles'>, mesh: SurfaceMeshEvidence,
  box: { readonly minimum: FunctionPoint; readonly maximum: FunctionPoint }, stop: () => boolean = () => false): SplineMeshCertificate {
  return completeSteps(certifySplineAgainstMeshSteps(spline, mesh, box, stop));
}

/**
 * The same certificate as resumable steps: preparation also pauses every STEP_UNITS entries. Proof work pauses every STEP_UNITS work units, every 256
 * triangles, every STEP_UNITS member geometry checks and before every cell, so a receiving thread can return to its event loop between slices. Pausing never
 * changes a check, a count or the result; abandoning the steps simply produces no result.
 */
export function* certifySplineAgainstMeshSteps(spline: Pick<FunctionSurfaceSpline, 'uKnots' | 'vKnots' | 'poles'>, mesh: SurfaceMeshEvidence,
  box: { readonly minimum: FunctionPoint; readonly maximum: FunctionPoint }, stop: () => boolean = () => false): Generator<void, SplineMeshCertificate, void> {
  const { uKnots, vKnots, poles } = spline, nu = uKnots.length, nv = vKnots.length;
  let pairs = 0, visitedCells = 0;
  const rejected = (reason: SplineMeshRejection): SplineMeshCertificate => ({ status: 'rejected', reason, visitedCells });
  const stopped = (): SplineMeshCertificate => ({ status: 'stopped', visitedCells });
  /** One unit of proof work (a triangle/cell clip or an overlap test): one shared ceiling, periodic cancellation. */
  const work = (): SplineMeshCertificate | null => {
    if (++pairs > FUNCTION_SURFACE_SPLINE_PAIR_LIMIT) return rejected('budget');
    return pairs % 1024 === 0 && stop() ? stopped() : null;
  };
  if (!(yield* increasingSteps(uKnots)) || !(yield* increasingSteps(vKnots))
    || poles.length !== 4 * nu * nv || 4 * nu * nv > FUNCTION_SURFACE_SPLINE_POLE_LIMIT) {
    return rejected('structure');
  }
  if (!(yield* everySteps(poles, pole => pole.length === 3 && finite(pole)))) return rejected('nonfinite');
  const cells = (nu - 1) * (nv - 1);
  // Triangles of positive parameter area meeting each cell, with their clipped areas.
  const area = new Float64Array(cells), members: number[][] = [], polygon = new PolygonWorkspace();
  for (let cell = 0; cell < cells; cell++) {
    if (cell % STEP_UNITS === 0) yield;
    members.push([]);
  }
  const corners = (t: number): readonly Planar[] => mesh.triangles[t].map(index => mesh.vertices[index].parameters);
  for (let t = 0; t < mesh.triangles.length; t++) {
    if (t % 256 === 0) { if (stop()) return stopped(); yield; }
    if (mesh.triangles[t].some(index => mesh.vertices[index] === undefined || !finite(mesh.vertices[index].parameters))) return rejected('structure');
    const planar = corners(t);
    const uMin = Math.min(...planar.map(p => p[0])), uMax = Math.max(...planar.map(p => p[0]));
    const vMin = Math.min(...planar.map(p => p[1])), vMax = Math.max(...planar.map(p => p[1]));
    let pieces = 0;
    for (let i = firstCell(uKnots, uMin); i < nu - 1 && uKnots[i] < uMax; i++) {
      for (let j = firstCell(vKnots, vMin); j < nv - 1 && vKnots[j] < vMax; j++) {
        const halt = work(); if (halt !== null) return halt;
        if (pairs % STEP_UNITS === 0) yield;
        const piece = polygon.rectangleArea(planar, uKnots[i], vKnots[j], uKnots[i + 1], vKnots[j + 1]);
        if (piece > 0) { area[i * (nv - 1) + j] += piece; members[i * (nv - 1) + j].push(t); pieces += piece; }
      }
    }
    // A drawn triangle outside the spline's parameter rectangle would be geometry the spline does not replace.
    if (pieces < polygonArea(planar) * (1 - AREA_TOLERANCE)) return rejected('coverage');
  }
  let splineToMesh = 0, coveredCells = 0, outsideCells = 0, curved = false;
  for (let i = 0; i < nu - 1; i++) {
    if (stop()) return stopped();
    for (let j = 0; j < nv - 1; j++) {
      yield;
      visitedCells++;
      const net = cellNet(spline, i, j);
      const cell = i * (nv - 1) + j, full = (uKnots[i + 1] - uKnots[i]) * (vKnots[j + 1] - vKnots[j]);
      const c00 = net[0][0], c10 = net[3][0], c01 = net[0][3], c11 = net[3][3];
      const netDiff = bilinearGap(net);
      let magnitude = 0;
      for (const row of net) for (const point of row) {
        magnitude = Math.max(magnitude, Math.abs(point[0]), Math.abs(point[1]), Math.abs(point[2]));
      }
      // Planarity of the same net: its own bilinear net with zero corner twist, up to rounding.
      if (netDiff + length(add(subtract(subtract(c11, c10), c01), c00)) > ROUNDING * (1 + magnitude)) curved = true;
      if (members[cell].length === 0) {
        const outside = [0, 1, 2].some(axis => net.every(row => row.every(point => point[axis] > box.maximum[axis]))
          || net.every(row => row.every(point => point[axis] < box.minimum[axis])));
        if (!outside) return rejected('coverage');
        outsideCells++;
        continue;
      }
      const low: Planar = [uKnots[i], vKnots[j]], high: Planar = [uKnots[i + 1], vKnots[j + 1]];
      // Coverage of the cell: no two clips overlap in positive area (every pair is tested, within the shared work
      // ceiling), so their areas add up to the area of their union; that union must be the whole cell. An area sum
      // alone is not enough: a duplicated half and a missing half also sum to the cell.
      const clips: Planar[][] = [];
      for (const t of members[cell]) {
        const halt = work(); if (halt !== null) return halt;
        if (pairs % STEP_UNITS === 0) yield;
        polygon.rectangleArea(corners(t), low[0], low[1], high[0], high[1]);
        clips.push(polygon.copy());
      }
      let overlap = 0;
      for (let x = 0; x < clips.length; x++) {
        for (let y = x + 1; y < clips.length; y++) {
          const halt = work(); if (halt !== null) return halt;
          if (pairs % STEP_UNITS === 0) yield;
          overlap += polygon.intersectionArea(clips[x], clips[y]);
        }
      }
      if (!(overlap <= full * AREA_TOLERANCE) || area[cell] > full * (1 + AREA_TOLERANCE)) return rejected('overlap');
      if (area[cell] < full * (1 - AREA_TOLERANCE)) return rejected('coverage');
      coveredCells++;
      const width = high[0] - low[0], height = high[1] - low[1];
      /** B at a cell-local parameter point. */
      const bilinear = (point: Planar): Vector => {
        const a = point[0] / width, b = point[1] / height;
        const w00 = (1 - a) * (1 - b), w10 = a * (1 - b), w01 = (1 - a) * b, w11 = a * b;
        // Preserve the grouped scalar operations without six temporary vector arrays per evaluation.
        return [(c00[0] * w00 + c10[0] * w10) + (c01[0] * w01 + c11[0] * w11),
          (c00[1] * w00 + c10[1] * w10) + (c01[1] * w01 + c11[1] * w11),
          (c00[2] * w00 + c10[2] * w10) + (c01[2] * w01 + c11[2] * w11)];
      };
      let meshGap = 0;
      for (const [member, t] of members[cell].entries()) {
        // A single cell can contain thousands of triangles. Its error proof must yield too, after the overlap proof.
        if (member % STEP_UNITS === 0) { if (stop()) return stopped(); yield; }
        const [a, b, c] = mesh.triangles[t].map(index => mesh.vertices[index]);
        const e1: Planar = [b.parameters[0] - a.parameters[0], b.parameters[1] - a.parameters[1]];
        const e2: Planar = [c.parameters[0] - a.parameters[0], c.parameters[1] - a.parameters[1]];
        const determinant = e1[0] * e2[1] - e1[1] * e2[0];
        const d1 = subtract(b.point, a.point), d2 = subtract(c.point, a.point);
        /** L_T at a cell-local point of the clip (inside T: barycentric weights in [0, 1] up to rounding). */
        const affine = (point: Planar): Vector => {
          const du = point[0] + low[0] - a.parameters[0], dv = point[1] + low[1] - a.parameters[1];
          const alpha = (du * e2[1] - dv * e2[0]) / determinant, beta = (e1[0] * dv - e1[1] * du) / determinant;
          return [a.point[0] + (d1[0] * alpha + d2[0] * beta), a.point[1] + (d1[1] * alpha + d2[1] * beta),
            a.point[2] + (d1[2] * alpha + d2[2] * beta)];
        };
        const clip = clips[member];
        const extreme = [0, 0, 0];
        for (let index = 0; index < clip.length; index++) {
          const p = clip[index], q = clip[(index + 1) % clip.length], m: Planar = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
          const values = [p, m, q].map(point => {
            const mapped = affine(point), patch = bilinear(point);
            if (!finite(mapped) || !finite(patch)) return null;
            magnitude = Math.max(magnitude, ...mapped.map(Math.abs), ...patch.map(Math.abs));
            return subtract(patch, mapped);
          });
          const [start, middle, end] = values;
          if (start === null || middle === null || end === null) return rejected('nonfinite');
          // Along the edge each component of B - L_T is exactly quadratic; the clip's extremes lie on its edges.
          for (let axis = 0; axis < 3; axis++) extreme[axis] = Math.max(extreme[axis], quadraticMaximum(start[axis], middle[axis], end[axis]));
        }
        meshGap = Math.max(meshGap, Math.hypot(extreme[0], extreme[1], extreme[2]));
      }
      const raw = netDiff + meshGap, bound = raw + ROUNDING * (raw + magnitude);
      if (!Number.isFinite(bound)) return rejected('nonfinite');
      splineToMesh = Math.max(splineToMesh, bound);
    }
  }
  return { status: 'certified', splineToMesh, coveredCells, outsideCells, curved, visitedCells, work: pairs };
}

/** Build the spline from the sampler's leaves and certify it against the sampler's mesh. */
export function smoothFunctionSurface(source: SmoothSurfaceSource, leaves: readonly SurfaceLeaf[],
  options: SmoothSurfaceOptions): SmoothSurfaceOutcome {
  let samples = 0, cells = 0;
  const used = (): SmoothSurfaceUsage => ({ samples, cells });
  const declined = (reason: 'coverage' | 'budget' | 'samples' | 'bound' | 'affine'): SmoothSurfaceOutcome =>
    ({ status: 'declined', reason, used: used() });
  const stopped = (): SmoothSurfaceOutcome => ({ status: 'stopped', used: used() });
  const uIndex = [...new Set(leaves.flatMap(leaf => [leaf.u, leaf.u + leaf.span]))].sort((a, b) => a - b);
  const vIndex = [...new Set(leaves.flatMap(leaf => [leaf.v, leaf.v + leaf.span]))].sort((a, b) => a - b);
  const nu = uIndex.length, nv = vIndex.length;
  if (nu < 2 || nv < 2) return declined('coverage');
  // One shared budget: the sampler's remaining samples and cells, and the common pole ceiling.
  if (4 * nu * nv > FUNCTION_SURFACE_SPLINE_POLE_LIMIT || nu * nv > options.remainingSamples
    || (nu - 1) * (nv - 1) > options.remainingCells) return declined('budget');
  const uKnots = uIndex.map(index => options.parameter(index, 0)), vKnots = vIndex.map(index => options.parameter(index, 1));
  // The same clear knot margin the native builder requires, so a certified spline is never refused later.
  for (const knots of [uKnots, vKnots]) {
    for (let n = 1; n < knots.length; n++) {
      if (!(knots[n] - knots[n - 1] > KNOT_GAP * Math.max(1, Math.abs(knots[n]), Math.abs(knots[n - 1])))) return declined('coverage');
    }
  }
  const values: Vector[][] = [];
  for (let i = 0; i < nu; i++) {
    const row: Vector[] = [];
    for (let j = 0; j < nv; j++) {
      if ((i * nv + j) % 256 === 0 && options.stop()) return stopped();
      const parameters: SurfaceParameter = [uKnots[i], vKnots[j]];
      const known = options.knownSample?.([uIndex[i], vIndex[j]]);
      // Keep logical sample charging and stop cadence unchanged even when arithmetic was already certified.
      samples++;
      if (known !== undefined && (known.vertex.parameters[0] !== parameters[0]
        || known.vertex.parameters[1] !== parameters[1])) return declined('samples');
      const point = known === undefined ? source.point(parameters) : known.vertex.point;
      if (point === null || point.length !== 3 || !finite(point)) return declined('samples');
      const error = known === undefined ? functionPointError(source.enclosure(parameters, parameters), point) : known.error;
      if (!Number.isFinite(error) || error < 0) return declined('samples');
      row.push([point[0], point[1], point[2]]);
    }
    values.push(row);
  }
  // Shared derivatives: u along columns of fixed v, v along rows, twist = u-derivative of the v-derivatives.
  const du: Vector[][] = values.map(() => []), dv: Vector[][] = values.map(() => []), duv: Vector[][] = values.map(() => []);
  for (let j = 0; j < nv; j++) {
    if (options.stop()) return stopped();
    const column = values.map(row => row[j]);
    for (let i = 0; i < nu; i++) du[i][j] = derivative(column, uKnots, i);
  }
  for (let i = 0; i < nu; i++) {
    if (options.stop()) return stopped();
    for (let j = 0; j < nv; j++) dv[i][j] = derivative(values[i], vKnots, j);
  }
  for (let j = 0; j < nv; j++) {
    if (options.stop()) return stopped();
    const column = dv.map(row => row[j]);
    for (let i = 0; i < nu; i++) duv[i][j] = derivative(column, uKnots, i);
  }
  if ([du, dv, duv].some(field => field.some(row => row.some(vector => !finite(vector))))) return declined('samples');
  const hermite = (i: number, j: number, offsetU: number, offsetV: number): Vector =>
    add(add(add(values[i][j], scale(du[i][j], offsetU)), scale(dv[i][j], offsetV)), scale(duv[i][j], offsetU * offsetV));
  const rows = 2 * nu, columns = 2 * nv, poles: FunctionPoint[] = [];
  for (let p = 0; p < rows; p++) {
    if (options.stop()) return stopped();
    const a = poleSource(p, uKnots);
    for (let q = 0; q < columns; q++) {
      const b = poleSource(q, vKnots), pole = hermite(a.node, b.node, a.offset, b.offset);
      if (!finite(pole)) return declined('samples');
      poles.push(Object.freeze(pole));
    }
  }
  // One pass over the product cells proves coverage and the bound and decides planarity; `cells` counts each cell the
  // certificate actually examined (once), including when it stops or rejects part way.
  const certificate = certifySplineAgainstMesh({ uKnots, vKnots, poles }, options.mesh, options, options.stop);
  cells = certificate.visitedCells;
  if (certificate.status === 'stopped') return stopped();
  if (certificate.status === 'rejected') {
    return declined(certificate.reason === 'budget' ? 'budget' : certificate.reason === 'nonfinite' ? 'samples' : 'coverage');
  }
  // Planar data keep the existing exact planar triangles and their exact plane sections.
  if (!certificate.curved) return declined('affine');
  const errorBound = options.mesh.bound + certificate.splineToMesh;
  if (!(errorBound <= options.tolerance)) return declined('bound');
  return { status: 'ready', used: used(), spline: Object.freeze({ uKnots: Object.freeze(uKnots), vKnots: Object.freeze(vKnots),
    poles: Object.freeze(poles), errorBound }) };
}
