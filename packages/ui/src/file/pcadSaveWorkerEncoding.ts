import { encodeSaveDocument, type SaveDocumentInput, type SaveEncodingStage } from '@pointercad/io';
import type { DrawingSourceInput } from '@pointercad/model';

/**
 * 保存 Worker の中だけで使う(E24)。Worker が受け取る入力は全て転送か複製で来た Worker 自身の写しで、
 * 文書の原本は Worker に存在しない。三角形は項目を作る時に `meshes/*.bin` 用の新しいバイト列へ符号化されるので、
 * 項目ができた後は生の配列の写しを持ち続ける理由がない。圧縮の前に手放し、生の写し・符号化済みの項目・
 * 圧縮の出力が同時に生きないようにする(128MiB の保存で同時に生きる大きなコピーを1つ減らす)。
 * 形状・画像・サムネイルは項目がその写しをそのまま参照するので手放さず、それらと領域を共有する三角形も手放さない。
 */
interface OwnedMesh { readonly positions: Float32Array; readonly normals: Float32Array; readonly indices: Uint32Array }
interface OwnedAttachments {
  readonly shapes: ReadonlyMap<string, Uint8Array>;
  readonly meshes: ReadonlyMap<string, OwnedMesh>;
  readonly canvases: ReadonlyMap<string, Uint8Array>;
}

// ES2024 の ArrayBuffer.prototype.transfer(型の lib は ES2022)。切り離しと同時に元の領域を解放する。
// 無い実行環境では structuredClone の転送で切り離す(移った先は参照が無く、次の GC で解放される)。
const transferMethod: unknown = Reflect.get(ArrayBuffer.prototype, 'transfer');

function sourceAttachments(source: DrawingSourceInput): OwnedAttachments[] {
  if (source.sourceKind === 'part') return source.attachments === undefined ? [] : [source.attachments];
  return source.library === undefined ? [] : [...source.library.attachments.values()];
}

/** 入力の全ての添付の表(三角形・形状・画像)と、サムネイル。 */
function ownedParts(input: SaveDocumentInput): { tables: OwnedAttachments[]; thumbnails: Uint8Array[] } {
  if (input.kind === 'part') return { tables: input.options.attachments === undefined ? [] : [input.options.attachments],
    thumbnails: input.options.thumbnailPng === undefined ? [] : [input.options.thumbnailPng] };
  if (input.kind === 'assembly') return { tables: [input.bundle.attachments,
    ...[...input.bundle.embeddedDocuments.values()].map(part => part.attachments)],
  thumbnails: input.options.thumbnailPng === undefined ? [] : [input.options.thumbnailPng] };
  if (input.kind === 'drawing') return { tables: sourceAttachments(input.options.source),
    thumbnails: input.options.thumbnailPng === undefined ? [] : [input.options.thumbnailPng] };
  return { tables: [], thumbnails: [] };
}

function releaseBuffer(view: Float32Array | Uint32Array, retained: ReadonlySet<ArrayBufferLike>): number {
  const buffer = view.buffer;
  // 切り離し済み・共有メモリー・空の領域、項目が参照する領域は対象にしない(同じ領域を二度切り離さない)。
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0 || retained.has(buffer)) return 0;
  const bytes = buffer.byteLength;
  if (typeof transferMethod === 'function') Reflect.apply(transferMethod, buffer, [0]);
  else structuredClone(buffer, { transfer: [buffer] });
  return bytes;
}

/** Worker 自身の写しの三角形の配列を切り離し、手放した容量を返す。原本を持つスレッドから呼ばない。 */
export function releaseOwnedMeshCopies(input: SaveDocumentInput): number {
  const { tables, thumbnails } = ownedParts(input);
  // 形状・画像・サムネイルの項目は入力の写しをそのまま書くので、その領域は三角形と共有していても残す。
  const retained = new Set<ArrayBufferLike>(thumbnails.map(bytes => bytes.buffer));
  for (const table of tables) for (const bytes of [...table.shapes.values(), ...table.canvases.values()]) retained.add(bytes.buffer);
  let released = 0;
  for (const table of tables) for (const mesh of table.meshes.values()) {
    released += releaseBuffer(mesh.positions, retained) + releaseBuffer(mesh.normals, retained)
      + releaseBuffer(mesh.indices, retained);
  }
  return released;
}

export interface OwnedSaveEncoding {
  readonly bytes: Uint8Array;
  /** 圧縮の前に手放した三角形の写しの容量。 */
  readonly releasedMeshBytes: number;
}

/** Worker が所有する入力を符号化する。項目ができた直後(圧縮の前)に三角形の写しを手放す。 */
export async function encodeOwnedSaveInput(input: SaveDocumentInput,
  onProgress: (stage: SaveEncodingStage) => void): Promise<OwnedSaveEncoding> {
  let releasedMeshBytes = 0;
  const bytes = await encodeSaveDocument(input, { onProgress,
    onEntriesBuilt: () => { releasedMeshBytes = releaseOwnedMeshCopies(input); } });
  return { bytes, releasedMeshBytes };
}
