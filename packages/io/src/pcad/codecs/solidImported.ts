/** 部品 JSON: 外部から読み込んだ形状の素性。documentJson.ts への逆向きの依存を持たない。 */

import {
  type Checked,
  joinPath,
  readLiteral,
  readNumber,
  readRecord,
  readString,
} from '../guards.js';
import {
  readOptionalNumberField,
  readOptionalString,
} from './fields.js';
import {
  type SolidFeatureBase,
} from './solidBase.js';
import {
  type ImportedSolidFeature,
  type ImportedSource,
  type ImportedSourceFormat,
  LENGTH_UNITS,
  type LengthUnit,
  type SolidFeature,
} from '@pointercad/model';

/**
 * 読み込んだ形の出どころの形式(FR-802、P6 §2.8、タスク20)。
 * 3MF / glTF は読み込みの口がまだ Could(FR-809)だが、**文書の型は最初から 5 通り**
 * (口が開いてから型を広げると版がもう一度上がるため。`ImportedSourceFormat` の注釈)。
 */
const IMPORTED_SOURCE_FORMATS: readonly ImportedSourceFormat[] = [
  'step',
  'stl',
  'obj',
  '3mf',
  'gltf',
];

/**
 * 読み込んだ形の種類(FR-802、P6 §2.8)。**三角形の形はここに入らない**——
 * `'mesh'` は `importedMesh` という別のフィーチャーとして持つ(§0.a-0.24)。
 */
const IMPORTED_BODY_KINDS: readonly ImportedSolidFeature['bodyKind'][] = ['solid', 'shell'];

/**
 * 読み込んだ形の素性(FR-802、P6 §2.8、タスク20)を書き出す。
 *
 * **`importedAt` は省略できる欄**なので、無ければ欄ごと出さない(押し出しの `end`・
 * 穴の `entry` と同じ流儀。版 7 のファイルを往復しても欄が 1 つも増えない)。
 * 形そのもの(B-rep / 三角形)はここに 1 バイトも入らない——ZIP の別エントリ
 * (`shapes/<shapeRef>.brep` / `meshes/<meshRef>.bin`)にあり、その出し入れはタスク21 の担当。
 */
function serializeImportedSource(source: ImportedSource): ImportedSource {
  return {
    format: source.format,
    fileName: source.fileName,
    unit: source.unit,
    byteLength: source.byteLength,
    ...(source.importedAt === undefined ? {} : { importedAt: source.importedAt }),
  };
}

/**
 * 読み込んだ形の素性(FR-802、P6 §2.8)を読む。
 *
 * 形式・単位は決められた文字列のどれかで、知らない値は既存の `invalidField` になる
 * (**エラーコードは増やさない**。`docs/報告記録.md` 2026-09-04 01:40 の③)。
 * `importedAt` だけが省略できる欄で、無ければ `undefined` のまま持つ。
 */
function readImportedSource(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<ImportedSource> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const format = readLiteral(record.value, 'format', path, IMPORTED_SOURCE_FORMATS);
  if (!format.ok) {
    return format;
  }
  const fileName = readString(record.value, 'fileName', path);
  if (!fileName.ok) {
    return fileName;
  }
  const unit = readLiteral<LengthUnit>(record.value, 'unit', path, LENGTH_UNITS);
  if (!unit.ok) {
    return unit;
  }
  const byteLength = readNumber(record.value, 'byteLength', path);
  if (!byteLength.ok) {
    return byteLength;
  }
  const importedAt = readOptionalString(record.value, 'importedAt', path);
  if (!importedAt.ok) {
    return importedAt;
  }
  return {
    ok: true,
    value: {
      format: format.value,
      fileName: fileName.value,
      unit: unit.value,
      byteLength: byteLength.value,
      ...(importedAt.value === undefined ? {} : { importedAt: importedAt.value }),
    },
  };
}

/** 読み込んだ形(FR-802、P6 §2.8、§0.a-0.9)を読む。 */
export function readImportedSolidFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const shapeRef = readString(record, 'shapeRef', path);
  if (!shapeRef.ok) {
    return shapeRef;
  }
  const source = readImportedSource(record, 'source', path);
  if (!source.ok) {
    return source;
  }
  const bodyKind = readLiteral(record, 'bodyKind', path, IMPORTED_BODY_KINDS);
  if (!bodyKind.ok) {
    return bodyKind;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'importedSolid',
      shapeRef: shapeRef.value,
      source: source.value,
      bodyKind: bodyKind.value,
    },
  };
}

/** 読み込んだ三角形の形(FR-802、P6 §2.8、§0.a-0.24)を読む。`volume` は省略できる。 */
export function readImportedMeshFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const meshRef = readString(record, 'meshRef', path);
  if (!meshRef.ok) {
    return meshRef;
  }
  const source = readImportedSource(record, 'source', path);
  if (!source.ok) {
    return source;
  }
  const triangleCount = readNumber(record, 'triangleCount', path);
  if (!triangleCount.ok) {
    return triangleCount;
  }
  const volume = readOptionalNumberField(record, 'volume', path);
  if (!volume.ok) {
    return volume;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'importedMesh',
      meshRef: meshRef.value,
      source: source.value,
      triangleCount: triangleCount.value,
      ...(volume.value === undefined ? {} : { volume: volume.value }),
    },
  };
}

/** importedSolid の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializeImportedSolidFeature(feature: Extract<SolidFeature, { readonly kind: 'importedSolid' }>): SolidFeature {
  /*
    読み込んだ形(FR-802、P6 §2.8、§0.a-0.9)。**`document.json` に入るのは
    「入れ物の名前」と素性だけ**で、B-rep のバイト列は ZIP の別エントリになる
    (`shapes/<shapeRef>.brep`。エントリの出し入れはタスク21 の担当)。
  */
  return {
    id: feature.id,
    kind: 'importedSolid',
    name: feature.name,
    suppressed: feature.suppressed,
    shapeRef: feature.shapeRef,
    source: serializeImportedSource(feature.source),
    bodyKind: feature.bodyKind,
  };
}

/** importedMesh の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializeImportedMeshFeature(feature: Extract<SolidFeature, { readonly kind: 'importedMesh' }>): SolidFeature {
  // 読み込んだ三角形の形(FR-802、P6 §2.8、§0.a-0.24)。三角形は
  // `meshes/<meshRef>.bin` にある。`volume` は省略できる欄なので、無ければ出さない。
  return {
    id: feature.id,
    kind: 'importedMesh',
    name: feature.name,
    suppressed: feature.suppressed,
    meshRef: feature.meshRef,
    source: serializeImportedSource(feature.source),
    triangleCount: feature.triangleCount,
    ...(feature.volume === undefined ? {} : { volume: feature.volume }),
  };
}
