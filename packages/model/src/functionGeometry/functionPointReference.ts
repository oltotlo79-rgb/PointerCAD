/** A selected solution is defined by its parent and inputs, not a stored world-space point. */
import type {ExpressionValue} from '@pointercad/expression';
import {
  decodePointContinuationRequest,
  type PointCalculationCandidate,
  type PointCalculationSavedInput,
  type MathAxis,
  type FunctionPointDirectionKind,
} from '@pointercad/expression/math/contracts';


import type {Vec3} from '../sketch/vec3.js';

export type FunctionPointParent={readonly kind:'curve';readonly sketchId:string;readonly featureId:string}
  |{readonly kind:'surface';readonly featureId:string};
export interface FunctionPointChoice {
  /** Historical input defining the chosen branch. Re-evaluated before it can authorize continuation. */
  readonly input:PointCalculationSavedInput;
  readonly location:PointCalculationCandidate['location'];
}
export interface FunctionPointReference {
  readonly kind:'functionPoint';readonly parent:FunctionPointParent;
  readonly known:readonly {readonly axis:MathAxis;readonly value:ExpressionValue}[];
  readonly choice:FunctionPointChoice;
  readonly direction?:{readonly kind:FunctionPointDirectionKind;readonly length:ExpressionValue;readonly reverse:boolean;readonly sourcePointId?:string};
}
export type FunctionPointResolver=(reference:FunctionPointReference,ownerId:string)=>Vec3|null;
export function readFunctionPointChoice(value:unknown):FunctionPointChoice {
  if(value===null || typeof value!=='object' || !('input' in value) || !('location' in value) || Object.keys(value).length!==2) {
    throw new Error('関数上の点の選択条件を確認できません。');
  }
  const request=decodePointContinuationRequest({identity:{documentId:'point-choice',documentVersion:0,editorId:'point-choice',inputRevision:0},
    previous:value.input,current:value.input,anchor:value.location});
  return Object.freeze({input:request.previous,location:request.anchor});
}
export function functionPointReferenceKey(reference:FunctionPointReference):string {
  return JSON.stringify([reference.parent,reference.known.map(item=>[item.axis,item.value.value]),reference.choice,reference.direction?[reference.direction.kind,reference.direction.length.value,reference.direction.reverse,reference.direction.sourcePointId]:null]);
}
