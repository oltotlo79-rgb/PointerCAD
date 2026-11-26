import { concatZipParts, encodeOwnedSaveDocumentParts, type OwnedSaveEncodingControl, type SaveDocumentInput,
  type SaveEncodingStage } from '@pointercad/io';
import type { DrawingSourceInput } from '@pointercad/model';
import type { SaveResultIssueReport } from './saveResultIssue.js';

/**
 * 保存 Worker の中だけで使う(E24)。Worker が受け取る入力は全て転送か複製で来た Worker 自身の写しで、
 * 文書の原本は Worker に存在しない。大きな三角形は圧縮する区切りだけを符号化する。
 * 項目を作り終えた成分の生の写しは、その領域を読む物が無くなった時点で手放す。
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

/** 形状・画像・サムネイルの項目は入力の写しをそのまま書くので、その領域は三角形と共有していても残す。 */
function retainedBuffers(tables: readonly OwnedAttachments[], thumbnails: readonly Uint8Array[]): Set<ArrayBufferLike> {
  const retained = new Set<ArrayBufferLike>(thumbnails.map(bytes => bytes.buffer));
  for (const table of tables) for (const bytes of [...table.shapes.values(), ...table.canvases.values()]) retained.add(bytes.buffer);
  return retained;
}

/**
 * 三角形の成分を項目の区切りへ書き終えた知らせ(A-10)を受けて、その成分の領域を読む三角形の成分が残っていなければ
 * 手放す関数を作る。読み手は、全部の表の全部の三角形の成分で同じ領域を指す物を先に数える(区切りに書かない小さい三角形・
 * そろっていない三角形も数えるので、それらが読む領域は早く手放さない)。返す値は手放した容量。
 */
function componentReleaser(input: SaveDocumentInput): (component: Float32Array | Uint32Array) => number {
  const { tables, thumbnails } = ownedParts(input);
  const retained = retainedBuffers(tables, thumbnails), readers = new Map<ArrayBufferLike, number>();
  for (const table of tables) for (const mesh of table.meshes.values()) {
    for (const view of [mesh.positions, mesh.normals, mesh.indices]) readers.set(view.buffer, (readers.get(view.buffer) ?? 0) + 1);
  }
  return component => {
    const left = (readers.get(component.buffer) ?? 0) - 1;
    readers.set(component.buffer, left);
    return left === 0 ? releaseBuffer(component, retained) : 0;
  };
}

/** Worker 自身の写しの三角形の配列を切り離し、手放した容量を返す。原本を持つスレッドから呼ばない。 */
export function releaseOwnedMeshCopies(input: SaveDocumentInput): number {
  const { tables, thumbnails } = ownedParts(input);
  const retained = retainedBuffers(tables, thumbnails);
  let released = 0;
  for (const table of tables) for (const mesh of table.meshes.values()) {
    released += releaseBuffer(mesh.positions, retained) + releaseBuffer(mesh.normals, retained)
      + releaseBuffer(mesh.indices, retained);
  }
  return released;
}

 interface OwnedSaveEncoding {
  readonly bytes: Uint8Array;
  /** 実際に手放した三角形の写しの容量。大型の三角形は圧縮中にも手放す。 */
  readonly releasedMeshBytes: number;
  /** 書き手が入れずに保存した解析の結果(主スレッドへ返して理由を出す)。 */
  readonly analysisResultIssues: readonly SaveResultIssueReport[];
}

interface OwnedSavePartsEncoding {
  /** 順につなぐとファイルの全体になる部分の並び。 */
  readonly parts: readonly Uint8Array[];
  /** 実際に手放した三角形の写しの容量。大型の三角形は圧縮中にも手放す。 */
  readonly releasedMeshBytes: number;
  /** 書き手が入れずに保存した解析の結果(主スレッドへ返して理由を出す)。 */
  readonly analysisResultIssues: readonly SaveResultIssueReport[];
}

/** 全体と部分のどちらの出力でも、成功・取消・例外で残った三角形の写しを手放す。 */
async function encodeOwned<Encoded>(input: SaveDocumentInput, onProgress: (stage: SaveEncodingStage) => void,
  encode: (input: SaveDocumentInput, control: OwnedSaveEncodingControl) => Promise<Encoded>,
): Promise<{ readonly encoded: Encoded; readonly releasedMeshBytes: number;
  readonly analysisResultIssues: readonly SaveResultIssueReport[] }> {
  let releasedMeshBytes = 0;
  const analysisResultIssues: SaveResultIssueReport[] = [];
  const releaseComponent = componentReleaser(input);
  let encoded: Encoded;
  try {
    encoded = await encode(input, { onProgress, streamMeshEntries: true,
      onMeshComponentWritten: component => { releasedMeshBytes += releaseComponent(component); },
      onEntriesBuilt: () => { releasedMeshBytes += releaseOwnedMeshCopies(input); },
      onAnalysisResultIssue: (analysisId, issue) => { analysisResultIssues.push({ analysisId, issue }); } });
  } finally { releasedMeshBytes += releaseOwnedMeshCopies(input); }
  return { encoded, releasedMeshBytes, analysisResultIssues };
}

/** Worker が所有する入力を符号化し、1 つの並びで返す。 */
export async function encodeOwnedSaveInput(input: SaveDocumentInput,
  onProgress: (stage: SaveEncodingStage) => void): Promise<OwnedSaveEncoding> {
  const { encoded, releasedMeshBytes, analysisResultIssues } = await encodeOwned(input, onProgress, async (owned, control) => concatZipParts(await encodeOwnedSaveDocumentParts(owned, control)));
  return { bytes: encoded, releasedMeshBytes, analysisResultIssues };
}

/** Worker が所有する入力を符号化し、全体の並びを作らずに部分の並びで返す(部品の保存で部分のまま書く道)。 */
export async function encodeOwnedSaveInputParts(input: SaveDocumentInput,
  onProgress: (stage: SaveEncodingStage) => void): Promise<OwnedSavePartsEncoding> {
  const { encoded, releasedMeshBytes, analysisResultIssues } = await encodeOwned(input, onProgress, encodeOwnedSaveDocumentParts);
  return { parts: encoded, releasedMeshBytes, analysisResultIssues };
}
