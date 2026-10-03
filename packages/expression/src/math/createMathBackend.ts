/** Instantiate inside the disposable calculation Worker; never attach an engine to the input field. */
import {createNativeMathBox,nativeMathDeadlineKind} from './nativeMathBackend.js';
import {pacedCalculationMs,type MathNode} from './mathInputContract.js';
import {CANDIDATE_MATH_OPERATIONS,CANDIDATE_MATH_BY_ID} from './mathOperations.js';
import {createMathLatexCodec} from './mathLatexCodec.js';
import {MathDeadlineExceeded,executeMathWorkRequest,type MathExecutionBackend} from './mathWorkExecution.js';
import {createMathWorkEnvelope,type MathWorkRequest} from './mathWorkRequest.js';

export function createMathBackend():MathExecutionBackend {
  let deadline=Infinity,startedAt=0,parentDeadline=Infinity;
  const check=():void=>{if(performance.now()>deadline)throw new MathDeadlineExceeded();};
  // Special functions (including real/complex erf) and distributions share bounded high-precision kernels.
  // Keep 200ms for ordinary expressions, 1s for these operations, 3s for elliptic integrals (each at the machine's
  // current pace, v1.0.2: never shorter, at most CALCULATION_PACE_LIMITS.maximum times longer).
  // The allowance is relative to the original request, never renewed per function.
  const distributionAllowance=(kind?:'elliptic'):void=>{if(Number.isFinite(deadline))deadline=Math.min(parentDeadline,
    Math.max(deadline,startedAt+pacedCalculationMs(kind==='elliptic'?3000:1000)));};
  // Only validated input/substitution trees enter here (bounded by MATH_INPUT_LIMITS).
  const prepareDeadline=(expression:MathNode):void=>{
    const pending=[expression];
    while(pending.length>0) {
      const node=pending.pop();if(node===undefined)break;
      if(node.kind==='operation'||node.kind==='binder') {
        const head=CANDIDATE_MATH_BY_ID.get(node.operation)?.engineHead;
        const kind=head===undefined?null:nativeMathDeadlineKind(head);
        if(kind!==null)distributionAllowance(kind==='elliptic'?'elliptic':undefined);
      }
      if(node.kind==='operation')pending.push(...node.operands);
      else if(node.kind==='binder') {
        pending.push(node.body);
        for(const {domain} of node.bindings) {
          if(domain.kind==='set')pending.push(domain.value);
          else if(domain.kind==='range') {
            pending.push(domain.lower,domain.upper);if(domain.step!==null)pending.push(domain.step);
          }
        }
      }
    }
  };
  const codec=createMathLatexCodec();
  return {
    parseLatex:codec.parse,serializeLatex:codec.serialize,operations:CANDIDATE_MATH_OPERATIONS,operationsById:CANDIDATE_MATH_BY_ID,
    prepareDeadline,
    box:expression=>createNativeMathBox(expression,check,distributionAllowance),
    // An explicit allowance is already in milliseconds of this machine (the geometry clock paces its own limit).
    withinDeadline:<T>(operation:()=>T extends Promise<unknown> ? never : T,allowance?:number):T=>{
      const previous={deadline,startedAt,parentDeadline};parentDeadline=deadline;startedAt=performance.now();
      deadline=Math.min(parentDeadline,startedAt+(allowance??pacedCalculationMs(200)));
      try{const result=operation();check();return result;}
      finally{({deadline,startedAt,parentDeadline}=previous);}
    },
  };
}

/** A new calculation Worker compiles the shared parse, conversion, preparation and evaluation code during
 * its first calculations. Run two small representative requests while the Worker is prepared, before any
 * request starts its wall clock: a formula with a coefficient converted for the structured input, and that
 * saved structured formula converted back. The results are discarded; returns the elapsed milliseconds. */
export function warmMathBackend(backend:MathExecutionBackend):number {
  const started=performance.now();
  const identity={documentId:'math-backend-warmup',documentVersion:0,editorId:'warmup',inputRevision:0};
  const coefficients:MathWorkRequest['coefficients']=[{id:'warmup-coefficient',label:'a',decimal:'1.5',
    exactExpression:{kind:'operation',operation:'divide',operands:[{kind:'number',decimal:'3'},{kind:'number',decimal:'2'}]}}];
  const text:MathWorkRequest={identity,source:'sqrt(2)*sin(30)+coef("a")/3',notation:'text',angleUnit:'degree',
    coefficients,presentationNotation:'latex'};
  try {
    const saved=executeMathWorkRequest(createMathWorkEnvelope(1,text),backend).presentation;
    if(saved!==null&&saved!==undefined) {
      executeMathWorkRequest(createMathWorkEnvelope(2,{...text,source:saved.source,notation:'latex',definition:saved,
        presentationNotation:'text'}),backend);
    }
  } catch {
    // A failed warm-up only leaves that compilation inside the first request, exactly as before.
  }
  return performance.now()-started;
}
