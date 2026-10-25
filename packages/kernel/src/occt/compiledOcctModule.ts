/** A response whose decoded bytes passed the manifest length and SHA-256 checks. */
export interface VerifiedOcctResponse {
  readonly response: Response;
  readonly bytes: ArrayBuffer;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface OcctWasmExpectation {
  readonly url: string;
  readonly sha256: string;
  readonly byteLength: number;
}

/** Header mismatch is a compatibility decision; bad bytes are never one. */
export class OcctStreamingUnavailableError extends Error {}

const verifiedResponses = new WeakSet<VerifiedOcctResponse>();
const MAX_OCCT_WASM_BYTES = 64 * 1024 * 1024;

function abortError(): Error {
  return new DOMException('OCCT 初期化が取り消されました。', 'AbortError');
}

function requireNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function mediaType(header: string | null): string {
  return (header ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Copies each decoded chunk of the clone straight into one buffer of the trusted manifest length, so neither
 * a chunk list nor a second joined copy is retained. expectedLength comes from the pinned manifest and is
 * bounded here again (never from response headers) before it may size an allocation.
 */
async function readDecodedBytes(response: Response, expectedLength: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(expectedLength) || expectedLength <= 0 || expectedLength > MAX_OCCT_WASM_BYTES) {
    throw new Error('OCCT streaming の期待する長さが不正です。');
  }
  const bytes = new Uint8Array(expectedLength);
  const body = response.clone().body;
  if (body === null) throw new Error('OCCT streaming 資産の本文がありません。');
  const reader = body.getReader();
  let length = 0;
  let completed = false;
  const cancelBoth = async (): Promise<void> => {
    await Promise.all([
      reader.cancel().catch(() => undefined),
      response.body?.cancel().catch(() => undefined),
    ]);
  };
  const onAbort = (): void => { void cancelBoth(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    while (true) {
      const next = await reader.read();
      requireNotAborted(signal);
      if (next.done) {
        completed = true;
        break;
      }
      if (next.value.byteLength > expectedLength - length) {
        throw new Error(`OCCT streaming 資産の byteLength が上限を超えました(expected ${expectedLength})。`);
      }
      bytes.set(next.value, length);
      length += next.value.byteLength;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!completed) await cancelBoth();
    reader.releaseLock();
  }
  if (length !== expectedLength) {
    throw new Error(`OCCT streaming 資産の byteLength が一致しません(expected ${expectedLength}, actual ${length})。`);
  }
  return bytes.buffer;
}

export async function verifyOcctStreamingResponse(
  response: Response,
  expected: OcctWasmExpectation,
  signal?: AbortSignal,
  observe?: (phase: string) => void,
): Promise<VerifiedOcctResponse> {
  return verifyOcctResponse(response, expected, 'gzip', signal, observe);
}

/** Direct desktop assets are uncompressed; retain the fetched response for native code caching. */
export async function verifyOcctDirectResponse(
  response: Response,
  expected: OcctWasmExpectation,
  signal?: AbortSignal,
  observe?: (phase: string) => void,
): Promise<VerifiedOcctResponse> {
  return verifyOcctResponse(response, expected, 'identity', signal, observe);
}

async function verifyOcctResponse(
  response: Response,
  expected: OcctWasmExpectation,
  encoding: 'gzip' | 'identity',
  signal?: AbortSignal,
  observe?: (phase: string) => void,
): Promise<VerifiedOcctResponse> {
  requireNotAborted(signal);
  if (!/^[a-f0-9]{64}$/.test(expected.sha256) ||
      !Number.isSafeInteger(expected.byteLength) ||
      expected.byteLength <= 0 ||
      expected.byteLength > MAX_OCCT_WASM_BYTES) {
    throw new Error('OCCT streaming の期待する長さまたは SHA-256 が不正です。');
  }
  if (response.status !== 200) {
    throw new Error(`OCCT streaming 資産を取得できませんでした(HTTP ${response.status})。`);
  }
  if (response.redirected) throw new Error('OCCT streaming 資産が redirect されました。');
  if (response.url !== expected.url) throw new Error('OCCT streaming 資産の URL が一致しません。');
  if (mediaType(response.headers.get('Content-Type')) !== 'application/wasm') {
    throw new OcctStreamingUnavailableError('OCCT streaming の MIME が application/wasm ではありません。');
  }
  const actualEncoding = response.headers.get('Content-Encoding')?.trim().toLowerCase();
  if (encoding === 'gzip' && actualEncoding !== 'gzip') {
    throw new OcctStreamingUnavailableError('OCCT streaming の Content-Encoding が gzip ではありません。');
  }
  if (encoding === 'identity' && actualEncoding !== undefined && actualEncoding !== 'identity') {
    throw new Error('Direct OCCT asset unexpectedly has a content encoding.');
  }
  const notify = (phase: string): void => { try { observe?.(phase); } catch { /* Observation is not ownership. */ } };

  // Reading only a clone keeps the fetched HTTP response, including its cache metadata,
  // available for compileStreaming. No compile/instantiate may precede this digest.
  const bytes = await readDecodedBytes(response, expected.byteLength, signal);
  notify('downloaded');
  requireNotAborted(signal);
  notify('verify-start');
  const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes));
  requireNotAborted(signal);
  if (sha256 !== expected.sha256) {
    throw new Error(`OCCT streaming 資産の SHA-256 が一致しません(expected ${expected.sha256}, actual ${sha256})。`);
  }
  notify('verified');
  const verified: VerifiedOcctResponse = Object.freeze({
    response, bytes, sha256, byteLength: bytes.byteLength,
  });
  verifiedResponses.add(verified);
  return verified;
}

export async function compileVerifiedOcctResponse(
  verified: VerifiedOcctResponse,
): Promise<WebAssembly.Module> {
  assertVerifiedOcctResponse(verified);
  if (typeof WebAssembly.compileStreaming !== 'function') {
    // A caller can mutate an ArrayBuffer after verification. Compile a stable
    // copy only if its digest still matches the verified HTTP response.
    const bytes = verified.bytes.slice(0);
    const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes));
    if (sha256 !== verified.sha256) {
      throw new Error('OCCT streaming fallback の SHA-256 が一致しません。');
    }
    return WebAssembly.compile(bytes);
  }
  return WebAssembly.compileStreaming(verified.response);
}

export function assertVerifiedOcctResponse(verified: VerifiedOcctResponse): void {
  if (!verifiedResponses.has(verified)) {
    throw new Error('未検証の OCCT response を利用できません。');
  }
}

export interface OcctInstantiationHook {
  readonly instantiateWasm: (
    imports: WebAssembly.Imports,
    receiveInstance: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ) => Record<string, never>;
  readonly completion: Promise<void>;
  close(): void;
}

export function createOcctInstantiationHook(
  module: WebAssembly.Module,
  signal?: AbortSignal,
  observeStage?: (name: string) => void,
): OcctInstantiationHook {
  const observe = (name: string): void => {
    try { observeStage?.(name); } catch { /* Diagnostics cannot change native loading outcomes. */ }
  };
  let resolveCompletion: () => void = () => undefined;
  let rejectCompletion: (error: Error) => void = () => undefined;
  let finished = false;
  let called = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // A synchronously throwing glue factory can close the hook before it attaches
  // its own completion observer. Keep the rejection observable without leaking it.
  void completion.catch(() => undefined);
  const finish = (error?: Error): void => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener('abort', onAbort);
    if (timer !== undefined) clearTimeout(timer);
    if (error === undefined) resolveCompletion();
    else rejectCompletion(error);
  };
  const onAbort = (): void => { finish(abortError()); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) finish(abortError());

  return {
    instantiateWasm(imports, receiveInstance): Record<string, never> {
      if (called) {
        finish(new Error('OCCT instantiateWasm が重複して呼ばれました。'));
        return {};
      }
      called = true;
      if (finished) return {};
      // The model bridge has a finite Worker deadline. Bound this local hook too.
      timer = setTimeout(() => { finish(new Error('OCCT instantiateWasm が期限切れです。')); }, 150_000);
      void Promise.resolve().then(async () => {
        if (finished) return;
        observe('native-instantiate-start');
        const instance = await WebAssembly.instantiate(module, imports);
        observe('native-instantiate-end');
        if (finished) return;
        observe('receive-instance-start');
        receiveInstance(instance, module);
        observe('receive-instance-end');
        finish();
      }).catch((error: unknown) => {
        finish(error instanceof Error ? error : new Error(String(error)));
      });
      return {};
    },
    completion,
    close(): void {
      if (!finished) finish(abortError());
    },
  };
}
