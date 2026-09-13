/** Every owner that can contain a function point must be evaluated before reference resolution. */
import type { PlaneSpec } from '../geometry/planeSpec.js';
import type { PartDocument, ReferenceFeature, SolidFeature } from '../part/types.js';
import { mapSketchCoordinates } from '../sketch/mapCoordinates.js';
import type { CoordinateInput, PointReference } from '../sketch/types.js';
import type { FunctionPointReference } from './functionPointReference.js';

export interface FunctionPointOwner {
  readonly ownerId: string;
  readonly reference: FunctionPointReference;
  /** Only a sketch owner has a local feature order. Reference geometry has its own dependency graph. */
  readonly sketch?: { readonly id: string; readonly index: number };
  readonly solidIndex?: number;
}

function coordinateReferences(input: CoordinateInput): readonly PointReference[] {
  return input.mode === 'absolute' ? [] : [input.base];
}

function planeReferences(plane: PlaneSpec): readonly PointReference[] {
  switch (plane.kind) {
    case 'threePoints': return [plane.p1, plane.p2, plane.p3];
    case 'pointAndEdge': case 'pointAndAxis': case 'pointAndParallelFace': return [plane.point];
    case 'face': case 'workPlane': case 'tilted': return [];
  }
}

function referencePoints(feature: ReferenceFeature): readonly PointReference[] {
  switch (feature.kind) {
    case 'referencePlane': return planeReferences(feature.plane);
    case 'referencePoint': return feature.definition.kind === 'coordinate'
      ? coordinateReferences(feature.definition.at) : [];
    case 'referenceAxis': return feature.definition.kind === 'twoPoints'
      ? [feature.definition.from, feature.definition.to] : [];
    case 'referenceCoordinateSystem': return [feature.origin];
  }
}

function solidPoints(feature: SolidFeature): readonly PointReference[] {
  switch (feature.kind) {
    case 'primitive': return feature.origin.kind === 'coordinate' ? coordinateReferences(feature.origin.value) : [];
    case 'scale': return [feature.origin];
    case 'pattern': return feature.placement.kind === 'points' ? feature.placement.points : [];
    case 'cut': return planeReferences(feature.plane);
    case 'sheetBase': case 'sheetFlange': case 'sheetBend': case 'sheetRelief':
    case 'extrude': case 'revolve': case 'sew': case 'boolean': case 'hole':
    case 'threadHole': case 'fillet': case 'chamfer': case 'spring': case 'ruled':
    case 'loft': case 'draft': case 'mirror': case 'transform': case 'sweep':
    case 'rib': case 'emboss': case 'threadShaft': case 'surface': case 'functionSurface':
    case 'shell': case 'importedSolid': case 'importedMesh': return [];
  }
}

export function collectFunctionPointReferences(document: PartDocument): readonly FunctionPointOwner[] {
  const result: FunctionPointOwner[] = [];
  for (const sketch of document.sketches) for (const [index, feature] of sketch.features.entries()) {
    mapSketchCoordinates(feature, input => {
      for (const reference of coordinateReferences(input)) if (reference.kind === 'functionPoint') {
        result.push({ ownerId: feature.id, reference, sketch: { id: sketch.id, index } });
      }
      return input;
    });
  }
  for (const feature of document.references) for (const reference of referencePoints(feature)) {
    if (reference.kind === 'functionPoint') result.push({ ownerId: feature.id, reference });
  }
  for (const [solidIndex, feature] of document.solids.entries()) {
    if (feature.suppressed) continue;
    for (const reference of solidPoints(feature)) {
      if (reference.kind === 'functionPoint') result.push({ ownerId: feature.id, reference, solidIndex });
    }
  }
  return result;
}
