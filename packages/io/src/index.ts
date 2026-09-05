/**
 * ファイル入出力(要件 FR-8xx)。P2 で .pcad の document.json の読み書きを実装する。
 * STEP / STL / 3MF / OBJ / glTF は P4 以降。
 */

// .pcad の書式の版と封筒(要件§8、§0.a-0.3)。
export {
  PCAD_APP_NAME,
  PCAD_DOCUMENT_KIND,
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
// .pcad(ZIP コンテナ)の読み書き(FR-801、要件§8)。
export {
  PCAD_DOCUMENT_ENTRY,
  PCAD_THUMBNAIL_ENTRY,
  readPcadFile,
  writePcadFile,
  type ReadPcadFileError,
  type ReadPcadFileErrorCode,
  type ReadPcadFileResult,
  type WritePcadFileOptions,
} from './pcad/pcadFile.js';
// 自動保存の保管庫と制御(FR-805、NFR-RE-2)。
export {
  AUTO_SAVE_INTERVAL_MS,
  createAutoSaver,
  createIndexedDbAutoSaveStorage,
  createMemoryAutoSaveStorage,
  type AutoSaveRecord,
  type AutoSaver,
  type AutoSaverOptions,
  type AutoSaveStorage,
  type AutoSaveTimerHandle,
} from './autoSave.js';

// 書き出し・読み込みの形式(FR-803、FR-802)。**正本は `@pointercad/model` の
// `exchange/types.ts` と `exchange/exportPart.ts`**(P6 タスク2)へ移したので、ここは
// 同じ名前を再輸出するだけにしてある(二重定義にしない。io は model に依存している)。
export {
  canRoundTrip, EXPORT_FORMATS, IMPORT_FORMATS, type ExportFormat, type ImportFormat,
} from '@pointercad/model';

// DXF の読み書き(FR-813、計画書 §2.7)。字句(タグ)→ 曲線の換算 → 実体の読み取り、の 3 段を
// この順で並べる。**座標の単位は換算していない**(`DxfReadResult.unit` を見て上の段が決める)。
export {
  DXF_UNSUPPORTED_FORMAT_MESSAGE,
  formatDxfTags,
  parseDxfTags,
  type DxfTag,
} from './dxf/dxfTags.js';
export {
  bulgeToArc,
  DXF_SPLINE_WEIGHT_IGNORED_MESSAGE,
  ellipseFromDxf,
  parseDxfInteger,
  parseDxfNumber,
  splineFromDxf,
  type DxfArcGeometry,
  type DxfEllipseGeometry,
  type DxfPoint2d,
  type DxfSplineGeometry,
  type DxfSplineInput,
} from './dxf/dxfCurves.js';
export {
  DXF_BLOCK_NESTING_MESSAGE,
  DXF_MAX_BLOCK_NESTING_DEPTH,
  DXF_MAX_ENTITY_COUNT,
  DXF_NON_UNIFORM_SCALE_MESSAGE,
  DXF_TOO_MANY_ENTITIES_MESSAGE,
  readDxf,
  type DxfEntity,
  type DxfEntityBase,
  type DxfArcEntity,
  type DxfEllipseEntity,
  type DxfLengthUnit,
  type DxfLineEntity,
  type DxfPointEntity,
  type DxfReadResult,
  type DxfSplineEntity,
} from './dxf/readDxf.js';
