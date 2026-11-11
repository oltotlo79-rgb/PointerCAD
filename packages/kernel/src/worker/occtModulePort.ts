/** Receiver for the one private port transferred by the Worker's creator. */
export class OcctModulePort {
  private bootstrapped = false;
  private closed = false;
  private generation = 0;
  private requested = false;
  private settled = false;
  private retryable = false;
  private requestId = 0;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private port: MessagePort | undefined;
  private outcome: Promise<WebAssembly.Module | undefined> | undefined;
  private resolve: ((module: WebAssembly.Module | undefined) => void) | undefined;
  private reject: ((error: Error) => void) | undefined;

  handleBootstrap(event: MessageEvent<unknown>): void {
    const message = event.data;
    if (typeof message !== 'object' || message === null ||
        !('kind' in message) || message.kind !== 'occt-module-bootstrap') return;
    const incoming = event.ports[0];
    if (this.bootstrapped || this.closed || incoming === undefined || event.ports.length !== 1 ||
        !('generation' in message) || typeof message.generation !== 'number' ||
        !Number.isSafeInteger(message.generation) || message.generation <= 0) {
      if (incoming !== this.port) incoming?.close();
      return;
    }
    this.bootstrapped = true;
    this.generation = message.generation;
    this.port = incoming;
    this.outcome = new Promise<WebAssembly.Module | undefined>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // A close can precede the first kernel RPC. Keep the rejection observable.
    void this.outcome.catch(() => undefined);
    incoming.onmessage = (response: MessageEvent<unknown>): void => {
      const value = response.data;
      if (this.closed || typeof value !== 'object' || value === null ||
          !('generation' in value) || value.generation !== this.generation ||
          !('kind' in value)) return;
      if (value.kind === 'occt-module-close') {
        this.close();
      } else if ('requestId' in value ? value.requestId !== this.requestId : this.requestId !== 1) {
        return;
      } else if (this.settled) {
        return;
      } else if (!this.requested) {
        return;
      } else if (value.kind === 'occt-module-value') {
        if (!('module' in value) || !(value.module instanceof WebAssembly.Module)) {
          this.fail(new Error('OCCT broker の Module が不正です。'));
          return;
        }
        this.succeed(value.module);
      } else if (value.kind === 'occt-module-fallback') {
        this.succeed(undefined);
      } else if (value.kind === 'occt-module-failed') {
        this.retryable = true;
        this.fail(new Error('OCCT broker の検証に失敗しました。'));
      }
    };
    incoming.onmessageerror = (): void => {
      // A browser without Module cloning can still use the Worker's verified HTTP loader.
      this.succeed(undefined);
    };
    incoming.start();
  }

  getModule(): Promise<WebAssembly.Module | undefined> {
    if (this.closed) return Promise.reject(new Error('OCCT broker port は閉じられています。'));
    if (this.retryable) {
      this.retryable = false;
      this.requested = false;
      this.settled = false;
      this.outcome = new Promise<WebAssembly.Module | undefined>((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
      });
      void this.outcome.catch(() => undefined);
    }
    if (this.port !== undefined && !this.requested) {
      this.requested = true;
      this.requestId += 1;
      this.deadline = setTimeout(() => {
        this.retryable = true;
        this.fail(new Error('OCCT broker module request exceeded 150 seconds.'));
        try {
          this.port?.postMessage({ kind: 'occt-module-invalidate', generation: this.generation, requestId: this.requestId });
        } catch {
          this.close();
        }
      }, 150_000);
      try {
        this.port.postMessage({ kind: 'occt-module-ready', generation: this.generation, requestId: this.requestId });
      } catch {
        this.succeed(undefined);
      }
    }
    return this.outcome ?? Promise.resolve(undefined);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error('OCCT broker port は閉じられました。'));
    try { this.port?.postMessage({ kind: 'occt-module-close', generation: this.generation }); }
    catch { /* The parent has already closed its endpoint. */ }
    this.port?.close();
    if (this.port !== undefined) {
      this.port.onmessage = null;
      this.port.onmessageerror = null;
    }
    this.port = undefined;
  }

  private fail(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    if (this.deadline !== undefined) clearTimeout(this.deadline);
    this.deadline = undefined;
    this.reject?.(error);
    this.resolve = undefined;
    this.reject = undefined;
  }

  private succeed(module: WebAssembly.Module | undefined): void {
    if (this.settled) return;
    this.settled = true;
    if (this.deadline !== undefined) clearTimeout(this.deadline);
    this.deadline = undefined;
    this.resolve?.(module);
    this.resolve = undefined;
    this.reject = undefined;
  }
}
