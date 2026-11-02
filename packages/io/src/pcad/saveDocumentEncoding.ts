/** 保存を実行する環境に依存しない契約。ブラウザーのWorkerとheadless検査が同じIOを使う。 */
import type { AssemblyDocumentBundle, DrawingDocument, DrawingTemplate, PartDocument } from '@pointercad/model';
import { IO_LIMITS } from '../limits.js';
import { drawingBundleEntries } from './drawingBundle.js';
import { drawingTemplateEntries } from './drawingTemplateFile.js';
import { documentBundleEntries, pcadEntries, zipPcadEntriesAsync,
  type WriteDocumentBundleOptions, type WritePcadFileOptions, type WritePcaddFileOptions } from './pcadFile.js';
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
  const bytes = await zipPcadEntriesAsync(entries, { signal: control.signal });
  if (input.kind === 'drawing' && bytes.length > IO_LIMITS.archiveCompressedBytes) {
    throw new Error(ARCHIVE_TOO_LARGE_MESSAGE);
  }
  return bytes;
};
