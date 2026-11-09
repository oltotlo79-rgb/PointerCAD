/** 保存を実行する環境に依存しない契約。ブラウザーのWorkerとheadless検査が同じIOを使う。 */
import type { AssemblyDocumentBundle, DrawingDocument, DrawingTemplate, PartDocument } from '@pointercad/model';
import { IO_LIMITS } from '../limits.js';
import { drawingBundleEntries } from './drawingBundle.js';
import { drawingTemplateEntries } from './drawingTemplateFile.js';
import { documentBundleEntries, pcadEntries, PCAD_MESH_ENTRY_PREFIX, PCAD_MESH_ENTRY_SUFFIX, zipPcadEntriesAsync,
  type WriteDocumentBundleOptions, type WritePcadFileOptions, type WritePcaddFileOptions } from './pcadFile.js';
import { hasSteppedZipEntry, zipEntriesWithOwnedBuffersAsync, type ZipStepEntry } from './zipSteps.js';
import { ARCHIVE_TOO_LARGE_MESSAGE } from './readArchive.js';

export type SaveDocumentInput =
  | { readonly kind: 'part'; readonly document: PartDocument; readonly options: WritePcadFileOptions }
  | { readonly kind: 'assembly'; readonly bundle: AssemblyDocumentBundle; readonly options: WriteDocumentBundleOptions }
  | { readonly kind: 'drawing'; readonly document: DrawingDocument; readonly options: WritePcaddFileOptions }
  | { readonly kind: 'drawingTemplate'; readonly template: DrawingTemplate; readonly savedAt: string };

export type SaveEncodingStage = 'preparing' | 'compressing';
export interface SaveEncodingControl {
  readonly signal?: AbortSignal;
  readonly onProgress?: (stage: SaveEncodingStage) => void;
  /**
   * 全項目を作り終えた直後・圧縮の前に1回だけ呼ぶ(取消済みなら呼ばない)。入力を自分で所有する呼び出し側
   * (保存 Worker)は、項目へ写し終えた入力の写しをここで手放せる。三角形は項目用の新しいバイト列へ
   * 符号化済みなので、この時点の後は入力の三角形の配列を読まない。入力の原本を持つ呼び出し側は使わない。
   */
  readonly onEntriesBuilt?: () => void;
}
export type SaveDocumentEncoder = (input: SaveDocumentInput, control?: SaveEncodingControl) => Promise<Uint8Array>;

/** pcadEntriesがmeshごとに新規確保した全領域entryだけ。shape/画像/入力meshは借用のまま。 */
function ownedPartMeshBuffers(input: SaveDocumentInput,
  entries: ReadonlyMap<string, ZipStepEntry>): Set<ArrayBuffer> {
  const owned = new Set<ArrayBuffer>();
  if (input.kind !== 'part') return owned;
  for (const ref of input.options.attachments?.meshes.keys() ?? []) {
    const bytes = entries.get(`${PCAD_MESH_ENTRY_PREFIX}${ref}${PCAD_MESH_ENTRY_SUFFIX}`)?.[0];
    if (bytes !== undefined && bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0
      && bytes.byteLength > 0 && bytes.byteLength === bytes.buffer.byteLength) owned.add(bytes.buffer);
  }
  return owned;
}

/** この関数自身はスレッドを作らない。UIは必ず専用Workerから呼ぶ。 */
export const encodeSaveDocument: SaveDocumentEncoder = async (input, control = {}) => {
  control.signal?.throwIfAborted();
  control.onProgress?.('preparing');
  const entries = input.kind === 'part' ? pcadEntries(input.document, input.options)
    : input.kind === 'assembly' ? await documentBundleEntries(input.bundle, input.options)
      : input.kind === 'drawingTemplate' ? drawingTemplateEntries(input.template, input.savedAt)
        : await drawingBundleEntries(input.document, input.options);
  control.signal?.throwIfAborted();
  control.onEntriesBuilt?.();
  control.onProgress?.('compressing');
  // 大きい項目は区切って圧縮し、区切りごとに Worker の終了要求・取消を受け付ける(取消を1秒以内に)。
  const ownedBuffers = ownedPartMeshBuffers(input, entries);
  const bytes = ownedBuffers.size > 0 && hasSteppedZipEntry(entries)
    ? await zipEntriesWithOwnedBuffersAsync(entries, ownedBuffers, { signal: control.signal })
    : await zipPcadEntriesAsync(entries, { signal: control.signal });
  if (input.kind === 'drawing' && bytes.length > IO_LIMITS.archiveCompressedBytes) {
    throw new Error(ARCHIVE_TOO_LARGE_MESSAGE);
  }
  return bytes;
};
