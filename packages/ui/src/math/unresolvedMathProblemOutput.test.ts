import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend, executeMathWorkRequest, type MathExecutionBackend } from '@pointercad/expression/math/worker';
import { MATH_INPUT_FORMAT, type MathEvaluation } from '@pointercad/expression/math/contracts';
import type { MathEditorOutput } from './mathEditorSession.js';
import { unresolvedMathProblemOutput } from './unresolvedMathProblemOutput.js';

let backend:MathExecutionBackend;
beforeAll(()=>{backend=createMathBackend();});
function output(source='pde([diff(u,t)=diff(u,x,x)],[x,t],[u],[[u,[0,t],0]])'):MathEditorOutput {
  const input={identity:{documentId:'pde',documentVersion:1,editorId:'pde',inputRevision:1},source,notation:'text' as const,angleUnit:'degree' as const};
  const reply=executeMathWorkRequest({kind:'evaluate-math',serial:1,request:{...input,coefficients:[]}},backend);
  if(reply.expression===null) throw new Error(JSON.stringify(reply.evaluation));
  return {input,definition:{format:MATH_INPUT_FORMAT,source,inputNotation:'text',angleUnit:'degree',expression:reply.expression},
    evaluation:{status:'unresolved',reason:'unevaluated',names:[]}};
}
describe('未解決の式を保存する入口は、通常の数値の適用と区別する',()=>{
  it('元のPDE・境界条件・未解決状態だけを受け付ける',()=>{
    const value=output();expect(unresolvedMathProblemOutput(value)).toBe(value.definition);
  });
  it.each(['0','1+2','odesolve([diff(y,x)=y],x,[y],[])'])('%sは未解決のPDEとして受け付けない',source=>{
    expect(unresolvedMathProblemOutput(output(source))).toBeNull();
  });
  it('失敗・中止・値・不足条件・古い返信は保存できない',()=>{
    const value=output();
    const evaluations:MathEvaluation[]=[{status:'invalid',reason:'syntax',detail:'不正'}, {status:'stopped',reason:'cancelled'},
      {status:'value',kind:'real',exact:null,decimal:'0',coordinate:0,approximation:null},
      {status:'unresolved',reason:'missing-condition',names:[]}];
    for(const evaluation of evaluations) expect(unresolvedMathProblemOutput({...value,evaluation})).toBeNull();
    expect(unresolvedMathProblemOutput({...value,definition:null})).toBeNull();
    expect(unresolvedMathProblemOutput({...value,input:{...value.input,source:'0'}})).toBeNull();
  });
});
