import type { FunctionPoint } from './functionGeometryBounds.js';
import type { ImplicitGridCell } from './implicitGrid.js';
import { implicitPoint,implicitBoxDistance } from './implicitPoint.js';

export interface ImplicitCoverageOptions {
  readonly shouldStop?:()=> 'cancelled'|'deadline'|undefined;
  readonly tolerance?:number;
  readonly regularRegion?:(minimum:FunctionPoint,maximum:FunctionPoint)=>boolean;
}
export type ImplicitCoverageResult={readonly status:'ready';readonly maximumDistance:number}
  |{readonly status:'stopped';readonly reason:'cancelled'|'deadline'|'unresolved'};
/** A retained regular tangency must be covered by actual emitted geometry, within the explicit error budget. */
export class ImplicitCoverageIndex {
  private readonly neighbourhood=new Map<string,Set<number>>();
  constructor(private readonly options:ImplicitCoverageOptions) {}
  include(cell:ImplicitGridCell,used:ReadonlySet<number>):void {
    if(used.size===0) return;
    for(const corner of cell.points){
      const nearby=this.neighbourhood.get(corner.key)??new Set<number>();
      for(const index of used) nearby.add(index);this.neighbourhood.set(corner.key,nearby);
    }
  }
  verify(cells:readonly ImplicitGridCell[],vertices:readonly FunctionPoint[]):ImplicitCoverageResult {
    let maximumDistance=0;
    for(const cell of cells) if(cell.needsCoverage){
      const stop=this.options.shouldStop?.();if(stop!==undefined) return {status:'stopped',reason:stop};
      const tolerance=this.options.tolerance,regularRegion=this.options.regularRegion;
      if(tolerance===undefined || !Number.isFinite(tolerance) || tolerance<=0 || regularRegion===undefined) return {status:'stopped',reason:'unresolved'};
      const minimum=implicitPoint(axis=>Math.min(...cell.points.map(point=>point.point[axis])));
      const maximum=implicitPoint(axis=>Math.max(...cell.points.map(point=>point.point[axis])));
      const nearby=new Set<number>();for(const corner of cell.points) for(const index of this.neighbourhood.get(corner.key)??[]) nearby.add(index);
      const candidates=[...nearby].map(index=>({index,distance:implicitBoxDistance(minimum,maximum,vertices[index])})).sort((a,b)=>a.distance-b.distance);
      let covered=false;
      for(const candidate of candidates){
        const stop=this.options.shouldStop?.();if(stop!==undefined) return {status:'stopped',reason:stop};
        if(candidate.distance>tolerance) break;
        if(regularRegion(implicitPoint(axis=>Math.min(minimum[axis],vertices[candidate.index][axis])),implicitPoint(axis=>Math.max(maximum[axis],vertices[candidate.index][axis])))){
          maximumDistance=Math.max(maximumDistance,candidate.distance);covered=true;break;
        }
      }
      if(!covered) return {status:'stopped',reason:'unresolved'};
    }
    return {status:'ready',maximumDistance};
  }
}
