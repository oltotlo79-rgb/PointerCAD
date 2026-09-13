/** Merge only exactly coplanar, convex adjacent triangle pairs; never change their point set. */
import type { FunctionSurfaceGeometrySpec } from './functionSurfaceGeometrySpec.js';

type Dyadic = { readonly coefficient: bigint; readonly exponent: number };
type IntegerPoint = readonly [bigint, bigint, bigint];
export type FunctionSurfacePolygon = readonly [number, number, number] | readonly [number, number, number, number];

/** IEEE-754 coordinates are dyadic rationals. Integer determinants distinguish a real crease
 * from exact coplanarity without a tolerance that could silently change the certified surface. */
function dyadic(value: number, bits: DataView): Dyadic {
  if (value === 0) return { coefficient: 0n, exponent: 0 };
  bits.setFloat64(0, value);
  const encoded = bits.getBigUint64(0), exponent = Number((encoded >> 52n) & 0x7ffn);
  const fraction = encoded & 0xfffffffffffffn;
  return { coefficient: (encoded >> 63n ? -1n : 1n) * (exponent === 0 ? fraction : fraction | 0x10000000000000n),
    exponent: exponent === 0 ? -1074 : exponent - 1075 };
}
const subtract = (a: IntegerPoint, b: IntegerPoint): IntegerPoint => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const cross = (a: IntegerPoint, b: IntegerPoint): IntegerPoint =>
  [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot = (a: IntegerPoint, b: IntegerPoint): bigint => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

function convexCoplanar(points: readonly (readonly Dyadic[])[]): boolean {
  let exponent = 0;
  for (const point of points) for (const coordinate of point) {
    if (coordinate.coefficient !== 0n) exponent = Math.min(exponent, coordinate.exponent);
  }
  const scaled = points.map((point): IntegerPoint => {
    const coordinate = (axis: number): bigint => point[axis].coefficient === 0n ? 0n
      : point[axis].coefficient << BigInt(point[axis].exponent - exponent);
    return [coordinate(0), coordinate(1), coordinate(2)];
  });
  const normal = cross(subtract(scaled[1],scaled[0]), subtract(scaled[2],scaled[0]));
  if (dot(normal, subtract(scaled[3],scaled[0])) !== 0n) return false;
  // Strict convexity also rejects overlap, folded-back pairs and degenerate corners.
  for (let i=0; i<4; i++) {
    const turn = cross(subtract(scaled[(i+1)%4],scaled[i]), subtract(scaled[(i+2)%4],scaled[(i+1)%4]));
    if (dot(normal,turn) <= 0n) return false;
  }
  return true;
}

/** Input has passed checkedFunctionSurface: at most two opposite uses of each indexed edge.
 * Pairing is deterministic, bounded to four vertices and preserves every exterior boundary. */
export function functionSurfacePlanarPairs(spec: FunctionSurfaceGeometrySpec,
  isCancelled: () => boolean = () => false): readonly FunctionSurfacePolygon[] | null {
  const neighbors = new Map<string, number[]>(), bits = new DataView(new ArrayBuffer(8));
  const exact = new Map<number, readonly Dyadic[]>();
  const point = (index: number): readonly Dyadic[] => {
    let result = exact.get(index);
    if (result === undefined) { result = spec.vertices[index].map(value => dyadic(value,bits)); exact.set(index,result); }
    return result;
  };
  const key = (a: number,b: number): string => `${Math.min(a,b)},${Math.max(a,b)}`;
  for (let index=0; index<spec.triangles.length; index++) {
    if (index%64===0 && isCancelled()) return null;
    const triangle=spec.triangles[index];
    for (let edge=0;edge<3;edge++) {
      const name=key(triangle[edge],triangle[(edge+1)%3]), uses=neighbors.get(name);
      if (uses===undefined) neighbors.set(name,[index]); else uses.push(index);
    }
  }
  const used=new Uint8Array(spec.triangles.length), result: FunctionSurfacePolygon[]=[];
  for (let index=0;index<spec.triangles.length;index++) {
    if (index%64===0 && isCancelled()) return null;
    if (used[index]) continue;
    const triangle=spec.triangles[index]; let polygon: FunctionSurfacePolygon=triangle;
    for (let edge=0;edge<3;edge++) {
      const a=triangle[edge],b=triangle[(edge+1)%3],c=triangle[(edge+2)%3];
      const uses=neighbors.get(key(a,b));
      if (uses===undefined || uses.length!==2) continue;
      const other=uses[0]===index ? uses[1] : uses[0];
      if (used[other]) continue;
      const adjacent=spec.triangles[other], reverse=adjacent.findIndex((start,i)=>start===b && adjacent[(i+1)%3]===a);
      if (reverse<0) continue;
      const d=adjacent[(reverse+2)%3];
      if (d===c) continue;
      const quad=[a,d,b,c] as const;
      if (!convexCoplanar(quad.map(point))) continue;
      polygon=quad; used[other]=1; break;
    }
    used[index]=1;result.push(polygon);
  }
  return isCancelled() ? null : result;
}
