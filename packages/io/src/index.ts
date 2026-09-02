/**
 * ファイル入出力(要件 FR-8xx)。.pcad / STEP / STL / 3MF / OBJ / glTF は P2 以降で実装する。
 * P0 ではスキーマバージョンと対応形式の一覧だけを定義する。
 */

/** .pcad の document.json に埋め込むスキーマバージョン(要件§8)。 */
export const PCAD_SCHEMA_VERSION = 1;

export type ExportFormat = 'step' | 'stl' | '3mf' | 'obj' | 'glb';
export type ImportFormat = 'step' | 'stl' | 'obj';

export const EXPORT_FORMATS: readonly ExportFormat[] = ['step', 'stl', '3mf', 'obj', 'glb'];
export const IMPORT_FORMATS: readonly ImportFormat[] = ['step', 'stl', 'obj'];

/** 読み込めるファイルは書き出しもできること(要件 FR-802 / FR-803 の整合)。 */
export function canRoundTrip(format: ImportFormat): boolean {
  return (EXPORT_FORMATS as readonly string[]).includes(format);
}
