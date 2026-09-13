/** Freudenthal tetrahedra share diagonals and indexed edge roots across neighbouring grid cells. */
import type { FunctionPoint } from './functionGeometryBounds.js';
import type { ImplicitGridCell } from './implicitGrid.js';
import { implicitPoint } from './implicitPoint.js';
import { ImplicitIntersectionVertices } from './implicitIntersectionVertices.js';
import { ImplicitCoverageIndex, type ImplicitCoverageOptions } from './implicitCoverage.js';

const TETRAHEDRA = [[0,1,3,7],[0,1,5,7],[0,2,3,7],[0,2,6,7],[0,4,5,7],[0,4,6,7]] as const;
const EDGES = [[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]] as const;
const FACES = [[0,1,2],[0,1,3],[0,2,3],[1,2,3]] as const;
export interface ImplicitMesh { readonly vertices: readonly FunctionPoint[]; readonly triangles: readonly (readonly [number,number,number])[] }
export type ImplicitMeshResult = {readonly status:'ready'; readonly mesh:ImplicitMesh; readonly maximumCoverageDistance:number}
  | {readonly status:'stopped';readonly reason:'cancelled'|'deadline'|'vertices'|'triangles'|'singular'|'roundoff'|'unresolved'};
function subtract(a: FunctionPoint,b: FunctionPoint): FunctionPoint { return [a[0]-b[0],a[1]-b[1],a[2]-b[2]]; }
function cross(a: FunctionPoint,b: FunctionPoint): FunctionPoint { return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]; }
function dot(a: FunctionPoint,b: FunctionPoint): number { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
export function meshImplicitTetrahedra(cells: readonly ImplicitGridCell[], options: ImplicitCoverageOptions & {
  readonly maximumVertices:number; readonly maximumTriangles:number;
}): ImplicitMeshResult {
  if (![options.maximumVertices,options.maximumTriangles].every(value=>Number.isSafeInteger(value) && value>=1 && value<=200_000)) {
    throw new RangeError('陰関数の点と面の個数上限が不正です。');
  }
  const intersections=new ImplicitIntersectionVertices(options.maximumVertices),coverage=new ImplicitCoverageIndex(options);
  const vertices = intersections.vertices, triangles: [number,number,number][] = [];
  const faces = new Set<string>();
  let used = new Set<number>();
  function add(a:number,b:number,c:number,normal:FunctionPoint): boolean {
    if (a===b || a===c || b===c) return true;
    const key = [a,b,c].sort((x,y)=>x-y).join(',');
    if (faces.has(key)) {used.add(a);used.add(b);used.add(c);return true;}
    const winding = cross(subtract(vertices[b],vertices[a]),subtract(vertices[c],vertices[a]));
    const alignment = dot(winding,normal);
    if (!Number.isFinite(alignment)) return false;
    if (alignment === 0) return dot(winding,winding) === 0;
    used.add(a);used.add(b);used.add(c);
    faces.add(key); triangles.push(alignment > 0 ? [a,b,c] : [a,c,b]); return true;
  }
  for (const cell of cells) {
    used=new Set<number>();
    const stop = options.shouldStop?.(); if (stop !== undefined) return {status:'stopped',reason:stop};
    for (const ids of TETRAHEDRA) {
      const points = ids.map(index=>cell.points[index]), values = points.map(point=>point.value);
      const a = subtract(points[1].point,points[0].point), b = subtract(points[2].point,points[0].point), c = subtract(points[3].point,points[0].point);
      const determinant = dot(a,cross(b,c));
      if (determinant === 0 || !Number.isFinite(determinant)) return {status:'stopped',reason:'roundoff'};
      const bc=cross(b,c), ca=cross(c,a), ab=cross(a,b);
      const normal = implicitPoint(axis=>((values[1]-values[0])*bc[axis]+(values[2]-values[0])*ca[axis]+(values[3]-values[0])*ab[axis])/determinant);
      if (values.every(value=>value===0)) return {status:'stopped',reason:'singular'};
      const polygon = new Set<number>();
      for (const [a,b] of EDGES) if ((values[a]<0)!==(values[b]<0)) {
        const index=intersections.vertex(points[a],points[b]);if(index===null) return {status:'stopped',reason:'vertices'};polygon.add(index);
      }
      for (const face of FACES) if (face.every(index=>values[index]===0)) {
        for (const index of face) {
          const shared=intersections.vertex(points[index],points[index]);if(shared===null) return {status:'stopped',reason:'vertices'};polygon.add(shared);
        }
      }
      const ordered = [...polygon];
      if (ordered.length >= 3) {
        // Sort the convex planar section around its own centre; tetrahedron linear fields define its normal.
        const centre = implicitPoint(axis=>ordered.reduce((sum,index)=>sum+vertices[index][axis],0)/ordered.length);
        const first = subtract(vertices[ordered[0]],centre), second=cross(normal,first);
        ordered.sort((a,b)=>Math.atan2(dot(subtract(vertices[a],centre),second),dot(subtract(vertices[a],centre),first))
          -Math.atan2(dot(subtract(vertices[b],centre),second),dot(subtract(vertices[b],centre),first)));
        for (let index=1;index<ordered.length-1;index++) if (!add(ordered[0],ordered[index],ordered[index+1],normal)) return {status:'stopped',reason:'roundoff'};
      }
      if (triangles.length > options.maximumTriangles) return {status:'stopped',reason:'triangles'};
    }
    coverage.include(cell,used);
  }
  const checked=coverage.verify(cells,vertices);if(checked.status!=='ready') return checked;
  return {status:'ready',mesh:{vertices,triangles},maximumCoverageDistance:checked.maximumDistance};
}
