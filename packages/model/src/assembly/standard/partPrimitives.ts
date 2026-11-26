/**
 * 規格部品の形を作る小さな部品(原点・名前・円柱・ブーリアン・輪・正多角形の面・中心の点・押し出し・平面の面・
 * 円柱の側面・外ねじ(簡略の表し方)・六角ナットの体)。
 * 従来の JIS の部品(`buildStandardPart.ts`)と、族の部品の形(`catalog/profiles/`・`catalog/families/`)が同じ作り方で組むために、
 * ここに 1 つだけ置く。
 */
import {
  exactExpressionValueFromNumber, expressionValueFromNumber, type ExpressionValue,
} from '@pointercad/expression';

import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import { appendSolid, createEmptyPartDocument, createPrimitiveFeature, nextSolidId, nextSolidName, replaceSketch } from '../../part/createPartDocument.js';
import type {
  BooleanFeature, ExtrudeFeature, PartDocument, PrimitiveFeature, SketchFaceRef, SolidOrigin, ThreadHoleFeature,
  ThreadShaftFeature,
} from '../../part/types.js';
import {
  absoluteCoordinate, appendFeature, createPointFeature, DEFAULT_FACE_COLOR, nextFeatureId, nextFeatureName,
} from '../../sketch/createSketchDocument.js';
import { DEFAULT_WORK_PLANE_ID } from '../../sketch/planeMath.js';
import type { SketchDocument, SketchFaceFeature, SketchPointFeature, SketchPolygonFeature } from '../../sketch/types.js';
import { threadMinorDiameter, type ThreadSeries } from '../../thread/metricThread.js';

// These preconditions describe the generated document and its authored construction, not a picker field.
export class StandardPartGeometryError extends Error {}

export function origin(x: number, y: number, z: number): SolidOrigin {
  return { kind: 'coordinate', value: absoluteCoordinate(x, y, z) };
}

export function withName(document: PartDocument, name: string): PartDocument {
  return { ...document, name };
}

export function activeSketch(document: PartDocument): SketchDocument {
  const sketch = document.sketches.find((candidate) => candidate.id === document.activeSketchId);
  if (sketch === undefined) throw new StandardPartGeometryError('規格部品の作図面が見つかりません。');
  return sketch;
}

/** Z 軸の向きの円柱(底面の中心が原点から z の高さ)。 */
export function appendCylinder(
  document: PartDocument,
  radius: number,
  height: ExpressionValue,
  z = 0,
): { readonly document: PartDocument; readonly feature: PrimitiveFeature } {
  const created = createPrimitiveFeature(document, 'cylinder', origin(0, 0, z));
  const feature: PrimitiveFeature = {
    ...created,
    shape: { kind: 'cylinder', radius: expressionValueFromNumber(radius), height },
  };
  return { document: appendSolid(document, feature), feature };
}

export function appendBoolean(
  document: PartDocument,
  operation: BooleanFeature['operation'],
  targetFeatureId: string,
  toolFeatureId: string,
): { readonly document: PartDocument; readonly feature: BooleanFeature } {
  const feature: BooleanFeature = {
    id: nextSolidId(document, operation),
    name: nextSolidName(document, operation),
    suppressed: false,
    kind: 'boolean',
    operation,
    targetFeatureId,
    toolFeatureId,
  };
  return { document: appendSolid(document, feature), feature };
}

/** Z 軸の向きの輪(外の円柱から内の円柱を引く)。 */
export function appendRing(
  document: PartDocument,
  innerRadius: number,
  outerRadius: number,
  height: number,
): { readonly document: PartDocument; readonly featureId: string } {
  const outer = appendCylinder(document, outerRadius, expressionValueFromNumber(height));
  const inner = appendCylinder(outer.document, innerRadius, expressionValueFromNumber(height));
  const ring = appendBoolean(inner.document, 'subtract', outer.feature.id, inner.feature.id);
  return { document: ring.document, featureId: ring.feature.id };
}

/** 作図面の原点を中心とする正多角形の面(内接円の半径で指定)。 */
export function regularPolygonProfile(
  document: PartDocument,
  sides: number,
  inscribedRadius: number,
): { readonly document: PartDocument; readonly profile: SketchFaceRef; readonly area: number } {
  let sketch = activeSketch(document);
  const polygon: SketchPolygonFeature = {
    id: nextFeatureId(sketch, 'polygon'),
    name: nextFeatureName(sketch, 'polygon'),
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'polygon',
    center: absoluteCoordinate(0, 0, 0),
    sides: expressionValueFromNumber(sides),
    radius: expressionValueFromNumber(inscribedRadius),
    radiusMode: 'inscribed',
    construction: false,
  };
  sketch = appendFeature(sketch, polygon);
  const face: SketchFaceFeature = {
    id: nextFeatureId(sketch, 'face'),
    name: nextFeatureName(sketch, 'face'),
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'face',
    boundary: [{ featureId: polygon.id }],
    color: DEFAULT_FACE_COLOR,
  };
  sketch = appendFeature(sketch, face);
  return {
    document: replaceSketch(document, sketch),
    profile: { sketchId: sketch.id, faceFeatureId: face.id },
    area: sides * inscribedRadius * inscribedRadius * Math.tan(Math.PI / sides),
  };
}

export function centerPoint(document: PartDocument): {
  readonly document: PartDocument;
  readonly point: SketchPointFeature;
} {
  let sketch = activeSketch(document);
  const point = createPointFeature(sketch, absoluteCoordinate(0, 0, 0));
  sketch = appendFeature(sketch, point);
  return { document: replaceSketch(document, sketch), point };
}

export function appendExtrude(
  document: PartDocument,
  profile: SketchFaceRef,
  distance: ExpressionValue,
  reversed = false,
): { readonly document: PartDocument; readonly feature: ExtrudeFeature } {
  const feature: ExtrudeFeature = {
    id: nextSolidId(document, 'extrude'),
    name: nextSolidName(document, 'extrude'),
    suppressed: false,
    kind: 'extrude',
    profile,
    distance,
    reversed,
    symmetric: false,
  };
  return { document: appendSolid(document, feature), feature };
}

/** Z 軸に垂直な平面の面の参照(押し出しの上面など)。 */
export function planeFace(
  bodyFeatureId: string,
  area: number,
  z: number,
): SubShapeRef {
  return {
    bodyFeatureId,
    index: 0,
    fingerprint: {
      kind: 'face', surfaceKind: 'plane', area, position: [0, 0, z], axis: [0, 0, 1], radius: null,
    },
  };
}

/** 底面の中心が (0, 0, base) の Z 軸の向きの円柱の側面の参照(外ねじの面など)。 */
function cylinderFace(
  bodyFeatureId: string,
  radius: number,
  height: number,
  base: number,
): SubShapeRef {
  return {
    bodyFeatureId,
    index: 0,
    fingerprint: {
      kind: 'face', surfaceKind: 'cylinder', area: 2 * Math.PI * radius * height,
      position: [0, 0, base + height / 2], axis: [0, 0, 1], radius,
    },
  };
}

export interface ExternalThreadSpec {
  /** ねじの呼び(例 M8)。 */
  readonly nominal: string;
  readonly pitch: number;
  readonly series: ThreadSeries;
  /** 軸の長さ(円柱の高さ)。 */
  readonly shaftLength: ExpressionValue;
  /** ねじ部の長さ(軸の終わりの側から)。 */
  readonly threadLength: number;
  /** 軸の底面の z(既定 0。頭の上に軸を置く形は頭の高さ)。 */
  readonly shaftBase?: number;
}

/** 円柱の軸の外ねじ(形は作らない簡略の表し方。ねじの長さは軸の終わりの側から)。 */
export function appendExternalThread(
  document: PartDocument,
  shaft: PrimitiveFeature,
  spec: ExternalThreadSpec,
): { readonly document: PartDocument; readonly feature: ThreadShaftFeature } {
  if (shaft.shape.kind !== 'cylinder') throw new StandardPartGeometryError('外ねじの対象が円柱ではありません。');
  const radius = shaft.shape.radius.value;
  const feature: ThreadShaftFeature = {
    id: nextSolidId(document, 'threadShaft'),
    name: nextSolidName(document, 'threadShaft'),
    suppressed: false,
    kind: 'threadShaft',
    targetFeatureId: shaft.id,
    face: cylinderFace(shaft.id, radius, spec.shaftLength.value, spec.shaftBase ?? 0),
    nominal: spec.nominal,
    series: spec.series,
    pitch: expressionValueFromNumber(spec.pitch),
    length: expressionValueFromNumber(spec.threadLength),
    fromEnd: 'last',
    modeled: false,
  };
  return { document: appendSolid(document, feature), feature };
}

export interface HexNutBody {
  /** ねじの呼び(例 M8)。 */
  readonly designation: string;
  /** ねじの呼び径 d。 */
  readonly nominalDiameter: number;
  /** 六角の対辺 s。 */
  readonly acrossFlats: number;
  /** 高さ m。 */
  readonly height: number;
}

/** 六角ナットの体: 対辺 s の六角柱(高さ m)に、ねじの下穴径の通しのねじ穴(簡略の表し方)。 */
export function buildHexNutBody(body: HexNutBody, thread: { readonly series: ThreadSeries; readonly pitch: number },
  name: string): PartDocument {
  let document = createEmptyPartDocument();
  const profile = regularPolygonProfile(document, 6, body.acrossFlats / 2);
  document = profile.document;
  const head = appendExtrude(document, profile.profile, expressionValueFromNumber(body.height));
  document = head.document;
  const center = centerPoint(document);
  document = center.document;
  const feature: ThreadHoleFeature = {
    id: nextSolidId(document, 'threadHole'),
    name: nextSolidName(document, 'threadHole'),
    suppressed: false,
    kind: 'threadHole',
    targetFeatureId: head.feature.id,
    face: planeFace(head.feature.id, profile.area, body.height),
    centers: [{ sketchId: document.activeSketchId, pointFeatureId: center.point.id }],
    designation: body.designation,
    series: thread.series,
    pitch: expressionValueFromNumber(thread.pitch),
    drillDiameter: exactExpressionValueFromNumber(threadMinorDiameter(body.nominalDiameter, thread.pitch)),
    depth: { kind: 'through' },
    threadLength: expressionValueFromNumber(body.height),
    representation: 'simplified',
    tiltAngle: expressionValueFromNumber(0),
    tiltAzimuth: expressionValueFromNumber(0),
  };
  return withName(appendSolid(document, feature), name);
}
