/** A parametric surface point owns its original U/V formulas and the independent XYZ clipping box. */
import {MathInputProblem} from './mathInputContract.js';
import {decodeFunctionSurfaceWorkRequest,type FunctionSurfaceWorkRequest} from './functionSurfaceWorkRequest.js';
import {functionPointAxis} from './functionPointWorkRequest.js';
import {functionWorkArray,functionWorkNumber,functionWorkRecord} from './functionWorkData.js';
import type {FunctionKnownCoordinate} from './functionPointCandidates.js';
import type {FunctionPoint} from './functionGeometryBounds.js';
import type {ParameterBox} from './bivariateIntervalNewton.js';

export interface SurfacePointWorkRequest extends FunctionSurfaceWorkRequest {
  readonly kind:'parametric-surface';readonly independent:readonly ['U','V'];
  readonly known:readonly FunctionKnownCoordinate[];
}
export type SurfacePointSavedInput=Omit<SurfacePointWorkRequest,'identity'>;
export function saveSurfacePointInput(value:unknown):SurfacePointSavedInput {
  const {identity:_identity,...saved}=decodeSurfacePointWorkRequest(value);void _identity;return Object.freeze(saved);
}
export interface SurfacePointCandidate {
  readonly point:FunctionPoint;readonly minimum:FunctionPoint;readonly maximum:FunctionPoint;
  readonly location:{readonly kind:'parametric-surface';readonly box:ParameterBox};
}
export type SurfacePointCandidates={readonly status:'ready';readonly candidates:readonly SurfacePointCandidate[];
  readonly exhaustive:boolean;readonly unresolved:readonly {readonly box:ParameterBox;readonly reason:string}[]}
  |{readonly status:'out-of-range';readonly axes:readonly FunctionKnownCoordinate['axis'][]}
  |{readonly status:'underconstrained'}
  |{readonly status:'stopped';readonly reason:'cancelled'|'deadline'|'budget'};

export function decodeSurfacePointWorkRequest(value:unknown):SurfacePointWorkRequest {
  const hasParameterBounds=value!==null&&typeof value==='object'&&Object.hasOwn(value,'parameterBounds');
  const raw=functionWorkRecord(value,['kind','identity','independent','outputs','lower','upper','minimum','maximum',
    'tolerance','budget','coefficients','known',...(hasParameterBounds?['parameterBounds']:[])]);
  if(raw.kind!=='parametric-surface')throw new MathInputProblem('syntax','媒介曲面上の点の依頼の種類が不正です。');
  const {kind:_kind,known:rawKnown,...surface}=raw;void _kind;
  const parent=decodeFunctionSurfaceWorkRequest(surface);
  if(parent.independent[0]!=='U')throw new MathInputProblem('syntax','媒介曲面のU・Vの式を指定してください。');
  const known=functionWorkArray(rawKnown,2).map(value=>{
    const item=functionWorkRecord(value,['axis','value']);
    return Object.freeze({axis:functionPointAxis(item.axis),value:functionWorkNumber(item.value)});
  });
  if(known.length<1||new Set(known.map(item=>item.axis)).size!==known.length){
    throw new MathInputProblem('syntax','既知の座標を重複しない1軸か2軸で指定してください。');
  }
  return Object.freeze({...parent,kind:'parametric-surface',independent:Object.freeze(['U','V'] as const),known:Object.freeze(known)});
}
