/** 部品 JSON: 基本形状とばね。documentJson.ts への逆向きの依存を持たない。 */

import {
  type Checked,
  checkRecord,
  joinPath,
  readExpression,
  readLiteral,
  readRecord,
  readValue,
} from '../guards.js';
import {
  readCoordinate,
  serializeCoordinate,
} from './coordinates.js';
import {
  serializeExpression,
} from './fields.js';
import {
  readPointRefField,
  readRevolveAxis,
  readSubShapeRefField,
  serializePointRef,
  serializeRevolveAxis,
  serializeSubShapeRef,
} from './shapeReferences.js';
import {
  type SolidFeatureBase,
} from './solidBase.js';
import {
  type PrimitiveShape,
  type SolidFeature,
  type SolidOrigin,
  type SpringDerived,
  type SpringHandedness,
} from '@pointercad/model';

/**
 * 基本形状(FR-429、P5 計画書 §0.a-0.18、タスク17)の基準点の3通り
 * (座標の式・スケッチの点・立体の頂点)。
 */
const SOLID_ORIGIN_KINDS: readonly SolidOrigin['kind'][] = ['coordinate', 'sketchPoint', 'vertex'];

/** 基本形状5種の判別(球・箱・円柱・円錐・トーラス。FR-429、P5 計画書 §2.7.1、タスク17)。 */
const PRIMITIVE_SHAPE_KINDS: readonly PrimitiveShape['kind'][] = [
  'sphere',
  'box',
  'cylinder',
  'cone',
  'torus',
];

const SPRING_DERIVED_VALUES: readonly SpringDerived[] = ['length', 'pitch', 'turns'];

const SPRING_HANDEDNESS_VALUES: readonly SpringHandedness[] = ['right', 'left'];

/**
 * 基本形状の基準点(FR-429、P5 計画書 §2.7.1、タスク17)。3通りで欄が違うので
 * `kind` で分岐する。`vertex` の指紋は `serializeSubShapeRef` をそのまま使い回す
 * (P3 の加工フィーチャーと同じ形)。
 */
function serializeSolidOrigin(origin: SolidOrigin): SolidOrigin {
  switch (origin.kind) {
    case 'coordinate':
      return { kind: 'coordinate', value: serializeCoordinate(origin.value) };
    case 'sketchPoint':
      return { kind: 'sketchPoint', ref: serializePointRef(origin.ref) };
    case 'vertex':
      return { kind: 'vertex', ref: serializeSubShapeRef(origin.ref) };
  }
}

/**
 * 基本形状の寸法(FR-429、P5 計画書 §2.7.1、タスク17)。種類ごとに欄が違うので
 * `kind` で分岐する。寸法は式のまま保存する(FR-202)。
 */
function serializePrimitiveShape(shape: PrimitiveShape): PrimitiveShape {
  switch (shape.kind) {
    case 'sphere':
      return { kind: 'sphere', radius: serializeExpression(shape.radius) };
    case 'box':
      return {
        kind: 'box',
        sizeX: serializeExpression(shape.sizeX),
        sizeY: serializeExpression(shape.sizeY),
        sizeZ: serializeExpression(shape.sizeZ),
      };
    case 'cylinder':
      return {
        kind: 'cylinder',
        radius: serializeExpression(shape.radius),
        height: serializeExpression(shape.height),
      };
    case 'cone':
      return {
        kind: 'cone',
        bottomRadius: serializeExpression(shape.bottomRadius),
        topRadius: serializeExpression(shape.topRadius),
        height: serializeExpression(shape.height),
      };
    case 'torus':
      return {
        kind: 'torus',
        majorRadius: serializeExpression(shape.majorRadius),
        minorRadius: serializeExpression(shape.minorRadius),
      };
  }
}

/**
 * ばね(FR-414、§2.7b)を読む。`derived` / `handedness` は選択肢の一覧と突き合わせて絞る
 * (知らない値は断る)。
 */
export function readSpringFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const origin = readPointRefField(record, 'origin', path);
  if (!origin.ok) {
    return origin;
  }
  const axis = readRevolveAxis(record, 'axis', path);
  if (!axis.ok) {
    return axis;
  }
  const tiltAngle = readExpression(record, 'tiltAngle', path);
  if (!tiltAngle.ok) {
    return tiltAngle;
  }
  const tiltAzimuth = readExpression(record, 'tiltAzimuth', path);
  if (!tiltAzimuth.ok) {
    return tiltAzimuth;
  }
  const length = readExpression(record, 'length', path);
  if (!length.ok) {
    return length;
  }
  const pitch = readExpression(record, 'pitch', path);
  if (!pitch.ok) {
    return pitch;
  }
  const turns = readExpression(record, 'turns', path);
  if (!turns.ok) {
    return turns;
  }
  const derived = readLiteral(record, 'derived', path, SPRING_DERIVED_VALUES);
  if (!derived.ok) {
    return derived;
  }
  const coilDiameter = readExpression(record, 'coilDiameter', path);
  if (!coilDiameter.ok) {
    return coilDiameter;
  }
  const wireDiameter = readExpression(record, 'wireDiameter', path);
  if (!wireDiameter.ok) {
    return wireDiameter;
  }
  const handedness = readLiteral(record, 'handedness', path, SPRING_HANDEDNESS_VALUES);
  if (!handedness.ok) {
    return handedness;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'spring',
      origin: origin.value,
      axis: axis.value,
      tiltAngle: tiltAngle.value,
      tiltAzimuth: tiltAzimuth.value,
      length: length.value,
      pitch: pitch.value,
      turns: turns.value,
      derived: derived.value,
      coilDiameter: coilDiameter.value,
      wireDiameter: wireDiameter.value,
      handedness: handedness.value,
    },
  };
}

// ---------------------------------------------------------------------------
// P5(FR-429、計画書 §2.7.1、タスク17)が足す基本形状の読み込み
// ---------------------------------------------------------------------------

/**
 * 基本形状の基準点を読む(FR-429)。3通りで欄が違うので `kind` で分岐する。
 * `sketchPoint` は `readPointRefField`、`vertex` は `readSubShapeRefField`(P3 の
 * 加工フィーチャーと同じ組み立て)をそのまま使い回す。
 */
function readSolidOrigin(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<SolidOrigin> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const kind = readLiteral(record.value, 'kind', path, SOLID_ORIGIN_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'coordinate': {
      const coordinate = readCoordinate(record.value, 'value', path);
      if (!coordinate.ok) {
        return coordinate;
      }
      return { ok: true, value: { kind: 'coordinate', value: coordinate.value } };
    }
    case 'sketchPoint': {
      const ref = readPointRefField(record.value, 'ref', path);
      if (!ref.ok) {
        return ref;
      }
      return { ok: true, value: { kind: 'sketchPoint', ref: ref.value } };
    }
    case 'vertex': {
      const ref = readSubShapeRefField(record.value, 'ref', path);
      if (!ref.ok) {
        return ref;
      }
      return { ok: true, value: { kind: 'vertex', ref: ref.value } };
    }
  }
}

/** 基本形状の寸法を読む(FR-429)。種類ごとに欄が違うので `kind` で分岐する。 */
function readPrimitiveShape(value: unknown, path: string): Checked<PrimitiveShape> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const kind = readLiteral(record.value, 'kind', path, PRIMITIVE_SHAPE_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'sphere': {
      const radius = readExpression(record.value, 'radius', path);
      if (!radius.ok) {
        return radius;
      }
      return { ok: true, value: { kind: 'sphere', radius: radius.value } };
    }
    case 'box': {
      const sizeX = readExpression(record.value, 'sizeX', path);
      if (!sizeX.ok) {
        return sizeX;
      }
      const sizeY = readExpression(record.value, 'sizeY', path);
      if (!sizeY.ok) {
        return sizeY;
      }
      const sizeZ = readExpression(record.value, 'sizeZ', path);
      if (!sizeZ.ok) {
        return sizeZ;
      }
      return {
        ok: true,
        value: { kind: 'box', sizeX: sizeX.value, sizeY: sizeY.value, sizeZ: sizeZ.value },
      };
    }
    case 'cylinder': {
      const radius = readExpression(record.value, 'radius', path);
      if (!radius.ok) {
        return radius;
      }
      const height = readExpression(record.value, 'height', path);
      if (!height.ok) {
        return height;
      }
      return { ok: true, value: { kind: 'cylinder', radius: radius.value, height: height.value } };
    }
    case 'cone': {
      const bottomRadius = readExpression(record.value, 'bottomRadius', path);
      if (!bottomRadius.ok) {
        return bottomRadius;
      }
      const topRadius = readExpression(record.value, 'topRadius', path);
      if (!topRadius.ok) {
        return topRadius;
      }
      const height = readExpression(record.value, 'height', path);
      if (!height.ok) {
        return height;
      }
      return {
        ok: true,
        value: {
          kind: 'cone',
          bottomRadius: bottomRadius.value,
          topRadius: topRadius.value,
          height: height.value,
        },
      };
    }
    case 'torus': {
      const majorRadius = readExpression(record.value, 'majorRadius', path);
      if (!majorRadius.ok) {
        return majorRadius;
      }
      const minorRadius = readExpression(record.value, 'minorRadius', path);
      if (!minorRadius.ok) {
        return minorRadius;
      }
      return {
        ok: true,
        value: { kind: 'torus', majorRadius: majorRadius.value, minorRadius: minorRadius.value },
      };
    }
  }
}

function readPrimitiveShapeField(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<PrimitiveShape> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  return readPrimitiveShape(found.value, joinPath(parentPath, key));
}

/**
 * 基本形状(球・箱・円柱・円錐・トーラス。FR-429、P5 計画書 §2.7.1、タスク17)を読む。
 * 対象を消費しない「作る」フィーチャーなので、押し出し・ばねと同じ構え(基本の欄 +
 * 種類固有の欄)で読む。
 */
export function readPrimitiveFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const origin = readSolidOrigin(record, 'origin', path);
  if (!origin.ok) {
    return origin;
  }
  const axis = readRevolveAxis(record, 'axis', path);
  if (!axis.ok) {
    return axis;
  }
  const shape = readPrimitiveShapeField(record, 'shape', path);
  if (!shape.ok) {
    return shape;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'primitive',
      origin: origin.value,
      axis: axis.value,
      shape: shape.value,
    },
  };
}

/** spring の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializeSpringFeature(feature: Extract<SolidFeature, { readonly kind: 'spring' }>): SolidFeature {
  return {
    id: feature.id,
    kind: 'spring',
    name: feature.name,
    suppressed: feature.suppressed,
    origin: serializePointRef(feature.origin),
    axis: serializeRevolveAxis(feature.axis),
    tiltAngle: serializeExpression(feature.tiltAngle),
    tiltAzimuth: serializeExpression(feature.tiltAzimuth),
    length: serializeExpression(feature.length),
    pitch: serializeExpression(feature.pitch),
    turns: serializeExpression(feature.turns),
    derived: feature.derived,
    coilDiameter: serializeExpression(feature.coilDiameter),
    wireDiameter: serializeExpression(feature.wireDiameter),
    handedness: feature.handedness,
  };
}

/** primitive の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializePrimitiveFeature(feature: Extract<SolidFeature, { readonly kind: 'primitive' }>): SolidFeature {
  // 基本形状(FR-429、P5 計画書 §2.7.1、タスク17)。対象を消費しない「作る」
  // フィーチャーなので、押し出し・ばねと同じく欄をそのまま組み立てる。
  return {
    id: feature.id,
    kind: 'primitive',
    name: feature.name,
    suppressed: feature.suppressed,
    origin: serializeSolidOrigin(feature.origin),
    axis: serializeRevolveAxis(feature.axis),
    shape: serializePrimitiveShape(feature.shape),
  };
}
