/** Conforming parameter triangles, bounded on the whole cell before actual CAD clipping. */
import { unionOutsideBounds } from './mathIntervalUnion.js';
import { nextFloat } from './mathInterval.js';
import { functionPointError, functionRangeDiameter, validFunctionWorldBounds,
  type FunctionPoint, type FunctionPointRanges } from './functionGeometryBounds.js';
import { createSurfaceBoundary, splitSurfaceCell, type SurfaceParameter, type SurfaceCell, type SurfaceLeaf } from './surfaceParameterGrid.js';
import { FUNCTION_SURFACE_LIMITS } from './functionSurfaceLimits.js';
import type { FunctionSurfaceBoundary } from './functionSurfaceBoundary.js';

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

/** No partial mesh on cancellation, unresolved domains, resource exhaustion or unverifiable precision. */
export function sampleFunctionSurface(evaluator: FunctionSurfaceEvaluator, options: FunctionSurfaceOptions): FunctionSurfaceSamplingResult {
  if (!validOptions(options)) throw new RangeError('有限のXYZ範囲・2つの媒介範囲・精度と分割上限を指定してください。');
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
  while (stack.length > 0) {
    const stop = options.shouldStop?.(); if (stop !== undefined) return stopped(stop);
    if (cells >= options.maximumCells) return stopped('cells');
    const cell = stack.pop(); if (cell === undefined) break; cells++;
    const lower = parameters([cell.u,cell.v]), upper = parameters([cell.u+cell.span,cell.v+cell.span]);
    const ranges = evaluator.enclosure(lower,upper);
    if (unionOutsideBounds(ranges, options.minimum, options.maximum)) continue;
    if (ranges.every(range => range.continuous && range.ranges.length > 0)) {
      const supplied = evaluator.interpolationErrorBound?.(lower,upper);
      const error = supplied !== undefined && supplied !== null && Number.isFinite(supplied) && supplied >= 0
        ? supplied : functionRangeDiameter(ranges);
      // Reserve half of the requested tolerance for vertex evaluation, including later neighbor split points.
      if (error <= options.tolerance/2) {
        const points = [...corners(cell),centre(cell)].map(sample);
        if (failure !== undefined) return stopped(failure);
        if (points.every(point => point !== null)) {
          if (points.some(point => point.error > options.tolerance/2)) return stopped('roundoff');
          leaves.push({ ...cell, interpolationError: error }); continue;
        }
      }
    }
    if (cell.depth >= options.maximumDepth) return stopped('subdivision');
    const middle = parameters(centre(cell));
    if (middle.some((value, axis) => value === lower[axis] || value === upper[axis])) return stopped('roundoff');
    stack.push(...[...splitSurfaceCell(cell)].reverse());
  }
  if (leaves.length === 0) return { status: 'empty', stats: stats() };
  const boundary = createSurfaceBoundary(leaves,options.boundary?.periodic,gridSize);
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
  return { status: 'ready', vertices, triangles, maximumInterpolationErrorBound, stats: stats() };
}
