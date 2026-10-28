import { isPcadReadReplyFor, type PcadReadKind, type PcadReadRequest, type PcadReadResults } from './pcadReadProtocol.js';

/** 実IOを持つ相手をheadless検査で明示注入する小さな境界。 */
export interface PcadReadWorkerPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(request: PcadReadRequest, transfer: Transferable[]): void;
  terminate(): void;
}
export interface PcadReadControl {
  readonly signal?: AbortSignal;
  readonly isCurrent?: () => boolean;
}
export interface PcadFileReader {
  <K extends PcadReadKind>(kind: K, bytes: Uint8Array, control?: PcadReadControl): Promise<PcadReadResults[K]>;
}
export class PcadReadWorkerError extends Error {
  constructor(readonly reason: 'unavailable' | 'crashed' | 'rejected', message: string) {
    super(message);
    this.name = 'PcadReadWorkerError';
  }
}
function browserWorker(): PcadReadWorkerPort {
  try { return new Worker(new URL('./pcadRead.worker.ts', import.meta.url), { type: 'module' }); }
  catch (error) { throw new PcadReadWorkerError('unavailable', error instanceof Error ? error.message : String(error)); }
}
function assertCurrent(control: PcadReadControl): void {
  control.signal?.throwIfAborted();
  if (control.isCurrent?.() === false) throw new DOMException('Read is stale', 'AbortError');
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

/** A request owns exactly one short-lived Worker. There is no renderer-side reader fallback. */
export function createPcadFileReader(createWorker: () => PcadReadWorkerPort = browserWorker): PcadFileReader {
  return async <K extends PcadReadKind>(kind: K, bytes: Uint8Array, control: PcadReadControl = {}): Promise<PcadReadResults[K]> => {
    const owned = await ownedBytes(bytes, control);
    assertCurrent(control);
    const id = crypto.randomUUID(), worker = createWorker();
    return new Promise<PcadReadResults[K]>((resolve, reject) => {
      let finished = false;
      const finish = (outcome: { readonly ok: true; readonly result: PcadReadResults[K] }
        | { readonly ok: false; readonly error: unknown }): void => {
        if (finished) return;
        finished = true;
        if (freshness !== null) clearInterval(freshness);
        worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
        control.signal?.removeEventListener('abort', cancel);
        // Even a throwing transport must settle the owner exactly once. Never retry termination.
        try { worker.terminate(); }
        catch (error) { reject(error instanceof Error ? error : new Error(String(error))); return; }
        if (outcome.ok) resolve(outcome.result);
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
          fail(new PcadReadWorkerError('rejected', reply.message)); return;
        }
        if (!isPcadReadReplyFor(reply, kind) || reply.id !== id) {
          fail(new PcadReadWorkerError('rejected', 'Invalid read reply')); return;
        }
        finish({ ok: true, result: reply.result });
      };
      worker.onerror = event => fail(new PcadReadWorkerError('crashed', event.message));
      worker.onmessageerror = () => fail(new PcadReadWorkerError('crashed', 'Read reply could not be read'));
      control.signal?.addEventListener('abort', cancel, { once: true });
      try { assertCurrent(control); worker.postMessage({ id, kind, bytes: owned }, [owned.buffer]); }
      catch (error) { fail(error); }
    });
  };
}

export const readPcadInWorker: PcadFileReader = createPcadFileReader();
