import type { ResolvedFace, SketchDocument } from '../sketch/types.js';

export interface IndependentProfileOrigin {
  readonly sketchId: string;
  readonly faceFeatureId: string;
  readonly lineFeatureIds: readonly [string, string, string, string];
}

export interface IndependentCurveProfileOrigin {
  readonly sketchId: string;
  readonly faceFeatureId: string;
  readonly curveFeatureIds: readonly [string, string, string, ...string[]];
}

/** Keep the legacy four-line identity; otherwise require saved whole curves. */
export function independentProfileOrigin(
  sketch: SketchDocument | undefined,
  face: ResolvedFace,
): IndependentProfileOrigin | IndependentCurveProfileOrigin | null {
  const legacy = independentFourLineProfile(sketch, face);
  if (legacy !== null) return legacy;
  if (sketch === undefined || face.curves.length < 3 || face.curves.length > 32) return null;
  const savedFaces = sketch.features.filter(feature => feature.id === face.featureId);
  const savedFace = savedFaces[0];
  if (savedFaces.length !== 1 || savedFace?.kind !== 'face'
    || savedFace.boundary.length !== face.curves.length) return null;
  const ids: string[] = [];
  for (let index = 0; index < face.curves.length; index++) {
    const reference = savedFace.boundary[index], curve = face.curves[index];
    if (reference === undefined || curve === undefined || reference.index !== undefined
      || reference.featureId !== curve.featureId || ids.includes(reference.featureId)) return null;
    const sources = sketch.features.filter(feature => feature.id === reference.featureId);
    const source = sources[0];
    if (sources.length !== 1 || source === undefined) return null;
    if (source.kind === 'line') {
      if (source.construction || curve.kind !== 'segment') return null;
    } else if (source.kind === 'spline') {
      if (source.construction || source.closed || curve.kind !== 'spline' || curve.closed
        || curve.degree !== undefined || curve.knots !== undefined
        || source.mode !== curve.mode || source.points.length !== curve.points.length) return null;
    } else return null;
    ids.push(source.id);
  }
  const [first, second, third, ...rest] = ids;
  if (first === undefined || second === undefined || third === undefined) return null;
  return { sketchId: sketch.id, faceFeatureId: face.featureId,
    curveFeatureIds: [first, second, third, ...rest] };
}

/**
 * Only four independently saved SketchLine features have an unambiguous source
 * for each native profile edge. Geometry, resolved feature IDs alone, and a
 * boundary index cannot establish this ownership.
 */
export function independentFourLineProfile(
  sketch: SketchDocument | undefined,
  face: ResolvedFace,
): IndependentProfileOrigin | null {
  if (sketch === undefined || face.curves.length !== 4) return null;
  const savedFace = sketch.features.find((feature) =>
    feature.id === face.featureId && feature.kind === 'face');
  if (savedFace?.kind !== 'face' || savedFace.boundary.length !== 4) return null;

  const ids: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const reference = savedFace.boundary[index];
    const curve = face.curves[index];
    if (reference === undefined || curve?.kind !== 'segment'
      || reference.index !== undefined || curve.featureId !== reference.featureId
      || ids.includes(reference.featureId)) return null;
    const source = sketch.features.find((feature) => feature.id === reference.featureId);
    if (source?.kind !== 'line' || source.construction) return null;
    ids.push(source.id);
  }
  return {
    sketchId: sketch.id,
    faceFeatureId: face.featureId,
    lineFeatureIds: [ids[0], ids[1], ids[2], ids[3]],
  };
}
