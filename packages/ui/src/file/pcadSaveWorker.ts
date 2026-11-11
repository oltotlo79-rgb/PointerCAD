import { admitThreeMf, checkThreeMfDeadline, threeMfDeadline,
  ThreeMfExportLimitError,
  type SaveDocumentEncoder, type SaveDocumentInput, type SaveEncodingControl,
  type ThreeMfMeshInput } from '@pointercad/io';
import { SavePointError, type CreatedSavePointListing, type NamedSavePoint, type SavePointKind } from '../history/namedSavePoints.js';
import { isPcadSavePointReply, isPcadSaveReply, isPcadThreeMfReply, type PcadCloneAndListResult, type PcadSavePointReply,
  type PcadSavePointRequest, type PcadWorkerRequest } from './pcadSaveProtocol.js';
import { captureSaveSnapshot, copySaveSnapshot } from './pcadSaveSnapshot.js';

/** headlessの検査では、この小さい境界へ実IOを使う相手を明示注入する。 */
export interface PcadSaveWorkerPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(request: PcadWorkerRequest, transfer: Transferable[]): void;
  terminate(): void;
}

export class PcadSaveWorkerError extends Error {
  constructor(readonly reason: 'unavailable' | 'crashed' | 'rejected', message: string) {
    super(message);
    this.name = 'PcadSaveWorkerError';
  }
}

function browserWorker(): PcadSaveWorkerPort {
  try {
    return new Worker(new URL('./pcadSave.worker.ts', import.meta.url), { type: 'module' });
  } catch (error) {
    throw new PcadSaveWorkerError('unavailable', error instanceof Error ? error.message : String(error));
  }
}

/** 失敗時の同期保存への代替は設けない。取消・返信・クラッシュの全出口でWorkerを破棄する。 */
export function createPcadSaveEncoder(createWorker: () => PcadSaveWorkerPort = browserWorker): SaveDocumentEncoder {
  return async (input: SaveDocumentInput, control: SaveEncodingControl = {}): Promise<Uint8Array> => {
    const captured = captureSaveSnapshot(input);
    control.signal?.throwIfAborted();
    control.onProgress?.('preparing');
    const owned = await copySaveSnapshot(captured, control.signal);
    control.signal?.throwIfAborted();
    const worker = createWorker();
    const id = crypto.randomUUID();
    return new Promise<Uint8Array>((resolve, reject) => {
      let finished = false;
      const cleanup = (): boolean => {
        if (finished) return false;
        finished = true;
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        worker.terminate();
        control.signal?.removeEventListener('abort', cancel);
        return true;
      };
      const fail = (error: unknown): void => { if (cleanup()) reject(error instanceof Error ? error : new Error(String(error))); };
      const cancel = (): void => { fail(control.signal?.reason ?? new DOMException('Save cancelled', 'AbortError')); };
      worker.onmessage = event => {
        if (finished) return;
        const reply = event.data;
        if (typeof reply === 'object' && reply !== null && 'id' in reply && typeof reply.id === 'string' && reply.id !== id) return;
        if (!isPcadSaveReply(reply)) { fail(new PcadSaveWorkerError('rejected', 'Invalid save reply')); return; }
        if (reply.id !== id) return;
        if (reply.kind === 'progress') control.onProgress?.(reply.stage);
        else if (reply.kind === 'failure') fail(new PcadSaveWorkerError('rejected', reply.message));
        else if (cleanup()) resolve(reply.bytes);
      };
      worker.onerror = event => { fail(new PcadSaveWorkerError('crashed', event.message)); };
      worker.onmessageerror = () => { fail(new PcadSaveWorkerError('crashed', 'Save reply could not be read')); };
      control.signal?.addEventListener('abort', cancel, { once: true });
      if (control.signal?.aborted === true) { cancel(); return; }
      try { worker.postMessage({ id, input: owned.input }, owned.transfer); }
      catch (error) { fail(new PcadSaveWorkerError('rejected', error instanceof Error ? error.message : String(error))); }
    });
  };
}

export const encodePcadInWorker: SaveDocumentEncoder = createPcadSaveEncoder();

export interface ThreeMfWorkControl {
  readonly remainingMs: number;
  readonly signal?: AbortSignal;
  readonly isCurrent?: () => boolean;
}

const THREE_MF_COPY_CHUNK_ELEMENTS = (1024 * 1024) / 4;

function assertThreeMfCurrent(control: ThreeMfWorkControl, deadlineAt: number): void {
  control.signal?.throwIfAborted();
  if (control.isCurrent !== undefined && !control.isCurrent()) {
    throw new DOMException('3MF export is stale', 'AbortError');
  }
  checkThreeMfDeadline(deadlineAt);
}

async function copyThreeMfMeshes(
  meshes: readonly ThreeMfMeshInput[], control: ThreeMfWorkControl, deadlineAt: number,
): Promise<readonly ThreeMfMeshInput[]> {
  const copied: ThreeMfMeshInput[] = [];
  const yieldCopy = async (): Promise<void> => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    assertThreeMfCurrent(control, deadlineAt);
  };
  await yieldCopy();
  for (const mesh of meshes) {
    assertThreeMfCurrent(control, deadlineAt);
    // The production path is typed by ExchangeExportMesh; the protocol requires
    // these concrete views so that only newly owned buffers can be transferred.
    if (!(mesh.positions instanceof Float32Array) || !(mesh.indices instanceof Uint32Array)) {
      throw new PcadSaveWorkerError('rejected', '3MF mesh arrays must be typed');
    }
    const positions = new Float32Array(mesh.positions.length);
    const indices = new Uint32Array(mesh.indices.length);
    for (let offset = 0; offset < positions.length; offset += THREE_MF_COPY_CHUNK_ELEMENTS) {
      positions.set(mesh.positions.subarray(offset, offset + THREE_MF_COPY_CHUNK_ELEMENTS), offset);
      await yieldCopy();
    }
    for (let offset = 0; offset < indices.length; offset += THREE_MF_COPY_CHUNK_ELEMENTS) {
      indices.set(mesh.indices.subarray(offset, offset + THREE_MF_COPY_CHUNK_ELEMENTS), offset);
      await yieldCopy();
    }
    let faceColors: Map<number, readonly [number, number, number]> | undefined;
    if (mesh.faceColors !== undefined) {
      faceColors = new Map();
      let count = 0;
      for (const [face, color] of mesh.faceColors) {
        faceColors.set(face, [color[0], color[1], color[2]]);
        if ((++count & 1023) === 0) await yieldCopy();
      }
    }
    let faceRanges: { readonly triangleOffset: number; readonly triangleCount: number }[] | undefined;
    if (mesh.faceRanges !== undefined) {
      faceRanges = [];
      for (const range of mesh.faceRanges) {
        faceRanges.push({ triangleOffset: range.triangleOffset, triangleCount: range.triangleCount });
        if ((faceRanges.length & 1023) === 0) await yieldCopy();
      }
    }
    copied.push({ name: mesh.name, color: mesh.color === null ? null
      : [mesh.color[0], mesh.color[1], mesh.color[2]], positions, indices,
    ...(faceColors === undefined ? {} : { faceColors }),
    ...(faceRanges === undefined ? {} : { faceRanges }) });
  }
  assertThreeMfCurrent(control, deadlineAt);
  return copied;
}

/** One short-lived Worker, no renderer-side XML or ZIP fallback. */
export function createThreeMfExportEncoder(createWorker: () => PcadSaveWorkerPort = browserWorker) {
  return async (meshes: readonly ThreeMfMeshInput[], control: ThreeMfWorkControl): Promise<Uint8Array> => {
    const deadlineAt = threeMfDeadline(control.remainingMs);
    assertThreeMfCurrent(control, deadlineAt);
    admitThreeMf(meshes, { ownedCopyCount: 1 });
    const owned = await copyThreeMfMeshes(meshes, control, deadlineAt);
    assertThreeMfCurrent(control, deadlineAt);
    const worker = createWorker();
    const id = crypto.randomUUID();
    return new Promise<Uint8Array>((resolve, reject) => {
      let finished = false;
      const cleanup = (): boolean => {
        if (finished) return false;
        finished = true;
        clearTimeout(timeout);
        if (freshness !== null) clearInterval(freshness);
        worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
        control.signal?.removeEventListener('abort', cancel);
        worker.terminate();
        return true;
      };
      const fail = (error: unknown): void => {
        if (cleanup()) reject(error instanceof Error ? error : new Error(String(error)));
      };
      const cancel = (): void => fail(control.signal?.reason ?? new DOMException('3MF export cancelled', 'AbortError'));
      const remainingMs = deadlineAt - performance.now();
      if (remainingMs <= 0) { worker.terminate(); reject(new ThreeMfExportLimitError('deadline')); return; }
      const timeout = setTimeout(() => fail(new ThreeMfExportLimitError('deadline')), remainingMs);
      const freshness = control.isCurrent === undefined ? null : setInterval(() => {
        try { assertThreeMfCurrent(control, deadlineAt); }
        catch (error) { fail(error); }
      }, 50);
      worker.onmessage = event => {
        if (finished) return;
        const reply = event.data;
        if (typeof reply === 'object' && reply !== null && 'id' in reply && typeof reply.id === 'string'
          && reply.id !== id) return;
        if (!isPcadThreeMfReply(reply) || reply.id !== id) {
          fail(new PcadSaveWorkerError('rejected', 'Invalid 3MF reply')); return;
        }
        try { assertThreeMfCurrent(control, deadlineAt); }
        catch (error) { fail(error); return; }
        if (reply.kind === 'export3mfFailure') fail(new PcadSaveWorkerError('rejected', reply.message));
        else if (cleanup()) resolve(reply.bytes);
      };
      worker.onerror = event => fail(new PcadSaveWorkerError('crashed', event.message));
      worker.onmessageerror = () => fail(new PcadSaveWorkerError('crashed', '3MF reply could not be read'));
      control.signal?.addEventListener('abort', cancel, { once: true });
      try {
        assertThreeMfCurrent(control, deadlineAt);
        const transfer: Transferable[] = [];
        for (const mesh of owned) {
          if (!(mesh.positions instanceof Float32Array) || !(mesh.indices instanceof Uint32Array)) {
            throw new PcadSaveWorkerError('rejected', 'Invalid owned 3MF mesh');
          }
          if (!(mesh.positions.buffer instanceof ArrayBuffer) || !(mesh.indices.buffer instanceof ArrayBuffer)) {
            throw new PcadSaveWorkerError('rejected', 'Shared 3MF mesh cannot be transferred');
          }
          transfer.push(mesh.positions.buffer, mesh.indices.buffer);
        }
        const workerRemainingMs = Math.min(deadlineAt - performance.now(), 25_000);
        if (workerRemainingMs <= 0) throw new ThreeMfExportLimitError('deadline');
        worker.postMessage({ id, kind: 'export3mf', meshes: owned,
          remainingMs: workerRemainingMs }, transfer);
      } catch (error) { fail(error); }
    });
  };
}

export const encodeThreeMfInWorker = createThreeMfExportEncoder();

export interface PcadSavePointClient {
  list(signal?: AbortSignal): Promise<readonly NamedSavePoint[]>;
  create(name: string, bytes: Uint8Array, kind: SavePointKind, signal?: AbortSignal): Promise<NamedSavePoint>;
  createAndList(name: string, bytes: Uint8Array, kind: SavePointKind, signal?: AbortSignal): Promise<CreatedSavePointListing>;
  clone(id: string, name: string, signal?: AbortSignal): Promise<NamedSavePoint>;
  cloneAndList(id: string, name: string, signal?: AbortSignal): Promise<PcadCloneAndListResult>;
  read(id: string, signal?: AbortSignal): Promise<{ readonly point: NamedSavePoint; readonly bytes: Uint8Array }>;
}

/** IDBを使う保存点だけはcancel通知→transaction結果返信の順にWorkerを終える。 */
export function createPcadSavePointClient(createWorker: () => PcadSaveWorkerPort = browserWorker): PcadSavePointClient {
  const run = (makeRequest: (id: string) => PcadSavePointRequest, signal?: AbortSignal): Promise<PcadSavePointReply> => {
    signal?.throwIfAborted();
    const worker = createWorker(), id = crypto.randomUUID(), request = makeRequest(id);
    return new Promise<PcadSavePointReply>((resolve, reject) => {
      let finished = false, cancelling = false, timeout: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): boolean => {
        if (finished) return false;
        finished = true;
        worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
        signal?.removeEventListener('abort', cancel);
        if (timeout !== null) clearTimeout(timeout);
        worker.terminate();
        return true;
      };
      const fail = (error: unknown): void => { if (cleanup()) reject(error instanceof Error ? error : new Error(String(error))); };
      const cancel = (): void => {
        if (finished || cancelling) return;
        cancelling = true;
        if (timeout !== null) clearTimeout(timeout);
        try { worker.postMessage({ id, kind: 'savePointCancel' }, []); }
        catch (cause) { fail(new PcadSaveWorkerError('rejected', cause instanceof Error ? cause.message : String(cause))); return; }
        // A crashed or unresponsive Worker cannot prove whether IDB committed; never roll back a point here.
        timeout = setTimeout(() => fail(new SavePointError('aborted', 'Save point cancellation did not finish')), 25_000);
      };
      worker.onmessage = event => {
        if (finished) return;
        const reply = event.data;
        if (typeof reply === 'object' && reply !== null && 'id' in reply && typeof reply.id === 'string' && reply.id !== id) return;
        if (!isPcadSavePointReply(reply) || reply.id !== id) {
          fail(new PcadSaveWorkerError('rejected', 'Invalid save point reply')); return;
        }
        if (cancelling) { fail(signal?.reason ?? new DOMException('Save point cancelled', 'AbortError')); return; }
        if (reply.kind === 'savePointFailure') fail(new SavePointError(reply.reason, reply.message));
        else if (reply.kind === 'savePointCancelled') fail(new SavePointError('cancelled', 'Save point cancelled'));
        else if (cleanup()) resolve(reply);
      };
      worker.onerror = event => fail(new PcadSaveWorkerError('crashed', event.message));
      worker.onmessageerror = () => fail(new PcadSaveWorkerError('crashed', 'Save point reply could not be read'));
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted === true) {
        fail(signal.reason ?? new DOMException('Save point cancelled', 'AbortError')); return;
      }
      timeout = setTimeout(() => fail(new SavePointError('aborted', 'Save point operation did not finish')), 25_000);
      const transfer: Transferable[] = (request.operation === 'create' || request.operation === 'createAndList')
        && request.bytes.buffer instanceof ArrayBuffer && request.bytes.byteOffset === 0
        && request.bytes.byteLength === request.bytes.buffer.byteLength ? [request.bytes.buffer] : [];
      try { worker.postMessage(request, transfer); }
      catch (cause) { fail(new PcadSaveWorkerError('rejected', cause instanceof Error ? cause.message : String(cause))); }
    });
  };
  return {
    async list(signal) {
      const reply = await run(id => ({ id, kind: 'savePoint', operation: 'list' }), signal);
      if (reply.kind !== 'savePointResult' || reply.operation !== 'list') throw new PcadSaveWorkerError('rejected', 'Wrong list reply');
      return reply.points;
    },
    async create(name, bytes, pointKind, signal) {
      const reply = await run(id => ({ id, kind: 'savePoint', operation: 'create', name, bytes, pointKind }), signal);
      if (reply.kind !== 'savePointResult' || reply.operation !== 'create') throw new PcadSaveWorkerError('rejected', 'Wrong create reply');
      return reply.point;
    },
    async createAndList(name, bytes, pointKind, signal) {
      const reply = await run(id => ({ id, kind: 'savePoint', operation: 'createAndList', name, bytes, pointKind }), signal);
      if (reply.kind !== 'savePointResult' || reply.operation !== 'createAndList')
        throw new PcadSaveWorkerError('rejected', 'Wrong create and list reply');
      return { point: reply.point, points: reply.points };
    },
    async clone(pointId, name, signal) {
      const reply = await run(id => ({ id, kind: 'savePoint', operation: 'clone', pointId, name }), signal);
      if (reply.kind !== 'savePointResult' || reply.operation !== 'clone') throw new PcadSaveWorkerError('rejected', 'Wrong clone reply');
      return reply.point;
    },
    async cloneAndList(pointId, name, signal) {
      const reply = await run(id => ({ id, kind: 'savePoint', operation: 'cloneAndList', pointId, name }), signal);
      if (reply.kind !== 'savePointResult' || reply.operation !== 'cloneAndList')
        throw new PcadSaveWorkerError('rejected', 'Wrong clone and list reply');
      return { point: reply.point, listing: reply.listing };
    },
    async read(pointId, signal) {
      const reply = await run(id => ({ id, kind: 'savePoint', operation: 'read', pointId }), signal);
      if (reply.kind !== 'savePointResult' || reply.operation !== 'read') throw new PcadSaveWorkerError('rejected', 'Wrong read reply');
      return { point: reply.point, bytes: reply.bytes };
    },
  };
}
