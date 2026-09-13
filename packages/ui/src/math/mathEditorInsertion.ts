/** Preserve the exact input while asynchronously changing notation or mounting the structured editor. */
import {validateMathSource} from '@pointercad/expression/math/contracts';
import {sameMathIdentity} from '@pointercad/expression/math/client';
import type {MathEditorInput} from './mathEditorSession.js';
interface PendingInsertion {readonly input:MathEditorInput;readonly template:string}
export interface MathEditorInsertionOptions {
  readonly current:()=>MathEditorInput;
  readonly isCurrent:()=>boolean;
  /** Worker conversion validates semantic equivalence and honours cancellation. */
  readonly toLatex:(input:MathEditorInput,signal:AbortSignal)=>Promise<string>;
  /** Returns the actual new session input; null means the parent rejected the change. */
  readonly applyConverted:(input:MathEditorInput,latex:string)=>MathEditorInput|null;
  readonly onProblem:(reason:'conversion'|'insertion')=>void;
}
function same(a:MathEditorInput,b:MathEditorInput):boolean {
  return sameMathIdentity(a.identity,b.identity)&&a.source===b.source&&a.notation===b.notation&&a.angleUnit===b.angleUnit;
}
function copy(input:MathEditorInput):MathEditorInput{return Object.freeze({...input,identity:Object.freeze({...input.identity})});}
export class MathEditorInsertion {
  private readonly options:MathEditorInsertionOptions;
  private target:{readonly insert:(latex:string)=>boolean}|null=null;
  private pending:PendingInsertion|null=null;
  private conversion:AbortController|null=null;
  private revision=0;
  private disposed=false;
  constructor(options:MathEditorInsertionOptions){this.options=options;}
  bind(insert:(latex:string)=>boolean):()=>void {
    if(this.disposed)return()=>undefined;
    const target={insert};this.target=target;this.flush();
    return()=>{if(this.target===target)this.target=null;};
  }
  /** Caller also uses this for source/parameter/document changes. It cannot invalidate a newer binding. */
  invalidate():void {
    if(this.revision>=Number.MAX_SAFE_INTEGER)throw new RangeError('Math insertion revision exhausted');
    this.revision+=1;
    this.conversion?.abort();this.conversion=null;this.pending=null;
  }
  insert(template:string):void {
    if(this.disposed||!this.options.isCurrent())return;
    validateMathSource(template);
    this.invalidate();
    const input=copy(this.options.current());
    if(input.notation==='latex'){this.pending={input,template};this.flush();return;}
    const controller=new AbortController();this.conversion=controller;
    void this.convert(input,template,controller,this.revision);
  }
  private async convert(input:MathEditorInput,template:string,controller:AbortController,revision:number):Promise<void> {
    try {
      const latex=await this.options.toLatex(input,controller.signal);
      if(this.disposed||controller.signal.aborted||this.conversion!==controller||this.revision!==revision||!this.options.isCurrent()
        ||!same(input,this.options.current()))return;
      validateMathSource(latex);this.conversion=null;
      const current=this.options.applyConverted(input,latex);
      if(this.disposed||this.revision!==revision||current===null||!this.options.isCurrent()||!same(current,this.options.current()))return;
      if(current.notation!=='latex'||current.source!==latex)throw new Error('The editor did not apply the verified notation');
      this.pending={input:copy(current),template};this.flush();
    }catch {
      if(this.disposed||controller.signal.aborted||this.revision!==revision||!same(input,this.options.current()))return;
      this.conversion=null;this.pending=null;this.options.onProblem('conversion');
    }
  }
  private flush():void {
    const pending=this.pending,target=this.target;
    if(this.disposed||pending===null||target===null)return;
    this.pending=null;
    if(!this.options.isCurrent()||!same(pending.input,this.options.current()))return;
    if(!target.insert(pending.template))this.options.onProblem('insertion');
  }
  dispose():void{if(this.disposed)return;this.disposed=true;this.invalidate();this.target=null;}
}
