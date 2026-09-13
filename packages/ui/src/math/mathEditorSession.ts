/** Editor lifecycle independent of its renderer. A result applies only to the exact input and document generation. */
import { validateMathSource, type MathEvaluation, type StoredMathExpression } from '@pointercad/expression/math/contracts';
import { sameMathIdentity, type MathRequestIdentity } from '@pointercad/expression/math/client';
export interface MathEditorInput {
  readonly identity: MathRequestIdentity;
  readonly source: string;
  readonly notation: 'text' | 'latex';
  readonly angleUnit: 'degree' | 'radian';
}
export interface MathEditorOutput {
  readonly input: MathEditorInput;
  readonly definition: StoredMathExpression | null;
  readonly evaluation: MathEvaluation;
}
export type MathEditorState =
  | { readonly status: 'editing'; readonly input: MathEditorInput }
  | { readonly status: 'calculating'; readonly input: MathEditorInput }
  | { readonly status: 'evaluated'; readonly input: MathEditorInput; readonly output: MathEditorOutput; readonly canApply: boolean }
  | { readonly status: 'rejected'; readonly input: MathEditorInput; readonly reason: 'source' | 'worker' };
export interface MathEditorSessionOptions {
  readonly initial: MathEditorInput;
  /** Must perform its work off the UI thread and honour AbortSignal via the Worker client. */
  readonly calculate: (input: MathEditorInput, signal: AbortSignal) => Promise<MathEditorOutput>;
  readonly isCurrentDocument: (identity: MathRequestIdentity) => boolean;
  /** Numeric coordinate fields and symbolic function formulas have distinct acceptance conditions. */
  readonly canApply: (output: MathEditorOutput) => boolean;
  readonly onState: (state: MathEditorState) => void;
  readonly onApply: (output: MathEditorOutput) => void;
}

function sameInput(a: MathEditorInput, b: MathEditorInput): boolean {
  return sameMathIdentity(a.identity,b.identity) && a.source === b.source && a.notation === b.notation && a.angleUnit === b.angleUnit;
}
function copyInput(input: MathEditorInput): MathEditorInput {
  return Object.freeze({...input,identity:Object.freeze({...input.identity})});
}
export class MathEditorSession {
  private readonly options: MathEditorSessionOptions;
  private current: MathEditorInput;
  private state: MathEditorState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: AbortController | null = null;
  private applyRevision: number | null = null;
  private disposed = false;
  constructor(options: MathEditorSessionOptions) {
    this.options=options;this.current=copyInput(options.initial);this.state={status:'editing',input:this.current};
    this.schedule();
  }
  get snapshot(): MathEditorState { return this.state; }
  private publish(state: MathEditorState): void {
    if(this.disposed)return;
    this.state=state;this.options.onState(state);
  }
  private cancelWork(): void {
    if(this.timer!==null){clearTimeout(this.timer);this.timer=null;}
    this.active?.abort();this.active=null;
  }
  update(source: string, notation: MathEditorInput['notation'], angleUnit: MathEditorInput['angleUnit']): void {
    if(this.disposed)return;
    if(this.current.source===source&&this.current.notation===notation&&this.current.angleUnit===angleUnit)return;
    if(this.current.identity.inputRevision>=Number.MAX_SAFE_INTEGER)throw new RangeError('Math editor revision exhausted');
    this.cancelWork();this.applyRevision=null;
    this.current=copyInput({...this.current,source,notation,angleUnit,
      identity:{...this.current.identity,inputRevision:this.current.identity.inputRevision+1}});
    this.publish({status:'editing',input:this.current});this.schedule();
  }
  /** Call on document/parameter generation changes, even if the visible source stayed identical. */
  refresh(identity: Omit<MathRequestIdentity,'inputRevision'>): void {
    if(this.disposed)return;
    this.cancelWork();this.applyRevision=null;
    if(this.current.identity.inputRevision>=Number.MAX_SAFE_INTEGER)throw new RangeError('Math editor revision exhausted');
    this.current=copyInput({...this.current,identity:{...identity,inputRevision:this.current.identity.inputRevision+1}});
    this.publish({status:'editing',input:this.current});this.schedule();
  }
  requestApply(): void {
    if(this.disposed||!this.options.isCurrentDocument(this.current.identity))return;
    if(this.state.status==='evaluated'&&this.state.canApply&&sameInput(this.state.input,this.current)) {
      this.options.onApply(this.state.output);return;
    }
    this.applyRevision=this.current.identity.inputRevision;
    if(this.state.status==='editing'){if(this.timer!==null){clearTimeout(this.timer);this.timer=null;}void this.run();}
  }
  private schedule(): void {
    try { validateMathSource(this.current.source); }
    catch { this.publish({status:'rejected',input:this.current,reason:'source'});return; }
    this.timer=setTimeout(()=>{this.timer=null;void this.run();},120);
  }
  private async run(): Promise<void> {
    if(this.disposed||this.active!==null||!this.options.isCurrentDocument(this.current.identity))return;
    const input=this.current,controller=new AbortController();this.active=controller;
    this.publish({status:'calculating',input});
    if(this.disposed||controller.signal.aborted||this.active!==controller)return;
    try {
      const output=await this.options.calculate(input,controller.signal);
      if(this.disposed||controller.signal.aborted||this.active!==controller||!sameInput(this.current,input)
        ||!this.options.isCurrentDocument(input.identity))return;
      this.active=null;
      const definition=output.definition;
      if(!sameInput(output.input,input)||(definition!==null&&(definition.source!==input.source
        ||definition.inputNotation!==input.notation||definition.angleUnit!==input.angleUnit))) {
        this.applyRevision=null;this.publish({status:'rejected',input,reason:'worker'});return;
      }
      const canApply=definition!==null&&(output.evaluation.status==='value'||output.evaluation.status==='unresolved')
        &&this.options.canApply(output);
      this.publish({status:'evaluated',input,output,canApply});
      // A parent state listener may have closed or changed the dialog while publishing.
      if(!this.disposed&&canApply&&this.applyRevision===input.identity.inputRevision&&sameInput(this.current,input)
        &&this.options.isCurrentDocument(input.identity)) {
        this.applyRevision=null;this.options.onApply(output);
      }
    } catch {
      if(this.disposed||controller.signal.aborted||this.active!==controller||!sameInput(this.current,input))return;
      this.active=null;this.applyRevision=null;this.publish({status:'rejected',input,reason:'worker'});
    }
  }
  dispose(): void { if(this.disposed)return;this.disposed=true;this.cancelWork();this.applyRevision=null; }
}
