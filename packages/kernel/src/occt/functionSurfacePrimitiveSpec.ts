import type {Vec3Tuple} from '../types.js';
import {validateFunctionClipBox,type FunctionClipBox} from './clipFunctionShape.js';

export type FunctionSurfacePrimitive={readonly kind:'sphere';readonly center:Vec3Tuple;readonly radius:number}
  |{readonly kind:'torus';readonly axis:0|1|2;readonly majorRadius:number;readonly minorRadius:number};
export interface FunctionSurfacePrimitiveSpec {readonly primitive:FunctionSurfacePrimitive;readonly bounds:FunctionClipBox}
function positive(value:unknown):value is number{return typeof value==='number' && Number.isFinite(value) && value>0;}
export function checkedFunctionSurfacePrimitive(input:FunctionSurfacePrimitiveSpec):FunctionSurfacePrimitiveSpec {
  validateFunctionClipBox(input.bounds);
  const primitive=input.primitive;if(primitive===null || typeof primitive!=='object' || Array.isArray(primitive)) throw new Error('関数の解析形状を確認できません。');
  let result:FunctionSurfacePrimitive;
  if(primitive.kind==='sphere'){
    if(Object.keys(primitive).length!==3 || !positive(primitive.radius) || !Array.isArray(primitive.center) || primitive.center.length!==3
      || !primitive.center.every(value=>typeof value==='number' && Number.isFinite(value))) throw new Error('関数の球の中心と半径を確認してください。');
    result={kind:'sphere',center:[primitive.center[0],primitive.center[1],primitive.center[2]],radius:primitive.radius};
  }else if(primitive.kind==='torus'){
    if(Object.keys(primitive).length!==4 || ![0,1,2].includes(primitive.axis) || !positive(primitive.majorRadius)
      || !positive(primitive.minorRadius) || primitive.majorRadius<=primitive.minorRadius) throw new Error('関数のトーラスの軸と半径を確認してください。');
    result={kind:'torus',axis:primitive.axis,majorRadius:primitive.majorRadius,minorRadius:primitive.minorRadius};
  }else throw new Error('関数の解析形状に対応していません。');
  return {primitive:result,bounds:{minimum:[...input.bounds.minimum],maximum:[...input.bounds.maximum]}};
}
