/** Uniform final cells with interval pruning. Every output vertex stays in the mandatory XYZ box. */
import { validFunctionWorldBounds, type FunctionPoint } from './functionGeometryBounds.js';
import { nextFloat } from './mathInterval.js';
import type { FunctionImplicitEvaluator } from './functionImplicitEvaluation.js';
import type { IntervalUnion } from './mathIntervalUnion.js';
import { FUNCTION_SURFACE_LIMITS, type FunctionSurfaceBudget } from './functionSurfaceLimits.js';
import { implicitMonotoneExtrema, proveImplicitRegionEmpty } from './implicitEmptyRegion.js';
import { implicitBoxDistance } from './implicitPoint.js';
import { hasRegularImplicitAxis, refinedImplicitPartials } from './implicitRegularity.js';

export interface ImplicitGridOptions extends FunctionSurfaceBudget {
  readonly minimum: FunctionPoint; readonly maximum: FunctionPoint; readonly tolerance: number;
  readonly fixed?: {readonly axis:0|1|2; readonly coordinate:number};
  readonly shouldStop?: () => 'cancelled' | 'deadline' | undefined;
}
export interface ImplicitGridPoint { readonly key: string; readonly point: FunctionPoint; readonly value: number }
export interface ImplicitGridCell { readonly points: readonly ImplicitGridPoint[]; readonly needsCoverage?: boolean }
export type ImplicitGridResult = {
  readonly status: 'ready'; readonly cells: readonly ImplicitGridCell[];
  /** Conservative geometric diameter, not a value residual or an estimate of curvature. */
  readonly maximumCellDiameter: number; readonly samples: number; readonly visited: number;
} | { readonly status: 'empty' | 'degenerate'; readonly samples: number; readonly visited: number }
  | { readonly status: 'stopped'; readonly reason: 'cancelled' | 'deadline' | 'samples' | 'cells' | 'subdivision' | 'domain' | 'singular' | 'unresolved';
      readonly samples: number; readonly visited: number; readonly region?: {readonly minimum:FunctionPoint;readonly maximum:FunctionPoint} };
const OFFSETS: readonly FunctionPoint[] = [[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,0,1],[1,0,1],[0,1,1],[1,1,1]];
function missesZero(range: IntervalUnion): boolean { return range.ranges.every(value => value.lower > 0 || value.upper < 0); }
function positive(range: IntervalUnion): boolean { return range.continuous && range.ranges.length > 0 && range.ranges.every(value => value.lower > 0); }
function negative(range: IntervalUnion): boolean { return range.continuous && range.ranges.length > 0 && range.ranges.every(value => value.upper < 0); }

export function buildImplicitGrid(evaluator: FunctionImplicitEvaluator, options: ImplicitGridOptions): ImplicitGridResult {
  if (!validFunctionWorldBounds(options.minimum,options.maximum) || !Number.isFinite(options.tolerance) || options.tolerance <= 0) {
    throw new RangeError('X・Y・Zの有限な最小値 < 最大値と、正の精度を全て指定してください。');
  }
  for (const key of ['maximumSamples','maximumCells','maximumTriangles','maximumDepth'] as const) {
    if (!Number.isSafeInteger(options[key]) || options[key] < 1 || options[key] > FUNCTION_SURFACE_LIMITS[key]) throw new RangeError('陰関数の分割上限が不正です。');
  }
  const fixed=options.fixed;
  if(fixed!==undefined && (![0,1,2].includes(fixed.axis) || !Number.isFinite(fixed.coordinate))) throw new RangeError('固定する座標軸と有限な座標を指定してください。');
  if(fixed!==undefined && (fixed.coordinate<options.minimum[fixed.axis] || fixed.coordinate>options.maximum[fixed.axis])) return {status:'empty',samples:0,visited:0};
  const offsets=fixed===undefined?OFFSETS:OFFSETS.filter(offset=>offset[fixed.axis]===0);
  const project=(point:FunctionPoint):FunctionPoint=>[
    fixed?.axis===0?fixed.coordinate:point[0],fixed?.axis===1?fixed.coordinate:point[1],fixed?.axis===2?fixed.coordinate:point[2],
  ];
  const width = implicitBoxDistance(project(options.minimum),project(options.maximum),project(options.minimum));
  let targetDepth = 0, diameter = width;
  // Half the error budget leaves room to cover a regular tangency on a shared cell face from its neighbour.
  while (diameter > options.tolerance/2 && targetDepth <= options.maximumDepth) { diameter = nextFloat(diameter/2,1); targetDepth++; }
  const size = 2**targetDepth, samples = new Map<string,ImplicitGridPoint>(), cells: ImplicitGridCell[] = [];
  let visited = 0, maximumCellDiameter = 0;
  const stopped = (reason: Extract<ImplicitGridResult,{status:'stopped'}>['reason']): Extract<ImplicitGridResult,{status:'stopped'}> => ({status:'stopped',reason,samples:samples.size,visited});
  let failure:Extract<ImplicitGridResult,{status:'stopped'}>['reason']|undefined;
  const takeCell=():boolean=>{
    failure=options.shouldStop?.();if(failure!==undefined) return false;
    if(visited>=options.maximumCells){failure='cells';return false;}visited++;return true;
  };
  if (targetDepth > options.maximumDepth) return stopped('subdivision');
  function world(grid: FunctionPoint): FunctionPoint {
    const axis = (index: number) => grid[index] === 0 ? options.minimum[index] : grid[index] === size ? options.maximum[index]
      : options.minimum[index]+(options.maximum[index]-options.minimum[index])*(grid[index]/size);
    return project([axis(0),axis(1),axis(2)]);
  }
  function sample(grid: FunctionPoint): ImplicitGridPoint | null {
    const key = grid.join(','), existing = samples.get(key); if (existing !== undefined) return existing;
    if (samples.size >= options.maximumSamples) return null;
    const point = world(grid), value = evaluator.point(point), result = {key,point,value}; samples.set(key,result); return result;
  }
  const pending: {origin: FunctionPoint; span: number}[] = [{origin:[0,0,0],span:size}];
  while (pending.length > 0) {
    const stop = options.shouldStop?.(); if (stop !== undefined) return stopped(stop);
    if (visited >= options.maximumCells) return stopped('cells'); visited++;
    const node = pending.pop(); if (node === undefined) break;
    const {origin,span} = node, lower = world(origin), upper = world([origin[0]+span,origin[1]+span,origin[2]+span]);
    const range = evaluator.enclosure(lower,upper);
    if (missesZero(range)) continue;
    if (range.continuous && range.ranges.length === 1 && range.ranges[0].lower === 0 && range.ranges[0].upper === 0) {
      return {status:'degenerate',samples:samples.size,visited};
    }
    if (span > 1) {
      const half = span/2;
      for (const offset of offsets) pending.push({origin:[origin[0]+offset[0]*half,origin[1]+offset[1]*half,origin[2]+offset[2]*half],span:half});
      continue;
    }
    if (!range.continuous || range.ranges.length !== 1) return stopped('domain');
    const cellDiameter = implicitBoxDistance(lower,upper,lower);
    if (cellDiameter > options.tolerance) return stopped('subdivision');
    maximumCellDiameter = Math.max(maximumCellDiameter,cellDiameter);
    const partials = refinedImplicitPartials(evaluator,lower,upper,takeCell);
    if(failure!==undefined) return stopped(failure);
    // Tighten extrema along every provably monotone coordinate before classifying a same-sign cell.
    const extrema = implicitMonotoneExtrema(lower,upper,partials);
    if (positive(evaluator.enclosure(extrema.minimumLow,extrema.minimumHigh)) || negative(evaluator.enclosure(extrema.maximumLow,extrema.maximumHigh))) continue;
    if (!hasRegularImplicitAxis(partials)) {
      const empty=proveImplicitRegionEmpty(evaluator,lower,upper,takeCell);
      if(failure!==undefined) return stopped(failure);
      if(empty) continue;
      return {...stopped('singular'),region:{minimum:lower,maximum:upper}};
    }
    const points: ImplicitGridPoint[] = [];
    for (const offset of offsets) {
      const value = sample([origin[0]+offset[0],origin[1]+offset[1],origin[2]+offset[2]]);
      if (value === null) return stopped('samples'); if (!Number.isFinite(value.value)) return stopped('domain'); points.push(value);
    }
    if (points.every(value=>value.value > 0) || points.every(value=>value.value < 0)) {
      const empty=proveImplicitRegionEmpty(evaluator,lower,upper,takeCell);
      if(failure!==undefined) return stopped(failure);
      if(empty) continue;
      // Retain this region. Meshing must prove that a nearby regular patch covers the entire cell within tolerance.
      // A hidden component with no neighbouring mesh therefore cannot disappear as an empty result.
      cells.push({points,needsCoverage:true}); continue;
    }
    cells.push({points});
  }
  return cells.length === 0 ? {status:'empty',samples:samples.size,visited}
    : {status:'ready',cells,maximumCellDiameter,samples:samples.size,visited};
}
