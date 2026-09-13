/** Keep unevaluated calculus away from the engine's implicit numerical/JIT fallback. */
import {MathInputProblem} from './mathInputContract.js';
export interface MathBackendBox {
  readonly json:unknown;
  evaluate():MathBackendBox;
  N():MathBackendBox;
}
const FALLBACKS=new Set(['Integrate','NIntegrate','Limit','NLimit','ND','NDerivative','Sum','Product','Measurement']);
export function pendingNumericMath(json:unknown):readonly string[] {
  const pending=[{value:json,depth:0}],found=new Set<string>();let remaining=32768;
  while(pending.length>0) {
    const item=pending.pop();if(!item)break;
    if(--remaining<0||item.depth>128)throw new MathInputProblem('budget','計算結果の構造が大きすぎます。');
    if(Array.isArray(item.value)) {
      if(typeof item.value[0]==='string'&&FALLBACKS.has(item.value[0]))found.add(item.value[0]);
      if(item.value.length>4096)throw new MathInputProblem('budget','計算結果の項目が多すぎます。');
      for(const value of item.value)pending.push({value,depth:item.depth+1});
    }else if(item.value&&typeof item.value==='object') {
      const values=Object.values(item.value);if(values.length>16)throw new MathInputProblem('budget','計算結果の形式が不正です。');
      for(const value of values)pending.push({value,depth:item.depth+1});
    }
  }
  return [...found];
}
export type PreparedMathNumeric =
  | {readonly status:'evaluated';readonly exact:unknown;readonly numeric:unknown}
  | {readonly status:'requires-deterministic-numeric';readonly exact:unknown;readonly operations:readonly string[]};
/** Caller first checks every source-domain obligation and wraps this synchronous work in its Worker deadline. */
export function evaluatePreparedMath(expression:MathBackendBox,allowNumeric?:(exact:unknown)=>boolean):PreparedMathNumeric {
  const exact=expression.evaluate(),operations=pendingNumericMath(exact.json);
  if(operations.length>0)return {status:'requires-deterministic-numeric',exact:exact.json,operations};
  if(allowNumeric!==undefined&&!allowNumeric(exact.json))return {
    status:'requires-deterministic-numeric',exact:exact.json,operations:['unverified-integral-result']};
  const numeric=exact.N();
  const remaining=pendingNumericMath(numeric.json);
  return remaining.length>0?{status:'requires-deterministic-numeric',exact:exact.json,operations:remaining}
    :{status:'evaluated',exact:exact.json,numeric:numeric.json};
}
