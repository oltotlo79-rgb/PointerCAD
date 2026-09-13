/** Integer dyadic keys keep neighboring parameter cells attached even after unequal subdivision. */
export type SurfaceParameter = readonly [number, number];
export interface SurfaceCell { readonly u: number; readonly v: number; readonly span: number; readonly depth: number }
export interface SurfaceLeaf extends SurfaceCell { readonly interpolationError: number }
type CoordinateMap = Map<number, Set<number>>;
function register(map: CoordinateMap, fixed: number, moving: number): void {
  const row = map.get(fixed) ?? new Set<number>(); row.add(moving); map.set(fixed, row);
}
function lowerBound(values: readonly number[], target: number): number {
  let a = 0, b = values.length;
  while (a < b) { const middle = Math.floor((a+b)/2); if (values[middle] < target) a = middle+1; else b = middle; }
  return a;
}
function ascending(map: ReadonlyMap<number, readonly number[]>, fixed: number, lower: number, upper: number): readonly number[] {
  const values = map.get(fixed) ?? [];
  return values.slice(lowerBound(values, lower), lowerBound(values, upper));
}
function descending(map: ReadonlyMap<number, readonly number[]>, fixed: number, lower: number, upper: number): readonly number[] {
  const values = map.get(fixed) ?? [];
  // Coordinates are integers. Selecting [lower+1, upper+1) means (lower,upper].
  return values.slice(lowerBound(values, lower+1), lowerBound(values, upper+1)).reverse();
}
export function createSurfaceBoundary(leaves: readonly SurfaceLeaf[], periodic: readonly [boolean,boolean] = [false,false],
  gridSize = 0): (leaf: SurfaceLeaf) => readonly SurfaceParameter[] {
  const rows: CoordinateMap = new Map(), columns: CoordinateMap = new Map();
  for (const { u, v, span } of leaves) for (const x of [u,u+span]) for (const y of [v,v+span]) {
    register(rows, y, x); register(columns, x, y);
  }
  const synchronize = (map: CoordinateMap) => {
    const points = new Set([...(map.get(0) ?? []),...(map.get(gridSize) ?? [])]);
    map.set(0,points); map.set(gridSize,points);
  };
  if (periodic[0]) synchronize(columns);
  if (periodic[1]) synchronize(rows);
  const sorted = (map: CoordinateMap) => new Map([...map].map(([key, values]) => [key, [...values].sort((a,b) => a-b)]));
  const horizontal = sorted(rows), vertical = sorted(columns);
  return leaf => {
    const { u, v, span } = leaf, right = u+span, top = v+span;
    return [
      ...ascending(horizontal, v, u, right).map(x => [x,v] as const),
      ...ascending(vertical, right, v, top).map(y => [right,y] as const),
      ...descending(horizontal, top, u, right).map(x => [x,top] as const),
      ...descending(vertical, u, v, top).map(y => [u,y] as const),
    ];
  };
}

export function splitSurfaceCell(cell: SurfaceCell): readonly SurfaceCell[] {
  const span = cell.span/2, depth = cell.depth+1;
  return [{ u: cell.u, v: cell.v, span, depth }, { u: cell.u+span, v: cell.v, span, depth },
    { u: cell.u+span, v: cell.v+span, span, depth }, { u: cell.u, v: cell.v+span, span, depth }];
}
