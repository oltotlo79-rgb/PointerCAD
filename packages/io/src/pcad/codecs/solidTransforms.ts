/** 部品 JSON: 配置・複製・変換。documentJson.ts への逆向きの依存を持たない。 */

import {
  type Checked,
  checkRecord,
  fieldProblem,
  joinPath,
  readBoolean,
  readExpression,
  readLiteral,
  readRecord,
  readString,
  readValue,
} from '../guards.js';
import {
  readPointReference,
  readPointReferenceItem,
  serializePointReference,
} from './coordinates.js';
import {
  WORLD_AXES,
} from './discriminants.js';
import {
  readExpressionItem,
  readList,
  serializeExpression,
} from './fields.js';
import {
  readOptionalRevolveAxis,
  readSubShapeRefField,
  serializeLineRef,
  serializeRevolveAxis,
  serializeSubShapeRef,
} from './shapeReferences.js';
import {
  type SolidFeatureBase,
} from './solidBase.js';
import {
  type MirrorPlane,
  type PatternDirection,
  type PatternPlacement,
  type ScaleFactor,
  type SolidFeature,
} from '@pointercad/model';

/** ミラーの鏡にする平面の2通り(FR-419、§0.a-0.36)。 */
const MIRROR_PLANE_KINDS: readonly MirrorPlane['kind'][] = ['workPlane', 'face'];

/** 拡大縮小の倍率の2通り(FR-424、§0.a-0.41)。 */
const SCALE_FACTOR_KINDS: readonly ScaleFactor['kind'][] = ['uniform', 'perAxis'];

const PATTERN_DIRECTION_KINDS: readonly PatternDirection['kind'][] = [
  'world',
  'line',
  'reference',
];

const PATTERN_PLACEMENT_KINDS: readonly PatternPlacement['kind'][] = [
  'linear',
  'circular',
  // 点の集まりへ複製(FR-425、P5 §0.a-0.42、タスク43)。
  'points',
];

function serializePatternDirection(direction: PatternDirection): PatternDirection {
  switch (direction.kind) {
    case 'world':
      return { kind: 'world', axis: direction.axis };
    case 'line':
      return { kind: 'line', line: serializeLineRef(direction.line) };
    case 'reference':
      return { kind: 'reference', referenceFeatureId: direction.referenceFeatureId };
  }
}

/** ミラーの鏡にする平面(FR-419、P5 タスク43)。 */
function serializeMirrorPlane(plane: MirrorPlane): MirrorPlane {
  switch (plane.kind) {
    case 'workPlane':
      return { kind: 'workPlane', planeId: plane.planeId };
    case 'face':
      return { kind: 'face', face: serializeSubShapeRef(plane.face) };
  }
}

/** 拡大縮小の倍率(FR-424、P5 タスク43)。 */
function serializeScaleFactor(factor: ScaleFactor): ScaleFactor {
  switch (factor.kind) {
    case 'uniform':
      return { kind: 'uniform', value: serializeExpression(factor.value) };
    case 'perAxis':
      return {
        kind: 'perAxis',
        x: serializeExpression(factor.x),
        y: serializeExpression(factor.y),
        z: serializeExpression(factor.z),
      };
  }
}

function serializePatternPlacement(placement: PatternPlacement): PatternPlacement {
  switch (placement.kind) {
    case 'linear':
      return {
        kind: 'linear',
        direction: serializePatternDirection(placement.direction),
        spacing: serializeExpression(placement.spacing),
        count: serializeExpression(placement.count),
        symmetric: placement.symmetric,
      };
    case 'circular':
      return {
        kind: 'circular',
        axis: serializePatternDirection(placement.axis),
        angle: serializeExpression(placement.angle),
        count: serializeExpression(placement.count),
        fullCircle: placement.fullCircle,
      };
    case 'points':
      // 点の集まりへ複製(FR-425、P5 タスク43)。個数・間隔の欄は無く、点の並びだけ。
      return { kind: 'points', points: placement.points.map(serializePointReference) };
  }
}

/**
 * パターンの向き・軸(§0.a-0.21)を読む。`RevolveAxis` と欄の形は同じだが、
 * 意味が違う別の型なので `readRevolveAxis` を使い回さず、同じ組み立てを別に持つ
 * (model 側が2つの型を分けているのと揃える)。
 */
function readPatternDirection(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<PatternDirection> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const kind = readLiteral(record.value, 'kind', path, PATTERN_DIRECTION_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'world': {
      const axis = readLiteral(record.value, 'axis', path, WORLD_AXES);
      if (!axis.ok) {
        return axis;
      }
      return { ok: true, value: { kind: 'world', axis: axis.value } };
    }
    case 'line': {
      const line = readRecord(record.value, 'line', path);
      if (!line.ok) {
        return line;
      }
      const linePath = joinPath(path, 'line');
      const sketchId = readString(line.value, 'sketchId', linePath);
      if (!sketchId.ok) {
        return sketchId;
      }
      const lineFeatureId = readString(line.value, 'lineFeatureId', linePath);
      if (!lineFeatureId.ok) {
        return lineFeatureId;
      }
      return {
        ok: true,
        value: {
          kind: 'line',
          line: { sketchId: sketchId.value, lineFeatureId: lineFeatureId.value },
        },
      };
    }
    case 'reference': {
      const referenceFeatureId = readString(record.value, 'referenceFeatureId', path);
      if (!referenceFeatureId.ok) {
        return referenceFeatureId;
      }
      return {
        ok: true,
        value: { kind: 'reference', referenceFeatureId: referenceFeatureId.value },
      };
    }
  }
}

/** パターンの並べ方(直線・円形、§2.7)を読む。 */
function readPatternPlacement(value: unknown, path: string): Checked<PatternPlacement> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const kind = readLiteral(record.value, 'kind', path, PATTERN_PLACEMENT_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'linear': {
      const direction = readPatternDirection(record.value, 'direction', path);
      if (!direction.ok) {
        return direction;
      }
      const spacing = readExpression(record.value, 'spacing', path);
      if (!spacing.ok) {
        return spacing;
      }
      const count = readExpression(record.value, 'count', path);
      if (!count.ok) {
        return count;
      }
      const symmetric = readBoolean(record.value, 'symmetric', path);
      if (!symmetric.ok) {
        return symmetric;
      }
      return {
        ok: true,
        value: {
          kind: 'linear',
          direction: direction.value,
          spacing: spacing.value,
          count: count.value,
          symmetric: symmetric.value,
        },
      };
    }
    case 'circular': {
      const axis = readPatternDirection(record.value, 'axis', path);
      if (!axis.ok) {
        return axis;
      }
      const angle = readExpression(record.value, 'angle', path);
      if (!angle.ok) {
        return angle;
      }
      const count = readExpression(record.value, 'count', path);
      if (!count.ok) {
        return count;
      }
      const fullCircle = readBoolean(record.value, 'fullCircle', path);
      if (!fullCircle.ok) {
        return fullCircle;
      }
      return {
        ok: true,
        value: {
          kind: 'circular',
          axis: axis.value,
          angle: angle.value,
          count: count.value,
          fullCircle: fullCircle.value,
        },
      };
    }
    case 'points': {
      // 点の集まりへ複製(FR-425、P5 タスク43)。個数・間隔の欄は無い。
      const points = readList(record.value, 'points', path, readPointReferenceItem);
      if (!points.ok) {
        return points;
      }
      return { ok: true, value: { kind: 'points', points: points.value } };
    }
  }
}

function readPatternPlacementField(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<PatternPlacement> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  return readPatternPlacement(found.value, joinPath(parentPath, key));
}

/** パターン(FR-411、FR-412、§0.a-0.20、§0.a-0.21)を読む。もとにする加工フィーチャーの id を持つ。 */
export function readPatternFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const sourceFeatureId = readString(record, 'sourceFeatureId', path);
  if (!sourceFeatureId.ok) {
    return sourceFeatureId;
  }
  const placement = readPatternPlacementField(record, 'placement', path);
  if (!placement.ok) {
    return placement;
  }
  return {
    ok: true,
    value: { ...base, kind: 'pattern', sourceFeatureId: sourceFeatureId.value, placement: placement.value },
  };
}

/** ミラー(FR-419)を読む。鏡は作業平面の id か立体の平らな面。 */
export function readMirrorFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const plane = readMirrorPlane(record, 'plane', path);
  if (!plane.ok) {
    return plane;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'mirror',
      targetFeatureId: targetFeatureId.value,
      plane: plane.value,
    },
  };
}

function readMirrorPlane(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<MirrorPlane> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const kind = readLiteral(record.value, 'kind', path, MIRROR_PLANE_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'workPlane': {
      const planeId = readString(record.value, 'planeId', path);
      if (!planeId.ok) {
        return planeId;
      }
      return { ok: true, value: { kind: 'workPlane', planeId: planeId.value } };
    }
    case 'face': {
      const face = readSubShapeRefField(record.value, 'face', path);
      if (!face.ok) {
        return face;
      }
      return { ok: true, value: { kind: 'face', face: face.value } };
    }
  }
}

/** 移動/回転(FR-424)を読む。移動は式 3 つ、回転軸は無し(null)でもよい。 */
export function readTransformFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const translation = readList(record, 'translation', path, readExpressionItem);
  if (!translation.ok) {
    return translation;
  }
  if (translation.value.length !== 3) {
    return fieldProblem(joinPath(path, 'translation'), 'type');
  }
  const rotationAxis = readOptionalRevolveAxis(record, 'rotationAxis', path);
  if (!rotationAxis.ok) {
    return rotationAxis;
  }
  const rotationAngle = readExpression(record, 'rotationAngle', path);
  if (!rotationAngle.ok) {
    return rotationAngle;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'transform',
      targetFeatureId: targetFeatureId.value,
      translation: [translation.value[0], translation.value[1], translation.value[2]],
      rotationAxis: rotationAxis.value,
      rotationAngle: rotationAngle.value,
    },
  };
}

/** 拡大縮小(FR-424)を読む。中心は点の指定、倍率は全体か軸ごと。 */
export function readScaleFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const origin = readPointReference(record, 'origin', path);
  if (!origin.ok) {
    return origin;
  }
  const factor = readScaleFactor(record, 'factor', path);
  if (!factor.ok) {
    return factor;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'scale',
      targetFeatureId: targetFeatureId.value,
      origin: origin.value,
      factor: factor.value,
    },
  };
}

function readScaleFactor(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<ScaleFactor> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const kind = readLiteral(record.value, 'kind', path, SCALE_FACTOR_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'uniform': {
      const value = readExpression(record.value, 'value', path);
      if (!value.ok) {
        return value;
      }
      return { ok: true, value: { kind: 'uniform', value: value.value } };
    }
    case 'perAxis': {
      const x = readExpression(record.value, 'x', path);
      if (!x.ok) {
        return x;
      }
      const y = readExpression(record.value, 'y', path);
      if (!y.ok) {
        return y;
      }
      const z = readExpression(record.value, 'z', path);
      if (!z.ok) {
        return z;
      }
      return { ok: true, value: { kind: 'perAxis', x: x.value, y: y.value, z: z.value } };
    }
  }
}

/** pattern の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializePatternFeature(feature: Extract<SolidFeature, { readonly kind: 'pattern' }>): SolidFeature {
  return {
    id: feature.id,
    kind: 'pattern',
    name: feature.name,
    suppressed: feature.suppressed,
    sourceFeatureId: feature.sourceFeatureId,
    placement: serializePatternPlacement(feature.placement),
  };
}

/** mirror の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializeMirrorFeature(feature: Extract<SolidFeature, { readonly kind: 'mirror' }>): SolidFeature {
  return {
    id: feature.id,
    kind: 'mirror',
    name: feature.name,
    suppressed: feature.suppressed,
    targetFeatureId: feature.targetFeatureId,
    plane: serializeMirrorPlane(feature.plane),
  };
}

/** transform の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializeTransformFeature(feature: Extract<SolidFeature, { readonly kind: 'transform' }>): SolidFeature {
  return {
    id: feature.id,
    kind: 'transform',
    name: feature.name,
    suppressed: feature.suppressed,
    targetFeatureId: feature.targetFeatureId,
    translation: [
      serializeExpression(feature.translation[0]),
      serializeExpression(feature.translation[1]),
      serializeExpression(feature.translation[2]),
    ],
    rotationAxis:
      feature.rotationAxis === null ? null : serializeRevolveAxis(feature.rotationAxis),
    rotationAngle: serializeExpression(feature.rotationAngle),
  };
}

/** scale の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializeScaleFeature(feature: Extract<SolidFeature, { readonly kind: 'scale' }>): SolidFeature {
  return {
    id: feature.id,
    kind: 'scale',
    name: feature.name,
    suppressed: feature.suppressed,
    targetFeatureId: feature.targetFeatureId,
    origin: serializePointReference(feature.origin),
    factor: serializeScaleFactor(feature.factor),
  };
}
