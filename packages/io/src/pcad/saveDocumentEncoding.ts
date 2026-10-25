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
  control.onProgress?.('compressing');
  // 大きい項目は区切って圧縮し、区切りごとに Worker の終了要求・取消を受け付ける(取消を1秒以内に)。
  const bytes = await zipPcadEntriesAsync(entries, { signal: control.signal });
  if (input.kind === 'drawing' && bytes.length > IO_LIMITS.archiveCompressedBytes) {
    throw new Error(ARCHIVE_TOO_LARGE_MESSAGE);
  }
  return bytes;
};
