/** Host-owned lifetime for the optional exact engine. Preparation cannot renew its deadline. */
import type { CalculationWorkerPort } from './boundedCalculationClient.js';
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import type { ExactMathEngine } from './exactMathWorkExecution.js';

export const EXACT_MATH_ENGINE_LIMITS = Object.freeze({
  preparationMs: 180_000,
  calculationMs: 45_000,
  totalMs: 225_000,
  requestsPerWorker: 32,
});
export type ExactMathEnginePhase = 'runtime-loading' | 'symbolic-import' | 'calculating';
export class ExactMathEngineStopped extends Error {
  constructor(readonly reason: 'cancelled' | 'deadline') {
    super(reason === 'cancelled' ? '数学の計算を中止しました。' : '数学の計算が制限時間を超えました。');
    this.name = 'ExactMathEngineStopped';
  }
}
interface EngineOptions {
  readonly createWorker: () => CalculationWorkerPort;
  readonly onPhase?: (phase: ExactMathEnginePhase) => void;
}
interface ActiveCalculation {
  readonly serial: number;
  readonly absoluteEnd: number;
  deadlineEnd: number;
  readonly warm: boolean;
  calculationEnd: number | null;
  phase: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly detachAbort: () => void;
}
const phases = ['runtime-loading', 'symbolic-import', 'calculating'] as const;
function protocolFailure(): MathInputProblem {
  return new MathInputProblem('unsupported', '数学の計算部からの応答を確認できませんでした。');
}
function envelope(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null;
  }
  return value as Record<string, unknown>;
}
function keysAre(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

/** One calculation at a time. The enclosing request queue owns document/input identities. */
export class ExactMathEngineClient implements ExactMathEngine {
  private worker: CalculationWorkerPort | null = null;
  private active: ActiveCalculation | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private serial = 0;
  private uses = 0;
  private ready = false;
  private disposed = false;

  constructor(private readonly options: EngineOptions) {}

  evaluate(expression: MathNode, angleUnit: 'degree' | 'radian', signal?: AbortSignal): Promise<unknown> {
    if (this.disposed || signal?.aborted) return Promise.reject(new ExactMathEngineStopped('cancelled'));
    if (this.active !== null) return Promise.reject(new MathInputProblem('budget', '前の数学の計算を完了または中止してください。'));
    if (this.serial >= Number.MAX_SAFE_INTEGER) return Promise.reject(new MathInputProblem('budget', '計算の識別番号を使い切りました。'));
    if (this.uses >= EXACT_MATH_ENGINE_LIMITS.requestsPerWorker) this.stopWorker();
    const serial = ++this.serial, startedAt = performance.now();
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (this.active?.serial === serial) this.fail(new ExactMathEngineStopped('cancelled'));
      };
      this.active = { serial, absoluteEnd: startedAt + EXACT_MATH_ENGINE_LIMITS.totalMs,
        deadlineEnd: startedAt + (this.ready ? EXACT_MATH_ENGINE_LIMITS.calculationMs : EXACT_MATH_ENGINE_LIMITS.preparationMs),
        warm: this.ready, calculationEnd: this.ready ? startedAt + EXACT_MATH_ENGINE_LIMITS.calculationMs : null,
        phase: -1, resolve, reject, detachAbort: () => signal?.removeEventListener('abort', abort) };
      signal?.addEventListener('abort', abort, { once: true });
      this.arm(this.active.calculationEnd ?? startedAt + EXACT_MATH_ENGINE_LIMITS.preparationMs);
      try {
        const worker = this.worker ?? this.createWorker();
        this.uses += 1;
        // A real Worker takes an immutable structured clone during this call.
        worker.postMessage({ kind: 'exact-evaluate', serial, expression, angleUnit });
      } catch { this.fail(protocolFailure()); }
    });
  }

  private arm(end: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    const active = this.active;
    if (active === null) return;
    active.deadlineEnd = Math.min(end, active.absoluteEnd);
    this.timer = setTimeout(() => {
      if (this.active === active) this.fail(new ExactMathEngineStopped('deadline'));
    }, Math.max(0, Math.ceil(active.deadlineEnd - performance.now())));
  }

  private createWorker(): CalculationWorkerPort {
    const worker = this.options.createWorker();
    if (this.active === null || this.disposed) {
      worker.terminate();
      throw new ExactMathEngineStopped('cancelled');
    }
    this.worker = worker;
    worker.onmessage = event => {
      if (this.worker !== worker || this.active === null) return;
      try { this.receive(event.data); } catch { this.fail(protocolFailure()); }
    };
    const fail = () => { if (this.worker === worker) this.fail(protocolFailure()); };
    worker.onerror = event => { event.preventDefault(); fail(); };
    worker.onmessageerror = fail;
    return worker;
  }

  private receive(value: unknown): void {
    const active = this.active, message = envelope(value);
    if (active === null) return;
    if (performance.now() >= active.deadlineEnd) { this.fail(new ExactMathEngineStopped('deadline')); return; }
    if (message === null || message.serial !== active.serial) { this.fail(protocolFailure()); return; }
    if (message.kind === 'phase' && keysAre(message, ['kind', 'serial', 'phase'])) {
      this.phase(message.phase); return;
    }
    if (message.kind !== 'result' || !keysAre(message, ['kind', 'serial', 'result']) || active.phase !== 2) {
      this.fail(protocolFailure()); return;
    }
    // Final AST, domain, and identity validation remains mandatory in the existing coordinator.
    this.ready = true;
    this.clearActive();
    active.resolve(message.result);
  }

  private phase(value: unknown): void {
    const active = this.active;
    if (active === null) return;
    const next = phases.findIndex(phase => phase === value);
    if (next < 0 || next <= active.phase || (active.warm && next !== 2)) {
      this.fail(protocolFailure()); return;
    }
    active.phase = next;
    if (next === 2) {
      // Warm requests already have a deadline: a delayed phase must never reset it.
      active.calculationEnd ??= performance.now() + EXACT_MATH_ENGINE_LIMITS.calculationMs;
      this.arm(active.calculationEnd);
    }
    this.options.onPhase?.(phases[next]);
  }

  private clearActive(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.active?.detachAbort();
    this.active = null;
  }

  private fail(error: Error): void {
    const active = this.active;
    this.clearActive();
    try { this.stopWorker(); } finally { active?.reject(error); }
  }

  private stopWorker(): void {
    const worker = this.worker;
    this.worker = null;
    this.ready = false;
    this.uses = 0;
    if (worker === null) return;
    worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
    worker.terminate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fail(new ExactMathEngineStopped('cancelled'));
  }
}
