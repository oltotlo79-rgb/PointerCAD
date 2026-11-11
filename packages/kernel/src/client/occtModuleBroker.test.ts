import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { compileVerifiedOcctResponse, verifyOcctStreamingResponse } from '../occt/compiledOcctModule.js';
import { OcctModulePort } from '../worker/occtModulePort.js';
import { createKernelWorker } from './createKernelWorker.js';
import { OcctModuleBroker, type OcctBrokerObservation } from './occtModuleBroker.js';

const wasm42 = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127,
  3, 2, 1, 0, 7, 10, 1, 6, 97, 110, 115, 119, 101, 114, 0, 0,
  10, 6, 1, 4, 0, 65, 42, 11,
]);
const wasm43 = Uint8Array.from(wasm42);
wasm43[wasm43.length - 2] = 43;
const url = 'https://pointercad.example/occt/stream/native.wasm';
const hash42 = createHash('sha256').update(wasm42).digest('hex');

function response(bytes: Uint8Array): Response {
  const result = new Response(Uint8Array.from(bytes).buffer, {
    status: 200, headers: { 'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip' },
  });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

function verified42(responses: Response[]) {
  const next = response(wasm42);
  responses.push(next);
  return verifyOcctStreamingResponse(next, {
    url, sha256: hash42, byteLength: wasm42.byteLength,
  });
}

function worker(receiver: OcctModulePort): Worker {
  return {
    postMessage(message: unknown, ports: Transferable[]) {
      const transferred = ports.filter((port): port is MessagePort => port instanceof MessagePort);
      receiver.handleBootstrap(new MessageEvent('message', { data: message, ports: transferred }));
    },
  } as Worker;
}

async function answer(module: WebAssembly.Module | undefined): Promise<number> {
  if (module === undefined) throw new Error('missing verified module');
  const instance = await WebAssembly.instantiate(module);
  const exported = instance.exports.answer;
  if (typeof exported !== 'function') throw new Error('native answer is missing');
  const value: unknown = Reflect.apply(exported, undefined, []);
  if (typeof value !== 'number') throw new Error('native answer is not numeric');
  return value;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function observeRetryRequest(): Promise<void> {
  const NativeChannel = MessageChannel;
  return new Promise(resolve => {
    vi.stubGlobal('MessageChannel', class extends NativeChannel {
      constructor() {
        super();
        this.port1.addEventListener('message', (event: MessageEvent<unknown>) => {
          const value = event.data;
          if (typeof value === 'object' && value !== null && 'kind' in value &&
            value.kind === 'occt-module-ready' && 'requestId' in value && value.requestId === 2) resolve();
        });
      }
    });
  });
}

describe('finite shared OCCT fetch ownership', () => {
  it.each([true, false])('releases a stalled fetch and retries on the same lease (honours abort: %s)', async honoursAbort => {
    const responses: Response[] = [];
    let signal: AbortSignal | undefined;
    const load = vi.fn<(signal: AbortSignal) => ReturnType<typeof verified42>>()
      .mockImplementationOnce(current => {
        signal = current;
        return new Promise((_resolve, reject) => {
          if (honoursAbort) current.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      }).mockImplementation(() => verified42(responses));
    const compile = vi.fn(compileVerifiedOcctResponse);
    const broker = new OcctModuleBroker(load, compile, 0);
    const first = new OcctModulePort(), keeper = new OcctModulePort();
    const closeFirst = broker.attach(worker(first)), closeKeeper = broker.attach(worker(keeper));
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const expired = expect(first.getModule()).rejects.toThrow();
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(150_000);
      await expired;
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
      expect(compile).not.toHaveBeenCalled();
      vi.useRealTimers();
      expect(await answer(await first.getModule())).toBe(42);
      expect(await answer(await keeper.getModule())).toBe(42);
      expect(load).toHaveBeenCalledTimes(2);
      expect(compile).toHaveBeenCalledTimes(1);
    } finally { closeFirst(); closeKeeper(); first.close(); keeper.close(); vi.useRealTimers(); }
  });

  it.each(['success', 'failure'] as const)('ignores a timed-out fetch late %s after a new shared result', async outcome => {
    const responses: Response[] = [];
    let resolveOld!: (value: Awaited<ReturnType<typeof verified42>>) => void;
    let rejectOld!: (reason: Error) => void;
    const old = new Promise<Awaited<ReturnType<typeof verified42>>>((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
    const load = vi.fn<() => ReturnType<typeof verified42>>()
      .mockImplementationOnce(() => old).mockImplementation(() => verified42(responses));
    const compile = vi.fn(compileVerifiedOcctResponse);
    const broker = new OcctModuleBroker(load, compile, 0);
    const first = new OcctModulePort(), keeper = new OcctModulePort();
    const closeFirst = broker.attach(worker(first)), closeKeeper = broker.attach(worker(keeper));
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const expired = expect(first.getModule()).rejects.toThrow();
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(150_000);
      await expired;
      vi.useRealTimers();
      expect(await answer(await first.getModule())).toBe(42);
      if (outcome === 'success') resolveOld(await verified42(responses));
      else rejectOld(new Error('late obsolete fetch failure'));
      await old.catch(() => undefined);
      expect(await answer(await keeper.getModule())).toBe(42);
      expect(load).toHaveBeenCalledTimes(2);
      expect(compile).toHaveBeenCalledTimes(1);
    } finally { closeFirst(); closeKeeper(); first.close(); keeper.close(); vi.useRealTimers(); }
  });

  it('last close aborts an ignored-signal fetch, clears its deadline and permits a new owner', async () => {
    const responses: Response[] = [];
    let signal: AbortSignal | undefined;
    const load = vi.fn<(signal: AbortSignal) => ReturnType<typeof verified42>>()
      .mockImplementationOnce(current => { signal = current; return new Promise(() => undefined); })
      .mockImplementation(() => verified42(responses));
    const broker = new OcctModuleBroker(load, compileVerifiedOcctResponse, 0);
    const first = new OcctModulePort(), keeper = new OcctModulePort();
    const closeFirst = broker.attach(worker(first)), closeKeeper = broker.attach(worker(keeper));
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const closed = expect(first.getModule()).rejects.toThrow('閉じられました');
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
      closeFirst(); first.close(); await closed;
      expect(signal?.aborted).toBe(false);
      closeKeeper(); keeper.close();
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
      const next = new OcctModulePort();
      const closeNext = broker.attach(worker(next));
      try {
        expect(await answer(await next.getModule())).toBe(42);
        expect(load).toHaveBeenCalledTimes(2);
      } finally { closeNext(); next.close(); }
    } finally { closeFirst(); closeKeeper(); first.close(); keeper.close(); vi.useRealTimers(); }
  });
});

describe('parent-owned OCCT module broker', () => {
  it('a timed-out lease explicitly retries the same verified compile without an old delivery', async () => {
    const responses: Response[] = [];
    let release!: (module: WebAssembly.Module) => void;
    const deferred = new Promise<WebAssembly.Module>(resolve => { release = resolve; });
    const load = vi.fn(() => verified42(responses));
    const compile = vi.fn(() => deferred);
    const broker = new OcctModuleBroker(load, compile, 0);
    const retryReceived = observeRetryRequest();
    const receiver = new OcctModulePort();
    const close = broker.attach(worker(receiver));
    const delivered: number[] = [];
    const nativeSend: unknown = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'postMessage')?.value;
    if (typeof nativeSend !== 'function') throw new Error('missing MessagePort.postMessage');
    vi.spyOn(MessagePort.prototype, 'postMessage').mockImplementation(function (this: MessagePort, ...args: unknown[]) {
      const [message] = args;
      if (typeof message === 'object' && message !== null && 'kind' in message &&
        message.kind === 'occt-module-value' && 'requestId' in message && typeof message.requestId === 'number')
        delivered.push(message.requestId);
      Reflect.apply(nativeSend, this, args);
    });
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const first = receiver.getModule();
      const expired = expect(first).rejects.toThrow('150 seconds');
      await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(1));
      vi.advanceTimersByTime(150_000);
      await expired;
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
      const retry = receiver.getModule();
      expect(receiver.getModule()).toBe(retry);
      await retryReceived;
      release(await WebAssembly.compile(wasm42));
      expect(await answer(await retry)).toBe(42);
      expect(delivered).toEqual([2]);
      expect(load).toHaveBeenCalledTimes(1);
      expect(compile).toHaveBeenCalledTimes(1);
      close();
      receiver.close();
      await expect(receiver.getModule()).rejects.toThrow('閉じられています');
    } finally { vi.useRealTimers(); close(); receiver.close(); }
  });

  it('an expired delivery failure cannot clear or suppress the next request failure', async () => {
    let rejectOld!: (reason: Error) => void;
    // HTTP is now bounded; preserve this old-delivery race in verified compilation.
    const old = new Promise<WebAssembly.Module>((_resolve, reject) => { rejectOld = reject; });
    const responses: Response[] = [];
    const load = vi.fn(() => verified42(responses));
    const compile = vi.fn(compileVerifiedOcctResponse).mockImplementationOnce(() => old);
    const broker = new OcctModuleBroker(load, compile, 0);
    const retryReceived = observeRetryRequest();
    const receiver = new OcctModulePort();
    const close = broker.attach(worker(receiver));
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const expired = expect(receiver.getModule()).rejects.toThrow('150 seconds');
      await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(1));
      vi.advanceTimersByTime(150_000);
      await expired;
      vi.useRealTimers();
      const retry = receiver.getModule();
      const failed = expect(retry).rejects.toThrow('検証に失敗');
      await retryReceived;
      rejectOld(new Error('late shared failure'));
      await failed;
      expect(await answer(await receiver.getModule())).toBe(42);
      expect(load).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); close(); receiver.close(); }
  });
  it('explicit retry with retained live leases revalidates transient and corrupt loads, never falling back', async () => {
    const responses: Response[] = [];
    let attempts = 0;
    const load = vi.fn(() => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error('temporary network failure'));
      if (attempts === 2) return verifyOcctStreamingResponse(response(wasm43), {
        url, sha256: hash42, byteLength: wasm42.byteLength,
      });
      return verified42(responses);
    });
    const compile = vi.fn(compileVerifiedOcctResponse);
    const broker = new OcctModuleBroker(load, compile, 0);
    const first = new OcctModulePort(), keeper = new OcctModulePort();
    const closeFirst = broker.attach(worker(first)), closeKeeper = broker.attach(worker(keeper));
    try {
      await expect(first.getModule()).rejects.toThrow('検証に失敗');
      expect(load).toHaveBeenCalledTimes(1);
      expect(compile).not.toHaveBeenCalled();
      await expect(first.getModule()).rejects.toThrow('検証に失敗');
      expect(load).toHaveBeenCalledTimes(2);
      expect(compile).not.toHaveBeenCalled();
      const retry = first.getModule();
      expect(first.getModule()).toBe(retry);
      expect(await answer(await retry)).toBe(42);
      expect(await answer(await keeper.getModule())).toBe(42);
      expect(load).toHaveBeenCalledTimes(3);
      expect(compile).toHaveBeenCalledTimes(1);
    } finally { closeFirst(); closeKeeper(); first.close(); keeper.close(); }
  });

  it('an aborted obsolete load failing late cannot erase a newer successful shared module', async () => {
    let rejectOld!: (reason: unknown) => void;
    const old = new Promise<undefined>((_resolve, reject) => { rejectOld = reject; });
    const responses: Response[] = [];
    const load = vi.fn<() => Promise<Awaited<ReturnType<typeof verified42>> | undefined>>()
      .mockImplementationOnce(() => old).mockImplementation(() => verified42(responses));
    const broker = new OcctModuleBroker(load, compileVerifiedOcctResponse, 0);
    const first = new OcctModulePort();
    const closeFirst = broker.attach(worker(first));
    const rejected = expect(first.getModule()).rejects.toThrow('閉じられました');
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    closeFirst(); first.close(); await rejected;
    const second = new OcctModulePort(), third = new OcctModulePort();
    const closeSecond = broker.attach(worker(second)), closeThird = broker.attach(worker(third));
    try {
      expect(await answer(await second.getModule())).toBe(42);
      rejectOld(new Error('late obsolete network failure'));
      await old.catch(() => undefined);
      expect(await answer(await third.getModule())).toBe(42);
      expect(load).toHaveBeenCalledTimes(2);
    } finally { closeSecond(); closeThird(); second.close(); third.close(); }
  });
  it('closes the private port before the synchronous Worker terminate', async () => {
    const receiver = new OcctModulePort();
    const terminated = vi.fn();
    class FakeWorker {
      postMessage(message: unknown, ports: Transferable[]): void {
        receiver.handleBootstrap(new MessageEvent('message', {
          data: message,
          ports: ports.filter((port): port is MessagePort => port instanceof MessagePort),
        }));
      }
      terminate(): void { terminated(); }
    }
    vi.stubGlobal('Worker', FakeWorker);
    const kernelWorker = createKernelWorker();
    const pending = receiver.getModule();
    const rejection = expect(pending).rejects.toThrow('閉じられました');
    kernelWorker.terminate();
    await rejection;
    expect(terminated).toHaveBeenCalledTimes(1);
  });

  it('compiles one verified response for two Workers and keeps instances separate', async () => {
    const verified = await verifyOcctStreamingResponse(response(wasm42), {
      url, sha256: hash42, byteLength: wasm42.byteLength,
    });
    const load = vi.fn(() => Promise.resolve(verified));
    const compile = vi.fn(compileVerifiedOcctResponse);
    const broker = new OcctModuleBroker(load, compile, 0);
    const first = new OcctModulePort();
    const second = new OcctModulePort();
    const closeFirst = broker.attach(worker(first));
    const closeSecond = broker.attach(worker(second));
    const [one, two] = await Promise.all([first.getModule(), second.getModule()]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(one).toBeInstanceOf(WebAssembly.Module);
    expect(two).toBeInstanceOf(WebAssembly.Module);
    if (one === undefined || two === undefined) throw new Error('missing verified module');
    const firstInstance = await WebAssembly.instantiate(one);
    const secondInstance = await WebAssembly.instantiate(two);
    expect(firstInstance).not.toBe(secondInstance);
    expect(await answer(one)).toBe(42);
    expect(await answer(two)).toBe(42);
    closeFirst();
    closeSecond();
    first.close();
    second.close();
  });

  it('does not cancel the other Worker and releases the parent promise after the last close', async () => {
    const responses: Response[] = [];
    let release: (() => void) | undefined;
    const load = vi.fn(() => new Promise<Awaited<ReturnType<typeof verified42>>>((resolve, reject) => {
      release = () => { void verified42(responses).then(resolve, reject); };
    }));
    const broker = new OcctModuleBroker(load, compileVerifiedOcctResponse, 10);
    const first = new OcctModulePort();
    const second = new OcctModulePort();
    const closeFirst = broker.attach(worker(first));
    const closeSecond = broker.attach(worker(second));
    const cancelled = first.getModule();
    const cancelledCheck = expect(cancelled).rejects.toThrow('閉じられました');
    const successful = second.getModule();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    closeFirst();
    release?.();
    await cancelledCheck;
    expect(await answer(await successful)).toBe(42);
    expect(responses.length).toBe(1);
    expect(responses[0]?.bodyUsed).toBe(true);
    closeSecond();
    const third = new OcctModulePort();
    const closeThird = broker.attach(worker(third));
    expect(await answer(await third.getModule())).toBe(42);
    expect(load).toHaveBeenCalledTimes(1);
    closeThird();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const fourth = new OcctModulePort();
    const closeFourth = broker.attach(worker(fourth));
    const again = fourth.getModule();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    release?.();
    expect(await answer(await again)).toBe(42);
    expect(responses.length).toBe(2);
    expect(responses[1] !== responses[0]).toBe(true);
    expect(responses[1]?.bodyUsed).toBe(true);
    closeFourth();
    first.close();
    second.close();
    third.close();
    fourth.close();
  });

  it('keeps a live lease and a 30-second restart window, then evicts the parent Module', async () => {
    const responses: Response[] = [];
    const load = vi.fn(() => verified42(responses));
    const broker = new OcctModuleBroker(load);
    const first = new OcctModulePort();
    const second = new OcctModulePort();
    const closeFirst = broker.attach(worker(first));
    const closeSecond = broker.attach(worker(second));
    expect(await answer(await first.getModule())).toBe(42);
    expect(await answer(await second.getModule())).toBe(42);
    expect(load).toHaveBeenCalledTimes(1);
    expect(responses.length).toBe(1);
    expect(responses[0]?.bodyUsed).toBe(true);

    vi.useFakeTimers();
    closeFirst();
    vi.advanceTimersByTime(60_000);
    expect(load).toHaveBeenCalledTimes(1);
    closeSecond();
    vi.advanceTimersByTime(29_999);
    const restarted = new OcctModulePort();
    const closeRestarted = broker.attach(worker(restarted));
    vi.useRealTimers();
    expect(await answer(await restarted.getModule())).toBe(42);
    expect(load).toHaveBeenCalledTimes(1);
    expect(responses.length).toBe(1);

    vi.useFakeTimers();
    closeRestarted();
    vi.advanceTimersByTime(30_000);
    vi.useRealTimers();
    const fresh = new OcctModulePort();
    const closeFresh = broker.attach(worker(fresh));
    expect(await answer(await fresh.getModule())).toBe(42);
    expect(load).toHaveBeenCalledTimes(2);
    expect(responses.length).toBe(2);
    expect(responses[1] !== responses[0]).toBe(true);
    expect(responses[1]?.bodyUsed).toBe(true);
    vi.useFakeTimers();
    closeFresh();
    vi.advanceTimersByTime(30_000);
    vi.useRealTimers();
    first.close();
    second.close();
    restarted.close();
    fresh.close();
  });

  it('aborts an unfinished parent load only after its last live lease closes', async () => {
    const aborted = vi.fn();
    const load = vi.fn((signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted();
        reject(new DOMException('closed', 'AbortError'));
      }, { once: true });
    }));
    const broker = new OcctModuleBroker(load);
    const first = new OcctModulePort();
    const second = new OcctModulePort();
    const closeFirst = broker.attach(worker(first));
    const closeSecond = broker.attach(worker(second));
    const firstRejection = expect(first.getModule()).rejects.toThrow('閉じられました');
    const secondRejection = expect(second.getModule()).rejects.toThrow('閉じられました');
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    closeFirst();
    first.close();
    await firstRejection;
    expect(aborted).not.toHaveBeenCalled();
    closeSecond();
    second.close();
    await secondRejection;
    expect(aborted).toHaveBeenCalledTimes(1);
  });

  it('fails closed when different native bytes claim the verified hash', async () => {
    const broker = new OcctModuleBroker(() => verifyOcctStreamingResponse(response(wasm43), {
      url, sha256: hash42, byteLength: wasm42.byteLength,
    }));
    const receiver = new OcctModulePort();
    const close = broker.attach(worker(receiver));
    await expect(receiver.getModule()).rejects.toThrow('検証に失敗');
    close();
    receiver.close();
  });

  it('uses the verified HTTP fallback when Module cloning throws', async () => {
    const verified = await verifyOcctStreamingResponse(response(wasm42), {
      url, sha256: hash42, byteLength: wasm42.byteLength,
    });
    const send: unknown = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'postMessage')?.value;
    if (typeof send !== 'function') throw new Error('missing MessagePort.postMessage');
    vi.spyOn(MessagePort.prototype, 'postMessage').mockImplementation(function (this: MessagePort, ...args: unknown[]) {
      const [message] = args;
      if (typeof message === 'object' && message !== null &&
          'kind' in message && message.kind === 'occt-module-value') throw new DOMException('clone', 'DataCloneError');
      Reflect.apply(send, this, args);
    });
    const broker = new OcctModuleBroker(() => Promise.resolve(verified), compileVerifiedOcctResponse, 0);
    const receiver = new OcctModulePort();
    const close = broker.attach(worker(receiver));
    await expect(receiver.getModule()).resolves.toBeUndefined();
    close();
    receiver.close();
  });
});


describe('parent compile observations', () => {
  it('one verified compile is bracketed before two distinct real MessagePort deliveries', async () => {
    const responses: Response[] = [], events: OcctBrokerObservation[] = [];
    const broker = new OcctModuleBroker(() => verified42(responses), compileVerifiedOcctResponse, 0,
      event => { events.push(event); });
    const first = new OcctModulePort(), second = new OcctModulePort();
    const closeFirst = broker.attach(worker(first)), closeSecond = broker.attach(worker(second));
    try {
      expect(await answer(await first.getModule())).toBe(42);
      expect(await answer(await second.getModule())).toBe(42);
      expect(events.filter(event => event.phase === 'compile-start')).toHaveLength(1);
      expect(events.filter(event => event.phase === 'compile-end')).toHaveLength(1);
      expect(events.filter(event => event.phase === 'module-delivered').map(event => event.generation)).toEqual([1, 2]);
      const verified = events.findIndex(event => event.phase === 'verified');
      const start = events.findIndex(event => event.phase === 'compile-start');
      const end = events.findIndex(event => event.phase === 'compile-end');
      const delivery = events.findIndex(event => event.phase === 'module-delivered');
      expect(verified).toBeLessThan(start); expect(start).toBeLessThan(end); expect(end).toBeLessThan(delivery);
      expect(events[start]).toMatchObject({ sha256: hash42, byteLength: wasm42.byteLength });
      expect(events[end]?.elapsedMs).toBeGreaterThanOrEqual(events[start]?.elapsedMs ?? Infinity);
      expect(events.filter(event => event.phase === 'shared-hit')).toHaveLength(1);
    } finally { closeFirst(); closeSecond(); first.close(); second.close(); }
  });

  it('a throwing diagnostic observer cannot cancel a lease or discard a verified module', async () => {
    const responses: Response[] = [], compile = vi.fn(compileVerifiedOcctResponse);
    const broker = new OcctModuleBroker(() => verified42(responses), compile, 0,
      () => { throw new Error('diagnostic consumer failed'); });
    const first = new OcctModulePort(), second = new OcctModulePort();
    const closeFirst = broker.attach(worker(first)), closeSecond = broker.attach(worker(second));
    try {
      expect(await answer(await first.getModule())).toBe(42);
      closeFirst(); first.close();
      expect(await answer(await second.getModule())).toBe(42);
      expect(compile).toHaveBeenCalledTimes(1);
    } finally { closeFirst(); closeSecond(); first.close(); second.close(); }
  });
});
