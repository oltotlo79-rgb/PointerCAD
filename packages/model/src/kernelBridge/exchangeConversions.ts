/** Pure file-exchange conversion. Transport and cancellation remain at the bridge. */
import type { ShapeExportItem, ShapeExportRequest, ShapeExportResult, ShapeImportBody, ShapeImportRequest, ShapeImportResult } from '@pointercad/kernel';
import { EXPORT_MESH_QUALITY, type ExportMeshQuality } from '../exchange/types.js';
import { importedShapeOf } from '../part/types.js';
import type { ResolvedSolidStep } from '../part/resolvePart.js';
import type { ShapeExportBody, ShapeExportOptions, ShapeExportOutcome, ShapeImportOptions, ImportedBody, ImportedBodyCommon, ShapeImportOutcome } from './exchangeContracts.js';

/**
 * 頼んでいない形式が返ったとき。**この橋は `'brep'` を頼まない**(`.pcad` へ抱き込む
 * バイト列は読み込みの経路で得る)ので起こらないが、網羅 `switch` の枝を黙って落とさない
 * ために断りを 1 つ置く。エラーコードは増やしていない(日本語の 1 行だけ)。
 */
const EXPORT_UNEXPECTED_FORMAT_MESSAGE = '書き出せませんでした。もう一度お試しください。';

/** STEP のファイル名に付ける拡張子。ほかの 3 形式の名前は幾何カーネルが組んで返す。 */
const STEP_FILE_EXTENSION = '.step';

/**
 * 書き出す立体を kernel の言葉へ詰め替える。**1 つでも段の鍵が引けなければ `null`** を返し、
 * 呼び出し側はカーネルを呼ばずに断る(`toMeasureRequest` と同じ流儀)。
 */
export function toShapeExportItems(
  steps: readonly ResolvedSolidStep[],
  bodies: readonly ShapeExportBody[],
): readonly ShapeExportItem[] | null {
  const keyByFeatureId = new Map(steps.map((step) => [step.featureId, step.key]));
  const items: ShapeExportItem[] = [];
  for (const body of bodies) {
    const bodyKey = keyByFeatureId.get(body.featureId);
    if (bodyKey === undefined) {
      return null;
    }
    items.push({
      bodyKey,
      name: body.name,
      color: body.color,
      faceColors: body.faceColors,
    });
  }
  return items;
}

/**
 * 三角形の細かさの対。三角形を使う形式なのに対が無いのは呼び出し側の取り違えだが、
 * **断らずに標準の細かさで書く**(NFR-RE-1「止めずに警告する」)。表の正本は
 * `exchange/types.ts` の 1 か所だけ(同じ 3 つの数を写さない)。
 */
function meshQualityOf(options: ShapeExportOptions): ExportMeshQuality {
  return options.meshQuality ?? EXPORT_MESH_QUALITY.normal;
}

/** 書き出しの依頼を kernel の言葉へ詰め替える(網羅 `switch`。形式が増えたら落ちる)。 */
export function toShapeExportRequest(
  items: readonly ShapeExportItem[],
  options: ShapeExportOptions,
): ShapeExportRequest {
  switch (options.format) {
    case 'step':
      return { format: 'step', partId: options.partId, bodies: items, withColors: options.withColors };
    case 'stl':
      return {
        format: 'stl',
        partId: options.partId,
        bodies: items,
        ascii: options.ascii,
        baseName: options.baseName,
        ...meshQualityOf(options),
      };
    case 'obj':
    case 'gltf':
      return {
        format: options.format,
        partId: options.partId,
        bodies: items,
        baseName: options.baseName,
        ...meshQualityOf(options),
      };
    case 'mesh':
      return { format: 'mesh', partId: options.partId, bodies: items, ...meshQualityOf(options) };
  }
}

/**
 * 書き出しの結果を model の言葉へ詰め替える(kernel の型を外へ出さない、NFR-MA-1)。
 *
 * **STEP のファイル名だけはここで組む。** ほかの 3 形式は名前まで幾何カーネルが返す
 * (`.obj` が `.mtl` を名前で指すため)ので、呼び出し側から見た約束——「返ったファイルを
 * 名前のまま全部保存する」——を STEP でも同じにしておく。
 */
export function toShapeExportOutcome(
  result: ShapeExportResult,
  options: ShapeExportOptions,
): ShapeExportOutcome {
  switch (result.format) {
    case 'step':
      return {
        kind: 'files',
        files: [
          { fileName: `${options.baseName}${STEP_FILE_EXTENSION}`, bytes: result.bytes },
        ],
        // STEP は三角形を通らないので、落とした三角形は 1 枚も無い。
        droppedTriangleCount: 0,
      };
    case 'stl':
    case 'obj':
    case 'gltf':
      return {
        kind: 'files',
        files: result.files,
        droppedTriangleCount: result.droppedTriangleCount,
      };
    case 'mesh':
      // 並びは依頼のままなので、名前と色は同じ位置の依頼から取れる(kernel の約束)。
      return {
        kind: 'meshes',
        bodies: result.bodies.map((body, index) => ({
          name: options.bodies[index]?.name ?? null,
          color: options.bodies[index]?.color ?? null,
          positions: body.triangles.positions,
          indices: body.triangles.indices,
        })),
      };
    case 'brep':
      return { kind: 'failed', message: EXPORT_UNEXPECTED_FORMAT_MESSAGE };
  }
}

/** 読み込みの依頼を kernel の言葉へ詰め替える(網羅 `switch`)。 */
export function toShapeImportRequest(options: ShapeImportOptions): ShapeImportRequest {
  switch (options.format) {
    case 'step':
      return {
        format: 'step',
        bytes: options.bytes,
        fileName: options.fileName,
        withColors: options.withColors,
      };
    case 'stl':
      return { format: 'stl', bytes: options.bytes, fileName: options.fileName };
    case 'obj':
      return { format: 'obj', bytes: options.bytes, fileName: options.fileName };
    case 'gltf':
      return { format: 'gltf', bytes: options.bytes, fileName: options.fileName };
  }
}

/** 読み込んだ立体 1 つを model の言葉へ詰め替える(B-rep の枝と三角形の枝を保つ)。 */
function toImportedBody(body: ShapeImportBody): ImportedBody {
  const common: ImportedBodyCommon = {
    name: body.name,
    color: body.color,
    volume: body.volume,
    triangleCount: body.triangles.triangleCount,
  };
  if (body.bodyKind === 'mesh') {
    return {
      ...common,
      bodyKind: 'mesh',
      mesh: {
        positions: body.triangles.positions,
        normals: body.triangles.normals,
        indices: body.triangles.indices,
      },
    };
  }
  return { ...common, bodyKind: body.bodyKind, brepBytes: importedShapeOf(body.brepBytes).bytes };
}

/** 読み込みの結果を model の言葉へ詰め替える。 */
export function toShapeImportOutcome(result: ShapeImportResult): ShapeImportOutcome {
  return {
    kind: 'imported',
    bodies: result.bodies.map((body) => toImportedBody(body)),
    unit: result.unit,
  };
}

