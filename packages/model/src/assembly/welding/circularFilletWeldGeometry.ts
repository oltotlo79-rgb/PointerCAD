/** Internal circular-path geometry only. No catalog/save/generator registration.
 * A meridian triangle is revolved by the existing solid feature; this is not the
 * curved cross-section of the straight-extruded fillet-weld versions 3/4.
 * Parent faces/contact/material-side evidence must be admitted by a future planner.
 */
import { exactExpressionValueFromNumber } from '@pointercad/expression';

import { appendSolid, createEmptyPartDocument, nextSolidId, nextSolidName, replaceSketch } from '../../part/createPartDocument.js';
import type { PartDocument, RevolveFeature } from '../../part/types.js';
import { absoluteCoordinate, appendFeature, DEFAULT_FACE_COLOR, nextFeatureId, nextFeatureName } from '../../sketch/createSketchDocument.js';
import type { SketchFaceFeature, SketchLineFeature } from '../../sketch/types.js';
import { scaleVec3, type Vec3 } from '../../sketch/vec3.js';
import { quaternionFromBasis, type RigidPlacement } from '../placementMath.js';
import { createCircularWeldPath, readCircularWeldPathSnapshot, type CircularWeldBeadInterval, type CircularWeldPath } from './curvedWeldPath.js';
import { WELD_DIRECTION_TOLERANCE, weldCrossSectionIssue } from './types.js';

export interface CircularFilletWeldSection {
  readonly beadId: string;
  readonly radialLegMm: number;
  readonly normalLegMm: number;
  /** +1 is outward, -1 is inward, relative to the original circle center. */
  readonly radialDirection: 1 | -1;
  /** Side of the original circle normal, independent of traversal orientation. */
  readonly normalDirection: 1 | -1;
}

export interface CircularFilletWeldGeometry {
  readonly part: PartDocument;
  /** Already world placement. Never compose the occurrence placement a second time. */
  readonly placement: RigidPlacement;
  readonly path: CircularWeldPath;
  readonly interval: CircularWeldBeadInterval;
}

function validSection(section: CircularFilletWeldSection): boolean {
  return typeof section.beadId === 'string' && section.beadId.trim().length > 0
    && Number.isFinite(section.radialLegMm) && section.radialLegMm > 0
    && Number.isFinite(section.normalLegMm) && section.normalLegMm > 0
    && (section.radialDirection === 1 || section.radialDirection === -1)
    && (section.normalDirection === 1 || section.normalDirection === -1)
    && weldCrossSectionIssue(section.radialLegMm, section.normalLegMm, null) === null;
}

/** Revalidates the COMPLETE interval group and current evidence through the existing
 * strict decoder. currentEvidence/currentBeads must be independently resolved now;
 * passing saved inputs in their place is not evidence of currentness or contact.
 * One explicit interval produces one solid; gaps are never filled or merged.
 */
export function buildCircularFilletWeldGeometry(
  definition: unknown,
  currentEvidence: unknown,
  currentBeads: unknown,
  section: CircularFilletWeldSection,
): CircularFilletWeldGeometry | null {
  const path = createCircularWeldPath(definition, currentEvidence, currentBeads);
  return path === null ? null : buildGeometry(path, section);
}

/** Saved geometry only: local PartDocument, without any contact/currentness claim.
 * The assembly applies its saved component placement exactly once.
 */
export function rebuildCircularFilletWeldPart(definition: unknown, section: CircularFilletWeldSection): PartDocument | null {
  const snapshot = readCircularWeldPathSnapshot(definition);
  return snapshot === null ? null : buildGeometry(snapshot, section)?.part ?? null;
}

function buildGeometry(path: CircularWeldPath, section: CircularFilletWeldSection): CircularFilletWeldGeometry | null {
  if (!validSection(section)) return null;
  const interval = path.definition.intervals.find(row => row.beadId === section.beadId);
  if (interval === undefined) return null;
  const e = path.definition.evidence, radius = e.radiusMm;
  const tipRadius = radius + section.radialDirection * section.radialLegMm;
  // Inward sections must not touch/cross the axis; reject unrepresentable legs too.
  if (!Number.isFinite(tipRadius) || tipRadius <= 0 || tipRadius === radius) return null;
  const span = e.orientation * (interval.toParameter - interval.fromParameter);
  const degrees = span * 180 / Math.PI;
  const area = section.radialLegMm * section.normalLegMm / 2;
  const centroidRadius = radius + section.radialDirection * section.radialLegMm / 3;
  const volume = span * area * centroidRadius;
  if (!(span > 0 && span <= 2 * Math.PI) || !Number.isFinite(degrees) || degrees <= 0 || degrees > 360
    || !Number.isFinite(volume) || volume <= 0
    || !e.centerMm.every(value => Number.isFinite(Math.abs(value) + Math.max(radius, tipRadius) + section.normalLegMm))) return null;
  const frame = path.beadFrameAt(interval.beadId, interval.fromParameter);
  if (frame === null) return null;
  // Remove ONLY the traversal sign from tangent. The normal-side choice must not
  // flip when the same geometric interval is traversed backwards.
  const positiveTangent = scaleVec3(frame.tangent, e.orientation);
  const rotation = quaternionFromBasis(frame.radial, positiveTangent, e.normal, WELD_DIRECTION_TOLERANCE);
  if (rotation === null) return null;
  const placement: RigidPlacement = Object.freeze({ position: e.centerMm, rotation: Object.freeze(rotation) });
  const corners: readonly Vec3[] = [[radius, 0, 0], [tipRadius, 0, 0], [radius, 0, section.normalDirection * section.normalLegMm]];
  let part = createEmptyPartDocument();
  let sketch = part.sketches.find(row => row.id === part.activeSketchId);
  if (sketch === undefined) return null;
  const boundary: { readonly featureId: string }[] = [];
  for (let index = 0; index < corners.length; index += 1) {
    const from = corners[index], to = corners[(index + 1) % corners.length];
    const line: SketchLineFeature = {
      id: nextFeatureId(sketch, 'line'), name: nextFeatureName(sketch, 'line'), kind: 'line',
      planeId: 'xz', construction: false,
      from: absoluteCoordinate(from[0], from[1], from[2]), to: absoluteCoordinate(to[0], to[1], to[2]),
    };
    sketch = appendFeature(sketch, line);
    boundary.push({ featureId: line.id });
  }
  const face: SketchFaceFeature = {
    id: nextFeatureId(sketch, 'face'), name: nextFeatureName(sketch, 'face'), kind: 'face',
    planeId: 'xz', boundary, color: DEFAULT_FACE_COLOR,
  };
  part = replaceSketch(part, appendFeature(sketch, face));
  const revolve: RevolveFeature = {
    id: nextSolidId(part, 'revolve'), name: nextSolidName(part, 'revolve'), kind: 'revolve', suppressed: false,
    profile: { sketchId: sketch.id, faceFeatureId: face.id }, axis: { kind: 'world', axis: 'z' },
    angle: exactExpressionValueFromNumber(degrees), reversed: e.orientation === -1,
  };
  return { part: appendSolid(part, revolve), placement, path, interval };
}
