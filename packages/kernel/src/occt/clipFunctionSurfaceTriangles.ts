/** Clip planar CAD face boundaries before allocating shapes; adjacent faces reuse every cut edge. */
import type { Vec3Tuple } from '../types.js';
import { MAX_FUNCTION_SURFACE_FACES, MAX_FUNCTION_SURFACE_VERTICES, type FunctionSurfaceGeometrySpec } from './functionSurfaceGeometrySpec.js';
import { GEOMETRIC_CONFUSION_MM } from './tolerances.js';

export function clipFunctionSurfaceTriangles(spec: FunctionSurfaceGeometrySpec,
  isCancelled: () => boolean = () => false): FunctionSurfaceGeometrySpec | null {
  const points: Vec3Tuple[] = [...spec.vertices], cuts = new Map<string,number>();
  const triangles: [number,number,number][] = [];
  const intersection = (from: number, to: number, axis: number, boundary: number, plane: number): number => {
    const low = Math.min(from,to), high = Math.max(from,to), key = `${plane}:${low},${high}`;
    const a = points[low], b = points[high];
    if (a[axis] === boundary) return low;
    if (b[axis] === boundary) return high;
    const previous = cuts.get(key); if (previous !== undefined) return previous;
    // Scaling also handles opposite finite endpoints whose difference would overflow.
    const scale = Math.max(Math.abs(a[axis]),Math.abs(b[axis]),Math.abs(boundary));
    const ratio = (boundary/scale-a[axis]/scale)/(b[axis]/scale-a[axis]/scale);
    if (!(ratio > 0 && ratio < 1)) throw new Error('関数曲面の境界を必要な精度で切り取れませんでした。');
    const point: Vec3Tuple = [0,0,0].map((_,component) => component === axis ? boundary
      : (1-ratio)*a[component]+ratio*b[component]) as [number,number,number];
    if (!point.every(Number.isFinite)) throw new Error('関数曲面の切断位置が有限の座標になりませんでした。');
    // Trig sampling may put a boundary vertex a few ulps off its exact plane. Reuse only an
    // incident endpoint within floating roundoff, never weld unrelated vertices or enlarge CAD tolerance.
    for (const endpoint of [low,high]) {
      const original = points[endpoint], rounding = Math.min(GEOMETRIC_CONFUSION_MM,
        8*Number.EPSILON*Math.max(...original.map(Math.abs),...point.map(Math.abs)));
      if (Math.hypot(...point.map((value,component)=>value-original[component])) <= rounding) {
        cuts.set(key,endpoint); return endpoint;
      }
    }
    if (points.length >= MAX_FUNCTION_SURFACE_VERTICES*2) throw new Error('関数曲面の切断点の数が上限を超えています。');
    const index = points.length; points.push(point); cuts.set(key,index); return index;
  };
  for (let index = 0; index < spec.triangles.length; index++) {
    if (index % 64 === 0 && isCancelled()) return null;
    let polygon: readonly number[] = spec.triangles[index];
    for (let plane = 0; plane < 6 && polygon.length > 0; plane++) {
      const axis = Math.floor(plane/2), minimum = plane%2 === 0;
      const boundary = (minimum ? spec.bounds.minimum : spec.bounds.maximum)[axis];
      const inside = (point: number) => minimum ? points[point][axis] >= boundary : points[point][axis] <= boundary;
      const next: number[] = [];
      const append = (point: number) => { if (next.at(-1) !== point) next.push(point); };
      for (let edge = 0; edge < polygon.length; edge++) {
        const a = polygon[edge], b = polygon[(edge+1)%polygon.length], aInside = inside(a), bInside = inside(b);
        if (aInside) append(a);
        if (aInside !== bInside) append(intersection(a,b,axis,boundary,plane));
      }
      if (next.length > 1 && next[0] === next.at(-1)) next.pop();
      polygon = next;
    }
    for (let corner = 1; corner+1 < polygon.length; corner++) {
      const a = polygon[0], b = polygon[corner], c = polygon[corner+1];
      const ab = points[b].map((value,axis) => value-points[a][axis]), ac = points[c].map((value,axis) => value-points[a][axis]);
      const length = Math.max(...ab.map(Math.abs),...ac.map(Math.abs));
      if (length === 0) continue;
      const u = ab.map(value=>value/length), v = ac.map(value=>value/length);
      if ([u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]].every(value=>value===0)) continue;
      if (triangles.length >= MAX_FUNCTION_SURFACE_FACES) throw new Error('切断後の関数曲面の面数が上限を超えています。');
      triangles.push([a,b,c]);
    }
  }
  const vertices: Vec3Tuple[] = [], indexes = new Map<number,number>();
  const compact = (index: number) => {
    const previous = indexes.get(index); if (previous !== undefined) return previous;
    if (vertices.length >= MAX_FUNCTION_SURFACE_VERTICES) throw new Error('切断後の関数曲面の点数が上限を超えています。');
    const next = vertices.length; indexes.set(index,next); vertices.push(points[index]); return next;
  };
  return { vertices, triangles: triangles.map(([a,b,c])=>[compact(a),compact(b),compact(c)]), bounds: spec.bounds };
}
