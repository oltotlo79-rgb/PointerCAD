/** Conforming parameter triangles, bounded on the whole cell before actual CAD clipping. */
import { intervalUnion, unionAdd, unionOutsideBounds } from './mathIntervalUnion.js';
import { nextFloat, type MathInterval } from './mathInterval.js';
import { functionPointError, functionRangeDiameter, validFunctionWorldBounds,
  type FunctionPoint, type FunctionPointRanges } from './functionGeometryBounds.js';
import { createSurfaceBoundary, splitSurfaceCell, type SurfaceParameter, type SurfaceCell, type SurfaceLeaf } from './surfaceParameterGrid.js';
import { FUNCTION_SURFACE_LIMITS } from './functionSurfaceLimits.js';
import { CONDITION_BOUNDARY_SHARE, createFunctionConditionDomain, createFunctionDomainTest, functionBranchDistance,
  functionBranchSeparation, functionConditionBoundaryProblem, functionOutputTapes, functionTapeScope, restrictFunctionRanges,
  type FunctionConditionBranch, type FunctionConditionDomain, type FunctionSurfaceBoundary } from './functionSurfaceBoundary.js';
import { scalarIntervalBoundaries } from './scalarMathIntervals.js';
import { scalarBoundaryDisplacement } from './scalarCurveCurvature.js';
import type { ScalarCondition, ScalarTape } from './scalarMathTape.js';

export interface FunctionSurfaceEvaluator {
  readonly point: (parameters: SurfaceParameter) => FunctionPoint | null;
  readonly enclosure: (lower: SurfaceParameter, upper: SurfaceParameter) => FunctionPointRanges;
  /** Affine interpolation bound for any triangle contained in the parameter rectangle. */
  readonly interpolationErrorBound?: (lower: SurfaceParameter, upper: SurfaceParameter) => number | null;
}
export interface FunctionSurfaceOptions {
  readonly lower: SurfaceParameter;
  readonly upper: SurfaceParameter;
  readonly minimum: FunctionPoint;
  readonly maximum: FunctionPoint;
  readonly tolerance: number;
  readonly maximumSamples: number;
  readonly maximumCells: number;
  readonly maximumTriangles: number;
  readonly maximumDepth: number;
  readonly shouldStop?: () => 'cancelled' | 'deadline' | undefined;
  readonly boundary?: FunctionSurfaceBoundary;
  /** Optional range condition, compiled with the two independent variables as inputs in the same order. */
  readonly domain?: ScalarCondition;
}
export interface FunctionSurfaceVertex { readonly parameters: SurfaceParameter; readonly point: FunctionPoint }
export interface FunctionSurfaceStats { readonly samples: number; readonly cells: number; readonly triangles: number }
type StopReason = 'cancelled' | 'deadline' | 'samples' | 'cells' | 'triangles' | 'subdivision' | 'roundoff';
export type FunctionSurfaceSamplingResult =
  | { readonly status: 'ready'; readonly vertices: readonly FunctionSurfaceVertex[];
      readonly triangles: readonly (readonly [number, number, number])[];
      readonly maximumInterpolationErrorBound: number; readonly stats: FunctionSurfaceStats }
  | { readonly status: 'empty' | 'degenerate'; readonly stats: FunctionSurfaceStats }
  | { readonly status: 'stopped'; readonly reason: StopReason; readonly stats: FunctionSurfaceStats };
interface Sample { readonly vertex: FunctionSurfaceVertex; readonly error: number }
function budget(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function validOptions(options: FunctionSurfaceOptions): boolean {
  return validFunctionWorldBounds(options.minimum, options.maximum) && options.lower.length === 2 && options.upper.length === 2
    && [0,1].every(axis => Number.isFinite(options.lower[axis]) && Number.isFinite(options.upper[axis])
      && options.lower[axis] < options.upper[axis] && Number.isFinite(options.upper[axis]-options.lower[axis]))
    && Number.isFinite(options.tolerance) && options.tolerance > 0
    && budget(options.maximumSamples, 5, FUNCTION_SURFACE_LIMITS.maximumSamples) && budget(options.maximumCells, 1, FUNCTION_SURFACE_LIMITS.maximumCells)
    && budget(options.maximumTriangles, 4, FUNCTION_SURFACE_LIMITS.maximumTriangles) && budget(options.maximumDepth, 1, FUNCTION_SURFACE_LIMITS.maximumDepth);
}
function corners(cell: SurfaceCell): readonly SurfaceParameter[] {
  return [[cell.u,cell.v], [cell.u+cell.span,cell.v], [cell.u+cell.span,cell.v+cell.span], [cell.u,cell.v+cell.span]];
}
function centre(cell: SurfaceCell): SurfaceParameter { return [cell.u+cell.span/2,cell.v+cell.span/2]; }
function triangleKind(a: FunctionPoint, b: FunctionPoint, c: FunctionPoint): 'face' | 'degenerate' | 'roundoff' {
  const ab = b.map((value, axis) => value-a[axis]), ac = c.map((value, axis) => value-a[axis]);
  if (!ab.every(Number.isFinite) || !ac.every(Number.isFinite)) return 'roundoff';
  const sb = Math.max(...ab.map(Math.abs)), sc = Math.max(...ac.map(Math.abs));
  if (sb === 0 || sc === 0) return 'degenerate';
  const bUnit = ab.map(value => value/sb), cUnit = ac.map(value => value/sc);
  const normal = [bUnit[1]*cUnit[2]-bUnit[2]*cUnit[1], bUnit[2]*cUnit[0]-bUnit[0]*cUnit[2], bUnit[0]*cUnit[1]-bUnit[1]*cUnit[0]];
  return normal.some(value => value !== 0) ? 'face' : 'degenerate';
}

function surfaceConditions(evaluator: FunctionSurfaceEvaluator, options: FunctionSurfaceOptions,
  known?: readonly (ScalarTape | undefined)[]): FunctionConditionDomain | null {
  const { lower, upper } = options, middle: SurfaceParameter = [lower[0]+(upper[0]-lower[0])/2, lower[1]+(upper[1]-lower[1])/2];
  const tapes = functionOutputTapes(point => evaluator.enclosure([point[0], point[1]], [point[0], point[1]]),
    [middle, lower, upper, [lower[0], upper[1]], [upper[0], lower[1]]], 2, known);
  return createFunctionConditionDomain(tapes, box => evaluator.enclosure([box[0].lower, box[1].lower], [box[0].upper, box[1].upper]),
    options.domain);
}
function restrictSurface(evaluator: FunctionSurfaceEvaluator, domain: ScalarCondition): FunctionSurfaceEvaluator {
  const test = createFunctionDomainTest(domain);
  return {
    point: parameters => test.point(parameters) ? evaluator.point(parameters) : null,
    enclosure: (lower, upper) => restrictFunctionRanges(test.box([{ lower: lower[0], upper: upper[0] }, { lower: lower[1], upper: upper[1] }]),
      () => evaluator.enclosure(lower, upper)),
    ...(evaluator.interpolationErrorBound === undefined ? {} : { interpolationErrorBound: evaluator.interpolationErrorBound }),
  };
}

/** No partial mesh on cancellation, unresolved domains, resource exhaustion or unverifiable precision. */
export function sampleFunctionSurface(evaluator: FunctionSurfaceEvaluator, options: FunctionSurfaceOptions): FunctionSurfaceSamplingResult {
  if (!validOptions(options)) throw new RangeError('有限のXYZ範囲・2つの媒介範囲・精度と分割上限を指定してください。');
  const stop = options.shouldStop?.();
  if (stop !== undefined) return { status: 'stopped', reason: stop, stats: { samples: 0, cells: 0, triangles: 0 } };
  const drawn = options.domain === undefined ? evaluator : restrictSurface(evaluator, options.domain);
  // Without a range condition, the ordinary root enclosure also shows whether a general condition boundary can exist.
  const root = options.domain === undefined ? functionTapeScope(() => evaluator.enclosure(options.lower, options.upper), 2) : undefined;
  const initial = root?.values ?? drawn.enclosure(options.lower, options.upper);
  if (!initial.every(range => range.continuous)) {
    // General condition boundaries and range conditions use one conforming patch; exact cuts inside it are general too.
    const conditions = surfaceConditions(evaluator, options, root?.tapes);
    if (conditions !== null) return sampleSurfacePatch(drawn, options, initial, true, conditions);
  }
  if (initial.every(range => range.continuous) || !initial.some(range => scalarIntervalBoundaries(range).length > 0)) {
    return sampleSurfacePatch(drawn, options, initial, true);
  }
  const vertices: FunctionSurfaceVertex[] = [], triangles: (readonly [number, number, number])[] = [];
  let cells = 0, samples = 0, maximumInterpolationErrorBound = 0;
  const stats = (): FunctionSurfaceStats => ({ samples, cells, triangles: triangles.length });
  const stopped = (reason: StopReason): FunctionSurfaceSamplingResult => ({ status: 'stopped', reason, stats: stats() });
  const stack = [{ lower: options.lower, upper: options.upper, depth: 0, ranges: initial }];
  while (stack.length > 0) {
    const stop = options.shouldStop?.(); if (stop !== undefined) return stopped(stop);
    if (cells >= options.maximumCells) return stopped('cells');
    const cell = stack.pop(); if (cell === undefined) break;
    let boundaryError = 0;
    if (unionOutsideBounds(cell.ranges, options.minimum, options.maximum)) { cells++; continue; }
    const cuts = cell.ranges.flatMap(scalarIntervalBoundaries);
    const split = cuts.find(cut => cut.value > cell.lower[cut.axis] && cut.value < cell.upper[cut.axis]);
    if (split !== undefined && !cell.ranges.every(range => range.continuous)) {
      if (cell.depth >= options.maximumDepth) return stopped('subdivision');
      cells++;
      const left: [number, number] = [...cell.upper], right: [number, number] = [...cell.lower];
      left[split.axis] = split.value; right[split.axis] = split.value;
      stack.push({ lower: right, upper: cell.upper, depth: cell.depth + 1, ranges: evaluator.enclosure(right, cell.upper) },
        { lower: cell.lower, upper: left, depth: cell.depth + 1, ranges: evaluator.enclosure(cell.lower, left) });
      continue;
    }
    if (!cell.ranges.every(range => range.continuous)) {
      const edges = [0, 1, 2, 3].map(edge => cuts.some(cut => cut.axis === Math.floor(edge / 2)
        && cut.value === (edge % 2 === 0 ? cell.lower[cut.axis] : cell.upper[cut.axis])));
      const insideEdge = (axis: number, lower: boolean): number => {
        const edge = lower ? cell.lower[axis] : cell.upper[axis];
        const matching = cuts.filter(cut => cut.axis === axis && cut.value === edge);
        return nextFloat(matching.reduce((value, cut) => lower ? Math.max(value, cut.upper) : Math.min(value, cut.lower), edge), lower ? 1 : -1);
      };
      // Prefer retaining each included edge. Only exact comparison boundaries
      // may move beyond their enclosure into a certified branch rectangle.
      for (const mask of [1, 2, 4, 8, 3, 5, 6, 9, 10, 12, 7, 11, 13, 14, 15]) {
        if (edges.some((allowed, edge) => !allowed && (mask & (1 << edge)) !== 0)) continue;
        const lower: SurfaceParameter = [mask & 1 ? insideEdge(0, true) : cell.lower[0], mask & 4 ? insideEdge(1, true) : cell.lower[1]];
        const upper: SurfaceParameter = [mask & 2 ? insideEdge(0, false) : cell.upper[0], mask & 8 ? insideEdge(1, false) : cell.upper[1]];
        if (lower.some((value, axis) => value >= upper[axis])) continue;
        const ranges = evaluator.enclosure(lower, upper);
        if (!ranges.every(range => range.continuous || range.ranges.length === 0)) continue;
        if (!ranges.some(range => range.ranges.length === 0)) {
          const displacement = scalarBoundaryDisplacement(() => evaluator.enclosure(lower, upper),
            cell.lower.map((value, axis) => ({ lower: value, upper: cell.upper[axis] })),
            lower.map((value, axis) => ({ lower: value, upper: upper[axis] })));
          if (displacement === null) continue;
          const outside = unionOutsideBounds(ranges, options.minimum, options.maximum);
          if (outside) {
            const padding = intervalUnion(-displacement, displacement);
            if (!unionOutsideBounds([unionAdd(ranges[0], padding), unionAdd(ranges[1], padding), unionAdd(ranges[2], padding)],
              options.minimum, options.maximum)) continue;
          } else {
            if (displacement >= options.tolerance) continue;
            boundaryError = displacement;
          }
        }
        cell.lower = lower; cell.upper = upper; cell.ranges = ranges; break;
      }
    }
    if (unionOutsideBounds(cell.ranges, options.minimum, options.maximum)) { cells++; continue; }
    if (samples + 5 > options.maximumSamples) return stopped('samples');
    if (triangles.length >= options.maximumTriangles) return stopped('triangles');
    const topology = options.boundary;
    const boundary: FunctionSurfaceBoundary | undefined = topology === undefined ? undefined : {
      periodic: [0, 1].map(axis => topology.periodic[axis] && cell.lower[axis] === options.lower[axis]
        && cell.upper[axis] === options.upper[axis]) as [boolean, boolean],
      poles: [0, 1].map(axis => [topology.poles[axis][0] && cell.lower[axis] === options.lower[axis],
        topology.poles[axis][1] && cell.upper[axis] === options.upper[axis]]) as [[boolean, boolean], [boolean, boolean]],
    };
    const patch = sampleSurfacePatch(evaluator, { ...options, lower: cell.lower, upper: cell.upper,
      tolerance: boundaryError === 0 ? options.tolerance : nextFloat(options.tolerance - boundaryError, -1),
      maximumSamples: options.maximumSamples - samples, maximumCells: options.maximumCells - cells,
      maximumTriangles: options.maximumTriangles - triangles.length, maximumDepth: options.maximumDepth - cell.depth,
      ...(boundary === undefined ? {} : { boundary }) }, cell.ranges);
    cells += patch.stats.cells; samples += patch.stats.samples;
    if (patch.status === 'stopped') return stopped(patch.reason);
    if (patch.status !== 'ready') continue;
    const offset = vertices.length;
    for (const vertex of patch.vertices) vertices.push(vertex);
    for (const face of patch.triangles) triangles.push([face[0] + offset, face[1] + offset, face[2] + offset]);
    const error = boundaryError === 0 ? patch.maximumInterpolationErrorBound : nextFloat(patch.maximumInterpolationErrorBound + boundaryError, 1);
    if (error > options.tolerance) return stopped('roundoff');
    maximumInterpolationErrorBound = Math.max(maximumInterpolationErrorBound, error);
  }
  return triangles.length === 0 ? { status: 'empty', stats: stats() }
    : { status: 'ready', vertices, triangles, maximumInterpolationErrorBound, stats: stats() };
}

interface OmittedSurfaceCell { readonly cell: SurfaceCell; readonly branches: readonly FunctionConditionBranch[] }
interface SurfaceCover { readonly grid: SurfaceParameter; readonly distance: number }
const QUADRANTS: readonly (readonly [number, number])[] = [[1,1],[-1,1],[-1,-1],[1,-1]];
/** Rings of cells searched around an omitted cell whose own corners do not cover a branch. */
const COVER_RINGS = 6;

/**
 * With conditions, cells whose condition is undecided are left out only after each branch that may occur
 * there is covered by a drawn vertex of a proven cell: the continued branch distance plus that vertex error
 * is part of the reported bound. Triangles never join two branches or cross outside the condition.
 */
function sampleSurfacePatch(evaluator: FunctionSurfaceEvaluator, options: FunctionSurfaceOptions,
  initial: FunctionPointRanges, initialStopChecked = false, conditions: FunctionConditionDomain | null = null): FunctionSurfaceSamplingResult {
  // One extra integer bit keeps leaf centres integral at the maximum permitted depth.
  const gridSize = 2**(options.maximumDepth+1), cache = new Map<string, Sample | null>(), leaves: SurfaceLeaf[] = [];
  const vertices: FunctionSurfaceVertex[] = [], triangles: [number, number, number][] = [], vertexIndexes = new Map<string, number>();
  let cells = 0, failure: StopReason | undefined, maximumInterpolationErrorBound = 0;
  const stats = (): FunctionSurfaceStats => ({ samples: cache.size, cells, triangles: triangles.length });
  const stopped = (reason: StopReason): FunctionSurfaceSamplingResult => ({ status: 'stopped', reason, stats: stats() });
  const key = (grid: SurfaceParameter) => `${grid[0]},${grid[1]}`;
  const parameter = (index: number, axis: number) => index === 0 ? options.lower[axis] : index === gridSize ? options.upper[axis]
    : options.lower[axis]+(options.upper[axis]-options.lower[axis])*(index/gridSize);
  const parameters = (grid: SurfaceParameter): SurfaceParameter => [parameter(grid[0],0),parameter(grid[1],1)];
  const sample = (grid: SurfaceParameter): Sample | null => {
    const id = key(grid); if (cache.has(id)) return cache.get(id) ?? null;
    if (cache.size >= options.maximumSamples) { failure = 'samples'; return null; }
    const input = parameters(grid), point = evaluator.point(input);
    if (point === null || point.length !== 3 || !point.every(Number.isFinite)) { cache.set(id,null); return null; }
    const vertex: FunctionSurfaceVertex = { parameters: Object.freeze(input), point: Object.freeze([point[0],point[1],point[2]]) };
    const result = { vertex, error: functionPointError(evaluator.enclosure(input,input), vertex.point) };
    cache.set(id,result); return result;
  };
  const stack: SurfaceCell[] = [{ u: 0, v: 0, span: gridSize, depth: 0 }];
  // Condition boundaries only: drawn leaves by lower corner, omitted cells and the vertices covering them.
  const omitted: OmittedSurfaceCell[] = [], covers: SurfaceCover[] = [], coverPoints = new Map<string, SurfaceParameter>();
  const leafCorners = new Map<number, SurfaceLeaf>(), leafSelections = new Map<SurfaceLeaf, string | null>();
  const box = (lower: SurfaceParameter, upper: SurfaceParameter): MathInterval[] =>
    [{ lower: lower[0], upper: upper[0] }, { lower: lower[1], upper: upper[1] }];
  const split = (cell: SurfaceCell, lower: SurfaceParameter, upper: SurfaceParameter): boolean => {
    const middle = parameters(centre(cell));
    if (middle.some((value, axis) => value === lower[axis] || value === upper[axis])) return false;
    stack.push(...[...splitSurfaceCell(cell)].reverse());
    return true;
  };
  for (;;) {
    while (stack.length > 0) {
      if (cells !== 0 || !initialStopChecked) {
        const stop = options.shouldStop?.(); if (stop !== undefined) return stopped(stop);
      }
      if (cells >= options.maximumCells) return stopped('cells');
      const cell = stack.pop(); if (cell === undefined) break; cells++;
      const lower = parameters([cell.u,cell.v]), upper = parameters([cell.u+cell.span,cell.v+cell.span]);
      let ranges = cell.depth === 0 ? initial : evaluator.enclosure(lower,upper);
      if (unionOutsideBounds(ranges, options.minimum, options.maximum)) continue;
      let conditionBoundary = false;
      if (conditions !== null && !ranges.every(range => range.continuous && range.ranges.length > 0)) {
        const kind = conditions.classify(box(lower, upper), options.minimum, options.maximum, CONDITION_BOUNDARY_SHARE*options.tolerance);
        if (kind.kind === 'empty') continue;
        if (kind.kind === 'boundary') {
          if (kind.branches.some(branch => branch.visible)) omitted.push({ cell, branches: kind.branches });
          continue;
        }
        if (kind.values !== undefined) {
          // One branch holds at every point of the cell, so its own enclosure is the function here.
          ranges = kind.values;
          if (unionOutsideBounds(ranges, options.minimum, options.maximum)) continue;
        }
        conditionBoundary = kind.kind === 'refine';
      }
      if (ranges.every(range => range.continuous && range.ranges.length > 0)) {
        let supplied = evaluator.interpolationErrorBound?.(lower,upper);
        if (supplied === null && ranges.some(range => scalarIntervalBoundaries(range).length > 0)) {
          const insideLower: SurfaceParameter = [nextFloat(lower[0], 1), nextFloat(lower[1], 1)];
          const insideUpper: SurfaceParameter = [nextFloat(upper[0], -1), nextFloat(upper[1], -1)];
          if (insideLower.every((value, axis) => value <= insideUpper[axis])
              && evaluator.interpolationErrorBound?.(insideLower, insideUpper) === 0) supplied = 0;
        }
        const error = supplied !== undefined && supplied !== null && Number.isFinite(supplied) && supplied >= 0
          ? supplied : functionRangeDiameter(ranges);
        // Reserve half of the requested tolerance for vertex evaluation, including later neighbor split points.
        if (error <= options.tolerance/2) {
          const points = [...corners(cell),centre(cell)].map(sample);
          if (failure !== undefined) return stopped(failure);
          if (points.every(point => point !== null)) {
            if (points.some(point => point.error > options.tolerance/2)) return stopped('roundoff');
            const leaf: SurfaceLeaf = { ...cell, interpolationError: error };
            leaves.push(leaf);
            if (conditions !== null) leafCorners.set(cell.u*(gridSize+1)+cell.v, leaf);
            continue;
          }
        }
      }
      if (cell.depth >= options.maximumDepth) {
        if (conditionBoundary) throw functionConditionBoundaryProblem();
        return stopped('subdivision');
      }
      if (!split(cell, lower, upper)) return stopped('roundoff');
    }
    if (conditions === null || omitted.length === 0) break;
    // A drawn leaf that contains a corner of an omitted cell, found from the leaf sizes around it.
    const leafAt = (x: number, y: number, dx: number, dy: number, span: number): SurfaceLeaf | undefined => {
      const px = x+dx/2, py = y+dy/2;
      if (px < 0 || py < 0 || px > gridSize || py > gridSize) return undefined;
      const probe = (size: number): SurfaceLeaf | undefined => {
        const leaf = leafCorners.get(Math.floor(px/size)*size*(gridSize+1)+Math.floor(py/size)*size);
        return leaf !== undefined && leaf.span === size ? leaf : undefined;
      };
      for (let size = span; size <= gridSize; size *= 2) { const leaf = probe(size); if (leaf !== undefined) return leaf; }
      for (let size = span/2; size >= 2; size /= 2) { const leaf = probe(size); if (leaf !== undefined) return leaf; }
      return undefined;
    };
    const leafSelection = (leaf: SurfaceLeaf): string | null => {
      if (!leafSelections.has(leaf)) {
        leafSelections.set(leaf, conditions.selection(box(parameters([leaf.u,leaf.v]), parameters([leaf.u+leaf.span,leaf.v+leaf.span]))));
      }
      return leafSelections.get(leaf) ?? null;
    };
    const selectionsAt = new Map<string, readonly string[]>();
    const drawnSelections = (grid: SurfaceParameter, span: number): readonly string[] => {
      const id = key(grid), cached = selectionsAt.get(id);
      if (cached !== undefined) return cached;
      const found: string[] = [];
      for (const [dx, dy] of QUADRANTS) {
        const leaf = leafAt(grid[0], grid[1], dx, dy, span), selection = leaf === undefined ? null : leafSelection(leaf);
        if (selection !== null && !found.includes(selection)) found.push(selection);
      }
      selectionsAt.set(id, found);
      return found;
    };
    type Candidate = SurfaceCover & { readonly total: number };
    const candidate = (grid: SurfaceParameter, distance: number, best: Candidate | undefined): Candidate | undefined => {
      if (!(distance < options.tolerance)) return best;
      const point = sample(grid);
      if (point === null) return best;
      const total = distance === 0 && point.error === 0 ? 0 : nextFloat(distance+point.error, 1);
      return total <= options.tolerance && (best === undefined || total < best.total) ? { grid, distance, total } : best;
    };
    /** Near a meeting point of boundaries a branch region is a wedge; its drawn corners may lie a few cells away. */
    const nearbyCover = (cell: SurfaceCell, branch: FunctionConditionBranch): Candidate | undefined => {
      let best: Candidate | undefined;
      const visited = new Set<SurfaceLeaf>();
      for (let ring = 1; ring <= COVER_RINGS && best === undefined; ring++) {
        for (let i = -ring; i <= ring; i++) for (let j = -ring; j <= ring; j++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
          const leaf = leafAt(cell.u+i*cell.span, cell.v+j*cell.span, 1, 1, cell.span);
          if (leaf === undefined || visited.has(leaf)) continue;
          visited.add(leaf);
          const selection = leafSelection(leaf);
          if (selection === null) continue;
          for (const grid of corners(leaf)) {
            const joint = box(parameters([Math.min(cell.u, grid[0]), Math.min(cell.v, grid[1])]),
              parameters([Math.max(cell.u+cell.span, grid[0]), Math.max(cell.v+cell.span, grid[1])]));
            best = candidate(grid, functionBranchDistance(conditions.hull(joint, branch.key), conditions.hull(joint, selection)), best);
            if (failure !== undefined) return undefined;
          }
        }
      }
      return best;
    };
    const refine: SurfaceCell[] = [];
    for (const { cell, branches } of omitted.splice(0)) {
      const found: SurfaceCover[] = [];
      let complete = true;
      for (const branch of branches) {
        if (!branch.visible) continue;
        let best: Candidate | undefined;
        for (const grid of corners(cell)) {
          for (const selection of drawnSelections(grid, cell.span)) {
            const other = branches.find(item => item.key === selection);
            best = candidate(grid, other === undefined ? Infinity : functionBranchDistance(branch.hull, other.hull), best);
            if (failure !== undefined) return stopped(failure);
          }
        }
        best ??= nearbyCover(cell, branch);
        if (failure !== undefined) return stopped(failure);
        if (best === undefined) {
          // A branch that holds only on an equality line is never drawn itself. When every other branch is
          // farther than the tolerance, no smaller cell can cover it either.
          if (branch.thin && branches.every(other => other === branch || functionBranchSeparation(branch.hull, other.hull) > options.tolerance)) {
            throw functionConditionBoundaryProblem();
          }
          complete = false;
          break;
        }
        found.push({ grid: best.grid, distance: best.distance });
      }
      if (!complete) { refine.push(cell); continue; }
      for (const cover of found) { covers.push(cover); coverPoints.set(key(cover.grid), cover.grid); }
    }
    if (refine.length === 0) break;
    for (const cell of refine) {
      if (cell.depth >= options.maximumDepth) throw functionConditionBoundaryProblem();
      if (!split(cell, parameters([cell.u,cell.v]), parameters([cell.u+cell.span,cell.v+cell.span]))) return stopped('roundoff');
    }
  }
  if (leaves.length === 0) return { status: 'empty', stats: stats() };
  // Covering corners become ring vertices of the drawn leaves that contain them.
  const extra = [...coverPoints.values()].map(([u, v]): SurfaceLeaf => ({ u, v, span: 0, depth: 0, interpolationError: 0 }));
  const boundary = createSurfaceBoundary(extra.length === 0 ? leaves : [...leaves, ...extra], options.boundary?.periodic, gridSize);
  const canonicalGrid = (grid: SurfaceParameter): SurfaceParameter => {
    let [u,v] = grid;
    const topology = options.boundary;
    if (topology === undefined) return grid;
    if (topology.periodic[0] && u === gridSize) u = 0;
    if (topology.periodic[1] && v === gridSize) v = 0;
    if ((u === 0 && topology.poles[0][0]) || (u === gridSize && topology.poles[0][1])) v = 0;
    if ((v === 0 && topology.poles[1][0]) || (v === gridSize && topology.poles[1][1])) u = 0;
    return [u,v];
  };
  const vertexIndex = (grid: SurfaceParameter): number | null => {
    const canonical = canonicalGrid(grid), id = key(canonical), existing = vertexIndexes.get(id);
    const point = sample(grid); if (point === null) { failure ??= 'roundoff'; return null; }
    const representative = existing === undefined ? sample(canonical)?.vertex : vertices[existing];
    if (representative === undefined) { failure ??= 'roundoff'; return null; }
    // Shared topology may change a floating approximation by a few ulps. Recheck the full point enclosure.
    const error = id === key(grid) ? point.error : functionPointError(evaluator.enclosure(point.vertex.parameters,point.vertex.parameters),representative.point);
    if (error > options.tolerance/2) { failure = 'roundoff'; return null; }
    cache.set(key(grid),{vertex:{parameters:point.vertex.parameters,point:representative.point},error});
    if (existing !== undefined) return existing;
    const index = vertices.length; vertices.push(representative); vertexIndexes.set(id,index); return index;
  };
  for (const leaf of leaves) {
    const stop = options.shouldStop?.(); if (stop !== undefined) return stopped(stop);
    const centerGrid = centre(leaf), ring = boundary(leaf), simple = ring.length === 4;
    const middle = simple ? null : vertexIndex(centerGrid), indexes = ring.map(vertexIndex);
    if (failure !== undefined) return stopped(failure);
    if (!simple && middle === null || indexes.some(index => index === null)) return stopped('roundoff');
    const vertexError = (simple ? ring : [centerGrid,...ring]).reduce((error, grid) => Math.max(error, cache.get(key(grid))?.error ?? Infinity), 0);
    const total = leaf.interpolationError === 0 && vertexError === 0 ? 0 : nextFloat(leaf.interpolationError+vertexError,1);
    if (total > options.tolerance) return stopped('roundoff');
    maximumInterpolationErrorBound = Math.max(maximumInterpolationErrorBound,total);
    // The whole-cell bound applies to both diagonals. Only cells with neighbor split points need a centre fan.
    const faces = simple ? [[indexes[0],indexes[1],indexes[2]],[indexes[0],indexes[2],indexes[3]]]
      : indexes.map((a,index)=>[middle,a,indexes[(index+1)%indexes.length]]);
    for (const [a,b,c] of faces) {
      if (a === null || b === null || c === null) return stopped('roundoff');
      const kind = triangleKind(vertices[a].point,vertices[b].point,vertices[c].point);
      if (kind === 'roundoff') return stopped('roundoff');
      if (kind === 'degenerate') continue;
      if (triangles.length >= options.maximumTriangles) return stopped('triangles');
      triangles.push([a,b,c]);
    }
  }
  if (triangles.length === 0) return { status: 'degenerate', stats: stats() };
  for (const cover of covers) {
    // Recheck with the final vertex, which a periodic seam or pole may have replaced by its representative.
    const vertex = cache.get(key(cover.grid));
    const total = vertex === undefined || vertex === null ? Infinity
      : cover.distance === 0 && vertex.error === 0 ? 0 : nextFloat(cover.distance+vertex.error, 1);
    if (total > options.tolerance) return stopped('roundoff');
    maximumInterpolationErrorBound = Math.max(maximumInterpolationErrorBound, total);
  }
  return { status: 'ready', vertices, triangles, maximumInterpolationErrorBound, stats: stats() };
}
