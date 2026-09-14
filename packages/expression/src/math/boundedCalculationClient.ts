/** Bounded disposable Worker queue shared by scalar input and function geometry. */
import type { MathRequestIdentity } from './mathWorkRequest.js';
export interface CalculationRequest { readonly identity: MathRequestIdentity }

/** Platform-independent transport. DOM Worker construction belongs to the UI adapter. */
export interface CalculationWorkerPort {
  /** Optional host allowance for the first request, including module/backend loading.
   * Read after posting so a lazy shared transport can expose the actual Worker state.
   * Warm requests must return zero; cancellation and the absolute 30s ceiling remain.
   */
  readonly startupTimeoutMs?: number;
  onmessage:((event:{readonly data:unknown})=>void)|null;
  onerror:((event:{readonly preventDefault:()=>void})=>void)|null;
  onmessageerror:(()=>void)|null;
  postMessage(value:unknown):void;
  terminate():void;
}
export type CalculationCompletion<Result> =
  | { readonly status: 'result'; readonly identity: MathRequestIdentity; readonly result: Result }
  | { readonly status: 'cancelled' | 'deadline' | 'worker-error' | 'queue-full' | 'disposed'; readonly identity: MathRequestIdentity };

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
}

export class BoundedCalculationClient<Request extends CalculationRequest, Result> {
  private readonly options: CalculationClientOptions<Request, Result>;
  private readonly pending: PendingWork<Request, Result>[] = [];
  private worker: CalculationWorkerPort | null = null;
  private active: PendingWork<Request, Result> | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private serial = 0;
  private disposed = false;

  constructor(options: CalculationClientOptions<Request, Result>) { this.options = options; }

  evaluate(request: Request, timeoutMs: number, signal?: AbortSignal): Promise<CalculationCompletion<Result>> {
    // Own a validated immutable snapshot even while another request occupies the Worker.
    // A caller editing its arrays/identity must not relabel a delayed result as current.
    request = this.options.decodeRequest(request);
    if (this.disposed) return Promise.resolve({ status: 'disposed', identity: request.identity });
    if (signal?.aborted) return Promise.resolve({ status: 'cancelled', identity: request.identity });
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new RangeError('Invalid math deadline');
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
    this.active = null;
    if (this.timeout !== null) { clearTimeout(this.timeout); this.timeout = null; }
    if (replaceWorker) this.stopWorker();
    work.detachAbort();
    work.finish(result);
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
    try {
      if (this.worker === null) {
        const worker = this.options.createWorker();
        this.worker = worker;
        worker.onmessage = event => {
          if (this.worker !== worker) return;
          const active = this.active;
          if (!active) return;
          let decoded: ReturnType<CalculationClientOptions<Request, Result>['decodeReply']>;
          try { decoded = this.options.decodeReply(event.data, active.request); }
          catch { decoded = null; }
          if (decoded === null || decoded.serial !== active.serial) {
            this.complete({ status: 'worker-error', identity: active.request.identity }, true);
          } else this.complete({ status: 'result', identity: active.request.identity, result: decoded.result }, false);
        };
        const failure = () => {
          if (this.worker !== worker || !this.active) return;
          this.complete({ status: 'worker-error', identity: this.active.request.identity }, true);
        };
        worker.onerror = event => { event.preventDefault(); failure(); };
        worker.onmessageerror = failure;
      }
      const expire = () => {
        if (this.active?.serial === work.serial) this.complete({ status: 'deadline', identity: work.request.identity }, true);
      };
      this.timeout = setTimeout(expire, work.timeoutMs);
      const postedAt = performance.now();
      this.worker.postMessage(this.options.createEnvelope(work.serial,work.request));
      // A synchronous transport can already have completed/cancelled this work.
      if (this.active !== work) return;
      const startupTimeoutMs = this.worker.startupTimeoutMs ?? 0;
      if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 0 || startupTimeoutMs > 30_000) {
        throw new RangeError('Invalid math startup deadline');
      }
      if (startupTimeoutMs > work.timeoutMs) {
        if (this.timeout !== null) clearTimeout(this.timeout);
        this.timeout = setTimeout(expire, Math.max(0, Math.ceil(startupTimeoutMs - (performance.now() - postedAt))));
      }
    } catch {
      this.complete({ status: 'worker-error', identity: work.request.identity }, true);
    }
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
