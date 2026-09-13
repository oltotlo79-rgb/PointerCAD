/** Preserve the certified surface as CAD faces, sharing indexed boundary edges and vertices. */
import type { OpenCascadeInstance, TopoDS_Vertex, TopoDS_Edge, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations } from './allocations.js';
import { makeCompound } from './transformShape.js';
import { verifyFunctionShapeBounds, type FunctionClipResult } from './clipFunctionShape.js';
import { checkedFunctionSurface, type FunctionSurfaceInput } from './functionSurfaceGeometrySpec.js';
import { makeAnalyticFunctionSurface } from './makeAnalyticFunctionSurface.js';
import { clipFunctionSurfaceTriangles } from './clipFunctionSurfaceTriangles.js';
import { isValidShape } from './solidMesh.js';
import { functionSurfacePlanarPairs } from './functionSurfacePlanarPairs.js';
import { certifyFunctionSurfaceProjection, type FunctionSurfaceProjectionCertificate } from './functionSurfaceProjection.js';

export type FunctionSurfaceGeometryResult = (FunctionClipResult & { readonly projection?: FunctionSurfaceProjectionCertificate }) | { readonly status: 'cancelled' };
/** Standalone callers receive a validated shape; the full body pipeline validates while classifying. */
export function makeFunctionSurface(oc: OpenCascadeInstance, input: FunctionSurfaceInput,
  isCancelled: () => boolean = () => false): FunctionSurfaceGeometryResult {
  const result = makeUnclassifiedFunctionSurface(oc, input, isCancelled);
  if (result.status !== 'shape') return result;
  try {
    if (!isValidShape(oc, result.shape)) throw new Error('範囲で切り取った関数の形が正しくありません。');
    if (isCancelled()) { result.delete(); return { status: 'cancelled' }; }
    return result;
  } catch (error) { result.delete(); throw error; }
}

/** Internal construction stage. Its result MUST pass classifyFunctionSurface before use as a body.
 * Classification uses a bound exact projection proof or native self-intersection analysis, plus
 * native geometric validity. Keeping this stage separate avoids repeating that validity traversal.
 */
export function makeUnclassifiedFunctionSurface(oc: OpenCascadeInstance, input: FunctionSurfaceInput,
  isCancelled: () => boolean = () => false): FunctionSurfaceGeometryResult {
  if (isCancelled()) return { status: 'cancelled' };
  if('primitive' in input) return makeAnalyticFunctionSurface(oc,input,isCancelled);
  const clipped = clipFunctionSurfaceTriangles(checkedFunctionSurface(input),isCancelled);
  if (clipped === null) return { status: 'cancelled' };
  const spec = checkedFunctionSurface(clipped);
  if (spec.triangles.length === 0) return { status: 'empty' };
  const polygons = functionSurfacePlanarPairs(spec,isCancelled);
  if (polygons === null) return { status: 'cancelled' };
  const allocations = createAllocations(), { keep, release } = allocations;
  try {
    const vertices = new Map<number,TopoDS_Vertex>(), edges = new Map<string,TopoDS_Edge>(), faces: TopoDS_Shape[] = [];
    const vertex = (index: number): TopoDS_Vertex => {
      const previous = vertices.get(index); if (previous !== undefined) return previous;
      const point = keep(new oc.gp_Pnt_3(...spec.vertices[index])), maker = keep(new oc.BRepBuilderAPI_MakeVertex(point));
      const result = keep(maker.Vertex()); vertices.set(index,result); return result;
    };
    const edge = (start: number, end: number): TopoDS_Edge => {
      const low = Math.min(start,end), high = Math.max(start,end), key = `${low},${high}`;
      let result = edges.get(key);
      if (result === undefined) {
        const maker = keep(new oc.BRepBuilderAPI_MakeEdge_2(vertex(low),vertex(high)));
        if (!maker.IsDone()) throw new Error('関数曲面の辺を作れませんでした。精度と座標の大きさを確認してください。');
        result = keep(maker.Edge()); edges.set(key,result);
      }
      return start < end ? result : keep(oc.TopoDS.Edge_1(keep(result.Reversed())));
    };
    for (let index = 0; index < polygons.length; index++) {
      if (index % 64 === 0 && isCancelled()) { release(); return { status:'cancelled' }; }
      const polygon = polygons[index], [a,b,c] = polygon;
      const wireMaker = keep(new oc.BRepBuilderAPI_MakeWire_4(edge(a,b),edge(b,c),edge(c,polygon.length === 4 ? polygon[3] : a)));
      if (polygon.length === 4) wireMaker.Add_1(edge(polygon[3],a));
      if (!wireMaker.IsDone()) throw new Error('関数曲面の輪郭をつなげませんでした。');
      const wire = keep(wireMaker.Wire());
      if (!wire.Closed_1()) throw new Error('関数曲面の輪郭が閉じていません。');
      // The three indexed points already define this planar face. Asking OCCT to discover a
      // supporting surface for every tiny wire repeats plane fitting thousands of times.
      const origin=spec.vertices[a], p=spec.vertices[b], q=spec.vertices[c];
      const u=p.map((value,axis)=>value-origin[axis]),v=q.map((value,axis)=>value-origin[axis]);
      const scale=Math.max(...u.map(Math.abs),...v.map(Math.abs));
      if(!(scale>0)||!Number.isFinite(scale)) throw new Error('関数曲面の面を定める3点の大きさを確認してください。');
      const ux=u[0]/scale,uy=u[1]/scale,uz=u[2]/scale,vx=v[0]/scale,vy=v[1]/scale,vz=v[2]/scale;
      const nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx,length=Math.hypot(nx,ny,nz);
      if(!(length>0)) throw new Error('関数曲面の3点が一直線に並んでいるため面を作れません。');
      const normal=keep(new oc.gp_Dir_4(nx/length,ny/length,nz/length));
      const plane=keep(new oc.gp_Pln_3(keep(new oc.gp_Pnt_3(...origin)),normal));
      const maker = keep(new oc.BRepBuilderAPI_MakeFace_16(plane,wire,true));
      if (!maker.IsDone()) throw new Error('関数曲面の点が重なるか、面を張れない形になっています。');
      faces.push(keep(maker.Face()));
    }
    const result = keep(makeCompound(oc,faces));
    if (isCancelled()) { release(); return { status:'cancelled' }; }
    verifyFunctionShapeBounds(oc,result.shape,spec.bounds,allocations);
    const projection=certifyFunctionSurfaceProjection(spec,result.shape,isCancelled);
    // A returned trimmed face may still share geometry with its makers; release them together.
    return { status:'shape',shape:result.shape,count:faces.length,delete:release,...(projection===undefined?{}:{projection}) };
  } catch (error) { release(); throw error; }
}
