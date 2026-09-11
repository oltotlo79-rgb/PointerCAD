/** Split real intersections into editable, shared points in one immutable transaction. */
import { exactExpressionValueFromNumber, expressionValueFromNumber } from '@pointercad/expression';
import { createPointFeature, nextFeatureId, nextFeatureName, nextSerialName } from './createSketchDocument.js';
import { curveIntersections } from './intersectionMath.js';
import { resolveSketch, type SketchResolveOptions } from './resolveSketch.js';
import { hasSplitLineConstraint, remapSplitCoordinate, remapSplitFeature, type SplitLineIdentity } from './splitLineReferences.js';
import type { CoordinateInput, ResolvedSegment, ResolvedSketch, SketchDocument, SketchFeature, SketchLineFeature, SketchPointFeature } from './types.js';
import { distanceVec3, lerpVec3, SKETCH_TOLERANCE_MM, type Vec3 } from './vec3.js';

export type SplitLineFailure = 'missingLine' | 'constrainedLine' | 'invalidReferences';
export type SplitLineOutcome =
  | { readonly ok: true; readonly document: SketchDocument; readonly pointIds: readonly string[]; readonly splitCount: number }
  | { readonly ok: false; readonly reason: SplitLineFailure };

interface Junction {
  readonly position: Vec3;
  readonly hits: Map<string, number>;
}
interface LineCut { readonly ratio: number; readonly pointId: string }

function isInterior(curve: ResolvedSegment, ratio: number): boolean {
  const length = distanceVec3(curve.from, curve.to);
  return ratio * length > SKETCH_TOLERANCE_MM && (1 - ratio) * length > SKETCH_TOLERANCE_MM;
}

/** All intersections with the just drawn line, deduplicated in world space (including T junctions). */
function collectJunctions(document: SketchDocument, resolved: ResolvedSketch, line: ResolvedSegment): readonly Junction[] {
  const eligible = new Set(document.features.filter((feature) => feature.kind === 'line' && !feature.construction).map((feature) => feature.id));
  const junctions: Junction[] = [];
  for (const other of resolved.segments) {
    if (other.featureId === line.featureId || !eligible.has(other.featureId)) continue;
    for (const hit of curveIntersections(line, other)) {
      // Snap proximity alone cannot prove an intersection of actual 3D segments.
      if (distanceVec3(lerpVec3(line.from, line.to, hit.onFirst), lerpVec3(other.from, other.to, hit.onSecond)) > SKETCH_TOLERANCE_MM) continue;
      if (!isInterior(line, hit.onFirst) && !isInterior(other, hit.onSecond)) continue;
      let junction = junctions.find((candidate) => distanceVec3(candidate.position, hit.point) <= SKETCH_TOLERANCE_MM);
      if (junction === undefined) {
        junction = { position: hit.point, hits: new Map() };
        junctions.push(junction);
      }
      junction.hits.set(line.featureId, hit.onFirst);
      junction.hits.set(other.featureId, hit.onSecond);
    }
  }
  return junctions;
}

export function coordinateAtPoint(pointId: string): CoordinateInput {
  const zero = expressionValueFromNumber(0);
  return { mode: 'relative', base: { kind: 'point', pointId }, dx: zero, dy: zero, dz: zero };
}

function endFromOriginalStart(input: CoordinateInput, startPointId: string): CoordinateInput {
  return input.mode !== 'absolute' && input.base.kind === 'previous'
    ? { ...input, base: { kind: 'point', pointId: startPointId } } : input;
}

/** Reusing a junction must not wrap already connected pieces in more anchor points. */
function alreadyConnected(feature: SketchFeature, cuts: readonly LineCut[]): boolean {
  if (feature.kind !== 'line') return false;
  return cuts.every((cut) => {
    if (cut.ratio !== 0 && cut.ratio !== 1) return false;
    const at = cut.ratio === 0 ? feature.from : feature.to;
    return at.mode === 'relative' && at.base.kind === 'point' && at.base.pointId === cut.pointId
      && [at.dx, at.dy, at.dz].every((value) => value.value === 0 && value.source === '0');
  });
}

interface SplitBuild {
  readonly document: SketchDocument;
  readonly identities: ReadonlyMap<string, SplitLineIdentity>;
  readonly splitCount: number;
}

function buildPieces(document: SketchDocument, cuts: ReadonlyMap<string, readonly LineCut[]>, junctions: readonly SketchPointFeature[]): SplitBuild {
  let naming: SketchDocument = { ...document, features: [...document.features, ...junctions] };
  const identities = new Map<string, SplitLineIdentity>();
  const output: SketchFeature[] = [];
  let insertedJunctions = false;
  let splitCount = 0;
  const addPoint = (at: CoordinateInput, line: SketchLineFeature): SketchPointFeature => {
    const point = createPointFeature(naming, at, line.planeId);
    naming = { ...naming, features: [...naming.features, point] };
    return point;
  };
  for (const feature of document.features) {
    const lineCuts = cuts.get(feature.id);
    if (feature.kind !== 'line' || lineCuts === undefined) { output.push(feature); continue; }
    // These two points retain both original coordinate expressions. Inserting them at the
    // original line position also retains the meaning of the start's implicit previous base.
    const start = { ...addPoint(remapSplitCoordinate(feature.from, identities), feature), name: `${feature.name} 始点` };
    const end = { ...addPoint(remapSplitCoordinate(endFromOriginalStart(feature.to, start.id), identities), feature), name: `${feature.name} 終点` };
    output.push(start, end);
    if (!insertedJunctions) { output.push(...junctions); insertedJunctions = true; }
    const sorted = [...lineCuts].sort((a, b) => a.ratio - b.ratio);
    const startCut = sorted.find((cut) => cut.ratio === 0);
    const endCut = sorted.find((cut) => cut.ratio === 1);
    const vertices = [startCut?.pointId ?? start.id,
      ...sorted.filter((cut) => cut.ratio > 0 && cut.ratio < 1).map((cut) => cut.pointId),
      endCut?.pointId ?? end.id];
    const pieceIds: string[] = [];
    for (let index = 0; index < vertices.length - 1; index += 1) {
      const last = index === vertices.length - 2;
      const piece: SketchLineFeature = { ...feature,
        id: last ? feature.id : nextFeatureId(naming, 'line'),
        name: last ? feature.name : nextFeatureName(naming, 'line'),
        from: coordinateAtPoint(vertices[index]), to: coordinateAtPoint(vertices[index + 1]),
      };
      if (!last) naming = { ...naming, features: [...naming.features, piece] };
      pieceIds.push(piece.id); output.push(piece);
    }
    identities.set(feature.id, { startPointId: vertices[0], pieceIds });
    splitCount += vertices.length - 2;
  }
  return { document: { ...document, features: output.map((feature) => remapSplitFeature(feature, identities)) }, identities, splitCount };
}

/** No new saved feature type: ordinary points and lines retain edit, save and Undo behavior. */
export function splitLineIntersections(
  document: SketchDocument, lineId: string, options: SketchResolveOptions = {}, supplied?: ResolvedSketch,
): SplitLineOutcome {
  const source = document.features.find((feature) => feature.id === lineId);
  const resolved = supplied ?? resolveSketch(document, options);
  const line = resolved.segments.find((segment) => segment.featureId === lineId);
  if (source?.kind !== 'line' || line === undefined) return { ok: false, reason: 'missingLine' };
  if (source.construction) return { ok: true, document, pointIds: [], splitCount: 0 };
  const junctions = collectJunctions(document, resolved, line);
  if (junctions.length === 0) return { ok: true, document, pointIds: [], splitCount: 0 };
  const affected = new Set(junctions.flatMap((junction) => [...junction.hits.keys()]));
  const firstIndex = document.features.findIndex((feature) => affected.has(feature.id));
  const earlierPointIds = new Set(document.features.slice(0, firstIndex).filter((feature) => feature.kind === 'point').map((feature) => feature.id));
  const newPoints: SketchPointFeature[] = [];
  const pointIds: string[] = [];
  const cuts = new Map<string, LineCut[]>();
  for (const junction of junctions) {
    const existing = resolved.points.find((point) => earlierPointIds.has(point.id)
      && distanceVec3(point.position, junction.position) <= SKETCH_TOLERANCE_MM);
    const naming = { ...document, features: [...document.features, ...newPoints] };
    const point = existing ?? { ...createPointFeature(naming, {
      mode: 'absolute', x: exactExpressionValueFromNumber(junction.position[0]),
      y: exactExpressionValueFromNumber(junction.position[1]), z: exactExpressionValueFromNumber(junction.position[2]),
    }, source.planeId), name: nextSerialName(naming.features.map((feature) => feature.name), '交点') };
    if (existing === undefined && 'at' in point) newPoints.push(point);
    pointIds.push(point.id);
    for (const [featureId, ratio] of junction.hits) {
      const segment = resolved.segments.find((candidate) => candidate.featureId === featureId);
      if (segment === undefined) return { ok: false, reason: 'missingLine' };
      const normalized = isInterior(segment, ratio) ? ratio : ratio < 0.5 ? 0 : 1;
      const previous = cuts.get(featureId) ?? [];
      cuts.set(featureId, [...previous, { ratio: normalized, pointId: point.id }]);
    }
  }
  for (const feature of document.features) {
    const lineCuts = cuts.get(feature.id);
    if (lineCuts !== undefined && alreadyConnected(feature, lineCuts)) cuts.delete(feature.id);
  }
  if (hasSplitLineConstraint(document, new Set(cuts.keys()))) return { ok: false, reason: 'constrainedLine' };
  const result = buildPieces(document, cuts, newPoints);
  // An existing invalid feature may stay invalid; this operation cannot add another broken reference.
  const previousErrors = new Set(resolved.errors.map((error) => `${error.featureId}:${error.code}`));
  const after = resolveSketch(result.document, options);
  if (after.errors.some((error) => !previousErrors.has(`${error.featureId}:${error.code}`))) {
    return { ok: false, reason: 'invalidReferences' };
  }
  return { ok: true, document: result.document, pointIds, splitCount: result.splitCount };
}
