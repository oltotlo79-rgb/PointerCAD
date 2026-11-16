/**
 * 線分と円弧の閉じた輪で書いた断面を、作図面の面にして押し出す(鋼材の r2 の断面と、長さを持つ族〔T スロットフレーム〕が共に使う)。
 * buildStandardPart.ts から移した物で、作る部品文書は前と同じ(フィーチャーの順・名前・値)。
 */
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';

import { createEmptyPartDocument, replaceSketch } from '../../part/createPartDocument.js';
import type { PartDocument } from '../../part/types.js';
import {
  absoluteCoordinate, appendFeature, DEFAULT_FACE_COLOR, nextFeatureId, nextFeatureName,
} from '../../sketch/createSketchDocument.js';
import { DEFAULT_WORK_PLANE_ID } from '../../sketch/planeMath.js';
import type { SketchArcFeature, SketchDocument, SketchFaceFeature, SketchLineFeature } from '../../sketch/types.js';
import { activeSketch, appendBoolean, appendExtrude } from './partPrimitives.js';
import type { SteelProfileSegment } from './steelSectionProfiles.js';

/** 押し出す断面: 外の輪 1 本と、中空の内の輪(無ければ空)。どの輪も線分と円弧を順につないだ閉じた輪。 */
export interface ProfileLoops {
  readonly segments: readonly SteelProfileSegment[];
  readonly holes: readonly (readonly SteelProfileSegment[])[];
}

/** One closed profile loop and its face. The r1 sections use exactly one loop, with the original feature order. */
function appendProfileLoop(start: SketchDocument, segments: readonly SteelProfileSegment[]):
{ readonly sketch: SketchDocument; readonly faceId: string } {
  let sketch = start;
  const boundary: { featureId: string }[] = [];
  for (const segment of segments) {
    const feature: SketchLineFeature | SketchArcFeature = segment.kind === 'line' ? {
      id: nextFeatureId(sketch, 'line'), name: nextFeatureName(sketch, 'line'),
      planeId: DEFAULT_WORK_PLANE_ID, kind: 'line', construction: false,
      from: absoluteCoordinate(segment.from[0], segment.from[1], 0),
      to: absoluteCoordinate(segment.to[0], segment.to[1], 0),
    } : {
      id: nextFeatureId(sketch, 'arc'), name: nextFeatureName(sketch, 'arc'),
      planeId: DEFAULT_WORK_PLANE_ID, kind: 'arc', construction: false,
      center: absoluteCoordinate(segment.center[0], segment.center[1], 0),
      radius: expressionValueFromNumber(segment.radius),
      startAngle: expressionValueFromNumber(segment.startAngle * 180 / Math.PI),
      endAngle: expressionValueFromNumber(segment.endAngle * 180 / Math.PI),
    };
    sketch = appendFeature(sketch, feature);
    boundary.push({ featureId: feature.id });
  }
  const face: SketchFaceFeature = {
    id: nextFeatureId(sketch, 'face'), name: nextFeatureName(sketch, 'face'),
    planeId: DEFAULT_WORK_PLANE_ID, kind: 'face', boundary, color: DEFAULT_FACE_COLOR,
  };
  return { sketch: appendFeature(sketch, face), faceId: face.id };
}

/**
 * Extrude the outer loop; a hollow section (rectangular tube) also extrudes each inner loop and subtracts it,
 * like the round pipe's two cylinders. The first solid stays the outer stock extrude (steelFinishedLength).
 */
export function buildProfileSection(section: ProfileLoops, length: ExpressionValue): PartDocument {
  let document = createEmptyPartDocument();
  const outer = appendProfileLoop(activeSketch(document), section.segments);
  let sketch = outer.sketch;
  const holeFaceIds: string[] = [];
  for (const hole of section.holes) {
    const added = appendProfileLoop(sketch, hole);
    sketch = added.sketch;
    holeFaceIds.push(added.faceId);
  }
  document = replaceSketch(document, sketch);
  const body = appendExtrude(document, { sketchId: sketch.id, faceFeatureId: outer.faceId }, length);
  document = body.document;
  let targetId = body.feature.id;
  for (const faceId of holeFaceIds) {
    const hole = appendExtrude(document, { sketchId: sketch.id, faceFeatureId: faceId }, length);
    const hollow = appendBoolean(hole.document, 'subtract', targetId, hole.feature.id);
    document = hollow.document;
    targetId = hollow.feature.id;
  }
  return document;
}
