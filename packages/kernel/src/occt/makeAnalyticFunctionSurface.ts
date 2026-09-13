/** Exact native surfaces still pass through the same six-plane face clip; they never add caps. */
import type {OpenCascadeInstance} from 'opencascade.js/dist/opencascade.full.js';
import {createAllocations} from './allocations.js';
import {makePrimitive} from './makePrimitive.js';
import {clipFunctionShape} from './clipFunctionShape.js';
import {checkedFunctionSurfacePrimitive,type FunctionSurfacePrimitiveSpec} from './functionSurfacePrimitiveSpec.js';
import type {FunctionSurfaceGeometryResult} from './makeFunctionSurface.js';
import type {Vec3Tuple} from '../types.js';

export function makeAnalyticFunctionSurface(oc:OpenCascadeInstance,input:FunctionSurfacePrimitiveSpec,isCancelled:()=>boolean):FunctionSurfaceGeometryResult {
  const {primitive,bounds}=checkedFunctionSurfacePrimitive(input);if(isCancelled()) return {status:'cancelled'};
  const owner=createAllocations();
  try{
    const axis:Vec3Tuple=primitive.kind==='sphere' || primitive.axis===2?[0,0,1]:primitive.axis===0?[1,0,0]:[0,1,0];
    const source=owner.keep(makePrimitive(oc,{kind:'primitive',origin:primitive.kind==='sphere'?primitive.center:[0,0,0],axis,
      shape:primitive.kind==='sphere'?{kind:'sphere',radius:primitive.radius}:{kind:'torus',majorRadius:primitive.majorRadius,minorRadius:primitive.minorRadius},
      originQuery:null,targetKey:null}));
    if(isCancelled()){owner.release();return {status:'cancelled'};}
    const clipped=clipFunctionShape(oc,source.shape,bounds,'face');
    if(clipped.status==='shape') owner.keep(clipped);
    if(isCancelled()){owner.release();return {status:'cancelled'};}
    if(clipped.status!=='shape'){owner.release();return clipped;}
    return {status:'shape',shape:clipped.shape,count:clipped.count,delete:()=>owner.release()};
  }catch(error){owner.release();throw error;}
}
