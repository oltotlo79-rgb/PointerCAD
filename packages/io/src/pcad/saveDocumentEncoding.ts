/** 保存を実行する環境に依存しない契約。ブラウザーのWorkerとheadless検査が同じIOを使う。 */
import { ownedAttachmentsDigestOf, type AssemblyDocumentBundle, type DrawingDocument, type DrawingTemplate, type PartDocument } from '@pointercad/model';
import { IO_LIMITS } from '../limits.js';
import { drawingBundleEntries, drawingEntriesWithMeshes } from './drawingBundle.js';
import { drawingTemplateEntries } from './drawingTemplateFile.js';
import { bundleEntriesWithMeshes, documentBundleEntries, dropAssemblySaveExtras, ownedMeshEntryBytes,
  partEntriesWithMeshes, pcadEntries, PCAD_MESH_ENTRY_PREFIX, PCAD_MESH_ENTRY_SUFFIX, streamedMeshEntryBytes, zipPcadEntriesPartsAsync,
  type ImportedMeshBytes, type PcadZipEntries, type WriteDocumentBundleOptions, type WritePcadFileOptions, type WritePcaddFileOptions } from './pcadFile.js';
import { concatZipParts, hasSteppedZipEntry, packOwnedZipEntries, zipEntriesWithOwnedBuffersPartsAsync, type ZipChunkedBytes, type ZipStepEntry } from './zipSteps.js';
import { ARCHIVE_TOO_LARGE_MESSAGE } from './readArchive.js';
import type { AnalysisResultIssue } from './codecs/analysisResult.js';

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
  /**
   * 解析の結果を書けなかった時に、結果の id と理由の符号で 1 件ずつ呼ぶ。書き手はその結果を入れずに保存を続ける
   * (文書は保存できる)。保存 Worker は集めた符号を成功の返信に載せ、主スレッドの呼び出し側へ同じ形で渡す。
   */
  readonly onAnalysisResultIssue?: (analysisId: string, issue: AnalysisResultIssue) => void;
}
/** The callback owns the input views and may release a component after its last use. */
export interface OwnedSaveEncodingControl extends SaveEncodingControl {
  readonly onMeshComponentWritten: (component: Float32Array | Uint32Array) => void;
  /** Owned Worker input can be consumed during compression when no saved result needs the prepared bytes. */
  readonly streamMeshEntries?: boolean;
}

export type SaveDocumentEncoder = (input: SaveDocumentInput, control?: SaveEncodingControl) => Promise<Uint8Array>;
/**
 * `SaveDocumentEncoder` と同じ符号化で、結果を順につなぐとファイルの全体になる部分の並びで返す。
 * 全体の並びを作らないので、部分のまま書ける保存先へ渡すと保存中の記憶量の山が全体の写し 1 つ分下がる。
 */
export type SaveDocumentPartsEncoder = (input: SaveDocumentInput, control?: SaveEncodingControl) => Promise<readonly Uint8Array[]>;

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
export const encodeSaveDocumentParts: SaveDocumentPartsEncoder = async (input, control = {}) => {
  return encodeSaveParts(input, control);
};

/** Save Worker route. Its snapshot owns the input, including all mesh components. */
export function encodeOwnedSaveDocumentParts(input: SaveDocumentInput, control: OwnedSaveEncodingControl): Promise<readonly Uint8Array[]> {
  const results = input.kind === 'part' ? input.options.analysisResults
    : input.kind === 'assembly' ? input.bundle.analysisResults : undefined;
  if (control.streamMeshEntries && (results === undefined || results.size === 0)) {
    return encodeStreamedOwnedSaveDocumentParts(input, control);
  }
  // The saved-result writer may still use raw data during preparation.
  const release = results === undefined || results.size === 0 ? control.onMeshComponentWritten : undefined;
  return encodeSaveParts(input, control, mesh => ownedMeshEntryBytes(mesh, release));
}

/** Worker path. Large meshes are materialized at the corresponding ZIP entry. */
function encodeStreamedOwnedSaveDocumentParts(input: SaveDocumentInput,
  control: OwnedSaveEncodingControl): Promise<readonly Uint8Array[]> {
  const { onMeshComponentWritten } = control;
  const prepared: (Float32Array | Uint32Array)[] = [];
  return encodeSaveParts(input, { ...control, onEntriesBuilt: () => {
    for (const component of prepared) onMeshComponentWritten(component);
    prepared.length = 0;
  } }, mesh => {
    const entry = streamedMeshEntryBytes(mesh, onMeshComponentWritten);
    // Hash and result writers may still read small meshes during preparation.
    if (entry instanceof Uint8Array) prepared.push(mesh.positions, mesh.normals, mesh.indices);
    return entry;
  });
}

type OwnedEntries = PcadZipEntries<ZipChunkedBytes>;
type MeshEncoder = (mesh: ImportedMeshBytes) => Uint8Array | ZipChunkedBytes | null;

function usesIndividualBytes(entries: OwnedEntries): entries is PcadZipEntries {
  for (const [bytes] of entries.values()) if (!(bytes instanceof Uint8Array)) return false;
  return true;
}

function buildSaveEntries(input: SaveDocumentInput, report: SaveEncodingControl['onAnalysisResultIssue'],
  encodeMesh?: MeshEncoder): OwnedEntries | Promise<OwnedEntries> {
  const withReport = <T extends object>(options: T): T => report === undefined ? options
    : { ...options, onAnalysisResultIssue: report };
  switch (input.kind) {
    case 'part': {
      const options = withReport(input.options);
      return encodeMesh === undefined ? pcadEntries(input.document, options) : partEntriesWithMeshes(input.document, options, encodeMesh);
    }
    case 'assembly': {
      const options = withReport(input.options);
      return encodeMesh === undefined ? documentBundleEntries(input.bundle, options) : bundleEntriesWithMeshes(input.bundle, options, encodeMesh, ownedAttachmentsDigestOf);
    }
    case 'drawing': return encodeMesh === undefined ? drawingBundleEntries(input.document, input.options)
      : drawingEntriesWithMeshes(input.document, input.options, encodeMesh, IO_LIMITS, ownedAttachmentsDigestOf);
    case 'drawingTemplate': return drawingTemplateEntries(input.template, input.savedAt);
  }
}

async function encodeSaveParts(input: SaveDocumentInput, control: SaveEncodingControl,
  encodeMesh?: MeshEncoder): Promise<readonly Uint8Array[]> {
  control.signal?.throwIfAborted();
  control.onProgress?.('preparing');
  const report = control.onAnalysisResultIssue;
  const pending = buildSaveEntries(input, report, encodeMesh);
  const entries = pending instanceof Promise ? await pending : pending;
  control.signal?.throwIfAborted();
  control.onEntriesBuilt?.();
  control.onProgress?.('compressing');
  const zipControl = { signal: control.signal };
  let renderPacked: Awaited<ReturnType<typeof packOwnedZipEntries>> | undefined;
  let parts: Uint8Array[];
  if (usesIndividualBytes(entries)) parts = await zipIndividualEntries(input, entries, zipControl);
  else {
    renderPacked = await packOwnedZipEntries(entries, zipControl);
    parts = renderPacked(entries);
  }
  const compressedSize = (): number => parts.reduce((total, part) => total + part.byteLength, 0);
  if (input.kind === 'assembly' && compressedSize() > IO_LIMITS.archiveCompressedBytes) {
    if (dropAssemblySaveExtras(entries, report)) {
      parts = [];
      if (renderPacked !== undefined) parts = renderPacked(entries);
      else if (usesIndividualBytes(entries)) parts = await zipPcadEntriesPartsAsync(entries, zipControl);
    }
  }
  if ((input.kind === 'drawing' || input.kind === 'assembly') && compressedSize() > IO_LIMITS.archiveCompressedBytes) {
    throw new Error(ARCHIVE_TOO_LARGE_MESSAGE);
  }
  return parts;
}

function zipIndividualEntries(input: SaveDocumentInput, entries: PcadZipEntries, control: Pick<SaveEncodingControl, 'signal'>): Promise<Uint8Array[]> {
  const owned = ownedPartMeshBuffers(input, entries);
  return owned.size > 0 && hasSteppedZipEntry(entries)
    ? zipEntriesWithOwnedBuffersPartsAsync(entries, owned, control) : zipPcadEntriesPartsAsync(entries, control);
}

/** 部分の並びの符号化と同じ符号化の結果を、1 つの並びにつないで返す(ファイル 1 つを丸ごと受ける保存先用)。 */
export const encodeSaveDocument: SaveDocumentEncoder = async (input, control = {}) =>
  concatZipParts(await encodeSaveDocumentParts(input, control));
