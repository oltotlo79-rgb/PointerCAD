/**
 * ファイル入出力(要件 FR-8xx)。P2 で .pcad の document.json の読み書きを実装する。
 * STEP / STL / 3MF / OBJ / glTF は P4 以降。
 */

// 圧縮入力・展開後・メッシュ配列・DXF 本文の読み込み上限（単一正本）。
export {
  IO_LIMITS,
  isMeshAllocationWithinLimit,
  meshAllocationByteLength,
  type IoLimits,
} from './limits.js';

// .pcad / .pcada の書式の版と封筒(要件§8、§0.a-0.3、P7 §0.a-0.1)。
export {
  PCAD_APP_NAME,
  PCAD_ASSEMBLY_KIND,
  PCAD_ASSEMBLY_KINDS,
  PCAD_DOCUMENT_KIND,
  PCAD_DOCUMENT_KINDS,
  PCAD_SCHEMA_VERSION,
  PCAD_TEMPLATE_KIND,
  SCHEMA_MIGRATIONS,
  type PcadAssemblyEnvelope,
  type PcadAssemblyKind,
  type PcadDocumentKind,
  type PcadEnvelope,
  type PcadPartFile,
  type SchemaMigration,
} from './pcad/schema.js';
// アセンブリ文書と document.json の相互変換(FR-601、FR-801、P7 §2.2、タスク3)。
export {
  readAssemblyDocument,
  writeAssemblyDocument,
  type ReadAssemblyDocumentResult,
  type WriteAssemblyDocumentOptions,
} from './pcad/assemblyJson.js';
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
  decodeImportedMeshBytes,
  emptyPcadAttachments,
  encodeImportedMeshBytes,
  // 読んだファイルがひな形か(FR-814、P6 §0.a-0.35、タスク27)。**画面(タスク33)が
  // 種別の文字列を写さずに判断できるよう、述語のまま出す。**
  isTemplateKind,
  PCAD_CANVAS_ENTRY_PREFIX,
  PCAD_CANVAS_ENTRY_SUFFIX,
  PCAD_DOCUMENT_ENTRY,
  PCAD_MESH_ENTRY_PREFIX,
  PCAD_MESH_ENTRY_SUFFIX,
  // アセンブリが抱き込む部品文書のエントリ(`parts/<ref>.json`。P7 タスク3)。
  PCAD_PART_ENTRY_PREFIX,
  PCAD_PART_ENTRY_SUFFIX,
  PCAD_SHAPE_ENTRY_PREFIX,
  PCAD_SHAPE_ENTRY_SUFFIX,
  PCAD_THUMBNAIL_ENTRY,
  readPcadaFile,
  readPcadFile,
  writePcadaFile,
  writePcadFile,
  type ImportedMeshBytes,
  type PcadAttachments,
  type ReadPcadaFileResult,
  type ReadPcadFileError,
  type ReadPcadFileErrorCode,
  type ReadPcadFileResult,
  type WritePcadaFileOptions,
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
  DXF_TOO_LARGE_MESSAGE,
  DXF_UNSUPPORTED_FORMAT_MESSAGE,
  formatDxfTags,
  parseDxfTags,
  type DxfTag,
} from './dxf/dxfTags.js';
export {
  // `arcToBulge` は `bulgeToArc` の逆(円弧 → 多角形のふくらみ)。書き出し(タスク25)が
  // 折れ線の区間へ円弧を戻すのに使う。
  arcToBulge,
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
// DXF の書き出し(タスク25)。**R12(AC1009)・`$INSUNITS = 4`(mm)固定**で、R12 に無い
// `ELLIPSE` / `SPLINE` は折れ線へ落とす(落とした本数は `DxfWriteResult.flattenedCurveCount`)。
// `writeDxf` はテキストだけ、`writeDxfDocument` は案内の材料つきの結果を返す。
export {
  DXF_WRITE_ACAD_VERSION,
  DXF_WRITE_INSUNITS,
  DXF_WRITE_INVALID_VALUE_MESSAGE,
  dxfFlattenedCurveMessage,
  formatDxfNumber,
  writeDxf,
  writeDxfDocument,
  type DxfWriteResult,
} from './dxf/writeDxf.js';

// 3MF の読み書き(FR-803、FR-809、計画書 §2.6)。3MF は ZIP の中の XML なので、OCCT を
// 使わずに `packages/io` が自前で組み立て・読み取りをする(§0.a-0.18、§0.a-0.26)。
// **kernel の型を輸入しない**(依存方向。`rules/04-設計の規律.md`)ので、書き出しは平らな
// 配列を受け(`ThreeMfMeshInput`)、読み込みは kernel の `ImportedMeshData` と同じ並びを返す。
export {
  escapeXmlAttribute,
  escapeXmlText,
  formatXmlNumber,
  XML_INVALID_NUMBER_MESSAGE,
} from './threemf/xmlText.js';
export {
  DEFAULT_THREE_MF_COLOR,
  THREE_MF_CONTENT_TYPES_ENTRY,
  THREE_MF_INVALID_COLOR_MESSAGE,
  THREE_MF_INVALID_INDICES_MESSAGE,
  THREE_MF_INVALID_POSITIONS_MESSAGE,
  THREE_MF_MODEL_ENTRY,
  THREE_MF_RELS_ENTRY,
  writeThreeMf,
  type ThreeMfColor,
  type ThreeMfMeshInput,
  type WriteThreeMfOptions,
} from './threemf/writeThreeMf.js';
export {
  readAttributes,
  readThreeMf,
  THREE_MF_MAX_TRIANGLE_COUNT,
  THREE_MF_NO_FACE_MESSAGE,
  THREE_MF_READ_FAILED_MESSAGE,
  threeMfTooLargeMessage,
  type ThreeMfLengthUnit,
  type ThreeMfMesh,
  type ThreeMfReadResult,
  type ReadThreeMfOptions,
} from './threemf/readThreeMf.js';
