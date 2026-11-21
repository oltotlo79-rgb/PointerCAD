import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  addSketch, appendSolid, createEmptyPartDocument, createSketchFor,
  nextSolidId, nextSolidName, replaceSketch, type SolidLabelKey,
} from '../part/createPartDocument.js';
import type { HoleFeature, PartDocument, SketchFaceRef, SketchPointRef } from '../part/types.js';
import {
  absoluteCoordinate, appendFeature, createPointFeature, DEFAULT_FACE_COLOR,
  nextFeatureId, nextFeatureName,
} from '../sketch/createSketchDocument.js';
import type { BaseWorkPlaneId } from '../sketch/planeMath.js';
import type { CoordinateInput, SketchFaceFeature, SketchRectangleFeature } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';

export function solidIdentity(document: PartDocument, label: SolidLabelKey) {
  return { id: nextSolidId(document, label), name: nextSolidName(document, label), suppressed: false };
}

/** A rectangle and its face in the first sketch of a new empty part. Corners may be parameter expressions. */
export function rectangleProfile(planeId: BaseWorkPlaneId, corner1: CoordinateInput, corner2: CoordinateInput) {
  const part = createEmptyPartDocument();
  const sketch = part.sketches[0];
  const rectangle: SketchRectangleFeature = {
    kind: 'rectangle', id: nextFeatureId(sketch, 'rectangle'), name: nextFeatureName(sketch, 'rectangle'),
    planeId, corner1, corner2, construction: false,
  };
  const outline = appendFeature(sketch, rectangle);
  const face: SketchFaceFeature = {
    kind: 'face', id: nextFeatureId(outline, 'face'), name: nextFeatureName(outline, 'face'),
    planeId, boundary: [{ featureId: rectangle.id }], color: DEFAULT_FACE_COLOR,
  };
  const profile: SketchFaceRef = { sketchId: sketch.id, faceFeatureId: face.id };
  return { part: replaceSketch(part, appendFeature(outline, face)), profile };
}

export function rectangularProfile(planeId: BaseWorkPlaneId, first: Vec3, opposite: Vec3) {
  return rectangleProfile(planeId, absoluteCoordinate(...first), absoluteCoordinate(...opposite));
}

/** A new sketch holding one point, for a hole centre. */
function sketchPoint(part: PartDocument, at: CoordinateInput): { readonly part: PartDocument; readonly ref: SketchPointRef } {
  const sketch = createSketchFor(part);
  const point = createPointFeature(sketch, at);
  return { part: addSketch(part, appendFeature(sketch, point)), ref: { sketchId: sketch.id, pointFeatureId: point.id } };
}

interface TopHole {
  readonly targetId: string;
  /** The top face's sub-shape index in the target body, measured on the real kernel (the matcher weighs it). */
  readonly faceIndex: number;
  readonly height: number;
  readonly faceArea: number;
  readonly centerX: number;
  readonly diameter: number | ExpressionValue;
}

/** The stock is centred on Z. Both the uncut and the centrally bored top face have centroid (0,0,h). */
export function drillTop(part: PartDocument, spec: TopHole) {
  const center = sketchPoint(part, absoluteCoordinate(spec.centerX, 0, 0));
  const hole: HoleFeature = {
    ...solidIdentity(part, 'hole'), kind: 'hole', targetFeatureId: spec.targetId,
    face: { bodyFeatureId: spec.targetId, index: spec.faceIndex, fingerprint: {
      kind: 'face', surfaceKind: 'plane', area: spec.faceArea,
      position: [0, 0, spec.height], axis: [0, 0, 1], radius: null,
    } },
    centers: [center.ref],
    diameter: typeof spec.diameter === 'number' ? expressionValueFromNumber(spec.diameter) : spec.diameter,
    depth: { kind: 'through' },
    tiltAngle: expressionValueFromNumber(0), tiltAzimuth: expressionValueFromNumber(0),
  };
  return { part: appendSolid(center.part, hole), holeId: hole.id };
}
