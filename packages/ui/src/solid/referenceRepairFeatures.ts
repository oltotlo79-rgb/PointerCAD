import type { RuledSection, SketchFeature, SolidFeature } from '@pointercad/model';
import { repairCoordinate, repairPlane, repairPoint, type RepairMapper } from './referenceRepairGeometry.js';

export function repairSolid(feature: SolidFeature, map: RepairMapper): SolidFeature {
  const section = (value: RuledSection, field: string): RuledSection => value.kind === 'solidFace'
    ? { ...value, ref: map(value.ref, field) } : value;
  switch (feature.kind) {
    case 'extrude': return feature.end?.kind === 'toFace'
      ? { ...feature, end: { ...feature.end, face: map(feature.end.face, 'end', 'plane') } } : feature;
    case 'hole': case 'threadHole': case 'emboss': return { ...feature, face: map(feature.face, 'face', 'plane') };
    case 'threadShaft': return { ...feature, face: map(feature.face, 'face', 'cylinder') };
    case 'faceOffset': return { ...feature, face: map(feature.face, 'face', 'plane') };
    case 'fillet': case 'chamfer': return { ...feature, targets: feature.targets.map((ref, index) => map(ref, `targets:${index}`)) };
    case 'draft': return { ...feature, neutralFace: map(feature.neutralFace, 'neutralFace', 'plane'),
      faces: feature.faces.map((ref, index) => map(ref, `faces:${index}`)) };
    case 'shell': return { ...feature, openFaces: feature.openFaces.map((ref, index) => map(ref, `openFaces:${index}`)) };
    case 'primitive': {
      const origin = feature.origin;
      return { ...feature, origin: origin.kind === 'vertex' ? { ...origin, ref: map(origin.ref, 'origin') }
        : origin.kind === 'coordinate' ? { ...origin, value: repairCoordinate(origin.value, map, 'origin') } : origin };
    }
    case 'ruled': return { ...feature, first: section(feature.first, 'first'), second: section(feature.second, 'second') };
    case 'loft': return { ...feature, sections: feature.sections.map((value, index) => section(value, `sections:${index}`)) };
    case 'mirror': return feature.plane.kind === 'face' ? { ...feature, plane: { ...feature.plane, face: map(feature.plane.face, 'plane', 'plane') } } : feature;
    case 'scale': return { ...feature, origin: repairPoint(feature.origin, map, 'origin') };
    case 'surfaceCut': return feature.blade.kind === 'plane'
      ? { ...feature, blade: { kind: 'plane', plane: repairPlane(feature.blade.plane, map) } } : feature;
    case 'cut': return { ...feature, plane: repairPlane(feature.plane, map) };
    case 'surface': return feature.operation.kind === 'face' || feature.operation.kind === 'offset'
      ? { ...feature, operation: { ...feature.operation, face: map(feature.operation.face, 'face') } } : feature;
    case 'pattern': return feature.placement.kind === 'points' ? { ...feature, placement: { ...feature.placement,
      points: feature.placement.points.map((value, index) => ({ ...value, reference: repairPoint(value.reference, map, `points:${index}`) })) } } : feature;
    case 'sheetBase': case 'sheetFlange': case 'sheetBend': case 'sheetRelief': case 'revolve': case 'sew':
    case 'boolean': case 'spring': case 'transform': case 'sweep': case 'rib': case 'functionSurface':
    case 'importedSolid': case 'importedMesh': return feature;
  }
}

export function repairSketch(feature: SketchFeature, map: RepairMapper): SketchFeature {
  const coordinate = (value: Parameters<typeof repairCoordinate>[0], field: string): typeof value => repairCoordinate(value, map, field);
  switch (feature.kind) {
    case 'point': return { ...feature, at: coordinate(feature.at, 'at') };
    case 'line': return { ...feature, from: coordinate(feature.from, 'from'), to: coordinate(feature.to, 'to') };
    case 'arc': return { ...feature, center: coordinate(feature.center, 'center'),
      ...(feature.freeOrientation === undefined ? {} : { freeOrientation: {
        normal: coordinate(feature.freeOrientation.normal, 'normal'), xAxis: coordinate(feature.freeOrientation.xAxis, 'xAxis') } }) };
    case 'polygon': case 'ellipse': return { ...feature, center: coordinate(feature.center, 'center') };
    case 'rectangle': return { ...feature, corner1: coordinate(feature.corner1, 'corner1'), corner2: coordinate(feature.corner2, 'corner2') };
    case 'slot': return { ...feature, center1: coordinate(feature.center1, 'center1'), center2: coordinate(feature.center2, 'center2') };
    case 'spline': return { ...feature, points: feature.points.map((value, index) => coordinate(value, `points:${index}`)) };
    case 'projectedCurve': return { ...feature, source: map(feature.source, 'source') };
    case 'pointArray': return { ...feature, layout: feature.layout.kind === 'circular'
      ? { ...feature.layout, center: coordinate(feature.layout.center, 'center') }
      : { ...feature.layout, base: coordinate(feature.layout.base, 'base') } };
    case 'copy': {
      const placement = feature.placement;
      switch (placement.kind) {
        case 'mirror': return feature;
        case 'translate': return { ...feature, placement: { ...placement, delta: coordinate(placement.delta, 'delta') } };
        case 'linearArray': return { ...feature, placement: { ...placement, direction: coordinate(placement.direction, 'direction') } };
        case 'circularArray': return { ...feature, placement: { ...placement, center: coordinate(placement.center, 'center') } };
      }
      break;
    }
    case 'face': case 'functionCurve': case 'offset': case 'planeSection': return feature;
  }
}
