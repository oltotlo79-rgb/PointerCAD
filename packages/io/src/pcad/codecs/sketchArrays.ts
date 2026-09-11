/** 部品 JSON: スケッチの点列と複製。documentJson.ts への逆向きの依存を持たない。 */

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
  readCoordinate,
  serializeCoordinate,
} from './coordinates.js';
import {
  readList,
  serializeExpression,
} from './fields.js';
import {
  readElementRef,
  serializeElementRef,
} from './shapeReferences.js';
import {
  readConstructionFlag,
  type SketchFeatureBase,
} from './sketchBase.js';
import {
  type CopyPlacement,
  type MirrorBasis,
  type PointArrayLayout,
  type SketchFeature,
} from '@pointercad/model';

/**
 * 複製のしかたと鏡の基準(FR-324、P4 タスク20)。`model` の `CopyPlacement['kind']` /
 * `MirrorBasis['kind']` と同じ値ずつ。
 */
const COPY_PLACEMENT_KINDS: readonly CopyPlacement['kind'][] = [
  'mirror',
  'translate',
  'linearArray',
  'circularArray',
];

const MIRROR_BASIS_KINDS: readonly MirrorBasis['kind'][] = ['axis', 'plane'];

/** 点列の並べ方(FR-327、タスク6)。`model` の `PointArrayLayout['kind']` と同じ3値。 */
const POINT_ARRAY_LAYOUT_KINDS: readonly PointArrayLayout['kind'][] = [
  'linear',
  'circular',
  'grid',
];

/** 点列の並べ方(FR-327、タスク6)。種類ごとに欄が違うので `kind` で分岐する。 */
export function serializePointArrayLayout(layout: PointArrayLayout): PointArrayLayout {
  switch (layout.kind) {
    case 'linear':
      return {
        kind: 'linear',
        base: serializeCoordinate(layout.base),
        azimuth: serializeExpression(layout.azimuth),
        spacing: serializeExpression(layout.spacing),
        count: serializeExpression(layout.count),
      };
    case 'circular':
      return {
        kind: 'circular',
        center: serializeCoordinate(layout.center),
        radius: serializeExpression(layout.radius),
        count: serializeExpression(layout.count),
      };
    case 'grid':
      return {
        kind: 'grid',
        base: serializeCoordinate(layout.base),
        rowAzimuth: serializeExpression(layout.rowAzimuth),
        rowSpacing: serializeExpression(layout.rowSpacing),
        rowCount: serializeExpression(layout.rowCount),
        colAzimuth: serializeExpression(layout.colAzimuth),
        colSpacing: serializeExpression(layout.colSpacing),
        colCount: serializeExpression(layout.colCount),
      };
  }
}

/** 鏡の基準(FR-324、タスク20)。線を軸にするか平面かで欄が違うので `kind` で分岐する。 */
function serializeMirrorBasis(basis: MirrorBasis): MirrorBasis {
  switch (basis.kind) {
    case 'axis':
      return { kind: 'axis', axis: serializeElementRef(basis.axis) };
    case 'plane':
      return { kind: 'plane', planeId: basis.planeId };
  }
}

/** 複製のしかた(FR-324、タスク20)。並べ方ごとに欄が違うので `kind` で分岐する。 */
export function serializeCopyPlacement(placement: CopyPlacement): CopyPlacement {
  switch (placement.kind) {
    case 'mirror':
      return { kind: 'mirror', basis: serializeMirrorBasis(placement.basis) };
    case 'translate':
      return { kind: 'translate', delta: serializeCoordinate(placement.delta) };
    case 'linearArray':
      return {
        kind: 'linearArray',
        direction: serializeCoordinate(placement.direction),
        spacing: serializeExpression(placement.spacing),
        count: serializeExpression(placement.count),
      };
    case 'circularArray':
      return {
        kind: 'circularArray',
        center: serializeCoordinate(placement.center),
        angle: serializeExpression(placement.angle),
        count: serializeExpression(placement.count),
        fullCircle: placement.fullCircle,
      };
  }
}

/**
 * 点列の並べ方(FR-327、タスク6)。`kind` で直線状・円周上・格子状を見分けてから
 * 種類ごとの欄を読む(スプラインの `mode` と同じ、先に判別子だけを確かめる書き方)。
 */
function readPointArrayLayout(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<PointArrayLayout> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const kind = readLiteral(record.value, 'kind', path, POINT_ARRAY_LAYOUT_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'linear':
      return readLinearLayout(record.value, path);
    case 'circular':
      return readCircularLayout(record.value, path);
    case 'grid':
      return readGridLayout(record.value, path);
  }
}

function readLinearLayout(
  record: Record<string, unknown>,
  path: string,
): Checked<PointArrayLayout> {
  const base = readCoordinate(record, 'base', path);
  if (!base.ok) {
    return base;
  }
  const azimuth = readExpression(record, 'azimuth', path);
  if (!azimuth.ok) {
    return azimuth;
  }
  const spacing = readExpression(record, 'spacing', path);
  if (!spacing.ok) {
    return spacing;
  }
  const count = readExpression(record, 'count', path);
  if (!count.ok) {
    return count;
  }
  return {
    ok: true,
    value: {
      kind: 'linear',
      base: base.value,
      azimuth: azimuth.value,
      spacing: spacing.value,
      count: count.value,
    },
  };
}

function readCircularLayout(
  record: Record<string, unknown>,
  path: string,
): Checked<PointArrayLayout> {
  const center = readCoordinate(record, 'center', path);
  if (!center.ok) {
    return center;
  }
  const radius = readExpression(record, 'radius', path);
  if (!radius.ok) {
    return radius;
  }
  const count = readExpression(record, 'count', path);
  if (!count.ok) {
    return count;
  }
  return {
    ok: true,
    value: { kind: 'circular', center: center.value, radius: radius.value, count: count.value },
  };
}

function readGridLayout(
  record: Record<string, unknown>,
  path: string,
): Checked<PointArrayLayout> {
  const base = readCoordinate(record, 'base', path);
  if (!base.ok) {
    return base;
  }
  const rowAzimuth = readExpression(record, 'rowAzimuth', path);
  if (!rowAzimuth.ok) {
    return rowAzimuth;
  }
  const rowSpacing = readExpression(record, 'rowSpacing', path);
  if (!rowSpacing.ok) {
    return rowSpacing;
  }
  const rowCount = readExpression(record, 'rowCount', path);
  if (!rowCount.ok) {
    return rowCount;
  }
  const colAzimuth = readExpression(record, 'colAzimuth', path);
  if (!colAzimuth.ok) {
    return colAzimuth;
  }
  const colSpacing = readExpression(record, 'colSpacing', path);
  if (!colSpacing.ok) {
    return colSpacing;
  }
  const colCount = readExpression(record, 'colCount', path);
  if (!colCount.ok) {
    return colCount;
  }
  return {
    ok: true,
    value: {
      kind: 'grid',
      base: base.value,
      rowAzimuth: rowAzimuth.value,
      rowSpacing: rowSpacing.value,
      rowCount: rowCount.value,
      colAzimuth: colAzimuth.value,
      colSpacing: colSpacing.value,
      colCount: colCount.value,
    },
  };
}

/**
 * 点列(FR-308、FR-327)。**版4からは `layout` が必須**(欠けていれば `missingField`)。
 * 版3以前(スキーマ版は上げなかった、統括の差し戻し 2026-09-04)は `layout` を挟まず
 * `base`/`azimuth`/`spacing`/`count` を直下に持つフラットな形もあったが、その寛容さは
 * P4 タスク31(§0.a-0.24)で `schema.ts` の `SCHEMA_MIGRATIONS[3]` へ移した
 * (直線状 `kind: 'linear'` の `layout` へ包み直す変換)。書き手は常に `layout` を書く。
 */
export function readPointArrayFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const layout = readPointArrayLayout(record, 'layout', path);
  if (!layout.ok) {
    return layout;
  }
  return { ok: true, value: { ...base, kind: 'pointArray', layout: layout.value } };
}

/** 鏡の基準(FR-324、タスク20)。`kind` で線を軸にするか平面かを見分けてから欄を読む。 */
function readMirrorBasis(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<MirrorBasis> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const kind = readLiteral(record.value, 'kind', path, MIRROR_BASIS_KINDS);
  if (!kind.ok) {
    return kind;
  }
  if (kind.value === 'plane') {
    const planeId = readString(record.value, 'planeId', path);
    if (!planeId.ok) {
      return planeId;
    }
    return { ok: true, value: { kind: 'plane', planeId: planeId.value } };
  }
  const axis = readRecord(record.value, 'axis', path);
  if (!axis.ok) {
    return axis;
  }
  const reference = readElementRef(axis.value, joinPath(path, 'axis'));
  if (!reference.ok) {
    return reference;
  }
  return { ok: true, value: { kind: 'axis', axis: reference.value } };
}

/**
 * 複製のしかた(FR-324、タスク20)。`kind` で並べ方を見分けてから種類ごとの欄を読む
 * (点列の `layout` と同じ書き方)。
 */
function readCopyPlacement(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<CopyPlacement> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const kind = readLiteral(record.value, 'kind', path, COPY_PLACEMENT_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'mirror': {
      const basis = readMirrorBasis(record.value, 'basis', path);
      if (!basis.ok) {
        return basis;
      }
      return { ok: true, value: { kind: 'mirror', basis: basis.value } };
    }
    case 'translate': {
      const delta = readCoordinate(record.value, 'delta', path);
      if (!delta.ok) {
        return delta;
      }
      return { ok: true, value: { kind: 'translate', delta: delta.value } };
    }
    case 'linearArray':
      return readLinearArrayPlacement(record.value, path);
    case 'circularArray':
      return readCircularArrayPlacement(record.value, path);
  }
}

function readLinearArrayPlacement(
  record: Record<string, unknown>,
  path: string,
): Checked<CopyPlacement> {
  const direction = readCoordinate(record, 'direction', path);
  if (!direction.ok) {
    return direction;
  }
  const spacing = readExpression(record, 'spacing', path);
  if (!spacing.ok) {
    return spacing;
  }
  const count = readExpression(record, 'count', path);
  if (!count.ok) {
    return count;
  }
  return {
    ok: true,
    value: {
      kind: 'linearArray',
      direction: direction.value,
      spacing: spacing.value,
      count: count.value,
    },
  };
}

function readCircularArrayPlacement(
  record: Record<string, unknown>,
  path: string,
): Checked<CopyPlacement> {
  const center = readCoordinate(record, 'center', path);
  if (!center.ok) {
    return center;
  }
  const angle = readExpression(record, 'angle', path);
  if (!angle.ok) {
    return angle;
  }
  const count = readExpression(record, 'count', path);
  if (!count.ok) {
    return count;
  }
  const fullCircle = readBoolean(record, 'fullCircle', path);
  if (!fullCircle.ok) {
    return fullCircle;
  }
  return {
    ok: true,
    value: {
      kind: 'circularArray',
      center: center.value,
      angle: angle.value,
      count: count.value,
      fullCircle: fullCircle.value,
    },
  };
}

/**
 * ミラー・複写・配列複写(FR-324、P4 タスク20)を読む。
 * 複製された曲線は保存されていない(再計算で導く)ので、読むのは元の要素と複製のしかただけ。
 */
export function readCopyFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const source = readList(record, 'source', path, readElementRef);
  if (!source.ok) {
    return source;
  }
  const placement = readCopyPlacement(record, 'placement', path);
  if (!placement.ok) {
    return placement;
  }
  const construction = readConstructionFlag(record, path);
  if (!construction.ok) {
    return construction;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'copy',
      source: source.value,
      placement: placement.value,
      construction: construction.value,
    },
  };
}
