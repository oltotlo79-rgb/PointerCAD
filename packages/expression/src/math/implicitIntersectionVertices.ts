import type { FunctionPoint } from './functionGeometryBounds.js';
import type { ImplicitGridPoint } from './implicitGrid.js';
import { implicitPoint } from './implicitPoint.js';

/** Shared indexed intersections, including exact grid vertices; no proximity welding or coordinate clamping. */
export class ImplicitIntersectionVertices {
  readonly vertices:FunctionPoint[]=[];
  private readonly indices=new Map<string,number>();
  constructor(private readonly maximum:number) {}
  vertex(a:ImplicitGridPoint,b:ImplicitGridPoint):number|null {
    const key=a.value===0?`v:${a.key}`:b.value===0?`v:${b.key}`:a.key<b.key?`${a.key}/${b.key}`:`${b.key}/${a.key}`;
    const previous=this.indices.get(key);if(previous!==undefined) return previous;
    if(this.vertices.length>=this.maximum) return null;
    const scale=Math.max(Math.abs(a.value),Math.abs(b.value));
    const ratio=a.value===0?0:b.value===0?1:Math.abs(a.value/scale)/(Math.abs(a.value/scale)+Math.abs(b.value/scale));
    const point=a.value===0?a.point:b.value===0?b.point:implicitPoint(axis=>a.point[axis]===b.point[axis]?a.point[axis]:(1-ratio)*a.point[axis]+ratio*b.point[axis]);
    if(!point.every(Number.isFinite)) return null;
    const index=this.vertices.length;this.indices.set(key,index);this.vertices.push(point);return index;
  }
}
