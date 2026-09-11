/** 部品 JSON: 既存形状の加工。documentJson.ts への逆向きの依存を持たない。 */

import {
  type Checked,
  checkRecord,
  type ExpressionValueJson,
  joinPath,
  readBoolean,
  readExpression,
  readLiteral,
  readString,
  readValue,
} from '../guards.js';
import {
  readList,
  readNullableString,
  readOptionalExpression,
  serializeExpression,
} from './fields.js';
import {
  readPlaneSpec,
  serializePlaneSpec,
} from './referenceGeometry.js';
import {
  readSubShapeRef,
  readSubShapeRefField,
  serializeSubShapeRef,
} from './shapeReferences.js';
import {
  type SolidFeatureBase,
} from './solidBase.js';
import {
  type ChamferSize,
  type CutFeature,
  type SolidFeature,
} from '@pointercad/model';

const CHAMFER_SIZE_KINDS: readonly ChamferSize['kind'][] = [
  'equal',
  'twoDistances',
  'distanceAngle',
];

/** 切断で残す側(FR-432、§0.a-0.57)。法線の側か、その反対。 */
const CUT_KEEP_SIDES: readonly CutFeature['keep'][] = ['positive', 'negative'];

function serializeChamferSize(size: ChamferSize): ChamferSize {
  switch (size.kind) {
    case 'equal':
      return { kind: 'equal', distance: serializeExpression(size.distance) };
    case 'twoDistances':
      return {
        kind: 'twoDistances',
        distance1: serializeExpression(size.distance1),
        distance2: serializeExpression(size.distance2),
      };
    case 'distanceAngle':
      return {
        kind: 'distanceAngle',
        distance: serializeExpression(size.distance),
        angle: serializeExpression(size.angle),
      };
  }
}

/** C 面取りの大きさ(等距離・2距離・距離と角度、§0.a-0.18)を読む。 */
function readChamferSize(value: unknown, path: string): Checked<ChamferSize> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const kind = readLiteral(record.value, 'kind', path, CHAMFER_SIZE_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'equal': {
      const distance = readExpression(record.value, 'distance', path);
      if (!distance.ok) {
        return distance;
      }
      return { ok: true, value: { kind: 'equal', distance: distance.value } };
    }
    case 'twoDistances': {
      const distance1 = readExpression(record.value, 'distance1', path);
      if (!distance1.ok) {
        return distance1;
      }
      const distance2 = readExpression(record.value, 'distance2', path);
      if (!distance2.ok) {
        return distance2;
      }
      return {
        ok: true,
        value: { kind: 'twoDistances', distance1: distance1.value, distance2: distance2.value },
      };
    }
    case 'distanceAngle': {
      const distance = readExpression(record.value, 'distance', path);
      if (!distance.ok) {
        return distance;
      }
      const angle = readExpression(record.value, 'angle', path);
      if (!angle.ok) {
        return angle;
      }
      return {
        ok: true,
        value: { kind: 'distanceAngle', distance: distance.value, angle: angle.value },
      };
    }
  }
}

function readChamferSizeField(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<ChamferSize> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  return readChamferSize(found.value, joinPath(parentPath, key));
}

/** R 面取り(FR-407、§0.a-0.17)を読む。丸める辺・頂点の一覧(頂点は展開せずそのまま保存)。 */
export function readFilletFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const targets = readList(record, 'targets', path, readSubShapeRef);
  if (!targets.ok) {
    return targets;
  }
  const radius = readExpression(record, 'radius', path);
  if (!radius.ok) {
    return radius;
  }
  /*
    可変半径の終点側(FR-426、P5 タスク46)。**省略できる欄**なので、版 4 以前・
    版 5 前半のファイル(`radius` だけを持つ)は欄が無いまま読めて、`filletRadiusOf` が
    「一定半径」として返す。読み手で 2 通りの形へ分岐する必要も、移行を増やす必要もない
    (計画書 タスク54 の注意書きが求めていた「両方の形を読める」を、欄を足す形で満たす)。

    **`radiusEnd` が `null` のときも「欄が無い」として読む**(P5 仕上げ (h)、
    `docs/報告記録.md` 2026-09-05 23:08 の t47 指摘①)。書き手(`serializeSolidFeature`)は
    `radiusEnd` が `undefined` でも `null` でも欄ごと落とすので(§0.a-0.48「一定半径」)、
    読み手だけが `null` を型違いとして断ると書き手と非対称になる。`filletRadiusOf` も
    `undefined` と `null` を同じ「一定半径」として扱う(`createPartDocument.ts` の
    「省略できる欄の約束」を参照。`radiusEnd` は `thickness` と違い `null` に
    別の意味を持たせていない)。
  */
  const radiusEnd: Checked<ExpressionValueJson | undefined> =
    record['radiusEnd'] === null
      ? { ok: true, value: undefined }
      : readOptionalExpression(record, 'radiusEnd', path);
  if (!radiusEnd.ok) {
    return radiusEnd;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'fillet',
      targetFeatureId: targetFeatureId.value,
      targets: targets.value,
      radius: radius.value,
      ...(radiusEnd.value === undefined ? {} : { radiusEnd: radiusEnd.value }),
    },
  };
}

/** C 面取り(FR-408、§0.a-0.18)を読む。 */
export function readChamferFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const targets = readList(record, 'targets', path, readSubShapeRef);
  if (!targets.ok) {
    return targets;
  }
  const size = readChamferSizeField(record, 'size', path);
  if (!size.ok) {
    return size;
  }
  const swapReferenceFace = readBoolean(record, 'swapReferenceFace', path);
  if (!swapReferenceFace.ok) {
    return swapReferenceFace;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'chamfer',
      targetFeatureId: targetFeatureId.value,
      targets: targets.value,
      size: size.value,
      swapReferenceFace: swapReferenceFace.value,
    },
  };
}

// ---------------------------------------------------------------------------
// P5 の Should 群 9 種の読み込み(§2.11、タスク43)。
//
// **書き出し(`serializeSolidFeature`)と欄名・順序を必ず揃える。** 参照は id と指紋、
// 寸法は式のままで、座標・ラジアン・解決した形は 1 つも読まない(要件§8)。
// ---------------------------------------------------------------------------

/** 抜き勾配(FR-417)を読む。傾ける面は 1 枚以上、中立面は 1 枚。 */
export function readDraftFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const faces = readList(record, 'faces', path, readSubShapeRef);
  if (!faces.ok) {
    return faces;
  }
  const neutralFace = readSubShapeRefField(record, 'neutralFace', path);
  if (!neutralFace.ok) {
    return neutralFace;
  }
  const angle = readExpression(record, 'angle', path);
  if (!angle.ok) {
    return angle;
  }
  const reversed = readBoolean(record, 'reversed', path);
  if (!reversed.ok) {
    return reversed;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'draft',
      targetFeatureId: targetFeatureId.value,
      faces: faces.value,
      neutralFace: neutralFace.value,
      angle: angle.value,
      reversed: reversed.value,
    },
  };
}

/** くり抜き(FR-418、§2.12、P5 タスク46)を読む。開ける面は 0 枚でもよい。 */
export function readShellFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const openFaces = readList(record, 'openFaces', path, readSubShapeRef);
  if (!openFaces.ok) {
    return openFaces;
  }
  const thickness = readExpression(record, 'thickness', path);
  if (!thickness.ok) {
    return thickness;
  }
  const outward = readBoolean(record, 'outward', path);
  if (!outward.ok) {
    return outward;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'shell',
      targetFeatureId: targetFeatureId.value,
      openFaces: openFaces.value,
      thickness: thickness.value,
      outward: outward.value,
    },
  };
}

/**
 * 平面による切断(FR-432、§2.9b、タスク27c)を読む。
 *
 * 切断面は任意の作業平面(FR-328)と同じ `readPlaneSpec` を通す(読み書きを 2 か所に
 * 書かない)。`pairedWith` は**文字列か null** で、欄が無ければ型が違うとして断る
 * (「対の相手がいない」は null であって、欄の省略ではない)。
 * 知らない値は既存の `invalidField` になる(エラーコードは増やさない)。
 */
export function readCutFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const plane = readPlaneSpec(record, 'plane', path);
  if (!plane.ok) {
    return plane;
  }
  const keep = readLiteral(record, 'keep', path, CUT_KEEP_SIDES);
  if (!keep.ok) {
    return keep;
  }
  const pairedWith = readNullableString(record, 'pairedWith', path);
  if (!pairedWith.ok) {
    return pairedWith;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'cut',
      targetFeatureId: targetFeatureId.value,
      plane: plane.value,
      keep: keep.value,
      pairedWith: pairedWith.value,
    },
  };
}

/** fillet の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializeFilletFeature(feature: Extract<SolidFeature, { readonly kind: 'fillet' }>): SolidFeature {
  return {
    id: feature.id,
    kind: 'fillet',
    name: feature.name,
    suppressed: feature.suppressed,
    targetFeatureId: feature.targetFeatureId,
    targets: feature.targets.map(serializeSubShapeRef),
    radius: serializeExpression(feature.radius),
    // 可変半径(FR-426、P5 タスク46)。**一定半径のときは欄そのものを書かない**ので、
    // 版 4 以前・版 5 前半のファイルと 1 バイトも変わらない(押し出しの `end` と同じ決め)。
    ...(feature.radiusEnd === undefined || feature.radiusEnd === null
      ? {}
      : { radiusEnd: serializeExpression(feature.radiusEnd) }),
  };
}

/** chamfer の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializeChamferFeature(feature: Extract<SolidFeature, { readonly kind: 'chamfer' }>): SolidFeature {
  return {
    id: feature.id,
    kind: 'chamfer',
    name: feature.name,
    suppressed: feature.suppressed,
    targetFeatureId: feature.targetFeatureId,
    targets: feature.targets.map(serializeSubShapeRef),
    size: serializeChamferSize(feature.size),
    swapReferenceFace: feature.swapReferenceFace,
  };
}

/** draft の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializeDraftFeature(feature: Extract<SolidFeature, { readonly kind: 'draft' }>): SolidFeature {
  return {
    id: feature.id,
    kind: 'draft',
    name: feature.name,
    suppressed: feature.suppressed,
    targetFeatureId: feature.targetFeatureId,
    faces: feature.faces.map(serializeSubShapeRef),
    neutralFace: serializeSubShapeRef(feature.neutralFace),
    angle: serializeExpression(feature.angle),
    reversed: feature.reversed,
  };
}

/** shell の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializeShellFeature(feature: Extract<SolidFeature, { readonly kind: 'shell' }>): SolidFeature {
  // くり抜き(FR-418、§2.12、P5 タスク46)。開ける面は 0 枚でもよい。
  return {
    id: feature.id,
    kind: 'shell',
    name: feature.name,
    suppressed: feature.suppressed,
    targetFeatureId: feature.targetFeatureId,
    openFaces: feature.openFaces.map(serializeSubShapeRef),
    thickness: serializeExpression(feature.thickness),
    outward: feature.outward,
  };
}

/** cut の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializeCutFeature(feature: Extract<SolidFeature, { readonly kind: 'cut' }>): SolidFeature {
  // 平面による切断(FR-432、§2.9b、タスク27c)。切断面は任意の作業平面(FR-328)と
  // 同じ `serializePlaneSpec` を通す(読み書きを 2 か所に書かない)。
  // `pairedWith` は単独なら null をそのまま書き出す(欄ごと省略しない。
  // 「対の相手がいない」ことを読む側が判定に使うため)。
  return {
    id: feature.id,
    kind: 'cut',
    name: feature.name,
    suppressed: feature.suppressed,
    targetFeatureId: feature.targetFeatureId,
    plane: serializePlaneSpec(feature.plane),
    keep: feature.keep,
    pairedWith: feature.pairedWith,
  };
}
