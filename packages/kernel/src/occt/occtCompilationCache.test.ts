import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { verifyOcctStreamingResponse, type VerifiedOcctResponse } from './compiledOcctModule.js';
import { OcctCompilationCache } from './occtCompilationCache.js';

// Native WASM: answer() = 42. Cache tests use real compilation and instantiation.
const wasm = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127,
  3, 2, 1, 0, 7, 10, 1, 6, 97, 110, 115, 119, 101, 114, 0, 0,
  10, 6, 1, 4, 0, 65, 42, 11,
]);
const url = 'https://pointercad.example/occt/native.wasm';

async function verified(bytes: Uint8Array = wasm): Promise<VerifiedOcctResponse> {
  const response = new Response(bytes.slice().buffer, {
    status: 200,
    headers: { 'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip' },
  });
  Object.defineProperty(response, 'url', { value: url });
  return verifyOcctStreamingResponse(response, {
    url,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
  });
}

function answer(module: WebAssembly.Module): unknown {
  const instance = new WebAssembly.Instance(module);
  const exported = instance.exports.answer;
  if (typeof exported !== 'function') throw new Error('native fixture lost answer');
  return Reflect.apply(exported, undefined, []);
}

describe('OCCT compilation cache', () => {
  it('shares one native Module and in-flight Promise for the same verified hash', async () => {
    const cache = new OcctCompilationCache();
    const first = await verified();
    const second = await verified();
    const compile = vi.fn(() => WebAssembly.compile(wasm));
    try {
      const [left, right] = await Promise.all([
        cache.getOrCompile(first, compile), cache.getOrCompile(second, compile),
      ]);
      expect(left).toBe(right);
      expect(answer(left)).toBe(42);
      expect(compile).toHaveBeenCalledTimes(1);
      expect(await cache.getOrCompile(second, compile)).toBe(left);
      expect(compile).toHaveBeenCalledTimes(1);
    } finally {
      cache.close();
    }
  });

  it('separates hashes, rejects unverified input, and retries a failed compilation', async () => {
    const cache = new OcctCompilationCache();
    const first = await verified();
    const changed = wasm.slice();
    changed[changed.length - 2] = 43;
    const second = await verified(changed);
    const compile = vi.fn()
      .mockRejectedValueOnce(new Error('compile failed'))
      .mockImplementation((value: VerifiedOcctResponse) => WebAssembly.compile(value.bytes));
    try {
      await expect(cache.getOrCompile(first, compile)).rejects.toThrow('compile failed');
      const one = await cache.getOrCompile(first, compile);
      const two = await cache.getOrCompile(second, compile);
      expect(one).not.toBe(two);
      expect(answer(one)).toBe(42);
      expect(answer(two)).toBe(43);
      expect(compile).toHaveBeenCalledTimes(3);
      const forged = { ...first };
      expect(() => cache.getOrCompile(forged, compile)).toThrow('未検証');
    } finally {
      cache.close();
    }
  });

  it('does not let one cancelled caller poison another caller or a later Worker', async () => {
    const cache = new OcctCompilationCache();
    const input = await verified();
    const controller = new AbortController();
    let release: (module: WebAssembly.Module) => void = () => { throw new Error('compile not started'); };
    const compile = vi.fn(() => new Promise<WebAssembly.Module>((resolve) => { release = resolve; }));
    try {
      const cancelled = cache.getOrCompile(input, compile, controller.signal);
      const live = cache.getOrCompile(input, compile);
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
      const module = await WebAssembly.compile(wasm);
      release(module);
      expect(await live).toBe(module);
      expect(answer(await cache.getOrCompile(input, compile))).toBe(42);
      expect(compile).toHaveBeenCalledTimes(1);
    } finally {
      cache.close();
    }
  });

  it('rejects a stale result after its cache/Worker lifetime closes', async () => {
    const cache = new OcctCompilationCache();
    const input = await verified();
    let release: (module: WebAssembly.Module) => void = () => { throw new Error('compile not started'); };
    const pending = cache.getOrCompile(input, () => new Promise<WebAssembly.Module>((resolve) => {
      release = resolve;
    }));
    await Promise.resolve();
    cache.close();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    release(await WebAssembly.compile(wasm));
    const next = new OcctCompilationCache();
    const compile = vi.fn(() => WebAssembly.compile(wasm));
    try {
      expect(answer(await next.getOrCompile(input, compile))).toBe(42);
      expect(compile).toHaveBeenCalledTimes(1);
    } finally {
      next.close();
    }
  });

  it('keeps independently verified Worker lifetimes separate', async () => {
    const producer = new OcctCompilationCache();
    const consumer = new OcctCompilationCache();
    const first = await verified();
    const second = await verified();
    const producerCompile = vi.fn(() => WebAssembly.compile(wasm));
    const consumerCompile = vi.fn(() => WebAssembly.compile(wasm));
    try {
      const module = await producer.getOrCompile(first, producerCompile);
      const reused = await consumer.getOrCompile(second, consumerCompile);
      expect(answer(reused)).toBe(42);
      expect(answer(module)).toBe(42);
      expect(reused).not.toBe(module);
      expect(producerCompile).toHaveBeenCalledTimes(1);
      expect(consumerCompile).toHaveBeenCalledTimes(1);
    } finally {
      producer.close();
      consumer.close();
    }
  });

  it('ignores an unsolicited mismatched Module reply and compiles verified bytes locally', async () => {
    const name = `pcad-occt-test-${crypto.randomUUID()}`;
    const cache = new OcctCompilationCache();
    const rogue = new BroadcastChannel(name);
    const input = await verified();
    const wrong = await WebAssembly.compile(wasm);
    rogue.postMessage({ kind: 'reply', requestId: 'rogue', key: 'wrong-hash:0', module: wrong });
    const compile = vi.fn(() => WebAssembly.compile(wasm));
    try {
      expect(answer(await cache.getOrCompile(input, compile))).toBe(42);
      expect(compile).toHaveBeenCalledTimes(1);
    } finally {
      cache.close();
      rogue.close();
    }
  });

  it('rejects a forged Module even when its claimed hash matches verified bytes', async () => {
    const name = `pcad-occt-test-${crypto.randomUUID()}`;
    const cache = new OcctCompilationCache();
    const rogue = new BroadcastChannel(name);
    const input = await verified();
    const corrupt = wasm.slice();
    corrupt[corrupt.length - 2] = 99;
    const forgedModule = await WebAssembly.compile(corrupt);
    rogue.postMessage({
      kind: 'reply', key: `${input.sha256}:${input.byteLength}`,
      requestId: 'rogue', module: forgedModule,
    });
    const compile = vi.fn(() => WebAssembly.compile(input.bytes));
    try {
      expect(answer(await cache.getOrCompile(input, compile))).toBe(42);
      expect(compile).toHaveBeenCalledTimes(1);
    } finally {
      cache.close();
      rogue.close();
    }
  });
});
