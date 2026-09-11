/** 部品 JSON: スケッチ文書と要素の振り分け。documentJson.ts への逆向きの依存を持たない。 */

import {
  type Checked,
  checkRecord,
  readLiteral,
  readString,
} from '../guards.js';
import {
  serializeCoordinate,
  serializeFreeOrientation,
} from './coordinates.js';
import {
  readList,
  serializeExpression,
} from './fields.js';
import {
  serializeElementRef,
  serializeSubShapeRef,
} from './shapeReferences.js';
import {
  readCopyFeature,
  readPointArrayFeature,
  serializeCopyPlacement,
  serializePointArrayLayout,
} from './sketchArrays.js';
import {
  readSketchFeatureBase,
} from './sketchBase.js';
import {
  readSketchConstraintsField,
  serializeConstraint,
} from './sketchConstraints.js';
import {
  readArcFeature,
  readEllipseFeature,
  readFaceFeature,
  readLineFeature,
  readOffsetFeature,
  readPlaneSectionFeature,
  readPointFeature,
  readPolygonFeature,
  readProjectedCurveFeature,
  readRectangleFeature,
  readSlotFeature,
  readSplineFeature,
} from './sketchGeometry.js';
import {
  type SketchArcFeature,
  type SketchDocument,
  type SketchFeature,
} from '@pointercad/model';

const SKETCH_FEATURE_KINDS: readonly SketchFeature['kind'][] = [
  'point',
  'line',
  'arc',
  'pointArray',
  'face',
  'rectangle',
  'polygon',
  'slot',
  'ellipse',
  'spline',
  'offset',
  'copy',
  // 投影・交差(FR-325、P4 タスク25)。曲線そのものは保存せず、立体への参照だけを持つ。
  'projectedCurve',
  'planeSection',
];

function serializeSketchFeature(feature: SketchFeature): SketchFeature {
  switch (feature.kind) {
    case 'point':
      return {
        id: feature.id,
        kind: 'point',
        name: feature.name,
        planeId: feature.planeId,
        at: serializeCoordinate(feature.at),
      };
    case 'line':
      return {
        id: feature.id,
        kind: 'line',
        name: feature.name,
        planeId: feature.planeId,
        from: serializeCoordinate(feature.from),
        to: serializeCoordinate(feature.to),
        construction: feature.construction,
      };
    case 'arc': {
      const arc: SketchArcFeature = {
        id: feature.id,
        kind: 'arc',
        name: feature.name,
        planeId: feature.planeId,
        center: serializeCoordinate(feature.center),
        radius: serializeExpression(feature.radius),
        startAngle: serializeExpression(feature.startAngle),
        endAngle: serializeExpression(feature.endAngle),
        construction: feature.construction,
      };
      // 3D スケッチの円弧の向き(FR-330、P4 タスク10)。作図面のある円弧は持たないので、
      // そのときは欄そのものを書かない(持たない状態と「空の向き」を混ぜないため)。
      if (feature.freeOrientation === undefined) {
        return arc;
      }
      return { ...arc, freeOrientation: serializeFreeOrientation(feature.freeOrientation) };
    }
    case 'pointArray':
      return {
        id: feature.id,
        kind: 'pointArray',
        name: feature.name,
        planeId: feature.planeId,
        layout: serializePointArrayLayout(feature.layout),
      };
    case 'face':
      return {
        id: feature.id,
        kind: 'face',
        name: feature.name,
        planeId: feature.planeId,
        boundary: feature.boundary.map(serializeElementRef),
        color: feature.color,
      };
    case 'rectangle':
      return {
        id: feature.id,
        kind: 'rectangle',
        name: feature.name,
        planeId: feature.planeId,
        corner1: serializeCoordinate(feature.corner1),
        corner2: serializeCoordinate(feature.corner2),
        construction: feature.construction,
      };
    case 'polygon':
      return {
        id: feature.id,
        kind: 'polygon',
        name: feature.name,
        planeId: feature.planeId,
        center: serializeCoordinate(feature.center),
        sides: serializeExpression(feature.sides),
        radius: serializeExpression(feature.radius),
        radiusMode: feature.radiusMode,
        construction: feature.construction,
      };
    case 'slot':
      return {
        id: feature.id,
        kind: 'slot',
        name: feature.name,
        planeId: feature.planeId,
        center1: serializeCoordinate(feature.center1),
        center2: serializeCoordinate(feature.center2),
        width: serializeExpression(feature.width),
        construction: feature.construction,
      };
    case 'ellipse':
      return {
        id: feature.id,
        kind: 'ellipse',
        name: feature.name,
        planeId: feature.planeId,
        center: serializeCoordinate(feature.center),
        majorRadius: serializeExpression(feature.majorRadius),
        minorRadius: serializeExpression(feature.minorRadius),
        rotation: serializeExpression(feature.rotation),
        startAngle: serializeExpression(feature.startAngle),
        endAngle: serializeExpression(feature.endAngle),
        construction: feature.construction,
      };
    case 'spline':
      return {
        id: feature.id,
        kind: 'spline',
        name: feature.name,
        planeId: feature.planeId,
        mode: feature.mode,
        points: feature.points.map(serializeCoordinate),
        closed: feature.closed,
        construction: feature.construction,
      };
    case 'offset':
      // ずらした曲線そのものは保存しない(導出できるものは保存しない、rules/04)。
      return {
        id: feature.id,
        kind: 'offset',
        name: feature.name,
        planeId: feature.planeId,
        source: feature.source.map(serializeElementRef),
        distance: serializeExpression(feature.distance),
        side: feature.side,
        corner: feature.corner,
        construction: feature.construction,
      };
    case 'copy':
      // 複製された曲線そのものは保存しない(元の id と複製のしかたから導ける、rules/04)。
      return {
        id: feature.id,
        kind: 'copy',
        name: feature.name,
        planeId: feature.planeId,
        source: feature.source.map(serializeElementRef),
        placement: serializeCopyPlacement(feature.placement),
        construction: feature.construction,
      };
    case 'projectedCurve':
      // 投影された曲線そのものは保存しない(立体と作図面から再計算で導ける、rules/04)。
      return {
        id: feature.id,
        kind: 'projectedCurve',
        name: feature.name,
        planeId: feature.planeId,
        source: serializeSubShapeRef(feature.source),
        construction: feature.construction,
      };
    case 'planeSection':
      return {
        id: feature.id,
        kind: 'planeSection',
        name: feature.name,
        planeId: feature.planeId,
        targetFeatureId: feature.targetFeatureId,
        construction: feature.construction,
      };
  }
}

export function serializeSketch(sketch: SketchDocument): SketchDocument {
  const base: SketchDocument = {
    id: sketch.id,
    name: sketch.name,
    features: sketch.features.map(serializeSketchFeature),
  };
  // 拘束(FR-313、P4b タスク21)。**型自体が恒常的に省略可能**(`SketchDocument.constraints?`)
  // なので、`freeOrientation` と同じ約束で「有れば有るまま、無ければ書かない」にする
  // (`references` と違い、無い文書に `[]` を足す正規化はしない。往復が元の文書と
  // deep equal になることを不変条件にするため。統括の決定 2026-09-04)。
  if (sketch.constraints === undefined) {
    return base;
  }
  return { ...base, constraints: sketch.constraints.map(serializeConstraint) };
}

function readSketchFeature(value: unknown, path: string): Checked<SketchFeature> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const kind = readLiteral(record.value, 'kind', path, SKETCH_FEATURE_KINDS);
  if (!kind.ok) {
    return kind;
  }
  const base = readSketchFeatureBase(record.value, path);
  if (!base.ok) {
    return base;
  }
  switch (kind.value) {
    case 'point':
      return readPointFeature(record.value, path, base.value);
    case 'line':
      return readLineFeature(record.value, path, base.value);
    case 'arc':
      return readArcFeature(record.value, path, base.value);
    case 'pointArray':
      return readPointArrayFeature(record.value, path, base.value);
    case 'face':
      return readFaceFeature(record.value, path, base.value);
    case 'rectangle':
      return readRectangleFeature(record.value, path, base.value);
    case 'polygon':
      return readPolygonFeature(record.value, path, base.value);
    case 'slot':
      return readSlotFeature(record.value, path, base.value);
    case 'ellipse':
      return readEllipseFeature(record.value, path, base.value);
    case 'spline':
      return readSplineFeature(record.value, path, base.value);
    case 'offset':
      return readOffsetFeature(record.value, path, base.value);
    case 'copy':
      return readCopyFeature(record.value, path, base.value);
    case 'projectedCurve':
      return readProjectedCurveFeature(record.value, path, base.value);
    case 'planeSection':
      return readPlaneSectionFeature(record.value, path, base.value);
  }
}

export function readSketch(value: unknown, path: string): Checked<SketchDocument> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const id = readString(record.value, 'id', path);
  if (!id.ok) {
    return id;
  }
  const name = readString(record.value, 'name', path);
  if (!name.ok) {
    return name;
  }
  const features = readList(record.value, 'features', path, readSketchFeature);
  if (!features.ok) {
    return features;
  }
  const constraints = readSketchConstraintsField(record.value, path);
  if (!constraints.ok) {
    return constraints;
  }
  const sketch: SketchDocument = { id: id.value, name: name.value, features: features.value };
  if (constraints.value === null) {
    return { ok: true, value: sketch };
  }
  return { ok: true, value: { ...sketch, constraints: constraints.value } };
}
