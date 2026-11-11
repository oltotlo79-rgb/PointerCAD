import type { SaveDocumentInput, SaveEncodingStage } from '@pointercad/io';
import { IO_LIMITS, THREE_MF_EXPORT_BYTE_LIMIT, THREE_MF_EXPORT_TIME_LIMIT_MS,
  type ThreeMfMeshInput } from '@pointercad/io';
import { isNamedSavePoint, type CreatedSavePointListing, type NamedSavePoint, type SavePointErrorCode, type SavePointKind } from '../history/namedSavePoints.js';

export interface PcadSaveRequest {
  readonly id: string;
  readonly input: SaveDocumentInput;
}
export type PcadSaveReply =
  | { readonly id: string; readonly kind: 'progress'; readonly stage: SaveEncodingStage }
  | { readonly id: string; readonly kind: 'success'; readonly bytes: Uint8Array }
  | { readonly id: string; readonly kind: 'failure'; readonly message: string };

export function isPcadSaveReply(value: unknown): value is PcadSaveReply {
  if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string'
    || !('kind' in value)) return false;
  if (value.kind === 'progress') return 'stage' in value && (value.stage === 'preparing' || value.stage === 'compressing');
  if (value.kind === 'success') return 'bytes' in value && value.bytes instanceof Uint8Array;
  return value.kind === 'failure' && 'message' in value && typeof value.message === 'string';
}

/** 通常保存と同じ短命Workerへ渡す保存点操作。文書本体の参照は渡さない。 */
export type PcadSavePointRequest =
  | { readonly id: string; readonly kind: 'savePoint'; readonly operation: 'list' }
  | { readonly id: string; readonly kind: 'savePoint'; readonly operation: 'create';
    readonly name: string; readonly pointKind: SavePointKind; readonly bytes: Uint8Array }
  | { readonly id: string; readonly kind: 'savePoint'; readonly operation: 'createAndList';
    readonly name: string; readonly pointKind: SavePointKind; readonly bytes: Uint8Array }
  | { readonly id: string; readonly kind: 'savePoint'; readonly operation: 'clone';
    readonly pointId: string; readonly name: string }
  | { readonly id: string; readonly kind: 'savePoint'; readonly operation: 'cloneAndList';
    readonly pointId: string; readonly name: string }
  | { readonly id: string; readonly kind: 'savePoint'; readonly operation: 'read'; readonly pointId: string };
export interface PcadSavePointCancelRequest { readonly id: string; readonly kind: 'savePointCancel' }
export interface PcadThreeMfRequest {
  readonly id: string;
  readonly kind: 'export3mf';
  readonly meshes: readonly ThreeMfMeshInput[];
  readonly remainingMs: number;
}
export type PcadThreeMfReply =
  | { readonly id: string; readonly kind: 'export3mfSuccess'; readonly bytes: Uint8Array }
  | { readonly id: string; readonly kind: 'export3mfFailure'; readonly message: string };
export type PcadWorkerRequest = PcadSaveRequest | PcadSavePointRequest | PcadSavePointCancelRequest | PcadThreeMfRequest;

export interface PcadCloneAndListResult {
  readonly point: NamedSavePoint;
  readonly listing: { readonly ok: true; readonly points: readonly NamedSavePoint[] }
    | { readonly ok: false; readonly reason: SavePointErrorCode; readonly message: string };
}

export type PcadSavePointReply =
  | ({ readonly id: string; readonly kind: 'savePointResult'; readonly operation: 'createAndList' } & CreatedSavePointListing)
  | ({ readonly id: string; readonly kind: 'savePointResult'; readonly operation: 'cloneAndList' } & PcadCloneAndListResult)
  | { readonly id: string; readonly kind: 'savePointResult'; readonly operation: 'list'; readonly points: readonly NamedSavePoint[] }
  | { readonly id: string; readonly kind: 'savePointResult'; readonly operation: 'create' | 'clone'; readonly point: NamedSavePoint }
  | { readonly id: string; readonly kind: 'savePointResult'; readonly operation: 'read';
    readonly point: NamedSavePoint; readonly bytes: Uint8Array }
  | { readonly id: string; readonly kind: 'savePointFailure'; readonly reason: SavePointErrorCode; readonly message: string }
  | { readonly id: string; readonly kind: 'savePointCancelled' };

const ERROR_REASONS: ReadonlySet<string> = new Set([
  'invalid', 'corrupt', 'limitPoints', 'limitBytes', 'unavailable', 'quota', 'aborted', 'conflict', 'cancelled',
]);
const boundedId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 64;
const boundedName = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;

export function isPcadThreeMfRequest(value: unknown): value is PcadThreeMfRequest {
  if (typeof value !== 'object' || value === null || !('id' in value) || !boundedId(value.id)
    || !('kind' in value) || value.kind !== 'export3mf'
    || !('remainingMs' in value) || typeof value.remainingMs !== 'number'
    || !Number.isFinite(value.remainingMs) || value.remainingMs <= 0
    || value.remainingMs > THREE_MF_EXPORT_TIME_LIMIT_MS
    || !('meshes' in value) || !Array.isArray(value.meshes)) return false;
  return value.meshes.every((mesh: unknown) => typeof mesh === 'object' && mesh !== null
    && 'name' in mesh && (mesh.name === null || typeof mesh.name === 'string')
    && 'color' in mesh && (mesh.color === null || (Array.isArray(mesh.color) && mesh.color.length === 3
      && mesh.color.every((channel: unknown) => typeof channel === 'number')))
    && 'positions' in mesh && mesh.positions instanceof Float32Array
    && 'indices' in mesh && mesh.indices instanceof Uint32Array
    && (!('faceColors' in mesh) || mesh.faceColors === undefined || mesh.faceColors instanceof Map)
    && (!('faceRanges' in mesh) || mesh.faceRanges === undefined || Array.isArray(mesh.faceRanges)));
}

export function isPcadThreeMfReply(value: unknown): value is PcadThreeMfReply {
  if (typeof value !== 'object' || value === null || !('id' in value) || !boundedId(value.id)
    || !('kind' in value)) return false;
  if (value.kind === 'export3mfSuccess') return 'bytes' in value && value.bytes instanceof Uint8Array
    && value.bytes.byteLength <= THREE_MF_EXPORT_BYTE_LIMIT;
  return value.kind === 'export3mfFailure' && 'message' in value
    && typeof value.message === 'string' && value.message.length <= 4096;
}

export function isPcadSavePointRequest(value: unknown): value is PcadSavePointRequest | PcadSavePointCancelRequest {
  if (typeof value !== 'object' || value === null || !('id' in value) || !boundedId(value.id)
    || !('kind' in value)) return false;
  if (value.kind === 'savePointCancel') return true;
  if (value.kind !== 'savePoint' || !('operation' in value)) return false;
  if (value.operation === 'list') return true;
  if (value.operation === 'create' || value.operation === 'createAndList') return 'name' in value && boundedName(value.name)
    && 'pointKind' in value && (value.pointKind === 'part' || value.pointKind === 'assembly' || value.pointKind === 'drawing')
    && 'bytes' in value && value.bytes instanceof Uint8Array && value.bytes.byteLength <= IO_LIMITS.archiveCompressedBytes;
  if (value.operation === 'clone' || value.operation === 'cloneAndList') return 'pointId' in value && boundedId(value.pointId)
    && 'name' in value && boundedName(value.name);
  return value.operation === 'read' && 'pointId' in value && boundedId(value.pointId);
}

export function isPcadSavePointReply(value: unknown): value is PcadSavePointReply {
  if (typeof value !== 'object' || value === null || !('id' in value) || !boundedId(value.id)
    || !('kind' in value)) return false;
  if (value.kind === 'savePointCancelled') return true;
  if (value.kind === 'savePointFailure') return 'reason' in value && typeof value.reason === 'string'
    && ERROR_REASONS.has(value.reason) && 'message' in value && typeof value.message === 'string'
    && value.message.length <= 4096;
  if (value.kind !== 'savePointResult' || !('operation' in value)) return false;
  if (value.operation === 'createAndList') {
    if (!('point' in value) || !isNamedSavePoint(value.point) || !('points' in value)
      || !Array.isArray(value.points) || value.points.length === 0 || value.points.length > 100
      || !Array.from(value.points).every(isNamedSavePoint)) return false;
    const point = value.point, points = value.points as NamedSavePoint[];
    if (new Set(points.map(item => item.id)).size !== points.length) return false;
    const listed = points.find(item => item.id === point.id);
    return listed !== undefined && listed.originId === point.originId && listed.name === point.name
      && listed.createdAt === point.createdAt && listed.kind === point.kind
      && listed.sourceSha256 === point.sourceSha256 && listed.sourceByteLength === point.sourceByteLength
      && listed.entries.length === point.entries.length && listed.entries.every((entry, index) => {
        const other = point.entries[index];
        return other !== undefined && entry.name === other.name && entry.sha256 === other.sha256
          && entry.byteLength === other.byteLength && entry.level === other.level;
      });
  }
  if (value.operation === 'cloneAndList') {
    if (!('point' in value) || !isNamedSavePoint(value.point) || !('listing' in value)
      || typeof value.listing !== 'object' || value.listing === null || !('ok' in value.listing)) return false;
    const listing = value.listing;
    if (listing.ok === true) return 'points' in listing && Array.isArray(listing.points)
      && listing.points.length <= 100 && listing.points.every(isNamedSavePoint);
    return listing.ok === false && 'reason' in listing && typeof listing.reason === 'string'
      && ERROR_REASONS.has(listing.reason) && 'message' in listing && typeof listing.message === 'string'
      && listing.message.length <= 4096;
  }
  if (value.operation === 'list') return 'points' in value && Array.isArray(value.points)
    && value.points.length <= 100 && value.points.every(isNamedSavePoint);
  if (value.operation === 'create' || value.operation === 'clone')
    return 'point' in value && isNamedSavePoint(value.point);
  return value.operation === 'read' && 'point' in value && isNamedSavePoint(value.point)
    && 'bytes' in value && value.bytes instanceof Uint8Array && value.bytes.byteLength <= IO_LIMITS.archiveCompressedBytes;
}
