import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate, appendFeature, applyPlacementToDirection, applyPlacementToPoint, createPointFeature, createReferenceResolver,
  DEFAULT_FACE_COLOR, distanceVec3, FULL_TURN, FULL_TURN_EPSILON, isSamePoint, nextFeatureId, nextFeatureName,
  projectOntoPlane, radiansToDegrees, replaceSketch, resolveSketch, resolveSubShapeReference, sketchCurvesTouch,
  SKETCH_TOLERANCE_MM, subShapeFromFingerprint, withinMagnitude,
  type ResolvedCurve, type ResolvedSketch, type RigidPlacement, type SketchDocument, type SketchElementRef, type Vec3, type WorkPlane,
} from '@pointercad/model';
import { currentPartReferenceBodies } from '../solid/referenceRepairContext.js';
import type { AppState } from '../store/appState.js';
import type { AssemblyFaceProjection } from '../store/assemblySlice.js';
import { prepareDocumentEdit } from '../store/documentDerived.js';
import { beginDocumentRequest } from '../store/documentRequest.js';
import { useAppStore } from '../store/useAppStore.js';
import type { AssemblyMateFaceHit } from '../viewport/createAssemblyLayer.js';
import { currentAssemblyContext, pickedContextFace } from './assemblyContextGeometry.js';

type FaceProjection = NonNullable<Awaited<ReturnType<AssemblyFaceProjection>>>;
type ProfileKind = 'holeCenters' | 'outline';
function targetSketch(state: AppState) {
  const solved = state.resolvedPartSketches;
  if (solved === null || solved.document !== state.document || solved.activeDocumentId !== state.activeDocumentId
    || solved.generation !== state.completedGeneration || state.requestedGeneration !== solved.generation
    || state.isComputing || state.recomputeCancelled || state.timelineIndex !== null
    || state.activeTool !== 'select' || state.numericInput !== null || state.constraintPrompt !== null) return null;
  const resolved = solved.sketches.find(sketch => sketch.sketchId === state.sketch.id)?.resolved;
  if (resolved === undefined) return null;
  const resolver = createReferenceResolver(state.document, {
    sketch: id => solved.sketches.find(sketch => sketch.sketchId === id)?.resolved ?? null,
    subShape: reference => {
      const [body, duplicate] = currentPartReferenceBodies(state).filter(item => item.featureId === reference.bodyFeatureId);
      if (body === undefined || duplicate !== undefined || !body.isValid) return null;
      const matched = resolveSubShapeReference(body, reference);
      return matched.status === 'matched' ? subShapeFromFingerprint(matched.match.reference) : null;
    },
  });
  const plane = resolver.workPlane(state.workPlaneId);
  return plane === null ? null : { plane, resolved, solved };
}

function circleCenter(loop: readonly ResolvedCurve[]): Vec3 | null {
  const [first] = loop;
  if (first?.kind !== 'arc') return null;
  const sense = Math.sign(first.endAngle - first.startAngle);
  let sweep = 0;
  for (const curve of loop) {
    if (curve.kind !== 'arc' || !isSamePoint(first.center, curve.center)
      || !withinMagnitude(first.radius - curve.radius, SKETCH_TOLERANCE_MM)) return null;
    const angle = curve.endAngle - curve.startAngle;
    if (Math.sign(angle) !== sense) return null;
    sweep += angle;
  }
  return sense !== 0 && withinMagnitude(sweep - sense * FULL_TURN, FULL_TURN_EPSILON) ? first.center : null;
}

function curveInTarget(curve: ResolvedCurve, pose: RigidPlacement): ResolvedCurve | null {
  if (curve.kind === 'segment') {
    const from = applyPlacementToPoint(pose, curve.from), to = applyPlacementToPoint(pose, curve.to);
    return [...from, ...to].every(Number.isFinite) && distanceVec3(from, to) > SKETCH_TOLERANCE_MM ? { ...curve, from, to } : null;
  }
  if (curve.kind !== 'arc') return null;
  const center = applyPlacementToPoint(pose, curve.center);
  return [...center, curve.radius, curve.startAngle, curve.endAngle].every(Number.isFinite) && curve.radius > SKETCH_TOLERANCE_MM
    ? { ...curve, center, normal: applyPlacementToDirection(pose, curve.normal), xAxis: applyPlacementToDirection(pose, curve.xAxis) }
    : null;
}

function broadAxis(points: readonly Vec3[]): number {
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (const point of points) for (let axis = 0; axis < 3; axis += 1) {
    low[axis] = Math.min(low[axis], point[axis]);
    high[axis] = Math.max(high[axis], point[axis]);
  }
  return [0, 1, 2].reduce((best, axis) => high[axis] - low[axis] > high[best] - low[best] ? axis : best, 0);
}

function firstAtOrAbove<T>(items: readonly T[], limit: number, prefix: (item: T) => number): number {
  let low = 0, high = items.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (prefix(items[middle]) < limit) low = middle + 1;
    else high = middle;
  }
  return low;
}

function centersOverlap(points: readonly Vec3[], resolved: ResolvedSketch): boolean {
  const axis = broadAxis(points);
  const existing = resolved.points.map(item => item.position).sort((a, b) => a[axis] - b[axis]);
  const added = [...points].sort((a, b) => a[axis] - b[axis]);
  return added.some((point, index) => {
    const low = point[axis] - SKETCH_TOLERANCE_MM, high = point[axis] + SKETCH_TOLERANCE_MM;
    for (let cursor = index + 1; cursor < added.length && added[cursor][axis] <= high; cursor += 1) {
      if (isSamePoint(point, added[cursor])) return true;
    }
    for (let cursor = firstAtOrAbove(existing, low, item => item[axis]);
      cursor < existing.length && existing[cursor][axis] <= high; cursor += 1) {
      if (isSamePoint(point, existing[cursor])) return true;
    }
    return false;
  });
}

function importHoleCenters(
  sketch: SketchDocument, plane: WorkPlane, holes: NonNullable<FaceProjection['holes']>, pose: RigidPlacement, resolved: ResolvedSketch,
): SketchDocument | null {
  const projected = holes.map(circleCenter).filter((center): center is Vec3 => center !== null)
    .map(center => projectOntoPlane(plane, applyPlacementToPoint(pose, center)));
  if (projected.length === 0 || projected.some(point => !point.every(Number.isFinite)) || centersOverlap(projected, resolved)) return null;
  return projected.reduce((next, point) => appendFeature(next, createPointFeature(next, absoluteCoordinate(...point), plane.id)), sketch);
}

type Interval = readonly [number, number];

function axisInterval(curve: ResolvedCurve, axis: number): Interval {
  switch (curve.kind) {
    case 'segment': return [Math.min(curve.from[axis], curve.to[axis]), Math.max(curve.from[axis], curve.to[axis])];
    case 'arc': return [curve.center[axis] - curve.radius, curve.center[axis] + curve.radius];
    case 'ellipse': return [curve.center[axis] - curve.majorRadius, curve.center[axis] + curve.majorRadius];
    // Interpolating splines can leave the control polygon, so retain them as exact-check candidates.
    case 'spline': return [-Infinity, Infinity];
  }
}

function overlapChecker(resolved: ResolvedSketch, plane: WorkPlane): (curve: ResolvedCurve) => boolean {
  const axis = [0, 1, 2].reduce((best, candidate) =>
    plane.normal[candidate] ** 2 < plane.normal[best] ** 2 ? candidate : best, 0);
  const existing = [...resolved.segments, ...resolved.arcs, ...resolved.ellipses]
    .map(curve => ({ curve, range: axisInterval(curve, axis) })).sort((a, b) =>
      a.range[0] < b.range[0] ? -1 : a.range[0] > b.range[0] ? 1 : 0);
  let high = -Infinity;
  const prefixMaxima = existing.map(item => {
    high = Math.max(high, item.range[1]);
    return high;
  });
  return curve => {
    const range = axisInterval(curve, axis);
    const low = range[0] - SKETCH_TOLERANCE_MM, high = range[1] + SKETCH_TOLERANCE_MM;
    for (let index = firstAtOrAbove(prefixMaxima, low, value => value);
      index < existing.length && existing[index].range[0] <= high; index += 1) {
      const item = existing[index];
      if (item.range[1] >= low && sketchCurvesTouch(curve, item.curve)) return true;
    }
    return resolved.splines.some(spline => sketchCurvesTouch(curve, spline));
  };
}

function importOutline(
  sketch: SketchDocument, plane: WorkPlane, contours: readonly (readonly ResolvedCurve[])[], pose: RigidPlacement, resolved: ResolvedSketch,
): SketchDocument | null {
  const overlaps = overlapChecker(resolved, plane);
  let next = sketch;
  const loops: SketchElementRef[][] = [];
  for (const contour of contours) {
    if (contour.length === 0) return null;
    const loop: SketchElementRef[] = [];
    for (const source of contour) {
      const curve = curveInTarget(source, pose);
      if (curve === null || overlaps(curve)) return null;
      if (curve.kind === 'segment') {
        const id = nextFeatureId(next, 'line');
        next = appendFeature(next, { id, name: nextFeatureName(next, 'line'), planeId: plane.id, kind: 'line',
          from: absoluteCoordinate(...curve.from), to: absoluteCoordinate(...curve.to), construction: false });
        loop.push({ featureId: id });
      } else if (curve.kind === 'arc') {
        const id = nextFeatureId(next, 'arc');
        next = appendFeature(next, { id, name: nextFeatureName(next, 'arc'), planeId: plane.id, kind: 'arc',
          center: absoluteCoordinate(...curve.center), radius: expressionValueFromNumber(curve.radius), construction: false,
          startAngle: expressionValueFromNumber(radiansToDegrees(curve.startAngle)),
          endAngle: expressionValueFromNumber(radiansToDegrees(curve.endAngle)) });
        loop.push({ featureId: id });
      }
    }
    loops.push(loop);
  }
  const [boundary, ...holes] = loops;
  const id = nextFeatureId(next, 'face');
  return appendFeature(next, { id, name: nextFeatureName(next, 'face'), planeId: plane.id, kind: 'face',
    boundary, ...(holes.length === 0 ? {} : { holes }), color: DEFAULT_FACE_COLOR });
}

function importProfile(kind: ProfileKind, sketch: SketchDocument, plane: WorkPlane, projection: FaceProjection,
  pose: RigidPlacement, resolved: ResolvedSketch): SketchDocument | null {
  const holes = projection.holes;
  if (holes === undefined || projection.curves.length === 0) return null;
  const next = kind === 'holeCenters' ? importHoleCenters(sketch, plane, holes, pose, resolved)
    : importOutline(sketch, plane, [projection.curves, ...holes], pose, resolved);
  if (next === null) return null;
  // The ordinary sketch resolver checks closure, coplanarity and holes before any parent write.
  // New elements use absolute coordinates and refer only to elements appended in this operation.
  const proof = resolveSketch({ ...next, features: next.features.slice(sketch.features.length) },
    { workPlane: id => id === plane.id ? plane : null });
  return proof.errors.length === 0 && (kind === 'holeCenters' || proof.faces.length === 1) ? next : null;
}

export async function copyPickedAssemblyProfile(hit: AssemblyMateFaceHit | null): Promise<void> {
  const before = useAppStore.getState(), edit = before.partEdit, pick = edit?.contextPick;
  if (edit === null || pick == null || pick.kind === 'plane') return;
  const request = beginDocumentRequest('assembly.context.projectFace', before);
  const unavailable = (): void => useAppStore.getState().setFileMessage({ key: 'assembly.partEdit.projectionUnavailable', failed: true });
  const source = hit === null ? null : pickedContextFace(before, edit.componentId, hit);
  const target = targetSketch(before);
  const project = source?.view.projectContextFace;
  if (source === null || source.reference.origin?.shapeKind !== 'face' || target === null || project === undefined) {
    unavailable(); return;
  }
  const current = (state: AppState): boolean => request.isCurrent() && state.partEdit?.id === edit.id && state.partEdit.contextPick === pick
    && currentAssemblyContext(state) === source.view && state.document === before.document && state.sketch === before.sketch
    && state.workPlaneId === before.workPlaneId && state.resolvedPartSketches === target.solved
    && state.requestedGeneration === target.solved.generation && state.completedGeneration === target.solved.generation
    && !state.isComputing && !state.recomputeCancelled
    && state.activeTool === before.activeTool && state.selection === before.selection && state.timelineIndex === before.timelineIndex
    && state.numericInputRevision === before.numericInputRevision && state.cancelRequestCount === before.cancelRequestCount;
  const plane = target.plane, transform = source.inversePose;
  // Project in the source body's B-rep coordinates. The returned angles use this same
  // transported frame, so arc radians are converted to degrees without a second sign change.
  const basis = source.geometry.planarBasis;
  if (basis === undefined || source.geometry.surfaceKind !== 'plane') { unavailable(); return; }
  // Circular openings are classified in their own plane. A tilted projection can have
  // an elliptic outline, but projection still maps the true center to the target plane.
  const sourcePlane: WorkPlane = pick.kind === 'holeCenters'
    ? { id: plane.id, origin: basis.origin, axisU: basis.xAxis, axisV: basis.yAxis, normal: basis.normal } : {
    id: plane.id, origin: applyPlacementToPoint(transform, plane.origin),
    axisU: applyPlacementToDirection(transform, plane.axisU), axisV: applyPlacementToDirection(transform, plane.axisV),
    normal: applyPlacementToDirection(transform, plane.normal),
  };
  try {
    const projection = await project(source.partKey, source.body, source.reference, sourcePlane, () => current(useAppStore.getState()));
    if (!current(useAppStore.getState())) return;
    const sketch = projection === null ? null : importProfile(pick.kind, before.sketch, plane, projection, source.pose, target.resolved);
    if (sketch === null) { unavailable(); return; }
    const document = replaceSketch(before.document, sketch);
    // A face with inner wires uses the same save format as a sketch-region face with holes.
    const next = pick.kind === 'outline' && (projection?.holes?.length ?? 0) > 0 && document.schemaVersion < 23
      ? { ...document, schemaVersion: 23 } : document;
    await before.commitAssemblyPartPlacement(prepareDocumentEdit(before, next, false), {
      isCurrent: current, onApplied: state => { state.setPartEditContextPick(null); },
    });
  } catch {
    if (current(useAppStore.getState())) unavailable();
  }
}
