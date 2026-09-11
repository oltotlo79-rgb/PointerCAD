/** 部品 JSON: 押し出し・回転・接合・ブーリアン。documentJson.ts への逆向きの依存を持たない。 */

import {
  type Checked,
  joinPath,
  readBoolean,
  readExpression,
  readLiteral,
  readRecord,
  readString,
} from '../guards.js';
import {
  readList,
  readNullableExpression,
  readOptionalBoolean,
  readOptionalExpression,
  readOptionalLiteral,
  serializeExpression,
} from './fields.js';
import {
  readFaceRef,
  readFaceRefItem,
  readRevolveAxis,
  readSubShapeRefField,
  serializeFaceRef,
  serializeRevolveAxis,
  serializeSubShapeRef,
} from './shapeReferences.js';
import {
  type SolidFeatureBase,
} from './solidBase.js';
import {
  type BooleanOperation,
  type ExtrudeEnd,
  type SolidFeature,
  type ThicknessSide,
} from '@pointercad/model';

/*
 * `.pcad` から読める立体の種類(24 種)は `SOLID_FEATURE_KINDS`(`@pointercad/model`)を
 * そのまま使う(P5 仕上げ (h)、`docs/報告記録.md` 2026-09-05 23:08 の t47 指摘③)。
 *
 * 以前はここに io 自前の配列を持っていたが、model の `SolidFeatureKind` に種類を
 * 足しても揃えて直す仕組みが無く、`SolidFeatureKind` と数がずれる余地があった。
 * model 側は `satisfies Record<SolidFeatureKind, true>` で網羅を型検査しているので、
 * それを輸入するここは自前で並べ直さない。知らない種類の `kind` は `readLiteral` が
 * 「その欄の型が違う」として断る(新しい欄の解釈を推測しないため)。
 */
/** 押し出しの終端の4通り(FR-415、P5 タスク43)。 */
const EXTRUDE_END_KINDS: readonly ExtrudeEnd['kind'][] = [
  'distance',
  'symmetric',
  'toFace',
  'toNext',
];

/** 薄板押し出しの厚みの向き(FR-416、§0.a-0.46)。カーネルの `ThinExtrudeSide` と同じ3値。 */
const THICKNESS_SIDES: readonly ThicknessSide[] = ['inner', 'outer', 'both'];

const BOOLEAN_OPERATIONS: readonly BooleanOperation[] = ['union', 'subtract', 'intersect'];

/**
 * 押し出しの終端(FR-415、P5 タスク43)。呼び出し側が**省略されていない**ときだけ呼ぶ
 * (既定を書き込むと版 6 までのファイルの往復で欄が増えてしまう)。
 */
function serializeExtrudeEnd(end: ExtrudeEnd): ExtrudeEnd {
  switch (end.kind) {
    case 'distance':
    case 'symmetric':
    case 'toNext':
      // 欄を持たない 3 種。`kind` だけを写す(元の入れ物を持ち回らない)。
      return { kind: end.kind };
    case 'toFace':
      return { kind: 'toFace', face: serializeSubShapeRef(end.face) };
  }
}

/**
 * 押し出しの終端(FR-415、P5 タスク43)を読む。欄が無いファイルは `undefined` のまま
 * 返す(既定は model の `extrudeShapingOf` が `symmetric` から決める)。
 */
function readExtrudeEnd(
  record: Record<string, unknown>,
  path: string,
): Checked<ExtrudeEnd | undefined> {
  if (!('end' in record)) {
    return { ok: true, value: undefined };
  }
  const found = readRecord(record, 'end', path);
  if (!found.ok) {
    return found;
  }
  const endPath = joinPath(path, 'end');
  const kind = readLiteral(found.value, 'kind', endPath, EXTRUDE_END_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'distance':
    case 'symmetric':
    case 'toNext':
      return { ok: true, value: { kind: kind.value } };
    case 'toFace': {
      const face = readSubShapeRefField(found.value, 'face', endPath);
      if (!face.ok) {
        return face;
      }
      return { ok: true, value: { kind: 'toFace', face: face.value } };
    }
  }
}

export function readExtrudeFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const profile = readFaceRef(record, 'profile', path);
  if (!profile.ok) {
    return profile;
  }
  const distance = readExpression(record, 'distance', path);
  if (!distance.ok) {
    return distance;
  }
  const reversed = readBoolean(record, 'reversed', path);
  if (!reversed.ok) {
    return reversed;
  }
  const symmetric = readBoolean(record, 'symmetric', path);
  if (!symmetric.ok) {
    return symmetric;
  }
  /*
    終端・傾き・薄板(FR-415、FR-401、FR-416。P5 タスク43)。**5 欄とも省略できる。**
    版 6 までのファイルはどれも持たないので、無いときは `undefined` のまま読み、
    既定は model の `extrudeShapingOf` が与える(既定値を io にも書くと 2 か所になる)。
  */
  const end = readExtrudeEnd(record, path);
  if (!end.ok) {
    return end;
  }
  const taperAngle = readOptionalExpression(record, 'taperAngle', path);
  if (!taperAngle.ok) {
    return taperAngle;
  }
  const taperOutward = readOptionalBoolean(record, 'taperOutward', path);
  if (!taperOutward.ok) {
    return taperOutward;
  }
  const thickness = readNullableExpression(record, 'thickness', path);
  if (!thickness.ok) {
    return thickness;
  }
  const thicknessSide = readOptionalLiteral(record, 'thicknessSide', path, THICKNESS_SIDES);
  if (!thicknessSide.ok) {
    return thicknessSide;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'extrude',
      profile: profile.value,
      distance: distance.value,
      reversed: reversed.value,
      symmetric: symmetric.value,
      /*
        **省略されていた欄は欄ごと省略のまま返す**(`end: undefined` を持たせない)。
        `Object.keys` で欄の顔ぶれを固定している検査があり、値が undefined でも
        欄があると数が変わってしまうためで、意味の上でも「無い」と「未定」を分けない。
      */
      ...(end.value === undefined ? {} : { end: end.value }),
      ...(taperAngle.value === undefined ? {} : { taperAngle: taperAngle.value }),
      ...(taperOutward.value === undefined ? {} : { taperOutward: taperOutward.value }),
      ...(thickness.value === undefined ? {} : { thickness: thickness.value }),
      ...(thicknessSide.value === undefined ? {} : { thicknessSide: thicknessSide.value }),
    },
  };
}

export function readRevolveFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const profile = readFaceRef(record, 'profile', path);
  if (!profile.ok) {
    return profile;
  }
  const axis = readRevolveAxis(record, 'axis', path);
  if (!axis.ok) {
    return axis;
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
      kind: 'revolve',
      profile: profile.value,
      axis: axis.value,
      angle: angle.value,
      reversed: reversed.value,
    },
  };
}

export function readSewFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const faces = readList(record, 'faces', path, readFaceRefItem);
  if (!faces.ok) {
    return faces;
  }
  const tolerance = readExpression(record, 'tolerance', path);
  if (!tolerance.ok) {
    return tolerance;
  }
  return {
    ok: true,
    value: { ...base, kind: 'sew', faces: faces.value, tolerance: tolerance.value },
  };
}

export function readBooleanFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const operation = readLiteral(record, 'operation', path, BOOLEAN_OPERATIONS);
  if (!operation.ok) {
    return operation;
  }
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const toolFeatureId = readString(record, 'toolFeatureId', path);
  if (!toolFeatureId.ok) {
    return toolFeatureId;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'boolean',
      operation: operation.value,
      targetFeatureId: targetFeatureId.value,
      toolFeatureId: toolFeatureId.value,
    },
  };
}

/** extrude の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializeExtrudeFeature(feature: Extract<SolidFeature, { readonly kind: 'extrude' }>): SolidFeature {
  return {
    id: feature.id,
    kind: 'extrude',
    name: feature.name,
    suppressed: feature.suppressed,
    profile: serializeFaceRef(feature.profile),
    distance: serializeExpression(feature.distance),
    reversed: feature.reversed,
    symmetric: feature.symmetric,
    /*
      終端・傾き・薄板(FR-415、FR-401、FR-416。P5 タスク43)。**省略は欄ごと省略のまま**
      にするので、版 6 までのファイルは往復しても欄が 1 つも増えない。
    */
    ...(feature.end === undefined ? {} : { end: serializeExtrudeEnd(feature.end) }),
    ...(feature.taperAngle === undefined
      ? {}
      : { taperAngle: serializeExpression(feature.taperAngle) }),
    ...(feature.taperOutward === undefined ? {} : { taperOutward: feature.taperOutward }),
    ...(feature.thickness === undefined
      ? {}
      : {
          thickness:
            feature.thickness === null ? null : serializeExpression(feature.thickness),
        }),
    ...(feature.thicknessSide === undefined ? {} : { thicknessSide: feature.thicknessSide }),
  };
}

/** revolve の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializeRevolveFeature(feature: Extract<SolidFeature, { readonly kind: 'revolve' }>): SolidFeature {
  return {
    id: feature.id,
    kind: 'revolve',
    name: feature.name,
    suppressed: feature.suppressed,
    profile: serializeFaceRef(feature.profile),
    axis: serializeRevolveAxis(feature.axis),
    angle: serializeExpression(feature.angle),
    reversed: feature.reversed,
  };
}

/** sew の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializeSewFeature(feature: Extract<SolidFeature, { readonly kind: 'sew' }>): SolidFeature {
  return {
    id: feature.id,
    kind: 'sew',
    name: feature.name,
    suppressed: feature.suppressed,
    faces: feature.faces.map(serializeFaceRef),
    tolerance: serializeExpression(feature.tolerance),
  };
}

/** boolean の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializeBooleanFeature(feature: Extract<SolidFeature, { readonly kind: 'boolean' }>): SolidFeature {
  return {
    id: feature.id,
    kind: 'boolean',
    name: feature.name,
    suppressed: feature.suppressed,
    operation: feature.operation,
    targetFeatureId: feature.targetFeatureId,
    toolFeatureId: feature.toolFeatureId,
  };
}
