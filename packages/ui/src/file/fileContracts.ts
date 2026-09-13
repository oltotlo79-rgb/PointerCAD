/** Shared file-dialog data. This entry has no React, store, DOM, or CAD runtime dependency. */
import type { FileKind } from '@pointercad/model';
import { IO_LIMITS } from '@pointercad/io/limits';
import fileMessages from '../i18n/ja/file.json';
import assemblyMessages from '../i18n/ja/assembly.json';
import drawingMessages from '../i18n/ja/drawing.json';

export type SaveFileKind = Exclude<FileKind, 'dwg'> | 'pcada' | 'pcadd' | 'zip' | 'svg' | 'pdf' | 'png' | 'jpg';
export const PCAD_EXTENSION = '.pcad';
export const PCADA_EXTENSION = '.pcada';
export const PCADD_EXTENSION = '.pcadd';
export const PCAD_MIME_TYPE = 'application/octet-stream';
export const MAX_COMPRESSED_INPUT_BYTES = IO_LIMITS.archiveCompressedBytes;

const descriptions = {
  'file.typeDescription': fileMessages['file.typeDescription'],
  'assembly.fileType': assemblyMessages['assembly.fileType'],
  'drawing.fileType': drawingMessages['drawing.fileType'],
  'exchange.dwgType': fileMessages['exchange.dwgType'],
};

interface FileKindSpec {
  readonly label: string;
  readonly descriptionKey?: keyof typeof descriptions;
  readonly accept: Readonly<Record<string, readonly string[]>>;
}

/** One table drives the browser MIME filters and Electron extension filters. */
export const FILE_KIND_SPECS: Readonly<Record<SaveFileKind | FileKind, FileKindSpec>> = {
  pcadscript: { label: 'PointerCAD Script', accept: { 'application/json': ['.pcadscript'] } },
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
  dwg: { label: 'DWG', descriptionKey: 'exchange.dwgType', accept: { 'image/vnd.dwg': ['.dwg'] } },
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
