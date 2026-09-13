/** Persistent direction choices and bounded Worker endpoints; no symbolic evaluation in the editor. */
import {MathInputProblem} from './mathInputContract.js';
import {functionWorkNumber,functionWorkPoint,functionWorkRecord} from './functionWorkData.js';

export type FunctionPointDirectionKind='tangent'|'normal'|'tangent-u'|'tangent-v';
export interface FunctionDirectionOptions {
  readonly kind:FunctionPointDirectionKind;readonly length:number;readonly reverse:boolean;
}
export interface FunctionDirectionEndpoint {
  readonly point:readonly [number,number,number];
  readonly minimum:readonly [number,number,number];readonly maximum:readonly [number,number,number];
}
export type WithFunctionDirection<T>=T extends {readonly status:'ready'}?T&{readonly endpoint?:FunctionDirectionEndpoint}:T;
const invalid=():never=>{throw new MathInputProblem('syntax','接線・法線の種類、長さと計算結果を確認できません。');};
export function hasFunctionDirection(value:unknown):boolean {
  return value!==null&&typeof value==='object'&&Object.hasOwn(value,'direction');
}
export function decodeFunctionDirection(value:unknown):FunctionDirectionOptions {
  const raw=functionWorkRecord(value,['kind','length','reverse']),length=functionWorkNumber(raw.length);
  if(raw.kind!=='tangent'&&raw.kind!=='normal'&&raw.kind!=='tangent-u'&&raw.kind!=='tangent-v')return invalid();
  if(length<=0||typeof raw.reverse!=='boolean')return invalid();
  return Object.freeze({kind:raw.kind,length,reverse:raw.reverse});
}
export function decodeFunctionDirectionEndpoint(value:unknown,origin:FunctionDirectionEndpoint,
  options:FunctionDirectionOptions|undefined,tolerance:number):FunctionDirectionEndpoint|undefined {
  if(options===undefined){if(value!==undefined)return invalid();return undefined;}
  const raw=functionWorkRecord(value,['point','minimum','maximum']),point=functionWorkPoint(raw.point),
    minimum=functionWorkPoint(raw.minimum),maximum=functionWorkPoint(raw.maximum);
  if(point.some((number,axis)=>minimum[axis]>number||maximum[axis]<number
    ||maximum[axis]-minimum[axis]>tolerance))return invalid();
  const distance=Math.hypot(...point.map((number,axis)=>number-origin.point[axis]));
  if(!Number.isFinite(distance)||Math.abs(distance-options.length)>4*tolerance+Number.EPSILON*8*Math.max(distance,options.length))return invalid();
  return Object.freeze({point,minimum,maximum});
}
