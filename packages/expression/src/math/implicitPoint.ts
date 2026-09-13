import type { FunctionPoint } from './functionGeometryBounds.js';
import { intervalAdd, intervalSquare, intervalSqrt, intervalSubtract } from './mathInterval.js';
/** Preserve the three required axes without unchecked array-to-tuple casts. */
export function implicitPoint(coordinate: (axis: 0 | 1 | 2) => number): FunctionPoint {
  return [coordinate(0),coordinate(1),coordinate(2)];
}

/** Outward-rounded farthest Euclidean distance from a point to an entire box. */
export function implicitBoxDistance(minimum:FunctionPoint,maximum:FunctionPoint,point:FunctionPoint):number {
  let squared={lower:0,upper:0};
  for(let axis=0;axis<3;axis++){
    const delta=intervalSubtract({lower:minimum[axis],upper:maximum[axis]},{lower:point[axis],upper:point[axis]});
    const term=delta.status==='range'?intervalSquare(delta.interval):null;
    const sum=term?.status==='range'?intervalAdd(squared,term.interval):null;
    if(sum?.status!=='range') return Infinity;
    squared={lower:0,upper:sum.interval.upper};
  }
  const distance=intervalSqrt(squared);return distance.status==='range'?distance.interval.upper:Infinity;
}
