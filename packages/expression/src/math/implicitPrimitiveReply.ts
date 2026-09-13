/** Engine-free verification of the negotiated analytic reply; CAD still performs the mandatory XYZ clip. */
import {MathInputProblem} from './mathInputContract.js';
import {functionWorkNumber,functionWorkPoint,functionWorkRecord} from './functionWorkData.js';
import type {FunctionImplicitWorkRequest} from './functionImplicitWorkRequest.js';
import type {ImplicitPrimitive} from './implicitPrimitiveNumbers.js';

export interface ImplicitPrimitiveResult {readonly status:'analytic';readonly primitive:ImplicitPrimitive;readonly maximumParameterError:number}
export function decodeImplicitPrimitiveReply(value:unknown,request:FunctionImplicitWorkRequest):ImplicitPrimitiveResult {
  if(request.nativePrimitives!==true) throw new MathInputProblem('syntax','この呼出し側は解析曲面を受け取れません。');
  const raw=functionWorkRecord(value,['status','primitive','maximumParameterError']),error=functionWorkNumber(raw.maximumParameterError);
  if(raw.status!=='analytic' || error<0 || error>request.tolerance/4) throw new MathInputProblem('domain','解析曲面の丸め誤差が指定精度を超えています。');
  const shape=raw.primitive;if(shape===null || typeof shape!=='object' || !('kind' in shape)) throw new MathInputProblem('syntax','解析曲面の種類を確認できません。');
  let primitive:ImplicitPrimitive;
  if(shape.kind==='sphere'){
    const source=functionWorkRecord(shape,['kind','center','radius']),radius=functionWorkNumber(source.radius);
    if(radius<=0) throw new MathInputProblem('domain','球の半径は正の長さにしてください。');
    primitive=Object.freeze({kind:'sphere',center:functionWorkPoint(source.center),radius});
  }else if(shape.kind==='torus'){
    const source=functionWorkRecord(shape,['kind','axis','majorRadius','minorRadius']),axis=source.axis;
    const majorRadius=functionWorkNumber(source.majorRadius),minorRadius=functionWorkNumber(source.minorRadius);
    if((axis!==0 && axis!==1 && axis!==2) || minorRadius<=0 || majorRadius<=minorRadius) throw new MathInputProblem('domain','トーラスの軸と半径を確認してください。');
    primitive=Object.freeze({kind:'torus',axis,majorRadius,minorRadius});
  }else throw new MathInputProblem('syntax','解析曲面の種類に対応していません。');
  return Object.freeze({status:'analytic',primitive,maximumParameterError:error});
}
