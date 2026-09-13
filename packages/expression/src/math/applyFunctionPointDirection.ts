/** Calculate the requested direction only after the saved branch was revalidated. */
import {MathInputProblem} from './mathInputContract.js';
import {functionPointFrame,functionDirectionEndpoint} from './functionPointFrame.js';
import type {FunctionDirectionOptions,FunctionDirectionEndpoint} from './functionDirectionContract.js';
import type {PointCalculationCandidate,PointCalculationRequest} from './pointCalculationContract.js';
import type {PreparedScalarMathContext} from './evaluatePreparedScalarMath.js';

export function applyFunctionPointDirection(request:PointCalculationRequest,candidate:PointCalculationCandidate,
  direction:FunctionDirectionOptions|undefined,context:Omit<PreparedScalarMathContext,'angleUnit'>):FunctionDirectionEndpoint|undefined {
  if(direction===undefined)return undefined;
  const frame=functionPointFrame(request,candidate,direction.kind,context);
  if(frame===null)throw new MathInputProblem('domain','この点では指定した接線・法線を一意に定められません。尖点・特異点、直線の主法線などを確認してください。');
  const endpoint=functionDirectionEndpoint(candidate,frame,direction.length,request.tolerance,direction.reverse);
  if(endpoint===null)throw new MathInputProblem('domain','接線・法線の終点を指定精度で確定できません。長さを短くするか、点の精度を上げてください。');
  return endpoint;
}
