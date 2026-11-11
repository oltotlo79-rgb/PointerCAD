import { assertVerifiedOcctResponse, type VerifiedOcctResponse } from './compiledOcctModule.js';

function cacheKey(verified: VerifiedOcctResponse): string {
  return `${verified.sha256}:${verified.byteLength}`;
}

function abortError(): Error {
  return new DOMException('OCCT compile の待機が取り消されました。', 'AbortError');
}

function waitForCaller<T>(promise: Promise<T>, signals: readonly (AbortSignal | undefined)[]): Promise<T> {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.some((signal) => signal.aborted)) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    function detach(): void {
      for (const signal of active) signal.removeEventListener('abort', onAbort);
    }
    function onAbort(): void {
      detach();
      reject(abortError());
    }
    for (const signal of active) signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => { detach(); resolve(value); },
      (error: unknown) => { detach(); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}

export class OcctCompilationCache {
  private readonly promises = new Map<string, Promise<WebAssembly.Module>>();
  private closed = false;
  private readonly lifetime = new AbortController();

  getOrCompile(
    verified: VerifiedOcctResponse,
    compile: (verified: VerifiedOcctResponse) => Promise<WebAssembly.Module>,
    signal?: AbortSignal,
  ): Promise<WebAssembly.Module> {
    assertVerifiedOcctResponse(verified);
    if (this.closed) return Promise.reject(new Error('OCCT compile cache は閉じられています。'));
    if (signal?.aborted) return Promise.reject(abortError());
    const key = cacheKey(verified);
    let promise = this.promises.get(key);
    if (promise === undefined) {
      // A WebAssembly.Module carries no readable bytes. Another Worker's
      // self-reported hash cannot prove its identity, so reuse only Modules
      // compiled within this trusted loader lifetime.
      promise = Promise.resolve().then(() => {
        if (this.closed) throw abortError();
        return compile(verified);
      });
      this.promises.set(key, promise);
      void promise.then(
        () => undefined,
        () => { if (this.promises.get(key) === promise) this.promises.delete(key); },
      );
    }
    return waitForCaller(promise, [signal, this.lifetime.signal]);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    this.promises.clear();
  }
}
