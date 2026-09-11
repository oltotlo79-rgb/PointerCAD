/** Coordinate references move without parsing or replacing their expression sources. */
import type { CoordinateInput, CopyPlacement, SketchFeature } from './types.js';

type CoordinateMapper = (input: CoordinateInput) => CoordinateInput;

function mapPlacement(placement: CopyPlacement, map: CoordinateMapper): CopyPlacement {
  switch (placement.kind) {
    case 'mirror': return placement;
    case 'translate': return { ...placement, delta: map(placement.delta) };
    case 'linearArray': return { ...placement, direction: map(placement.direction) };
    case 'circularArray': return { ...placement, center: map(placement.center) };
  }
}

/** Exhaustive traversal; implicit bases inside a feature keep their local meaning. */
export function mapSketchCoordinates(feature: SketchFeature, map: CoordinateMapper): SketchFeature {
  switch (feature.kind) {
    case 'point': return { ...feature, at: map(feature.at) };
    case 'line': return { ...feature, from: map(feature.from), to: map(feature.to) };
    case 'arc': return { ...feature, center: map(feature.center),
      ...(feature.freeOrientation === undefined ? {} : { freeOrientation: {
        normal: map(feature.freeOrientation.normal), xAxis: map(feature.freeOrientation.xAxis),
      } }) };
    case 'pointArray': {
      const layout = feature.layout;
      return { ...feature, layout: layout.kind === 'circular'
        ? { ...layout, center: map(layout.center) } : { ...layout, base: map(layout.base) } };
    }
    case 'rectangle': return { ...feature, corner1: map(feature.corner1), corner2: map(feature.corner2) };
    case 'polygon': return { ...feature, center: map(feature.center) };
    case 'slot': return { ...feature, center1: map(feature.center1), center2: map(feature.center2) };
    case 'ellipse': return { ...feature, center: map(feature.center) };
    case 'spline': return { ...feature, points: feature.points.map(map) };
    case 'copy': return { ...feature, placement: mapPlacement(feature.placement, map) };
    case 'face': case 'offset': case 'projectedCurve': case 'planeSection': return feature;
  }
}
