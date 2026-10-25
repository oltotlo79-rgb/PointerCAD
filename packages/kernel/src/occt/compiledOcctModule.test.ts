import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  compileVerifiedOcctResponse,
  createOcctInstantiationHook,
  OcctStreamingUnavailableError,
  verifyOcctStreamingResponse,
  verifyOcctDirectResponse,
  type OcctWasmExpectation,
} from './compiledOcctModule.js';

// Native WASM, exporting answer() = 42. The compile and instantiate paths below are real.
const wasm = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127,
  3, 2, 1, 0, 7, 10, 1, 6, 97, 110, 115, 119, 101, 114, 0, 0,
  10, 6, 1, 4, 0, 65, 42, 11,
]);
const url = 'https://pointercad.example/occt/opencascade.full-a.wasm';

describe('verified uncompressed desktop response', () => {
  it('compiles the original response only after download and verification', async () => {
    const original = response(wasm, { 'Content-Type': 'application/wasm' });
    const phases: string[] = [];
    const verified = await verifyOcctDirectResponse(original, expectation(), undefined, phase => { phases.push(phase); });
    expect(phases).toEqual(['downloaded', 'verify-start', 'verified']);
    expect(verified.response).toBe(original);
    const instance = await WebAssembly.instantiate(await compileVerifiedOcctResponse(verified));
    const answer = instance.exports.answer;
    if (typeof answer !== 'function') throw new Error('Native fixture export missing');
    expect(Reflect.apply(answer, undefined, [])).toBe(42);
  });
  it('rejects altered bytes, length, URL, encoding and HTTP failure', async () => {
    const changed = wasm.slice(); changed[changed.length - 2] = 43;
    await expect(verifyOcctDirectResponse(response(changed, { 'Content-Type': 'application/wasm' }), expectation())).rejects.toThrow('SHA-256');
    await expect(verifyOcctDirectResponse(response(wasm, { 'Content-Type': 'application/wasm' }), { ...expectation(), byteLength: wasm.length + 1 })).rejects.toThrow('byteLength');
    await expect(verifyOcctDirectResponse(response(wasm, { 'Content-Type': 'application/wasm' }), { ...expectation(), url: 'app://other/asset.wasm' })).rejects.toThrow('URL');
    await expect(verifyOcctDirectResponse(response(), expectation())).rejects.toThrow('encoding');
    await expect(verifyOcctDirectResponse(new Response(null, { status: 404 }), expectation())).rejects.toThrow('404');
    await expect(verifyOcctStreamingResponse(response(wasm, { 'Content-Type': 'application/wasm' }), expectation())).rejects.toThrow('gzip');
  });
});

function expectation(bytes: Uint8Array = wasm): OcctWasmExpectation {
  return {
    url,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
  };
}

function response(
  bytes: Uint8Array = wasm,
  headers: HeadersInit = { 'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip' },
): Response {
  const result = new Response(bytes.slice().buffer, { status: 200, headers });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

/**
 * A gzip-labelled OCCT response whose body yields the given chunks one pull at a time, then closes or errors.
 * With holdOpen the exhausted source stays open, like a network body with bytes still due: it neither enqueues
 * nor closes again, so only cancel ends it. Without it the source closes on the pull after the last chunk, and
 * because Response.clone() tees and pre-pulls, that close happens before a reader of the clone can see an overflow.
 */
function chunkedResponse(chunks: readonly Uint8Array[], options: { readonly failAfter?: number; readonly cancel?: () => void; readonly holdOpen?: boolean } = {}): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (options.failAfter !== undefined && index === options.failAfter) {
        controller.error(new Error('OCCT fixture network reset'));
        return;
      }
      const next = chunks[index];
      index += 1;
      if (next === undefined && options.holdOpen === true) return;
      if (next === undefined) controller.close();
      else controller.enqueue(next.slice());
    },
    cancel() { options.cancel?.(); },
  }, { highWaterMark: 0 });
  const result = new Response(body, { status: 200, headers: { 'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip' } });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

/** A refused verification must not leave the original tee branch holding its chunks: it reads as finished. */
async function expectReleasedBody(original: Response): Promise<void> {
  const body = original.body;
  if (body === null) throw new Error('OCCT fixture lost its body');
  const reader = body.getReader();
  try {
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  } finally {
    reader.releaseLock();
  }
}

describe('OCCT streaming bytes and native Module', () => {
  beforeAll(async () => {
    // Node's first Response also starts Undici's asynchronous llhttp WASM setup.
    // Complete a real HTTP exchange before observing WASM calls, so that setup
    // cannot race the OCCT assertions. No OCCT compile/instantiate is excluded.
    const server = createServer((_request, reply) => {
      reply.writeHead(200, { 'Connection': 'close' });
      reply.end('ready');
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('HTTP fixture did not start');
      const ready = await fetch(`http://127.0.0.1:${address.port}/`, { signal: AbortSignal.timeout(5_000) });
      expect(await ready.text()).toBe('ready');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error));
      });
    }
  });

  it('checks decoded bytes, then compiles the original HTTP Response with the native API', async () => {
    const original = response();
    const verified = await verifyOcctStreamingResponse(original, expectation());
    expect(verified.response).toBe(original);
    expect(new Uint8Array(verified.bytes)).toEqual(wasm);
    const compiled = await compileVerifiedOcctResponse(verified);
    const instance = await WebAssembly.instantiate(compiled);
    const answer = instance.exports.answer;
    expect(typeof answer).toBe('function');
    if (typeof answer !== 'function') throw new Error('native WASM fixture lost answer');
    const actual: unknown = Reflect.apply(answer, undefined, []);
    expect(actual).toBe(42);
  });

  it('rejects a changed byte before any compile or instantiate', async () => {
    const changed = wasm.slice();
    changed[changed.length - 2] = 43;
    expect(WebAssembly.validate(changed)).toBe(true);
    const compile = vi.spyOn(WebAssembly, 'compile');
    const compileStreaming = vi.spyOn(WebAssembly, 'compileStreaming');
    const instantiate = vi.spyOn(WebAssembly, 'instantiate');
    const instantiateStreaming = vi.spyOn(WebAssembly, 'instantiateStreaming');
    const received = vi.fn();
    try {
      const operation = verifyOcctStreamingResponse(response(changed), expectation())
        .then(compileVerifiedOcctResponse)
        .then(async module => {
          const hook = createOcctInstantiationHook(module);
          try {
            hook.instantiateWasm({}, received);
            await hook.completion;
          } finally {
            hook.close();
          }
        });
      await expect(operation).rejects.toThrow('SHA-256');
      expect(compile).not.toHaveBeenCalled();
      expect(compileStreaming).not.toHaveBeenCalled();
      expect(instantiate).not.toHaveBeenCalled();
      expect(instantiateStreaming).not.toHaveBeenCalled();
      expect(received).not.toHaveBeenCalled();
    } finally {
      compile.mockRestore();
      compileStreaming.mockRestore();
      instantiate.mockRestore();
      instantiateStreaming.mockRestore();
    }
  });

  it('rejects an unverified object and a decoded length mismatch', async () => {
    const original = response();
    await expect(verifyOcctStreamingResponse(original, { ...expectation(), byteLength: wasm.byteLength + 1 }))
      .rejects.toThrow('byteLength');
    const forged = { response: response(), bytes: wasm.slice().buffer,
      sha256: expectation().sha256, byteLength: wasm.byteLength };
    await expect(compileVerifiedOcctResponse(forged)).rejects.toThrow('未検証');
  });

  it('compiles verified bytes with the native API when streaming is unavailable', async () => {
    const input = await verifyOcctStreamingResponse(response(), expectation());
    const original = WebAssembly.compileStreaming;
    Object.defineProperty(WebAssembly, 'compileStreaming', { configurable: true, value: undefined });
    try {
      const module = await compileVerifiedOcctResponse(input);
      const instance = await WebAssembly.instantiate(module);
      const answer = instance.exports.answer;
      if (typeof answer !== 'function') throw new Error('native WASM fixture lost answer');
      expect(Reflect.apply(answer, undefined, [])).toBe(42);
    } finally {
      Object.defineProperty(WebAssembly, 'compileStreaming', { configurable: true, value: original });
    }
  });

  it('refuses changed fallback bytes after the HTTP response was verified', async () => {
    const input = await verifyOcctStreamingResponse(response(), expectation());
    new Uint8Array(input.bytes)[input.byteLength - 2] = 99;
    const original = WebAssembly.compileStreaming;
    const compile = vi.spyOn(WebAssembly, 'compile');
    Object.defineProperty(WebAssembly, 'compileStreaming', { configurable: true, value: undefined });
    try {
      await expect(compileVerifiedOcctResponse(input)).rejects.toThrow('SHA-256');
      expect(compile).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(WebAssembly, 'compileStreaming', { configurable: true, value: original });
      compile.mockRestore();
    }
  });

  it('rejects an already cancelled verification before compile', async () => {
    const controller = new AbortController();
    controller.abort();
    const compile = vi.spyOn(WebAssembly, 'compileStreaming');
    try {
      await expect(verifyOcctStreamingResponse(response(), expectation(), controller.signal))
        .rejects.toMatchObject({ name: 'AbortError' });
      expect(compile).not.toHaveBeenCalled();
    } finally {
      compile.mockRestore();
    }
  });

  it('cancels an in-flight response read when the caller aborts', async () => {
    const controller = new AbortController();
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const pendingResponse = new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip' },
    });
    Object.defineProperty(pendingResponse, 'url', { value: url });
    const pending = verifyOcctStreamingResponse(pendingResponse, expectation(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('writes distinct stream chunks at their offsets, including an empty chunk, then compiles the original response', async () => {
    const chunks = [wasm.slice(0, 5), new Uint8Array(0), wasm.slice(5, 23), wasm.slice(23)];
    const original = chunkedResponse(chunks);
    const verified = await verifyOcctStreamingResponse(original, expectation());
    expect(verified.response).toBe(original);
    expect(verified.byteLength).toBe(wasm.byteLength);
    expect(verified.bytes.byteLength).toBe(wasm.byteLength);
    expect(new Uint8Array(verified.bytes)).toEqual(wasm);
    const instance = await WebAssembly.instantiate(await compileVerifiedOcctResponse(verified));
    const answer = instance.exports.answer;
    if (typeof answer !== 'function') throw new Error('native WASM fixture lost answer');
    expect(Reflect.apply(answer, undefined, [])).toBe(42);
  });

  it('refuses a chunk that would pass the trusted length, cancels the source and never compiles', async () => {
    const cancelled = vi.fn();
    const overlong = new Uint8Array(wasm.byteLength - 10 + 1);
    overlong.set(wasm.slice(10));
    const compileStreaming = vi.spyOn(WebAssembly, 'compileStreaming');
    try {
      const original = chunkedResponse([wasm.slice(0, 10), overlong], { cancel: cancelled, holdOpen: true });
      await expect(verifyOcctStreamingResponse(original, expectation()))
        .rejects.toThrow('上限を超えました');
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(compileStreaming).not.toHaveBeenCalled();
      await expectReleasedBody(original);
    } finally {
      compileStreaming.mockRestore();
    }
  });

  it('refuses the same overflow after the tee already closed the exhausted source, never compiles and releases the original body', async () => {
    const cancelled = vi.fn();
    const overlong = new Uint8Array(wasm.byteLength - 10 + 1);
    overlong.set(wasm.slice(10));
    const compileStreaming = vi.spyOn(WebAssembly, 'compileStreaming');
    try {
      const original = chunkedResponse([wasm.slice(0, 10), overlong], { cancel: cancelled });
      await expect(verifyOcctStreamingResponse(original, expectation())).rejects.toThrow(`(expected ${wasm.byteLength})`);
      // The source delivered both chunks and closed on the pre-pull before the overflow was seen: nothing is left
      // to cancel there. The still-open case above proves the propagated cancel.
      expect(cancelled).not.toHaveBeenCalled();
      expect(compileStreaming).not.toHaveBeenCalled();
      await expectReleasedBody(original);
    } finally {
      compileStreaming.mockRestore();
    }
  });

  it('rejects a short multi-chunk payload with the exact decoded length', async () => {
    await expect(verifyOcctStreamingResponse(chunkedResponse([wasm.slice(0, 10), wasm.slice(10, wasm.byteLength - 1)]), expectation()))
      .rejects.toThrow(`expected ${wasm.byteLength}, actual ${wasm.byteLength - 1}`);
  });

  it('propagates a read failure after a partial chunk, cancels the source and never compiles', async () => {
    const cancelled = vi.fn();
    const compileStreaming = vi.spyOn(WebAssembly, 'compileStreaming');
    try {
      await expect(verifyOcctStreamingResponse(chunkedResponse([wasm.slice(0, 10), wasm.slice(10)], { failAfter: 1, cancel: cancelled }), expectation()))
        .rejects.toThrow('OCCT fixture network reset');
      expect(compileStreaming).not.toHaveBeenCalled();
    } finally {
      compileStreaming.mockRestore();
    }
  });

  it('refuses an expected length above the trusted bound before reading the body', async () => {
    const pulled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull: pulled }, { highWaterMark: 0 });
    const untrusted = new Response(body, { status: 200, headers: { 'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip' } });
    Object.defineProperty(untrusted, 'url', { value: url });
    await expect(verifyOcctStreamingResponse(untrusted, { ...expectation(), byteLength: 64 * 1024 * 1024 + 1 }))
      .rejects.toThrow('期待する長さ');
    expect(pulled).not.toHaveBeenCalled();
  });

  it.each([
    [{ 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip' }, 'MIME'],
    [{ 'Content-Type': 'application/wasm' }, 'Content-Encoding'],
  ])('does not stream a response with wrong HTTP headers', async (headers, reason) => {
    await expect(verifyOcctStreamingResponse(response(wasm, headers), expectation()))
      .rejects.toThrow(OcctStreamingUnavailableError);
    await expect(verifyOcctStreamingResponse(response(wasm, headers), expectation()))
      .rejects.toThrow(reason);
  });

  it('rejects a redirected response and an unexpected URL', async () => {
    const redirected = response();
    Object.defineProperty(redirected, 'redirected', { value: true });
    await expect(verifyOcctStreamingResponse(redirected, expectation())).rejects.toThrow('redirect');
    await expect(verifyOcctStreamingResponse(response(), { ...expectation(), url: `${url}-other` }))
      .rejects.toThrow('URL');
  });

  it('passes real imports to native instantiate and calls the glue receiver once', async () => {
    const module = await WebAssembly.compile(wasm);
    const hook = createOcctInstantiationHook(module);
    let actualInstance: WebAssembly.Instance | undefined;
    let actualModule: WebAssembly.Module | undefined;
    const received = vi.fn((instance: WebAssembly.Instance, receivedModule: WebAssembly.Module) => {
      actualInstance = instance;
      actualModule = receivedModule;
    });
    expect(hook.instantiateWasm({}, received)).toEqual({});
    await hook.completion;
    expect(received).toHaveBeenCalledTimes(1);
    expect(actualInstance).toBeInstanceOf(WebAssembly.Instance);
    expect(actualModule).toBe(module);
    hook.close();
  });

  it('separates native and receiver stages without allowing observer errors to fail loading', async () => {
    const module = await WebAssembly.compile(wasm);
    const stages: string[] = [];
    const received = vi.fn();
    const hook = createOcctInstantiationHook(module, undefined, name => {
      stages.push(name);
      throw new Error('diagnostic sink failed');
    });
    try {
      hook.instantiateWasm({}, received);
      await hook.completion;
      expect(received).toHaveBeenCalledTimes(1);
      expect(stages).toEqual(['native-instantiate-start', 'native-instantiate-end',
        'receive-instance-start', 'receive-instance-end']);
    } finally { hook.close(); }
  });

  it('does not report receiver completion on receiver failure or cancelled initialization', async () => {
    const module = await WebAssembly.compile(wasm);
    const stages: string[] = [];
    const failed = createOcctInstantiationHook(module, undefined, name => { stages.push(name); });
    failed.instantiateWasm({}, () => { throw new Error('receiver failed'); });
    await expect(failed.completion).rejects.toThrow('receiver failed');
    expect(stages).toEqual(['native-instantiate-start', 'native-instantiate-end', 'receive-instance-start']);
    failed.close();
    const controller = new AbortController(), cancelledStages: string[] = [];
    const cancelled = createOcctInstantiationHook(module, controller.signal,
      name => { cancelledStages.push(name); });
    cancelled.instantiateWasm({}, vi.fn());
    controller.abort();
    await expect(cancelled.completion).rejects.toThrow();
    expect(cancelledStages).toEqual([]);
    cancelled.close();
  });

  it('propagates receiver failure and cancellation without a late success', async () => {
    const module = await WebAssembly.compile(wasm);
    const failed = createOcctInstantiationHook(module);
    failed.instantiateWasm({}, () => { throw new Error('receiver failed'); });
    await expect(failed.completion).rejects.toThrow('receiver failed');
    failed.close();

    const controller = new AbortController();
    const cancelled = createOcctInstantiationHook(module, controller.signal);
    const received = vi.fn();
    cancelled.instantiateWasm({}, received);
    controller.abort();
    await expect(cancelled.completion).rejects.toThrow();
    await Promise.resolve();
    expect(received).not.toHaveBeenCalled();
    cancelled.close();
  });

  it('propagates native instantiate failure and never calls the receiver', async () => {
    const module = await WebAssembly.compile(wasm);
    const instantiate = vi.spyOn(WebAssembly, 'instantiate').mockRejectedValueOnce(new Error('instantiate failed'));
    const hook = createOcctInstantiationHook(module);
    const received = vi.fn();
    try {
      hook.instantiateWasm({}, received);
      await expect(hook.completion).rejects.toThrow('instantiate failed');
      expect(received).not.toHaveBeenCalled();
    } finally {
      hook.close();
      instantiate.mockRestore();
    }
  });
});

// 実物の wasm を読んで固定値と照合する実測(`PCAD_OCCT_REAL_MEASURE=1` のときだけ動く)。
// 固定値の出どころ: 採用した closed 版 OCCT の
// `vendor/opencascade/opencascade.js-b5ff984-closed-0839d9bcc8ac4677/pcad-closed-build.json` の
// `build.wasmBytes`(19,082,393 バイト)と `build.wasm`(SHA-256)。旧レジストリ版は採用をやめた。
it.runIf(process.env.PCAD_OCCT_REAL_MEASURE === '1')(
  'measures the fixed 19 MB closed OCCT fixture hash, native compile, and process memory',
  async () => {
    const started = performance.now();
    const before = process.memoryUsage();
    const bytes = await readFile(new URL('../../node_modules/opencascade.js/dist/opencascade.full.wasm', import.meta.url));
    const loaded = performance.now();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const hashed = performance.now();
    expect(bytes.byteLength).toBe(19_082_393);
    expect(sha256).toBe('0839d9bcc8ac4677e346dee92c7b428b91ea9c646110fcdeee8a8701424472a7');
    const module = await WebAssembly.compile(bytes);
    const compiled = performance.now();
    const after = process.memoryUsage();
    expect(module).toBeInstanceOf(WebAssembly.Module);
    console.info('[pcad:occt-fixture]', JSON.stringify({
      bytes: bytes.byteLength,
      sha256,
      loadMs: loaded - started,
      hashMs: hashed - loaded,
      compileMs: compiled - hashed,
      rssBefore: before.rss,
      rssAfter: after.rss,
      externalBefore: before.external,
      externalAfter: after.external,
      arrayBuffersBefore: before.arrayBuffers,
      arrayBuffersAfter: after.arrayBuffers,
    }));
  },
);
