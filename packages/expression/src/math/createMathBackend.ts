/** Instantiate inside the disposable calculation Worker; never attach an engine to the input field. */
import {createNativeMathBox} from './nativeMathBackend.js';
import {MathInputProblem} from './mathInputContract.js';
import {CANDIDATE_MATH_OPERATIONS,CANDIDATE_MATH_BY_ID} from './mathOperations.js';
import {createMathLatexCodec} from './mathLatexCodec.js';
import type {MathExecutionBackend} from './mathWorkExecution.js';

export function createMathBackend():MathExecutionBackend {
  let deadline=Infinity,startedAt=0,parentDeadline=Infinity;
  const check=():void=>{if(performance.now()>deadline)throw new MathInputProblem('budget','計算時間の上限に達しました。式や範囲を小さくしてください。');};
  // Special functions (including real/complex erf) and distributions share bounded high-precision kernels.
  // Keep 200ms for ordinary expressions, 1s for these operations, 3s for elliptic integrals.
  // The allowance is relative to the original request, never renewed per function.
  const distributionAllowance=(kind?:'elliptic'):void=>{if(Number.isFinite(deadline))deadline=Math.min(parentDeadline,
    Math.max(deadline,startedAt+(kind==='elliptic'?3000:1000)));};
  const codec=createMathLatexCodec();
  return {
    parseLatex:codec.parse,serializeLatex:codec.serialize,operations:CANDIDATE_MATH_OPERATIONS,operationsById:CANDIDATE_MATH_BY_ID,
    box:expression=>createNativeMathBox(expression,check,distributionAllowance),
    withinDeadline:<T>(operation:()=>T extends Promise<unknown> ? never : T):T=>{
      const previous={deadline,startedAt,parentDeadline};parentDeadline=deadline;startedAt=performance.now();
      deadline=Math.min(parentDeadline,startedAt+200);
      try{const result=operation();check();return result;}
      finally{({deadline,startedAt,parentDeadline}=previous);}
    },
  };
}
