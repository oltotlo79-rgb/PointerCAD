import type { CoordinateInput, PlaneSpec, PointReference, ReferenceFeature, SubShapeRef } from '@pointercad/model';

/** Closed, typed adapters: field names identify a slot, never a JSON path to mutate. */
export type RepairRequirement = 'same-kind' | 'plane' | 'line' | 'cylinder' | 'circle' | 'sphere';
export type RepairMapper = (reference: SubShapeRef, field: string, requirement?: RepairRequirement) => SubShapeRef;

export function repairPoint(point: PointReference, map: RepairMapper, field: string): PointReference {
  return point.kind === 'subShape' ? { ...point, ref: map(point.ref, field) } : point;
}

export function repairCoordinate(value: CoordinateInput, map: RepairMapper, field: string): CoordinateInput {
  return value.mode === 'absolute' ? value : { ...value, base: repairPoint(value.base, map, field) };
}

export function repairPlane(plane: PlaneSpec, map: RepairMapper): PlaneSpec {
  switch (plane.kind) {
    case 'threePoints': return { ...plane, p1: repairPoint(plane.p1, map, 'p1'),
      p2: repairPoint(plane.p2, map, 'p2'), p3: repairPoint(plane.p3, map, 'p3') };
    case 'pointAndEdge': return { ...plane, point: repairPoint(plane.point, map, 'point'), edge: map(plane.edge, 'edge', 'line') };
    case 'pointAndAxis': return { ...plane, point: repairPoint(plane.point, map, 'point') };
    case 'pointAndParallelFace': return { ...plane, point: repairPoint(plane.point, map, 'point'), face: map(plane.face, 'face', 'plane') };
    case 'face': return { ...plane, face: map(plane.face, 'face', 'plane') };
    case 'workPlane': case 'tilted': return plane;
  }
}

export function repairReference(feature: ReferenceFeature, map: RepairMapper): ReferenceFeature {
  switch (feature.kind) {
    case 'referencePlane': return { ...feature, plane: repairPlane(feature.plane, map) };
    case 'referenceCoordinateSystem': return { ...feature, origin: repairPoint(feature.origin, map, 'origin') };
    case 'referenceAxis': {
      const definition = feature.definition;
      switch (definition.kind) {
        case 'twoPoints': return { ...feature, definition: { ...definition,
          from: repairPoint(definition.from, map, 'from'), to: repairPoint(definition.to, map, 'to') } };
        case 'edge': return { ...feature, definition: { ...definition, edge: map(definition.edge, 'edge', 'line') } };
        case 'faceNormal': return { ...feature, definition: { ...definition, face: map(definition.face, 'face', 'plane') } };
        case 'faceIntersection': return { ...feature, definition: { ...definition,
          face1: map(definition.face1, 'face1', 'plane'), face2: map(definition.face2, 'face2', 'plane') } };
      }
      break;
    }
    case 'referencePoint': {
      const definition = feature.definition;
      switch (definition.kind) {
        case 'coordinate': return { ...feature, definition: { ...definition, at: repairCoordinate(definition.at, map, 'at') } };
        case 'vertex': return { ...feature, definition: { ...definition, vertex: map(definition.vertex, 'vertex') } };
        case 'edgeMidpoint': return { ...feature, definition: { ...definition, edge: map(definition.edge, 'edge') } };
        case 'faceCenter': return { ...feature, definition: { ...definition, face: map(definition.face, 'face') } };
      }
    }
  }
}
