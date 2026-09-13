/** Instantiate inside the disposable calculation Worker; never attach an engine to the input field. */
import {CancellationError,ComputeEngine} from '@cortex-js/compute-engine';
import {MathInputProblem} from './mathInputContract.js';
import {CANDIDATE_MATH_OPERATIONS,CANDIDATE_MATH_BY_ID} from './mathOperations.js';
import {createMathLatexCodec} from './mathLatexCodec.js';
import type {MathExecutionBackend} from './mathWorkExecution.js';

export function createMathBackend():MathExecutionBackend {
  const engine=new ComputeEngine({precision:40});
  // Must precede every parse/evaluate operation. The public boundary rewrites degree arguments once.
  engine.jit='off';engine.angularUnit='rad';engine.iterationLimit=1000;engine.recursionLimit=64;
  const codec=createMathLatexCodec();
  return {
    parseLatex:codec.parse,serializeLatex:codec.serialize,operations:CANDIDATE_MATH_OPERATIONS,operationsById:CANDIDATE_MATH_BY_ID,
    box:expression=>engine.expr(expression),
    withinDeadline:<T>(operation:()=>T extends Promise<unknown> ? never : T):T=>{
      try{return engine.withTimeLimit<T>({ms:200,label:'PointerCAD math'},operation);}
      catch(error){
        if(error instanceof CancellationError)throw new MathInputProblem('budget','計算時間の上限に達しました。式や範囲を小さくしてください。');
        throw error;
      }
    },
  };
}
