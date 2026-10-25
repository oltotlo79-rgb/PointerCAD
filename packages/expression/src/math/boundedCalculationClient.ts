/** Bounded disposable Worker queue shared by scalar input and function geometry. */
import type { MathRequestIdentity } from './mathWorkRequest.js';
import { readCalculationPaceMessage } from './mathInputContract.js';
export interface CalculationRequest { readonly identity: MathRequestIdentity }
/** The absolute limit of one request's Worker deadline, also after the machine's pace stretches it. */
export const CALCULATION_DEADLINE_CEILING_MS = 30_000;
let observedClient = 0;

/** Platform-independent transport. DOM Worker construction belongs to the UI adapter. */
export interface CalculationWorkerPort {
  /** Optional host allowance for the first request, including module/backend loading.
   * Read after posting so a lazy shared transport can expose the actual Worker state.
   * Warm requests must return zero; cancellation and the absolute 30s ceiling remain.
   */
  readonly startupTimeoutMs?: number;
  /** A transport may require replacement after the validated terminal reply. */
  readonly retireAfterReply?: boolean;
  onmessage:((event:{readonly data:unknown})=>void)|null;
  onerror:((event:{readonly preventDefault:()=>void})=>void)|null;
  onmessageerror:(()=>void)|null;
  postMessage(value:unknown):void;
  terminate():void;
}
export type CalculationCompletion<Result> =
  | { readonly status: 'result'; readonly identity: MathRequestIdentity; readonly result: Result }
  | { readonly status: 'cancelled' | 'deadline' | 'worker-error' | 'queue-full' | 'disposed'; readonly identity: MathRequestIdentity };

/** A reply whose envelope was checked; `steps` decodes and verifies the rest and returns the whole decoded reply. */
export interface CalculationReplyStart<Result> {
  readonly serial: number;
  readonly steps: Iterator<void, { readonly serial: number; readonly result: Result }, void>;
}
/**
 * Longest synchronous slice of a resumable reply decode before the client yields to the event loop. Well inside the
 * 100 ms bound for one blocked task (docs/requirements.md §5.2) and close to one 60 fps frame.
 */
export const CALCULATION_REPLY_SLICE_MS = 8;

interface PendingWork<Request extends CalculationRequest, Result> {
  readonly serial: number;
  readonly request: Request;
  readonly timeoutMs: number;
  readonly finish: (result: CalculationCompletion<Result>) => void;
  readonly detachAbort: () => void;
}
export interface CalculationClientOptions<Request extends CalculationRequest, Result> {
  readonly decodeRequest: (value: unknown) => Request;
  readonly createEnvelope: (serial: number, request: Request) => unknown;
  readonly createWorker: () => CalculationWorkerPort;
  /** Validate the untrusted Worker envelope and value; a malformed reply never becomes a CAD coordinate. */
  readonly decodeReply: (value: unknown, request: Request) => { readonly serial: number; readonly result: Result } | null;
  /**
   * Optional resumable form of decodeReply for replies whose validation is long. It checks only the envelope and
   * returns its serial; the client compares that with the active request before any step runs, so a reply for another
   * request is rejected without reading its result. The steps then run in slices of at most CALCULATION_REPLY_SLICE_MS,
   * returning to the event loop between slices. Cancellation, disposal, any further Worker message or an exception ends
   * them, and only a finished decode is delivered. When present it replaces decodeReply for terminal replies.
   */
  readonly beginReply?: (value: unknown, request: Request) => CalculationReplyStart<Result>;
  /** Optional host-owned preparation protocol. Each client must validate eligible request kinds. */
  readonly progress?: {
    readonly maximumDurationMs: number;
    readonly createReceiver: (request: Request, serial: number, startedAt: number) => (value: unknown) => number | null;
  };
}

export class BoundedCalculationClient<Request extends CalculationRequest, Result> {
  private readonly options: CalculationClientOptions<Request, Result>;
  private readonly pending: PendingWork<Request, Result>[] = [];
  private worker: CalculationWorkerPort | null = null;
  private active: PendingWork<Request, Result> | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private serial = 0;
  private disposed = false;
  private startedAt = 0;
  private deadline = 0;
  private receivedProgress = false;
  private receivedPace = false;
  private receiveProgress: ((value: unknown) => number | null) | null = null;
  private observationId: number | null = null;
  /** The active request's terminal reply is being verified in slices (identity token of that verification). */
  private verifying: object | null = null;
  private verifyTimer: ReturnType<typeof setTimeout> | null = null;

  /** Passive E2E evidence; diagnostics must never interrupt cancellation or queue progress. */
  private observe(event: string, work: PendingWork<Request, Result>, status?: string, replaceWorker?: boolean): void {
    try {
      if (Reflect.get(globalThis, Symbol.for('pcad.w22.completion-observer')) !== true) return;
      this.observationId ??= ++observedClient;
      console.debug('[pcad:math-client]', JSON.stringify({ event, client: this.observationId,
        serial: work.serial, identity: work.request.identity, status, replaceWorker,
        timeOrigin: performance.timeOrigin, at: performance.now() }));
    } catch { /* Observation failure cannot alter the product outcome. */ }
  }

  constructor(options: CalculationClientOptions<Request, Result>) {
    const maximum = options.progress?.maximumDurationMs;
    if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 300_000)) {
      throw new RangeError('Invalid preparation deadline');
    }
    this.options = options;
  }

  evaluate(request: Request, timeoutMs: number, signal?: AbortSignal): Promise<CalculationCompletion<Result>> {
    // Own a validated immutable snapshot even while another request occupies the Worker.
    // A caller editing its arrays/identity must not relabel a delayed result as current.
    request = this.options.decodeRequest(request);
    if (this.disposed) return Promise.resolve({ status: 'disposed', identity: request.identity });
    if (signal?.aborted) return Promise.resolve({ status: 'cancelled', identity: request.identity });
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CALCULATION_DEADLINE_CEILING_MS) throw new RangeError('Invalid math deadline');
    if (this.pending.length >= 32) return Promise.resolve({ status: 'queue-full', identity: request.identity });
    if (this.serial >= Number.MAX_SAFE_INTEGER) throw new RangeError('Math request identifiers exhausted');
    this.serial += 1;
    const serial = this.serial;
    return new Promise(resolve => {
      const abort = () => this.cancel(serial);
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.push({ serial, request, timeoutMs, finish: resolve,
        detachAbort: () => signal?.removeEventListener('abort', abort) });
      this.pump();
    });
  }

  private stopWorker(): void {
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    }
  }

  private complete(result: CalculationCompletion<Result>, replaceWorker: boolean): void {
    const work = this.active;
    if (!work) return;
    this.observe('complete', work, result.status, replaceWorker);
    this.active = null;
    this.receiveProgress = null;
    this.receivedProgress = false;
    this.receivedPace = false;
    if (this.timeout !== null) { clearTimeout(this.timeout); this.timeout = null; }
    // Any unfinished verification is abandoned: its steps are never resumed and nothing partial is delivered.
    this.verifying = null;
    if (this.verifyTimer !== null) { clearTimeout(this.verifyTimer); this.verifyTimer = null; }
    if (replaceWorker) this.stopWorker();
    work.detachAbort();
    work.finish(result);
    this.observe('finished', work, result.status, replaceWorker);
    this.pump();
  }

  private cancel(serial: number): void {
    const active = this.active;
    if (active?.serial === serial) {
      this.complete({ status: 'cancelled', identity: active.request.identity }, true);
      return;
    }
    const index = this.pending.findIndex(work => work.serial === serial);
    if (index < 0) return;
    const work = this.pending.splice(index, 1)[0];
    if (work) { work.detachAbort(); work.finish({ status: 'cancelled', identity: work.request.identity }); }
  }

  private pump(): void {
    if (this.disposed || this.active !== null) return;
    const work = this.pending.shift();
    if (!work) return;
    this.active = work;
    this.startedAt = performance.now();
    this.deadline = this.startedAt + work.timeoutMs;
    this.receivedProgress = false;
    this.receivedPace = false;
    try {
      this.receiveProgress = this.options.progress?.createReceiver(work.request, work.serial, this.startedAt) ?? null;
      if (this.worker === null) {
        const worker = this.options.createWorker();
        this.worker = worker;
        worker.onmessage = event => {
          if (this.worker !== worker) return;
          const active = this.active;
          if (!active) return;
          // The terminal reply already arrived: a second message from the same Worker is a protocol race.
          if (this.verifying !== null) {
            this.complete({ status: 'worker-error', identity: active.request.identity }, true); return;
          }
          if (performance.now() >= this.deadline) {
            this.complete({ status: 'deadline', identity: active.request.identity }, true); return;
          }
          try {
            const pace = readCalculationPaceMessage(event.data);
            if (pace !== null) { this.allowPace(pace, active); return; }
            const end = this.receiveProgress?.(event.data) ?? null;
            // A progress listener may have cancelled this request or disposed its owner.
            if (this.active !== active) return;
            if (end !== null) {
              const maximum = this.options.progress?.maximumDurationMs ?? 0;
              if (!Number.isFinite(end) || end > this.startedAt + maximum) throw new RangeError('Invalid progress deadline');
              this.receivedProgress = true;
              this.armDeadline(end, active);
              return;
            }
          } catch {
            if (this.active === active) this.complete({ status: 'worker-error', identity: active.request.identity }, true);
            return;
          }
          const beginReply = this.options.beginReply;
          if (beginReply !== undefined) {
            let begun: CalculationReplyStart<Result> | null;
            try { begun = beginReply(event.data, active.request); }
            catch { begun = null; }
            // Another request's (stale) reply is refused here, before any of its result is decoded.
            if (begun === null || begun.serial !== active.serial) {
              this.complete({ status: 'worker-error', identity: active.request.identity }, true);
            } else this.verify(active, begun.steps, worker.retireAfterReply === true);
            return;
          }
          let decoded: ReturnType<CalculationClientOptions<Request, Result>['decodeReply']>;
          try { decoded = this.options.decodeReply(event.data, active.request); }
          catch { decoded = null; }
          if (decoded === null || decoded.serial !== active.serial) {
            this.complete({ status: 'worker-error', identity: active.request.identity }, true);
          } else this.complete({ status: 'result', identity: active.request.identity, result: decoded.result }, worker.retireAfterReply === true);
        };
        const failure = () => {
          if (this.worker !== worker || !this.active) return;
          this.complete({ status: 'worker-error', identity: this.active.request.identity }, true);
        };
        worker.onerror = event => { event.preventDefault(); failure(); };
        worker.onmessageerror = failure;
      }
      this.armDeadline(this.deadline, work);
      this.observe('dispatch', work);
      this.worker.postMessage(this.options.createEnvelope(work.serial,work.request));
      this.observe('dispatched', work);
      // A synchronous transport can already have completed/cancelled this work.
      if (this.active !== work) return;
      // A shared transport finishes its current dispatch before selecting the next
      // physical Worker. Read its cold-start allowance after that selection, without
      // moving the request's original start time or overwriting a preparation phase.
      queueMicrotask(() => this.allowStartup(work));
    } catch {
      if (this.active === work) this.complete({ status: 'worker-error', identity: work.request.identity }, true);
    }
  }

  /**
   * Run a resumable reply decode in slices. Like the former synchronous decode, an arrived reply's own bounded
   * validation is not cut by the calculation deadline; cancellation, disposal, a further Worker message and exceptions
   * still end it, and the request completes only with the finished, whole result.
   */
  private verify(work: PendingWork<Request, Result>, steps: CalculationReplyStart<Result>['steps'], retireAfterReply: boolean): void {
    const token = {};
    this.verifying = token;
    if (this.timeout !== null) { clearTimeout(this.timeout); this.timeout = null; }
    const current = () => this.active === work && this.verifying === token;
    const slice = () => {
      this.verifyTimer = null;
      if (!current()) return;
      const start = performance.now();
      try {
        for (;;) {
          const step = steps.next();
          if (step.done === true) {
            this.complete({ status: 'result', identity: work.request.identity, result: step.value.result }, retireAfterReply);
            return;
          }
          if (performance.now() - start >= CALCULATION_REPLY_SLICE_MS) { this.verifyTimer = setTimeout(slice, 0); return; }
        }
      } catch {
        if (current()) this.complete({ status: 'worker-error', identity: work.request.identity }, true);
      }
    };
    slice();
  }

  private allowStartup(work: PendingWork<Request, Result>): void {
    // A reply under verification has arrived; no startup allowance re-arms its finished calculation deadline.
    if (this.active !== work || this.worker === null || this.verifying !== null) return;
    try {
      const startupTimeoutMs = this.worker.startupTimeoutMs ?? 0;
      if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 0 || startupTimeoutMs > 30_000) {
        throw new RangeError('Invalid math startup deadline');
      }
      if (!this.receivedProgress && startupTimeoutMs > work.timeoutMs) {
        this.armDeadline(this.startedAt + startupTimeoutMs, work);
      }
    } catch {
      if (this.active === work) this.complete({ status: 'worker-error', identity: work.request.identity }, true);
    }
  }

  /** The Worker measured this machine's pace before calculating: the caller's deadline stretches by the same
   * factor as the Worker's own limits, never beyond the absolute ceiling, and never shortens a longer allowance
   * (first request, preparation phases). One pace per request. */
  private allowPace(pace: number, work: PendingWork<Request, Result>): void {
    if (this.receivedPace) throw new Error('Repeated calculation pace');
    this.receivedPace = true;
    const end = this.startedAt + Math.min(CALCULATION_DEADLINE_CEILING_MS, Math.ceil(work.timeoutMs * pace));
    if (end > this.deadline) this.armDeadline(end, work);
  }

  private armDeadline(end: number, work: PendingWork<Request, Result>): void {
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.deadline = end;
    this.timeout = setTimeout(() => {
      if (this.active === work) this.complete({ status: 'deadline', identity: work.request.identity }, true);
    }, Math.max(0, Math.ceil(end - performance.now())));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const active = this.active;
    if (active) this.complete({ status: 'disposed', identity: active.request.identity }, true);
    else this.stopWorker();
    for (const work of this.pending.splice(0)) {
      work.detachAbort(); work.finish({ status: 'disposed', identity: work.request.identity });
    }
  }
}
