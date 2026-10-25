import { afterEach, describe, expect, it, vi } from 'vitest';

import { OcctModulePort } from './occtModulePort.js';

// Two distinct native modules; an untrusted sender gives the second the first one's hash.
const wasm42 = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127,
  3, 2, 1, 0, 7, 10, 1, 6, 97, 110, 115, 119, 101, 114, 0, 0,
  10, 6, 1, 4, 0, 65, 42, 11,
]);
const wasm43 = Uint8Array.from(wasm42);
wasm43[wasm43.length - 2] = 43;

function bootstrap(receiver: OcctModulePort, port: MessagePort, generation: number): void {
  receiver.handleBootstrap(new MessageEvent('message', {
    data: { kind: 'occt-module-bootstrap', generation }, ports: [port],
  }));
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

afterEach(() => vi.restoreAllMocks());

describe('OCCT private module port', () => {
  it('expires only one request, keeps one listener pair, and retries only on an explicit call', async () => {
    const receiver = new OcctModulePort(), channel = new MessageChannel();
    bootstrap(receiver, channel.port2, 31);
    const listener = channel.port2.onmessage;
    const requests: unknown[] = [];
    channel.port1.onmessage = event => { requests.push(event.data); };
    channel.port1.start();
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const first = receiver.getModule();
      const expired = expect(first).rejects.toThrow('150 seconds');
      expect(receiver.getModule()).toBe(first);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(150_000);
      await expired;
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      expect(requests[1]).toEqual({ kind: 'occt-module-invalidate', generation: 31, requestId: 1 });
      expect(channel.port2.onmessage).toBe(listener);
      const retry = receiver.getModule();
      expect(receiver.getModule()).toBe(retry);
      await vi.waitFor(() => expect(requests).toHaveLength(3));
      expect(requests[2]).toEqual({ kind: 'occt-module-ready', generation: 31, requestId: 2 });
      channel.port1.postMessage({ kind: 'occt-module-value', generation: 31, requestId: 1,
        module: await WebAssembly.compile(wasm43) });
      channel.port1.postMessage({ kind: 'occt-module-failed', generation: 31, requestId: 1 });
      channel.port1.postMessage({ kind: 'occt-module-value', generation: 31, requestId: 2,
        module: await WebAssembly.compile(wasm42) });
      expect(await answer(await retry)).toBe(42);
      receiver.close();
      expect(channel.port2.onmessage).toBeNull();
      expect(channel.port2.onmessageerror).toBeNull();
      await expect(receiver.getModule()).rejects.toThrow('閉じられています');
    } finally { vi.useRealTimers(); receiver.close(); channel.port1.close(); }
  });
  it('explicit retry rejects obsolete attempt messages and close still ends the lease', async () => {
    const receiver = new OcctModulePort(), channel = new MessageChannel();
    bootstrap(receiver, channel.port2, 30);
    const requests: unknown[] = [];
    channel.port1.onmessage = event => { requests.push(event.data); };
    channel.port1.start();
    const first = receiver.getModule();
    channel.port1.postMessage({ kind: 'occt-module-failed', generation: 30, requestId: 1 });
    await expect(first).rejects.toThrow('検証に失敗');
    const retry = receiver.getModule();
    expect(receiver.getModule()).toBe(retry);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toMatchObject({ kind: 'occt-module-ready', generation: 30, requestId: 2 });
    const stale = await WebAssembly.compile(wasm43);
    channel.port1.postMessage({ kind: 'occt-module-value', generation: 30, requestId: 1, module: stale });
    channel.port1.postMessage({ kind: 'occt-module-failed', generation: 30, requestId: 1 });
    channel.port1.postMessage({ kind: 'occt-module-value', generation: 30, requestId: 2,
      module: await WebAssembly.compile(wasm42) });
    expect(await answer(await retry)).toBe(42);
    receiver.close(); channel.port1.close();
    await expect(receiver.getModule()).rejects.toThrow('閉じられています');
  });
  it('accepts only the first transferred port and its current generation', async () => {
    const receiver = new OcctModulePort();
    const parent = new MessageChannel();
    const intruder = new MessageChannel();
    const forged = await WebAssembly.compile(wasm43);
    const verified = await WebAssembly.compile(wasm42);
    bootstrap(receiver, parent.port2, 7);
    bootstrap(receiver, intruder.port2, 8);
    const pending = receiver.getModule();
    intruder.port1.postMessage({ kind: 'occt-module-value', generation: 8, module: forged,
      sha256: 'same-as-verified' });
    parent.port1.postMessage({ kind: 'occt-module-value', generation: 6, module: forged,
      sha256: 'same-as-verified' });
    parent.port1.postMessage({ kind: 'occt-module-value', generation: 7, module: verified });
    expect(await answer(await pending)).toBe(42);
    parent.port1.postMessage({ kind: 'occt-module-value', generation: 7, module: forged });
    expect(await answer(await receiver.getModule())).toBe(42);
    parent.port1.postMessage({ kind: 'occt-module-close', generation: 7 });
    await vi.waitFor(() => expect(receiver.getModule()).rejects.toThrow('閉じられています'));
    receiver.close();
    parent.port1.close();
    intruder.port1.close();
  });

  it('rejects late delivery after close and accepts a fresh restart generation', async () => {
    const old = new OcctModulePort();
    const oldChannel = new MessageChannel();
    bootstrap(old, oldChannel.port2, 10);
    const pending = old.getModule();
    old.close();
    await expect(pending).rejects.toThrow('閉じられました');
    oldChannel.port1.postMessage({ kind: 'occt-module-value', generation: 10,
      module: await WebAssembly.compile(wasm43) });
    await expect(old.getModule()).rejects.toThrow('閉じられています');

    const fresh = new OcctModulePort();
    const freshChannel = new MessageChannel();
    bootstrap(fresh, freshChannel.port2, 11);
    const next = fresh.getModule();
    freshChannel.port1.postMessage({ kind: 'occt-module-value', generation: 10,
      module: await WebAssembly.compile(wasm43) });
    freshChannel.port1.postMessage({ kind: 'occt-module-value', generation: 11,
      module: await WebAssembly.compile(wasm42) });
    expect(await answer(await next)).toBe(42);
    fresh.close();
    oldChannel.port1.close();
    freshChannel.port1.close();
  });

  it('falls back on a clone message error but fails closed on broker verification error', async () => {
    const fallback = new OcctModulePort();
    const channel = new MessageChannel();
    bootstrap(fallback, channel.port2, 21);
    const waiting = fallback.getModule();
    channel.port1.postMessage({ kind: 'occt-module-fallback', generation: 21 });
    await expect(waiting).resolves.toBeUndefined();
    fallback.close();
    channel.port1.close();

    const failed = new OcctModulePort();
    const failedChannel = new MessageChannel();
    bootstrap(failed, failedChannel.port2, 22);
    const rejected = failed.getModule();
    failedChannel.port1.postMessage({ kind: 'occt-module-failed', generation: 22 });
    await expect(rejected).rejects.toThrow('検証に失敗');
    failed.close();
    failedChannel.port1.close();
  });
});
