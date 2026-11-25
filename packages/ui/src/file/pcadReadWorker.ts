import { serveReadRanges, type ArchiveReadSource } from './pcadReadRanges.js';
import { isPcadReadReplyFor, type PcadRangeReadRequest, type PcadReadKind, type PcadReadRequest, type PcadReadResults } from './pcadReadProtocol.js';

/** 実IOを持つ相手をheadless検査で明示注入する小さな境界。 */
export interface PcadReadWorkerPort<Request = PcadReadRequest> {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(request: Request, transfer: Transferable[]): void;
  terminate(): void;
}
export interface PcadReadControl {
  readonly signal?: AbortSignal;
  readonly isCurrent?: () => boolean;
  /**
   * true の時だけ、呼び手の並びを写さずに Worker へ移す(呼び手の並びは長さ 0 に切り離される)。呼び手が以後その並びを
   * 読まず、並びが自分だけの全域の ArrayBuffer の時に限る。それ以外(既定)は今までどおり区切って写してから移す。
   * 128MiB の読込で、Worker へ渡す前の写し(ファイルの大きさの分)を作らないため(2026-11-13)。
   */
  readonly transferInput?: boolean;
}
export interface PcadFileReader {
  <K extends PcadReadKind>(kind: K, bytes: Uint8Array, control?: PcadReadControl): Promise<PcadReadResults[K]>;
}
export class PcadReadWorkerError extends Error {
  constructor(readonly reason: 'unavailable' | 'crashed' | 'rejected' | 'range', message: string) {
    super(message);
    this.name = 'PcadReadWorkerError';
  }
}
function browserWorker<Request>(): PcadReadWorkerPort<Request> {
  try { return new Worker(new URL('./pcadRead.worker.ts', import.meta.url), { type: 'module' }); }
  catch (error) { throw new PcadReadWorkerError('unavailable', error instanceof Error ? error.message : String(error)); }
}
function assertCurrent(control: PcadReadControl): void {
  control.signal?.throwIfAborted();
  if (control.isCurrent?.() === false) throw new DOMException('Read is stale', 'AbortError');
}

/** 全域の自分だけの ArrayBuffer の並びか(移しても、ほかの見せ方や共有の領域を壊さない)。 */
function wholeOwnedBuffer(bytes: Uint8Array): bytes is Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
}

/** Borrowed picked/recovery bytes stay attached. Copy in bounded chunks before transferring ownership. */
async function ownedBytes(bytes: Uint8Array, control: PcadReadControl): Promise<Uint8Array<ArrayBuffer>> {
  assertCurrent(control);
  if (!(bytes.buffer instanceof ArrayBuffer)) throw new PcadReadWorkerError('rejected', 'Shared read input is not supported');
  const copy = new Uint8Array(bytes.byteLength);
  const chunk = 1024 * 1024;
  for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
    copy.set(bytes.subarray(offset, offset + chunk), offset);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    assertCurrent(control);
  }
  return copy;
}

interface WorkerReadResult<K extends PcadReadKind> {
  readonly result: PcadReadResults[K];
  readonly savedSha256?: string;
}

/** A request owns exactly one short-lived Worker. There is no renderer-side reader fallback. */
function awaitRead<K extends PcadReadKind, Request>(worker: PcadReadWorkerPort<Request>,
  id: string, kind: K, control: PcadReadControl, start: () => void, release = (): void => undefined,
): Promise<WorkerReadResult<K>> {
  return new Promise<WorkerReadResult<K>>((resolve, reject) => {
    let finished = false;
    const finish = (outcome: { readonly ok: true; readonly reply: WorkerReadResult<K> }
      | { readonly ok: false; readonly error: unknown }): void => {
      if (finished) return;
      finished = true;
      if (freshness !== null) clearInterval(freshness);
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      control.signal?.removeEventListener('abort', cancel);
      // Even a throwing transport must settle the owner exactly once. Never retry termination.
      try {
        try { release(); } finally { worker.terminate(); }
      } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); return; }
      if (outcome.ok) resolve(outcome.reply);
      else reject(outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error)));
    };
    const fail = (error: unknown): void => finish({ ok: false, error });
    const cancel = (): void => fail(control.signal?.reason ?? new DOMException('Read cancelled', 'AbortError'));
    const freshness = control.isCurrent === undefined ? null : setInterval(() => {
      try { assertCurrent(control); } catch (error) { fail(error); }
    }, 50);
    worker.onmessage = event => {
      if (finished) return;
      const reply = event.data;
      if (typeof reply === 'object' && reply !== null && 'id' in reply && typeof reply.id === 'string' && reply.id !== id) return;
      try { assertCurrent(control); } catch (error) { fail(error); return; }
      if (typeof reply === 'object' && reply !== null && 'kind' in reply && reply.kind === 'failure'
        && 'message' in reply && typeof reply.message === 'string') {
        const reason = 'reason' in reply && reply.reason === 'range' ? 'range' : 'rejected';
        fail(new PcadReadWorkerError(reason, reply.message)); return;
      }
      if (!isPcadReadReplyFor(reply, kind) || reply.id !== id) {
        fail(new PcadReadWorkerError('rejected', 'Invalid read reply')); return;
      }
      finish({ ok: true, reply });
    };
    worker.onerror = event => fail(new PcadReadWorkerError('crashed', event.message));
    worker.onmessageerror = () => fail(new PcadReadWorkerError('crashed', 'Read reply could not be read'));
    control.signal?.addEventListener('abort', cancel, { once: true });
    try { assertCurrent(control); start(); }
    catch (error) { fail(error); }
  });
}

export function createPcadFileReader(createWorker: () => PcadReadWorkerPort = browserWorker): PcadFileReader {
  return async <K extends PcadReadKind>(kind: K, bytes: Uint8Array, control: PcadReadControl = {}): Promise<PcadReadResults[K]> => {
    const owned = control.transferInput === true && wholeOwnedBuffer(bytes) ? bytes : await ownedBytes(bytes, control);
    assertCurrent(control);
    const id = crypto.randomUUID(), worker = createWorker();
    const reply = await awaitRead(worker, id, kind, control, () => worker.postMessage({ id, kind, bytes: owned }, [owned.buffer]));
    return reply.result;
  };
}

export async function readPcadRangesInWorker<K extends PcadReadKind>(kind: K, source: ArchiveReadSource,
  digest: boolean, control: PcadReadControl): Promise<WorkerReadResult<K>> {
  assertCurrent(control);
  const id = crypto.randomUUID();
  const { port1, port2 } = new MessageChannel();
  const closePorts = (): void => { port1.close(); port2.close(); };
  try {
    serveReadRanges(port1, source, control.signal);
    const worker = browserWorker<PcadRangeReadRequest>();
    return awaitRead(worker, id, kind, control, () => {
      worker.postMessage({ id, kind, port: port2, size: source.size, digest }, [port2]);
    }, closePorts);
  } catch (error) {
    closePorts();
    throw error;
  }
}

export const readPcadInWorker: PcadFileReader = createPcadFileReader();
