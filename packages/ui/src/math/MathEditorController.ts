/** One editor owns its input, cancellation, and conversion; the view only subscribes to this state. */
import { sameMathIdentity, type MathWorkerClient, type MathWorkRequest, type MathRequestIdentity } from '@pointercad/expression/math/client';
import { MathEditorSession, type MathEditorInput, type MathEditorOutput, type MathEditorState } from './mathEditorSession.js';
import { MathEditorInsertion } from './mathEditorInsertion.js';
import { createMathSessionCalculation } from './mathSessionWorker.js';
import { convertMathSessionNotation } from './convertMathSessionNotation.js';
import { chooseMathResultComponent } from './mathResultComponent.js';
import type { MathEditorViewController } from './MathEditorSurface.js';

export interface MathEditorSnapshot {
  readonly state: MathEditorState;
  readonly query: string;
  readonly problem: 'source-limit' | 'conversion' | 'insertion' | null;
}
export interface MathEditorControllerOptions {
  readonly initial: MathEditorInput;
  /** Dedicated client. Closing this editor disposes it and terminates its calculation. */
  readonly client: MathWorkerClient;
  readonly requestFor: (input: MathEditorInput) => MathWorkRequest;
  readonly isCurrentDocument: (identity: MathRequestIdentity) => boolean;
  readonly canApply: (output: MathEditorOutput) => boolean;
  readonly onApply: (output: MathEditorOutput) => void;
  readonly onCancel: () => void;
  readonly onMoveOut: (direction: 'forward' | 'backward') => void;
}

export class MathEditorController implements MathEditorViewController {
  private readonly options: MathEditorControllerOptions;
  private readonly session: MathEditorSession;
  private readonly insertion: MathEditorInsertion;
  private readonly listeners = new Set<() => void>();
  private snapshot: MathEditorSnapshot;
  private conversion: AbortController | null = null;
  private previousNotation: { readonly original: MathEditorInput; readonly converted: MathEditorInput } | null = null;
  private disposed = false;
  constructor(options: MathEditorControllerOptions) {
    this.options = options;
    this.snapshot = { state: { status: 'editing', input: options.initial }, query: '', problem: null };
    this.session = new MathEditorSession({
      initial: options.initial,
      calculate: createMathSessionCalculation({ client: options.client, requestFor: options.requestFor, deadlineMs: 5_000 }),
      isCurrentDocument: options.isCurrentDocument, canApply: options.canApply,
      onState: state => this.publish({ ...this.snapshot, state }),
      onApply: output => { if (!this.disposed) options.onApply(output); },
    });
    this.insertion = new MathEditorInsertion({
      current: this.current, isCurrent: this.isCurrent,
      toLatex: (input, signal) => convertMathSessionNotation(options.client, input, options.requestFor(input), 'latex', signal),
      applyConverted: (input, source) => this.applyConverted(input, source, 'latex'),
      onProblem: problem => this.publish({ ...this.snapshot, problem }),
    });
  }
  readonly getSnapshot = (): MathEditorSnapshot => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(snapshot: MathEditorSnapshot): void {
    if (this.disposed) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
  readonly current = (): MathEditorInput => this.snapshot.state.input;
  readonly isCurrent = (): boolean => !this.disposed && this.options.isCurrentDocument(this.current().identity);
  private cancelConversion(): void {
    this.conversion?.abort();
    this.conversion = null;
  }
  private invalidate(): void {
    this.cancelConversion();
    this.previousNotation = null;
    this.insertion.invalidate();
    if (this.snapshot.problem !== null) this.publish({ ...this.snapshot, problem: null });
  }
  readonly sourceChanged = (source: string): void => {
    if (!this.isCurrent() || source === this.current().source) return;
    this.invalidate();
    this.session.update(source, this.current().notation, this.current().angleUnit);
  };
  readonly chooseResultComponent = (expected: MathEditorInput, indices: readonly number[]): boolean => {
    const state = this.snapshot.state;
    if (!this.sameInput(expected) || state.status !== 'evaluated') return false;
    const source = chooseMathResultComponent(expected, state.output.evaluation, indices);
    if (source === null) return false;
    this.sourceChanged(source);
    return true;
  };
  readonly changeAngleUnit = (unit: 'degree' | 'radian'): void => {
    if (!this.isCurrent() || unit === this.current().angleUnit) return;
    this.invalidate();
    this.session.update(this.current().source, this.current().notation, unit);
  };
  readonly apply = (): void => { if (this.isCurrent()) this.session.requestApply(); };
  readonly cancel = (): void => {
    if (this.disposed) return;
    this.dispose();
    this.options.onCancel();
  };
  readonly sourceLimit = (): void => this.publish({ ...this.snapshot, problem: 'source-limit' });
  readonly moveOut = (direction: 'forward' | 'backward'): void => { if (this.isCurrent()) this.options.onMoveOut(direction); };
  readonly bindInsertion = (insert: (latex: string) => boolean): (() => void) => this.insertion.bind(insert);
  readonly insert = (template: string): void => {
    if (!this.isCurrent()) return;
    this.cancelConversion();
    this.previousNotation = null;
    this.insertion.insert(template);
  };
  readonly setQuery = (query: string): void => { if (query !== this.snapshot.query) this.publish({ ...this.snapshot, query }); };
  private sameInput(input: MathEditorInput): boolean {
    const current = this.current();
    return this.isCurrent() && sameMathIdentity(input.identity, current.identity)
      && input.source === current.source && input.notation === current.notation && input.angleUnit === current.angleUnit;
  }
  private applyConverted(input: MathEditorInput, source: string, notation: 'text' | 'latex'): MathEditorInput | null {
    if (!this.sameInput(input)) return null;
    this.session.update(source, notation, input.angleUnit);
    const converted = this.current();
    this.previousNotation = { original: input, converted };
    return converted;
  }
  readonly requestNotation = (notation: 'text' | 'latex'): void => {
    if (!this.isCurrent() || this.current().notation === notation) return;
    const previous = this.previousNotation;
    const restore = previous !== null && previous.original.notation === notation && this.sameInput(previous.converted);
    this.invalidate();
    // Merely viewing the other notation must not rewrite spelling, spacing, or brackets.
    // Actual edits, angle changes, and document changes invalidate this single reverse conversion.
    if (restore && previous !== null) {
      this.applyConverted(this.current(), previous.original.source, notation);
      return;
    }
    const input = this.current(), controller = new AbortController();
    this.conversion = controller;
    void this.convert(input, notation, controller);
  };
  private async convert(input: MathEditorInput, target: 'text' | 'latex', controller: AbortController): Promise<void> {
    try {
      const source = await convertMathSessionNotation(this.options.client, input, this.options.requestFor(input), target, controller.signal);
      if (controller.signal.aborted || this.conversion !== controller) return;
      this.conversion = null;
      this.applyConverted(input, source, target);
    } catch {
      if (controller.signal.aborted || this.conversion !== controller || !this.sameInput(input)) return;
      this.conversion = null;
      this.publish({ ...this.snapshot, problem: 'conversion' });
    }
  }
  refresh(identity: Omit<MathRequestIdentity, 'inputRevision'>): void {
    if (this.disposed) return;
    this.invalidate();
    this.session.refresh(identity);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelConversion();
    this.previousNotation = null;
    this.insertion.dispose();
    this.session.dispose();
    this.options.client.dispose();
    this.listeners.clear();
  }
}
