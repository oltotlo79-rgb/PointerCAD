/** Planar implicit contours share every grid-edge root and become ordered, separate CAD polylines. */
import type { FunctionPoint } from './functionGeometryBounds.js';
import type { ImplicitGridCell } from './implicitGrid.js';
import { ImplicitIntersectionVertices } from './implicitIntersectionVertices.js';
import { ImplicitCoverageIndex, type ImplicitCoverageOptions } from './implicitCoverage.js';

const TRIANGLES = [[0,1,3],[0,3,2]] as const;
const SIDES = [[0,1],[1,2],[2,0]] as const;
export type ImplicitContourResult = {readonly status:'ready';readonly components:readonly (readonly FunctionPoint[])[];
  readonly maximumCoverageDistance:number;readonly vertices:number;readonly segments:number}
  | {readonly status:'stopped';readonly reason:'cancelled'|'deadline'|'vertices'|'segments'|'singular'|'unresolved'};
export function meshImplicitContours(cells:readonly ImplicitGridCell[],options:ImplicitCoverageOptions & {
  readonly maximumVertices:number;readonly maximumSegments:number;
}):ImplicitContourResult {
  if(![options.maximumVertices,options.maximumSegments].every(value=>Number.isSafeInteger(value) && value>=1 && value<=200_000)) {
    throw new RangeError('陰関数の点と線分の個数上限が不正です。');
  }
  const intersections=new ImplicitIntersectionVertices(options.maximumVertices),coverage=new ImplicitCoverageIndex(options);
  const adjacency=new Map<number,Set<number>>(),edges=new Set<string>();
  const key=(a:number,b:number)=>`${Math.min(a,b)},${Math.max(a,b)}`;
  for(const cell of cells){
    const stop=options.shouldStop?.();if(stop!==undefined) return {status:'stopped',reason:stop};
    if(cell.points.length!==4) throw new RangeError('平面の陰関数には4隅を持つセルが必要です。');
    const used=new Set<number>();
    for(const triangle of TRIANGLES){
      const points=triangle.map(index=>cell.points[index]),hits=new Set<number>();
      if(points.every(point=>point.value===0)) return {status:'stopped',reason:'singular'};
      for(const [a,b] of SIDES){
        if(points[a].value===0 && points[b].value===0){
          const first=intersections.vertex(points[a],points[a]),second=intersections.vertex(points[b],points[b]);
          if(first===null || second===null) return {status:'stopped',reason:'vertices'};hits.add(first);hits.add(second);
        }else if((points[a].value<0)!==(points[b].value<0)){
          const vertex=intersections.vertex(points[a],points[b]);if(vertex===null) return {status:'stopped',reason:'vertices'};hits.add(vertex);
        }
      }
      if(hits.size<2) continue;
      if(hits.size!==2) return {status:'stopped',reason:'singular'};
      const [a,b]=[...hits],edge=key(a,b);used.add(a);used.add(b);
      if(edges.has(edge)) continue;
      if(edges.size>=options.maximumSegments) return {status:'stopped',reason:'segments'};
      edges.add(edge);
      for(const [from,to] of [[a,b],[b,a]]){
        const neighbours=adjacency.get(from)??new Set<number>();neighbours.add(to);adjacency.set(from,neighbours);
        if(neighbours.size>2) return {status:'stopped',reason:'singular'};
      }
    }
    coverage.include(cell,used);
  }
  const checked=coverage.verify(cells,intersections.vertices);if(checked.status!=='ready') return checked;
  const remaining=new Set(edges),components:FunctionPoint[][]=[];
  const compare=(a:number,b:number):number=>{
    for(let axis=0;axis<3;axis++){const difference=intersections.vertices[a][axis]-intersections.vertices[b][axis];if(difference!==0) return difference;}
    return a-b;
  };
  const ends=[...adjacency].filter(([,neighbours])=>neighbours.size===1).map(([index])=>index).sort(compare);
  const interior=[...adjacency].filter(([,neighbours])=>neighbours.size===2).map(([index])=>index).sort(compare);
  for(const start of [...ends,...interior]){
    if(![...(adjacency.get(start)??[])].some(next=>remaining.has(key(start,next)))) continue;
    const component=[intersections.vertices[start]];let current=start;
    while(true){
      const stop=options.shouldStop?.();if(stop!==undefined) return {status:'stopped',reason:stop};
      const next=[...(adjacency.get(current)??[])].filter(next=>remaining.has(key(current,next))).sort(compare)[0];
      if(next===undefined) break;
      remaining.delete(key(current,next));component.push(intersections.vertices[next]);current=next;
      if(current===start) break;
    }
    components.push(component);
  }
  if(remaining.size!==0) return {status:'stopped',reason:'unresolved'};
  return {status:'ready',components,maximumCoverageDistance:checked.maximumDistance,vertices:intersections.vertices.length,segments:edges.size};
}
