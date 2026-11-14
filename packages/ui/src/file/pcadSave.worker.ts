import { writeThreeMf } from '@pointercad/io';
import { createNamedSavePoints, SavePointError } from '../history/namedSavePoints.js';
import { createIndexedDbSavePointStorage } from '../history/namedSavePointStorage.js';
import { isPcadSavePointRequest, isPcadThreeMfRequest, type PcadSavePointReply, type PcadSavePointRequest,
  type PcadSaveReply, type PcadWorkerRequest } from './pcadSaveProtocol.js';
import { encodeOwnedSaveInput, encodeOwnedSaveInputParts } from './pcadSaveWorkerEncoding.js';

let activePoint: { readonly id: string; readonly controller: AbortController } | null = null;
const points = createNamedSavePoints(createIndexedDbSavePointStorage());

function sendPoint(reply: PcadSavePointReply, transfer: Transferable[] = []): void {
  self.postMessage(reply, { transfer });
}

/**
 * 部分の並びの各領域を 1 回ずつ移す(写さない)。同じ領域を見る部分が複数あっても移すのは 1 回で、受け手の
 * 見せ方はそのまま残る。部分はこの Worker の符号化の出力か、この Worker へ移された入力の写しだけで、
 * 返信の後に Worker は終了する。共有メモリーは移せないので断る。
 */
function partsTransfer(parts: readonly Uint8Array[]): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const part of parts) {
    if (!(part.buffer instanceof ArrayBuffer)) throw new Error('Unexpected shared save output');
    buffers.add(part.buffer);
  }
  return [...buffers];
}

async function savePoint(request: PcadSavePointRequest, signal: AbortSignal): Promise<PcadSavePointReply> {
  if (request.operation === 'list') return { id: request.id, kind: 'savePointResult', operation: 'list',
    points: await points.list(signal) };
  if (request.operation === 'createAndList') return { id: request.id, kind: 'savePointResult', operation: 'createAndList',
    ...await points.createAndList(request.name, request.bytes, request.pointKind, signal) };
  if (request.operation === 'create') return { id: request.id, kind: 'savePointResult', operation: 'create',
    point: await points.create(request.name, request.bytes, request.pointKind, signal) };
  if (request.operation === 'clone') return { id: request.id, kind: 'savePointResult', operation: 'clone',
    point: await points.clone(request.pointId, request.name, signal) };
  if (request.operation === 'cloneAndList') {
    const point = await points.clone(request.pointId, request.name, signal);
    // Re-read and independently validate after the clone transaction commits.
    try {
      const listing = await points.list(signal);
      return { id: request.id, kind: 'savePointResult', operation: 'cloneAndList',
        point, listing: { ok: true, points: listing } };
    } catch (cause) {
      if (signal.aborted) throw cause;
      // A failed refresh must not erase or report failure of the committed clone.
      return { id: request.id, kind: 'savePointResult', operation: 'cloneAndList', point,
        listing: { ok: false, reason: cause instanceof SavePointError ? cause.reason : 'unavailable',
          message: (cause instanceof Error ? cause.message : String(cause)).slice(0, 4096) } };
    }
  }
  const result = await points.read(request.pointId, signal);
  return { id: request.id, kind: 'savePointResult', operation: 'read', ...result };
}

/** 同一配信元のmodule Worker専用。要求1件ごとに所有者が生成し、必ず終了させる。 */
self.onmessage = (event: MessageEvent<PcadWorkerRequest>): void => {
  if (typeof event.data !== 'object' || event.data === null) return;
  if ('kind' in event.data && event.data.kind === 'export3mf') {
    if (!isPcadThreeMfRequest(event.data)) return;
    const request = event.data;
    try {
      const bytes = writeThreeMf(request.meshes, { remainingMs: request.remainingMs });
      if (!(bytes.buffer instanceof ArrayBuffer)) throw new Error('Unexpected shared 3MF output');
      self.postMessage({ id: request.id, kind: 'export3mfSuccess', bytes }, { transfer: [bytes.buffer] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      self.postMessage({ id: request.id, kind: 'export3mfFailure', message: message.slice(0, 4096) });
    }
    return;
  }
  if ('kind' in event.data) {
    if (!isPcadSavePointRequest(event.data)) return;
    const request = event.data;
    if (request.kind === 'savePointCancel') {
      if (activePoint?.id === request.id) activePoint.controller.abort();
      return;
    }
    if (activePoint !== null) return;
    const controller = new AbortController();
    activePoint = { id: request.id, controller };
    void savePoint(request, controller.signal).then(reply => {
      if (reply.kind === 'savePointResult' && reply.operation === 'read') {
        if (!(reply.bytes.buffer instanceof ArrayBuffer)) throw new Error('Unexpected shared save point bytes');
        sendPoint(reply, [reply.bytes.buffer]);
      } else sendPoint(reply);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) sendPoint({ id: request.id, kind: 'savePointCancelled' });
      else sendPoint({ id: request.id, kind: 'savePointFailure',
        reason: cause instanceof SavePointError ? cause.reason : 'unavailable',
        message: cause instanceof Error ? cause.message : String(cause) });
    }).finally(() => { if (activePoint?.id === request.id) activePoint = null; });
    return;
  }
  const { id, input } = event.data;
  const send = (reply: PcadSaveReply, transfer: Transferable[] = []): void => {
    self.postMessage(reply, { transfer });
  };
  if (event.data.replyAsParts === true) {
    // 部分の並びのまま移す。全体の並びを作らないので、部分と全体の写しが同時に残る山を作らない。
    void encodeOwnedSaveInputParts(input, stage => send({ id, kind: 'progress', stage })).then(({ parts }) => {
      send({ id, kind: 'success', parts }, partsTransfer(parts));
    }).catch((error: unknown) => {
      send({ id, kind: 'failure', message: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  // 入力はこのWorkerの写しだけ。項目ができた時点で三角形の写しを手放してから圧縮する(E24)。
  void encodeOwnedSaveInput(input, stage => send({ id, kind: 'progress', stage })).then(({ bytes }) => {
    // エンコーダーが所有する出力だけを渡す。入力の原本はこのWorkerには存在しない。
    if (!(bytes.buffer instanceof ArrayBuffer)) throw new Error('Unexpected shared save output');
    send({ id, kind: 'success', bytes }, [bytes.buffer]);
  }).catch((error: unknown) => {
    send({ id, kind: 'failure', message: error instanceof Error ? error.message : String(error) });
  });
};
