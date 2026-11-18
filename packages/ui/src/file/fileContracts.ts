/** Shared file-dialog data. This entry has no React, store, DOM, or CAD runtime dependency. */
import type { FileKind } from '@pointercad/model';
import { IO_LIMITS } from '@pointercad/io/limits';
import fileMessages from '../i18n/ja/file.json';
import assemblyMessages from '../i18n/ja/assembly.json';
import drawingMessages from '../i18n/ja/drawing.json';

export type SaveFileKind = Exclude<FileKind, 'dwg'> | 'pcada' | 'pcadd' | 'zip' | 'svg' | 'pdf' | 'png' | 'jpg' | 'csv';
export const PCAD_EXTENSION = '.pcad';
export const PCADA_EXTENSION = '.pcada';
export const PCADD_EXTENSION = '.pcadd';
export const PCAD_MIME_TYPE = 'application/octet-stream';
export const MAX_COMPRESSED_INPUT_BYTES = IO_LIMITS.archiveCompressedBytes;
/**
 * 操作の割り当ての設定ファイル(`.pcadinput`。B-09 3-1)の読込の上限。中身は数 KB の JSON なので、
 * これより大きいファイルは本文を読まずに断る(ブラウザーの読込とデスクトップの読込の両方が使う)。
 */
export const INPUT_SETTINGS_FILE_BYTES = 256 * 1024;
/** 自動作図の処理ファイルの読込の上限。JSON は元の 1 バイトを最大 6 倍に書くので、model の SCRIPT_FILE_LIMITS.bytes と同じ値(単体で照らす)。 */
const SCRIPT_READ_BYTES = 6 * 1024 * 1024 + 65536;

const descriptions = {
  'file.typeDescription': fileMessages['file.typeDescription'],
  'assembly.fileType': assemblyMessages['assembly.fileType'],
  'drawing.fileType': drawingMessages['drawing.fileType'],
};

interface FileKindSpec {
  readonly label: string;
  readonly descriptionKey?: keyof typeof descriptions;
  readonly accept: Readonly<Record<string, readonly string[]>>;
}

/** One table drives the browser MIME filters and Electron extension filters. */
export const FILE_KIND_SPECS: Readonly<Record<SaveFileKind | FileKind, FileKindSpec>> = {
  pcadscript: { label: 'PointerCAD Script', accept: { 'application/json': ['.pcadscript'] } },
  pcadinput: { label: 'PointerCAD Input Settings', accept: { 'application/json': ['.pcadinput'] } },
  csv: { label: 'CSV', accept: { 'text/csv': ['.csv'] } },
  zip: { label: 'ZIP', accept: { 'application/zip': ['.zip'] } },
  pcada: { label: 'PointerCAD', descriptionKey: 'assembly.fileType', accept: { [PCAD_MIME_TYPE]: [PCADA_EXTENSION] } },
  pcadd: { label: 'PointerCAD', descriptionKey: 'drawing.fileType', accept: { [PCAD_MIME_TYPE]: [PCADD_EXTENSION] } },
  pcad: { label: 'PointerCAD', descriptionKey: 'file.typeDescription', accept: { [PCAD_MIME_TYPE]: [PCAD_EXTENSION] } },
  pcadt: { label: 'PointerCAD', accept: { [PCAD_MIME_TYPE]: ['.pcadt'] } },
  step: { label: 'STEP', accept: { 'model/step': ['.step', '.stp'] } },
  stl: { label: 'STL', accept: { 'model/stl': ['.stl'] } },
  obj: { label: 'OBJ', accept: { 'model/obj': ['.obj'] } },
  glb: { label: 'glTF', accept: { 'model/gltf-binary': ['.glb'], 'model/gltf+json': ['.gltf'] } },
  '3mf': { label: '3MF', accept: { 'model/3mf': ['.3mf'] } },
  dxf: { label: 'DXF', accept: { 'image/vnd.dxf': ['.dxf'] } },
  dwg: { label: 'DWG', accept: { 'image/vnd.dwg': ['.dwg'] } },
  svg: { label: 'SVG', accept: { 'image/svg+xml': ['.svg'] } },
  pdf: { label: 'PDF', accept: { 'application/pdf': ['.pdf'] } },
  png: { label: 'PNG', accept: { 'image/png': ['.png'] } },
  jpg: { label: 'JPEG', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } },
};

export interface NativeFileFilter {
  readonly name: string;
  readonly extensions: string[];
}

export function nativeFileFilter(kind: FileKind | SaveFileKind): NativeFileFilter {
  const spec = FILE_KIND_SPECS[kind];
  return {
    name: spec.descriptionKey === undefined ? spec.label : descriptions[spec.descriptionKey],
    extensions: Object.values(spec.accept).flat().map(extension => extension.slice(1)),
  };
}

export function isFileDialogKind(kind: string): kind is FileKind | SaveFileKind {
  return Object.hasOwn(FILE_KIND_SPECS, kind);
}

/** 種類つきの読込の上限(バイト)。Record なので、種類を足すと、ここに上限を決めるまで型の誤りになる。 */
const TYPED_READ_LIMITS: Readonly<Record<FileKind, number>> = {
  pcad: MAX_COMPRESSED_INPUT_BYTES, pcadt: MAX_COMPRESSED_INPUT_BYTES, pcadscript: SCRIPT_READ_BYTES,
  pcadinput: INPUT_SETTINGS_FILE_BYTES, step: MAX_COMPRESSED_INPUT_BYTES, stl: MAX_COMPRESSED_INPUT_BYTES,
  obj: MAX_COMPRESSED_INPUT_BYTES, glb: MAX_COMPRESSED_INPUT_BYTES, '3mf': MAX_COMPRESSED_INPUT_BYTES,
  dxf: MAX_COMPRESSED_INPUT_BYTES, dwg: MAX_COMPRESSED_INPUT_BYTES,
};

/**
 * ファイル名の拡張子から、種類つきの読込の上限を引く(大文字小文字は問わない)。ブラウザーの読込(fileGateway.ts)と
 * デスクトップの読込(pcadDialogs.ts の readLimitOf)の両方がここを引く。どの種類でもない名前(.pcada・.pcadd など)は
 * 圧縮した入力の上限。
 */
export function typedReadLimitOf(fileName: string): number {
  const lower = fileName.toLowerCase();
  for (const [kind, limit] of Object.entries(TYPED_READ_LIMITS)) {
    if (isFileDialogKind(kind) && Object.values(FILE_KIND_SPECS[kind].accept).flat().some(extension => lower.endsWith(extension))) {
      return limit;
    }
  }
  return MAX_COMPRESSED_INPUT_BYTES;
}
