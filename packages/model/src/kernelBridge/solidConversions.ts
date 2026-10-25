/** 立体の再計算と外観の依頼・結果を変換する。接続や非同期ジョブを所有しない。 */
import type {
  AppearanceMatch, AppearanceQuery, SolidBodyMesh, SolidRecomputeRequest, SolidRecomputeResult,
} from '@pointercad/kernel';
import type { ResolvedSolidStep } from '../part/resolvePart.js';
import type {
  AppearanceFaceRequest, AppearanceMatchEntry, SolidBody, SolidBodyFailure,
  MeshJsAccountingReading, MeshJsAccountingReceipt, MeshJsFinalAccountingReading, SolidRecomputeContext,
  SolidRecomputeOutcome, SolidRecomputeOptions,
} from './solidContracts.js';
import { toSubShapeQuery } from './subShapeQuery.js';
import { toSolidStepRequest } from './solidRequests.js';

/* ------------------------------------------------------------------ *
 * 外観の面の照合(FR-1106、P5 §2.2.3、タスク4)
 * ------------------------------------------------------------------ */

/**
 * 外観を割り当てた面を、カーネルへの照合の依頼へ詰め替える(§2.2.3)。
 *
 * **依頼が 1 件も無ければ空配列を返す。** カーネルは空なら照合の段そのものを飛ばし、
 * 物差し(境界箱の対角長)を測るための OCCT の呼び出しも 1 回も行わない
 * (§0.a-0.54「外観の追加で所要を増やさない」)。
 *
 * 次の 2 つは依頼に乗せずに落とす。落とした割り当ては `toAppearanceMatches` が
 * `faceIndex: null`(= 見つからない)で必ず補うので、件数は依頼元と食い違わない。
 *
 * - **段が見つからない割り当て**: そのフィーチャーが履歴から消えた、抑制された、
 *   ブーリアンに消費された場合。鍵が引けないので照合しようがない。
 * - **面以外の指紋**: 外観は面にしか付かない(`AppearanceTarget`)が、指紋の型は
 *   辺・頂点も表せるので、種類で守る(カーネルも面以外は断る)。
 */
export function toAppearanceQueries(
  steps: readonly ResolvedSolidStep[],
  requests: readonly AppearanceFaceRequest[],
): readonly AppearanceQuery[] {
  if (requests.length === 0) {
    return [];
  }
  const keyByFeatureId = new Map(steps.map((step) => [step.featureId, step.key]));
  const queries: AppearanceQuery[] = [];
  for (const request of requests) {
    const bodyKey = keyByFeatureId.get(request.bodyFeatureId);
    if (bodyKey === undefined || request.ref.fingerprint.kind !== 'face') {
      continue;
    }
    queries.push({ id: request.id, bodyKey, query: toSubShapeQuery(request.ref) });
  }
  return queries;
}

/**
 * 照合の結果を model の言葉へ詰め替える(§2.2.3)。
 *
 * **戻りは依頼(`requests`)と同じ並び・同じ件数**で、依頼に乗せなかったもの・
 * カーネルが返さなかったものは `faceIndex: null` で補う。呼び出し側(ui)は
 * 「見つからない割り当てが n 件」を数えるだけでよく、どこで落ちたかを気にしなくて済む。
 *
 * ボディの id は**文書側の値をそのまま返す**。カーネルは面の属するボディが
 * 見つからないときに空文字を返す約束だが、見つかったときの値は「段の id = ボディの id」
 * (§0.a-0.5)より必ず `request.bodyFeatureId` と同じなので、空文字を外へ出す意味が無い。
 */
export function toAppearanceMatches(
  requests: readonly AppearanceFaceRequest[],
  matches: readonly AppearanceMatch[] | undefined,
): readonly AppearanceMatchEntry[] {
  if (requests.length === 0) {
    return [];
  }
  const faceIndexById = new Map((matches ?? []).map((match) => [match.id, match.faceIndex]));
  return requests.map((request) => ({
    id: request.id,
    bodyFeatureId: request.bodyFeatureId,
    faceIndex: faceIndexById.get(request.id) ?? null,
  }));
}

/**
 * 立体の再計算の依頼を 1 つ組み立てる(Worker 版と直結版で同じものを使う)。
 *
 * ## 段ごとの三角形分割の粗さ(§2.13、§0.a-0.54)について
 *
 * `SolidStepRequest.tessellation` にはここでは何も入れず、**粗さの規則はカーネルに
 * 1 か所だけ置いたままにする**(`recomputeSolids.ts` の `isRelaxableSweepStep`。
 * ばねと実らせんのねじ穴を 0.15 / 0.7 へ緩める、P3 仕上げ (a) の実測)。
 * 同じ規則を model にも書くと 2 か所になり、片方だけ直したときに食い違うため。
 * カーネルは「段ごとの指定 > 全体の指定 > 段の種類の既定」の順で選ぶので、ここで
 * 値を添えるとカーネルの既定の方が負けてしまう。基本形状(球・トーラス)を緩める案は
 * **効き目が無いことがタスク14 で実測された**(球 r10 は 0.8 を添えても 978 枚のまま)
 * ので入れない。利用者が粗さを選べるようにする段になったら、その値だけをここへ通す。
 */
export function toSolidRecomputeRequest(
  steps: readonly ResolvedSolidStep[],
  options: SolidRecomputeOptions,
): SolidRecomputeRequest {
  const local = options.localMesh;
  if (local !== undefined && (local === null
    || !Number.isFinite(local.maximumFloat32ErrorMm) || local.maximumFloat32ErrorMm <= 0
    || !Number.isSafeInteger(local.maximumLiveMeshBytes)
    || local.maximumLiveMeshBytes <= 0 || local.maximumLiveMeshBytes > 512 * 1024 * 1024)) {
    throw new RangeError('Local mesh requires finite positive display and memory budgets');
  }
  return {
    partId: options.partId,
    steps: steps.map((step) => toSolidStepRequest(step)),
    generation: options.generation ?? 0,
    appearanceQueries: toAppearanceQueries(steps, options.appearance ?? []),
    measureAreas: options.measureAreas ?? false,
    ...(local === undefined ? {} : { localMesh: Object.freeze({
      maximumFloat32ErrorMm: local.maximumFloat32ErrorMm,
      maximumLiveMeshBytes: local.maximumLiveMeshBytes,
    }) }),
  };
}

/** Capture before awaiting transport; later changes to caller options cannot relabel a reply. */
export function captureSolidRecomputeContext(request: SolidRecomputeRequest): SolidRecomputeContext {
  return Object.freeze({ partId: request.partId ?? 'part:current', generation: request.generation,
    ...(request.localMesh === undefined ? {} : { localMesh: Object.freeze({
      maximumFloat32ErrorMm: request.localMesh.maximumFloat32ErrorMm,
      maximumLiveMeshBytes: request.localMesh.maximumLiveMeshBytes,
    }) }) });
}

function accountingObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function byteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Reads a bounded reservation, never converts unknown to zero or adds another clone term. */
export function readMeshJsAccounting(value: unknown, limitBytes: number): MeshJsAccountingReading {
  if (!byteCount(limitBytes) || limitBytes === 0 || limitBytes > 512 * 1024 * 1024
    || !accountingObject(value) || value.limitBytes !== limitBytes) {
    throw new RangeError('Local mesh accounting limit is invalid or missing');
  }
  const fields = value.status === 'known'
    ? ['status', 'limitBytes', 'cacheActiveBytes', 'cacheRetiredBytes', 'cacheProtectedBytes',
      'retainedReplyBytes', 'requestPeakReservedBytes']
    : ['status', 'limitBytes', 'reason'];
  if (Object.keys(value).length !== fields.length
    || !fields.every(key => Object.prototype.hasOwnProperty.call(value, key))) {
    throw new RangeError('Local mesh accounting fields are invalid');
  }
  if (value.status === 'unknown') {
    const reason = value.reason;
    if (reason !== 'callback-missing' && reason !== 'callback-error' && reason !== 'missing-counts'
      && reason !== 'invalid-byte-count' && reason !== 'overflow') {
      throw new RangeError('Local mesh accounting reason is invalid');
    }
    return Object.freeze({ status: 'unknown', limitBytes, reason });
  }
  const { cacheActiveBytes, cacheRetiredBytes, cacheProtectedBytes, retainedReplyBytes,
    requestPeakReservedBytes } = value;
  if (value.status !== 'known' || !byteCount(cacheActiveBytes) || !byteCount(cacheRetiredBytes)
    || !byteCount(cacheProtectedBytes) || !byteCount(retainedReplyBytes)
    || !byteCount(requestPeakReservedBytes)) {
    throw new RangeError('Local mesh accounting byte counts are invalid');
  }
  const cacheBytes = cacheActiveBytes + cacheRetiredBytes;
  const reservedBytes = cacheBytes + retainedReplyBytes;
  if (!byteCount(cacheBytes) || !byteCount(reservedBytes) || cacheProtectedBytes > cacheBytes
    || reservedBytes > requestPeakReservedBytes || requestPeakReservedBytes > limitBytes) {
    throw new RangeError('Local mesh accounting reservation exceeds its bound');
  }
  return Object.freeze({ status: 'known', limitBytes, cacheActiveBytes, cacheRetiredBytes,
    cacheProtectedBytes, retainedReplyBytes, requestPeakReservedBytes });
}

/**
 * Reads the post-token Worker union. Each part must fit inside the union, the union cannot exceed
 * its parts, and the clone must equal the reply's whole buffers; unknown never becomes zero.
 */
export function readMeshJsFinalAccounting(value: unknown, limitBytes: number): MeshJsFinalAccountingReading {
  if (!byteCount(limitBytes) || limitBytes === 0 || limitBytes > 512 * 1024 * 1024
    || !accountingObject(value) || value.limitBytes !== limitBytes) {
    throw new RangeError('Local mesh final accounting limit is invalid or missing');
  }
  const fields = value.status === 'known'
    ? ['status', 'limitBytes', 'cacheActiveBytes', 'cacheRetiredBytes', 'cacheProtectedBytes',
      'displayBackingBytes', 'replyBackingBytes', 'retainedBackingBytes', 'replyCloneReservedBytes']
    : ['status', 'limitBytes', 'reason'];
  if (Object.keys(value).length !== fields.length
    || !fields.every(key => Object.prototype.hasOwnProperty.call(value, key))) {
    throw new RangeError('Local mesh final accounting fields are invalid');
  }
  if (value.status === 'unknown') {
    const reason = value.reason;
    if (reason !== 'callback-missing' && reason !== 'callback-error' && reason !== 'invalid-byte-count'
      && reason !== 'overflow') {
      throw new RangeError('Local mesh final accounting reason is invalid');
    }
    return Object.freeze({ status: 'unknown', limitBytes, reason });
  }
  const { cacheActiveBytes, cacheRetiredBytes, cacheProtectedBytes, displayBackingBytes,
    replyBackingBytes, retainedBackingBytes, replyCloneReservedBytes } = value;
  if (value.status !== 'known' || !byteCount(cacheActiveBytes) || !byteCount(cacheRetiredBytes)
    || !byteCount(cacheProtectedBytes) || !byteCount(displayBackingBytes) || !byteCount(replyBackingBytes)
    || !byteCount(retainedBackingBytes) || !byteCount(replyCloneReservedBytes)) {
    throw new RangeError('Local mesh final accounting byte counts are invalid');
  }
  const cacheBytes = cacheActiveBytes + cacheRetiredBytes;
  const partsBytes = cacheBytes + displayBackingBytes + replyBackingBytes;
  if (!byteCount(cacheBytes) || !byteCount(partsBytes)
    || !byteCount(retainedBackingBytes + replyCloneReservedBytes) || cacheProtectedBytes > cacheBytes
    || cacheBytes > retainedBackingBytes || displayBackingBytes > retainedBackingBytes
    || replyBackingBytes > retainedBackingBytes || retainedBackingBytes > partsBytes
    || replyCloneReservedBytes !== replyBackingBytes) {
    throw new RangeError('Local mesh final accounting union is inconsistent');
  }
  return Object.freeze({ status: 'known', limitBytes, cacheActiveBytes, cacheRetiredBytes,
    cacheProtectedBytes, displayBackingBytes, replyBackingBytes, retainedBackingBytes,
    replyCloneReservedBytes });
}

function accountingReceipt(
  result: SolidRecomputeResult,
  context: SolidRecomputeContext | undefined,
): MeshJsAccountingReceipt | undefined {
  // Preserve historical conversions, including local fixtures, without issuing a safety receipt.
  if (context === undefined) return undefined;
  // Cancelled partial work is never a display publication.
  if (context.localMesh !== undefined && result.cancelled) return undefined;
  const budget = context.localMesh;
  if (budget === undefined) {
    if (result.meshJsAccounting !== undefined || result.meshJsFinalAccounting !== undefined
      || result.bodies.some(body => body.coordinateFrame !== undefined)) {
      throw new RangeError('World mesh request received a local reply');
    }
    return undefined;
  }
  if (typeof context.partId !== 'string' || context.partId.length === 0
    || !byteCount(context.generation) || !Number.isFinite(budget.maximumFloat32ErrorMm)
    || budget.maximumFloat32ErrorMm <= 0) {
    throw new RangeError('Local mesh dispatch context is invalid');
  }
  const reading = readMeshJsAccounting(result.meshJsAccounting, budget.maximumLiveMeshBytes);
  if (reading.status === 'unknown') throw new RangeError(`Local mesh accounting is unknown: ${reading.reason}`);
  const buffers = new Set<ArrayBuffer>();
  let receivedArrayBytes = 0;
  for (const body of result.bodies) {
    const frame = body.coordinateFrame;
    if (frame === undefined || frame.space !== 'local'
      || frame.maximumLiveMeshBytes !== budget.maximumLiveMeshBytes
      || !Number.isFinite(frame.maximumFloat32ErrorMm) || frame.maximumFloat32ErrorMm <= 0
      || frame.maximumFloat32ErrorMm > budget.maximumFloat32ErrorMm) {
      throw new RangeError('Local mesh frame does not match its dispatch budget');
    }
    // A small view cannot certify the allocation of a larger backing buffer.
    for (const array of [body.positions, body.normals, body.indices, body.edgePositions]) {
      if (!(array.buffer instanceof ArrayBuffer) || array.byteOffset !== 0
        || array.byteLength !== array.buffer.byteLength) {
        throw new RangeError('Local mesh backing buffer is not fully accounted');
      }
      if (!buffers.has(array.buffer)) {
        buffers.add(array.buffer);
        receivedArrayBytes += array.buffer.byteLength;
      }
    }
  }
  const replyArrayReservation = receivedArrayBytes * 2;
  if (!byteCount(receivedArrayBytes) || !byteCount(replyArrayReservation)
    || replyArrayReservation > reading.retainedReplyBytes) {
    throw new RangeError('Local mesh reply arrays exceed their reserved bytes');
  }
  // The post-token union is a separate kernel contract; a local reply without it is not adopted.
  const final = readMeshJsFinalAccounting(result.meshJsFinalAccounting, budget.maximumLiveMeshBytes);
  if (final.status === 'unknown') throw new RangeError(`Local mesh final accounting is unknown: ${final.reason}`);
  // Structured clone keeps distinct buffers distinct, so the received reply is the reported reply.
  if (final.replyBackingBytes !== receivedArrayBytes) {
    throw new RangeError('Local mesh final accounting does not match the reply arrays');
  }
  if (final.retainedBackingBytes + final.replyCloneReservedBytes > budget.maximumLiveMeshBytes) {
    throw new RangeError('Local mesh final retention exceeds its limit');
  }
  return Object.freeze({ partId: context.partId, generation: context.generation, reading, final });
}

/** 立体が消えたとき(画面に出すはずの段の結果も理由も返らなかったとき)に付ける理由。 */
const MISSING_BODY_MESSAGE = 'カーネルから立体が返りませんでした。';

/**
 * カーネルの結果を model のボディへ詰め替える。妥当性の判定は SolidBody.isValid の注釈のとおり。
 * `faces` / `edges` / `vertices` / `threadMarks` は kernel の一覧と欄の名前・形が同じなので
 * (計画書 §2.8)、詰め替えは配列をそのまま渡すだけで済む(model 独自の型として持つのは
 * `SolidFaceEntry` 等の型そのものを kernel から再輸出しないためで、値の変形は要らない)。
 */
function toSolidBody(mesh: SolidBodyMesh): SolidBody {
  const frame = mesh.coordinateFrame;
  if (frame !== undefined && (frame.space !== 'local'
    || !Array.isArray(frame.origin) || frame.origin.length !== 3
    || ![0, 1, 2].every((axis) => Object.prototype.hasOwnProperty.call(frame.origin, axis)
      && Number.isFinite(frame.origin[axis]))
    || !Number.isFinite(frame.maximumFloat32ErrorMm)
    || frame.maximumFloat32ErrorMm <= 0
    || (frame.maximumLiveMeshBytes !== undefined
      && (!Number.isSafeInteger(frame.maximumLiveMeshBytes)
        || frame.maximumLiveMeshBytes <= 0 || frame.maximumLiveMeshBytes > 512 * 1024 * 1024)))) {
    throw new RangeError('Local mesh frame is invalid');
  }
  return {
    featureId: mesh.id,
    ...(mesh.coordinateFrame === undefined ? {} : { coordinateFrame: mesh.coordinateFrame }),
    mesh: {
      positions: mesh.positions,
      normals: mesh.normals,
      indices: mesh.indices,
      edgePositions: mesh.edgePositions,
      triangleCount: mesh.triangleCount,
    },
    volume: mesh.volume,
    // 表面積は依頼が求めたときだけカーネルが測る(SolidRecomputeOptions.measureAreas)。
    // 測っていなければ欄ごと空のまま渡し、0 と偽らない。
    area: mesh.area,
    // 形の種類はカーネルの必須の欄(§0.a-0.77、タスク42b)なので、そのまま写す。
    // 判定は kernel の `hasSolid` そのままで、体積では決めない(体積 8000 の開いた殻がある)。
    bodyKind: mesh.bodyKind,
    isValid: mesh.triangleCount > 0 && Number.isFinite(mesh.volume) && (mesh.bodyKind === 'shell' || mesh.volume > 0),
    faces: mesh.faces,
    edges: mesh.edges,
    vertices: mesh.vertices,
    threadMarks: mesh.threadMarks,
    ...(mesh.origins === undefined ? {} : { origins: mesh.origins }),
  };
}

/**
 * カーネルの結果を model の言葉へ詰め替える。
 * 画面に出すはずの段(visible)なのにボディも理由も返らなかったものは、
 * 黙って消えないよう理由を補って失敗として扱う(FR-504。面の詰め替えと同じ書き方)。
 * 計算部のメモリの量(NFR-PF-6)は、カーネルが添えたときだけ `kernelMemory` へ写す。
 */
export function toSolidOutcome(
  steps: readonly ResolvedSolidStep[],
  result: SolidRecomputeResult,
  appearance: readonly AppearanceFaceRequest[] = [],
  context?: SolidRecomputeContext,
): SolidRecomputeOutcome {
  let meshJsAccounting: MeshJsAccountingReceipt | undefined;
  let bodies: SolidBody[] = [];
  if (!(context?.localMesh !== undefined && result.cancelled)) {
    try {
      // A feature failure does not invalidate independently successful, fully accounted bodies.
      meshJsAccounting = accountingReceipt(result, context);
      if (context?.localMesh !== undefined
        && result.bodies.some(body => result.failures.some(failure => failure.id === body.id))) {
        throw new RangeError('Local mesh body also reports a failure');
      }
      bodies = result.bodies.map((mesh) => toSolidBody(mesh));
    } catch (error) {
      // Keep terminal facts for unsafe failed replies, without publishing any body or receipt.
      if (context?.localMesh === undefined || result.failures.length === 0 || !(error instanceof RangeError)) throw error;
      meshJsAccounting = undefined;
    }
  }
  const collected: SolidBodyFailure[] = result.failures.map((failure) => ({
    featureId: failure.id,
    message: failure.message,
    ...(failure.code === undefined ? {} : { code: failure.code }),
  }));

  // Returned and intentionally suppressed bodies both preserve the kernel's failure facts.
  const reported = new Set<string>(result.bodies.map((body) => body.id));
  for (const failure of collected) {
    reported.add(failure.featureId);
  }
  for (const step of steps) {
    // 途中で打ち切られた段は「まだ計算していない」だけなので、失敗にしない(NFR-PF-4)。
    if (step.visible && !reported.has(step.featureId) && !result.cancelled) {
      collected.push({ featureId: step.featureId, message: MISSING_BODY_MESSAGE });
    }
  }

  return {
    bodies,
    failures: collected,
    cacheHits: result.cacheHits,
    cancelled: result.cancelled,
    appearanceMatches: toAppearanceMatches(appearance, result.appearanceMatches),
    ...(meshJsAccounting === undefined ? {} : { meshJsAccounting }),
    ...(result.memory === undefined
      ? {}
      : {
          kernelMemory: {
            usedBytes: result.memory.wasmHeapBytes,
            limitBytes: result.memory.wasmHeapLimitBytes,
          },
        }),
  };
}
