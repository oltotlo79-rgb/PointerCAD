/** 曲線の点は元の3式・独立変数の区間・XYZの範囲を別々に所有する。 */
import {MathInputProblem} from './mathInputContract.js';
import {decodeFunctionCurveWorkRequest,type FunctionCurveWorkRequest} from './functionCurveWorkRequest.js';
import {functionPointAxis} from './functionPointWorkRequest.js';
import {functionWorkArray,functionWorkNumber,functionWorkRecord} from './functionWorkData.js';
import type {FunctionKnownCoordinate} from './functionPointCandidates.js';
import type {FunctionPoint} from './functionGeometryBounds.js';
import type {MathInterval} from './mathInterval.js';

export interface CurvePointWorkRequest extends FunctionCurveWorkRequest {
  readonly kind:'curve';readonly known:readonly FunctionKnownCoordinate[];
}
export type CurvePointSavedInput=Omit<CurvePointWorkRequest,'identity'>;
export function saveCurvePointInput(value:unknown):CurvePointSavedInput {
  const {identity:_identity,...saved}=decodeCurvePointWorkRequest(value);void _identity;return Object.freeze(saved);
}
export interface CurvePointCandidate {
  readonly point:FunctionPoint;readonly minimum:FunctionPoint;readonly maximum:FunctionPoint;
  readonly location:{readonly kind:'curve';readonly independent:FunctionCurveWorkRequest['independent'];
    readonly interval:MathInterval;readonly direct:boolean};
}
export type CurvePointCandidates={readonly status:'ready';readonly candidates:readonly CurvePointCandidate[];
  readonly exhaustive:boolean;readonly unresolved:readonly {readonly interval:MathInterval;readonly reason:string}[]}
  |{readonly status:'out-of-range';readonly axes:readonly FunctionKnownCoordinate['axis'][]}
  |{readonly status:'stopped';readonly reason:'cancelled'|'deadline'|'budget'};

export function decodeCurvePointWorkRequest(value:unknown):CurvePointWorkRequest {
  const raw=functionWorkRecord(value,['kind','identity','independent','outputs','lower','upper','minimum','maximum','tolerance','coefficients','known']);
  if(raw.kind!=='curve') throw new MathInputProblem('syntax','曲線上の点の依頼の種類が不正です。');
  const {kind:_kind,known:rawKnown,...curve}=raw;void _kind;
  const parent=decodeFunctionCurveWorkRequest(curve),known=functionWorkArray(rawKnown,2).map(value=>{
    const item=functionWorkRecord(value,['axis','value']);
    return Object.freeze({axis:functionPointAxis(item.axis),value:functionWorkNumber(item.value)});
  });
  if(known.length<1 || new Set(known.map(item=>item.axis)).size!==known.length) {
    throw new MathInputProblem('syntax','既知の座標を重複しない1軸か2軸で指定してください。');
  }
  if(parent.independent!=='T') {
    const index=parent.independent==='X'?0:parent.independent==='Y'?1:2,node=parent.outputs[index].expression;
    if(node.kind!=='symbol' || node.reference.role!=='axis' || node.reference.name!==parent.independent) {
      throw new MathInputProblem('syntax','座標曲線の独立軸には、その軸自身の式を指定してください。');
    }
  }
  return Object.freeze({...parent,kind:'curve',known:Object.freeze(known)});
}
