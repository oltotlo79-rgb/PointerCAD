/** Connect exact-input editor acceptance to the single cancellable Worker queue. */
import type { MathEditorInput, MathEditorOutput } from './mathEditorSession.js';
import { sameMathIdentity, type MathWorkRequest, type MathWorkerClient } from '@pointercad/expression/math/client';
import { sameMathDeclarations } from '@pointercad/expression/math/contracts';
export function createMathSessionCalculation(options: {
  readonly client:MathWorkerClient;
  readonly requestFor:(input:MathEditorInput)=>MathWorkRequest;
  readonly deadlineMs:number;
}):(input:MathEditorInput,signal:AbortSignal)=>Promise<MathEditorOutput> {
  return async(input,signal)=>{
    const request=options.requestFor(input);
    if(!sameMathIdentity(request.identity,input.identity)||request.source!==input.source
      ||request.notation!==input.notation||request.angleUnit!==input.angleUnit
      ||!sameMathDeclarations(request.declarations??request.definition?.declarations,input.declarations))throw new Error('Math session scope changed');
    const completion=await options.client.evaluate(request,options.deadlineMs,signal);
    if(!sameMathIdentity(completion.identity,input.identity))throw new Error('Math result belongs to another editor generation');
    if(completion.status==='result')return {input,definition:completion.result.definition,evaluation:completion.result.evaluation};
    if(completion.status==='cancelled'||completion.status==='disposed')return {input,definition:null,evaluation:{status:'stopped',reason:'cancelled'}};
    if(completion.status==='deadline')return {input,definition:null,evaluation:{status:'stopped',reason:'deadline'}};
    if(completion.status==='queue-full')return {input,definition:null,evaluation:{status:'stopped',reason:'budget'}};
    throw new Error('Math Worker did not return a validated result');
  };
}
