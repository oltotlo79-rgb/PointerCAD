/** 部品 JSON: スケッチ図形。documentJson.ts への逆向きの依存を持たない。 */

import {
  type Checked,
  readBoolean,
  readExpression,
  readLiteral,
  readString,
} from '../guards.js';
import {
  readCoordinate,
  readCoordinateItem,
  readFreeOrientation,
} from './coordinates.js';
import {
  readList,
} from './fields.js';
import {
  readElementRef,
  readSubShapeRefField,
} from './shapeReferences.js';
import {
  readConstructionFlag,
  type SketchFeatureBase,
} from './sketchBase.js';
import {
  type OffsetCornerKind,
  type OffsetSide,
  type SketchArcFeature,
  type SketchFeature,
} from '@pointercad/model';

/**
 * オフセット(FR-321、P4 タスク15)の側と角。`model` の `OffsetSide` /
 * `OffsetCornerKind` と同じ2値ずつ。
 */
const OFFSET_SIDES: readonly OffsetSide[] = ['outside', 'inside'];

const OFFSET_CORNERS: readonly OffsetCornerKind[] = ['round', 'sharp'];

/** 正多角形(FR-315)の半径の意味。`model` の `SketchPolygonFeature.radiusMode` と同じ2値。 */
const POLYGON_RADIUS_MODES: readonly ('circumscribed' | 'inscribed')[] = [
  'circumscribed',
  'inscribed',
];

/** スプライン(FR-317)の点の意味。`model` の `SketchSplineFeature.mode` と同じ2値。 */
const SPLINE_MODES: readonly ('interpolate' | 'control')[] = ['interpolate', 'control'];

export function readPointFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const at = readCoordinate(record, 'at', path);
  if (!at.ok) {
    return at;
  }
  return { ok: true, value: { ...base, kind: 'point', at: at.value } };
}

export function readLineFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const from = readCoordinate(record, 'from', path);
  if (!from.ok) {
    return from;
  }
  const to = readCoordinate(record, 'to', path);
  if (!to.ok) {
    return to;
  }
  const construction = readConstructionFlag(record, path);
  if (!construction.ok) {
    return construction;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'line',
      from: from.value,
      to: to.value,
      construction: construction.value,
    },
  };
}

export function readArcFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const center = readCoordinate(record, 'center', path);
  if (!center.ok) {
    return center;
  }
  const radius = readExpression(record, 'radius', path);
  if (!radius.ok) {
    return radius;
  }
  const startAngle = readExpression(record, 'startAngle', path);
  if (!startAngle.ok) {
    return startAngle;
  }
  const endAngle = readExpression(record, 'endAngle', path);
  if (!endAngle.ok) {
    return endAngle;
  }
  const construction = readConstructionFlag(record, path);
  if (!construction.ok) {
    return construction;
  }
  const freeOrientation = readFreeOrientation(record, path);
  if (!freeOrientation.ok) {
    return freeOrientation;
  }
  const arc: SketchArcFeature = {
    ...base,
    kind: 'arc',
    center: center.value,
    radius: radius.value,
    startAngle: startAngle.value,
    endAngle: endAngle.value,
    construction: construction.value,
  };
  if (freeOrientation.value === null) {
    return { ok: true, value: arc };
  }
  return { ok: true, value: { ...arc, freeOrientation: freeOrientation.value } };
}

export function readFaceFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const boundary = readList(record, 'boundary', path, readElementRef);
  if (!boundary.ok) {
    return boundary;
  }
  const color = readString(record, 'color', path);
  if (!color.ok) {
    return color;
  }
  return {
    ok: true,
    value: { ...base, kind: 'face', boundary: boundary.value, color: color.value },
  };
}

export function readRectangleFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const corner1 = readCoordinate(record, 'corner1', path);
  if (!corner1.ok) {
    return corner1;
  }
  const corner2 = readCoordinate(record, 'corner2', path);
  if (!corner2.ok) {
    return corner2;
  }
  const construction = readConstructionFlag(record, path);
  if (!construction.ok) {
    return construction;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'rectangle',
      corner1: corner1.value,
      corner2: corner2.value,
      construction: construction.value,
    },
  };
}

export function readPolygonFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const center = readCoordinate(record, 'center', path);
  if (!center.ok) {
    return center;
  }
  const sides = readExpression(record, 'sides', path);
  if (!sides.ok) {
    return sides;
  }
  const radius = readExpression(record, 'radius', path);
  if (!radius.ok) {
    return radius;
  }
  const radiusMode = readLiteral(record, 'radiusMode', path, POLYGON_RADIUS_MODES);
  if (!radiusMode.ok) {
    return radiusMode;
  }
  const construction = readConstructionFlag(record, path);
  if (!construction.ok) {
    return construction;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'polygon',
      center: center.value,
      sides: sides.value,
      radius: radius.value,
      radiusMode: radiusMode.value,
      construction: construction.value,
    },
  };
}

export function readSlotFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const center1 = readCoordinate(record, 'center1', path);
  if (!center1.ok) {
    return center1;
  }
  const center2 = readCoordinate(record, 'center2', path);
  if (!center2.ok) {
    return center2;
  }
  const width = readExpression(record, 'width', path);
  if (!width.ok) {
    return width;
  }
  const construction = readConstructionFlag(record, path);
  if (!construction.ok) {
    return construction;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'slot',
      center1: center1.value,
      center2: center2.value,
      width: width.value,
      construction: construction.value,
    },
  };
}

export function readEllipseFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const center = readCoordinate(record, 'center', path);
  if (!center.ok) {
    return center;
  }
  const majorRadius = readExpression(record, 'majorRadius', path);
  if (!majorRadius.ok) {
    return majorRadius;
  }
  const minorRadius = readExpression(record, 'minorRadius', path);
  if (!minorRadius.ok) {
    return minorRadius;
  }
  const rotation = readExpression(record, 'rotation', path);
  if (!rotation.ok) {
    return rotation;
  }
  const startAngle = readExpression(record, 'startAngle', path);
  if (!startAngle.ok) {
    return startAngle;
  }
  const endAngle = readExpression(record, 'endAngle', path);
  if (!endAngle.ok) {
    return endAngle;
  }
  const construction = readConstructionFlag(record, path);
  if (!construction.ok) {
    return construction;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'ellipse',
      center: center.value,
      majorRadius: majorRadius.value,
      minorRadius: minorRadius.value,
      rotation: rotation.value,
      startAngle: startAngle.value,
      endAngle: endAngle.value,
      construction: construction.value,
    },
  };
}

export function readSplineFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const mode = readLiteral(record, 'mode', path, SPLINE_MODES);
  if (!mode.ok) {
    return mode;
  }
  const points = readList(record, 'points', path, readCoordinateItem);
  if (!points.ok) {
    return points;
  }
  const closed = readBoolean(record, 'closed', path);
  if (!closed.ok) {
    return closed;
  }
  const construction = readConstructionFlag(record, path);
  if (!construction.ok) {
    return construction;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'spline',
      mode: mode.value,
      points: points.value,
      closed: closed.value,
      construction: construction.value,
    },
  };
}

/**
 * オフセット(FR-321、P4 タスク15)を読む。
 * ずらした後の曲線は保存されていない(再計算で導く)ので、読むのは元の要素・距離・
 * 側・角だけ。距離の符号は使わず、どちら側かは `side` が持つ。
 */
export function readOffsetFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const source = readList(record, 'source', path, readElementRef);
  if (!source.ok) {
    return source;
  }
  const distance = readExpression(record, 'distance', path);
  if (!distance.ok) {
    return distance;
  }
  const side = readLiteral(record, 'side', path, OFFSET_SIDES);
  if (!side.ok) {
    return side;
  }
  const corner = readLiteral(record, 'corner', path, OFFSET_CORNERS);
  if (!corner.ok) {
    return corner;
  }
  const construction = readConstructionFlag(record, path);
  if (!construction.ok) {
    return construction;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'offset',
      source: source.value,
      distance: distance.value,
      side: side.value,
      corner: corner.value,
      construction: construction.value,
    },
  };
}

/**
 * 投影(FR-325、P4 タスク25)を読む。
 * 投影された曲線は保存されていない(立体と作図面から再計算で導く)ので、
 * 読むのは投影元の面・辺への参照だけ。
 */
export function readProjectedCurveFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const source = readSubShapeRefField(record, 'source', path);
  if (!source.ok) {
    return source;
  }
  const construction = readConstructionFlag(record, path);
  if (!construction.ok) {
    return construction;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'projectedCurve',
      source: source.value,
      construction: construction.value,
    },
  };
}

/** 交差(FR-325、P4 タスク25)を読む。断面を取る立体の id だけを持つ。 */
export function readPlaneSectionFeature(
  record: Record<string, unknown>,
  path: string,
  base: SketchFeatureBase,
): Checked<SketchFeature> {
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const construction = readConstructionFlag(record, path);
  if (!construction.ok) {
    return construction;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'planeSection',
      targetFeatureId: targetFeatureId.value,
      construction: construction.value,
    },
  };
}
