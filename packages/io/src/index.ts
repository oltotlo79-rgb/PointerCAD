/**
 * ファイル入出力(要件 FR-8xx)。P2 で .pcad の document.json の読み書きを実装する。
 * STEP / STL / 3MF / OBJ / glTF は P4 以降。
 */

// .pcad の書式の版と封筒(要件§8、§0.a-0.3)。
export {
  PCAD_APP_NAME,
  PCAD_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
  type PcadEnvelope,
  type SchemaMigration,
} from './pcad/schema.js';
// 部品文書と document.json の相互変換(FR-801、FR-202)。
export {
  parseDocument,
  serializeDocument,
  type ParseDocumentResult,
  type ParseError,
  type ParseErrorCode,
  type SerializeOptions,
} from './pcad/documentJson.js';

export type ExportFormat = 'step' | 'stl' | '3mf' | 'obj' | 'glb';
export type ImportFormat = 'step' | 'stl' | 'obj';

export const EXPORT_FORMATS: readonly ExportFormat[] = ['step', 'stl', '3mf', 'obj', 'glb'];
export const IMPORT_FORMATS: readonly ImportFormat[] = ['step', 'stl', 'obj'];

/** 読み込めるファイルは書き出しもできること(要件 FR-802 / FR-803 の整合)。 */
export function canRoundTrip(format: ImportFormat): boolean {
  return (EXPORT_FORMATS as readonly string[]).includes(format);
}
