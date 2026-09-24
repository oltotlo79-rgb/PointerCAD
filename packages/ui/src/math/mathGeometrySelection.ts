/**
 * Turn the current viewport/tree selection into the math-geometry quantities it could define
 * (design doc §4(a) の「測る量」欄; scratchpad/claude/plans/geomref-plan.md).
 *
 * Never offer a quantity the model would refuse: every filter here mirrors a rule enforced by
 * `packages/model/src/measure/mathGeometry.ts`'s `evaluate()` (NFR-UX-5 — a shown option must work).
 * In particular `MathGeometryShape` (mathGeometryTypes.ts) only accepts a body, a face, or a
 * *sub-shape* edge/vertex — a sketch point or sketch curve is never a valid shape-distance/area
 * target, and `volume` only resolves when the body's `bodyKind` is `'solid'` (a shell/mesh/mixed
 * body still measures `area` through the kernel's massProperties call, which does not check kind).
 *
 * GR-22 adds: a circular curve (sketch arc or circular solid edge) also offers `radius`/
 * `central-angle`; a compound sketch feature made only of segments/arcs (no ellipse/spline) offers
 * `contour-length` instead of `length` (never both — `mathGeometry.ts`'s `sketchCurve()` still
 * refuses to treat a compound contour as "its first edge"); a planar face participates in
 * `plane-angle`/`line-plane-angle`/parallel/perpendicular the same way a straight curve already did;
 * selecting a point together with a reference coordinate system offers the point's `coordinate` in
 * that frame; selecting exactly three points offers the ∠ABC `point-angle` (second = vertex); and a
 * pair of comparable curves (two segments, two circular arcs/edges, or two same-edge-count all-
 * straight compound contours) offers `congruent`/`similar` — mismatched comparable kinds or polygon
 * edge counts are never offered, matching `mathGeometryCongruence.ts`'s own refusal.
 */
import type {
  MathGeometryCurve,
  MathGeometryFace,
  MathGeometryFrame,
  MathGeometryPoint,
  MathGeometryQuantity,
  MathGeometryShape,
  ReferenceFeature,
  ResolvedSketch,
  SolidBody,
} from '@pointercad/model';

import { subShapeRefOf } from '../solid/subShapeSelection.js';

/**
 * Why the selection has no candidate right now. There is only ever one reason at a time (unlike a
 * per-quantity failure, which does not exist yet): the picker is empty, or it is not.
 */
export type MathGeometryCandidateReason = 'nothingSelected' | 'unsupportedPair' | 'tooMany';

export interface MathGeometryCandidates {
  readonly candidates: readonly MathGeometryQuantity[];
  /** Non-null exactly when candidates is empty. */
  readonly reason: MathGeometryCandidateReason | null;
}

/**
 * Selecting more than this becomes `'tooMany'`. Selecting exactly this many offers the 3-point
 * angle (∠ABC, GR-22) only when all three resolve to points; any other triple stays `'unsupportedPair'`.
 */
export const MATH_GEOMETRY_SELECTION_LIMIT = 3;

const NO_CANDIDATES: readonly MathGeometryQuantity[] = [];

function unresolved(reason: MathGeometryCandidateReason): MathGeometryCandidates {
  return { candidates: NO_CANDIDATES, reason };
}

/** A compound sketch feature (2+ curves under one feature id) usable for contour-length and/or congruence. */
interface ContourTarget {
  readonly sketchId: string;
  readonly featureId: string;
  /** Segment count; congruent/similar's polygon comparison needs 3+ (mirrors `mathGeometryCongruence.ts`). */
  readonly edgeCount: number;
  /** True only when every curve is a straight segment — an arc anywhere disqualifies the G1 "polygon" shape. */
  readonly allStraight: boolean;
}

/**
 * One resolved selection item. `point`/`curve` accept sketch elements as well as sub-shapes;
 * `shape` only ever holds something `MathGeometryShape` accepts (body/face/sub-shape edge/vertex),
 * so a sketch point or sketch curve leaves `shape` unset even though `point`/`curve` is set.
 */
interface Target {
  readonly point?: MathGeometryPoint;
  readonly curve?: MathGeometryCurve;
  readonly shape?: MathGeometryShape;
  /** Set only when `shape` is a face whose surface is planar (`plane-angle`/line-plane/parallel/perpendicular). */
  readonly plane?: MathGeometryFace;
  /** Set only for a selected reference coordinate system (`coordinate`'s optional frame). */
  readonly frame?: MathGeometryFrame;
  /** Set only for a compound sketch feature of segments/arcs (contour-length, and possibly congruence). */
  readonly contour?: ContourTarget;
  /** A straight curve (sketch segment or straight sub-shape edge) — angle/parallel/perpendicular need two. */
  readonly line: boolean;
  /** A circular curve (sketch arc or circular sub-shape edge) — radius/central-angle need exactly one. */
  readonly circular: boolean;
  /** True only for a whole body whose `bodyKind` is `'solid'`; shells/meshes/mixed bodies still offer area. */
  readonly volumeEligible: boolean;
}

const NOT_A_LINE_OR_CIRCLE = { line: false, circular: false } as const;

/**
 * Resolves one selection id against the current sketch, bodies and reference geometry. Returns null
 * when the id matches nothing usable: an unknown id, an invalid body, a compound sketch contour
 * mixing in an ellipse/spline (its curves live under one feature id — the id alone can never mean
 * "just its first edge", matching `mathGeometry.ts`'s `sketchCurve()`/`contourLength()`), a lone
 * ellipse/spline, or a reference that is not a coordinate system.
 */
function target(id: string, sketchId: string, sketch: ResolvedSketch, bodies: readonly SolidBody[],
  references: readonly ReferenceFeature[]): Target | null {
  const points = sketch.points.filter(item => item.id === id);
  if (points.length === 1) {
    return { point: { kind: 'sketch-point', sketchId, reference: { kind: 'point', pointId: id } },
      ...NOT_A_LINE_OR_CIRCLE, volumeEligible: false };
  }
  const curves = sketch.curvesByFeature.get(id)
    ?? [...sketch.segments, ...sketch.arcs, ...sketch.ellipses, ...sketch.splines].filter(curve => curve.featureId === id);
  if (curves.length === 1 && (curves[0].kind === 'segment' || curves[0].kind === 'arc')) {
    return { curve: { kind: 'sketch-curve', sketchId, featureId: id },
      line: curves[0].kind === 'segment', circular: curves[0].kind === 'arc', volumeEligible: false };
  }
  if (curves.length > 1 && curves.every(curve => curve.kind === 'segment' || curve.kind === 'arc')) {
    return { contour: { sketchId, featureId: id, edgeCount: curves.length,
      allStraight: curves.every(curve => curve.kind === 'segment') }, ...NOT_A_LINE_OR_CIRCLE, volumeEligible: false };
  }
  const validBodies = bodies.filter(item => item.isValid);
  const wholeBody = validBodies.filter(item => item.featureId === id);
  if (wholeBody.length === 1) {
    return { shape: { kind: 'body', featureId: id }, ...NOT_A_LINE_OR_CIRCLE, volumeEligible: wholeBody[0].bodyKind === 'solid' };
  }
  const isCoordinateSystem = references.some(item => item.id === id && item.kind === 'referenceCoordinateSystem');
  if (isCoordinateSystem) {
    return { frame: { kind: 'reference', featureId: id }, ...NOT_A_LINE_OR_CIRCLE, volumeEligible: false };
  }
  const reference = subShapeRefOf(validBodies, id);
  if (reference === null) return null;
  const fingerprint = reference.fingerprint;
  switch (fingerprint.kind) {
    case 'vertex':
      return { point: { kind: 'vertex', reference: { ...reference, fingerprint } },
        shape: { kind: 'vertex', reference: { ...reference, fingerprint } }, ...NOT_A_LINE_OR_CIRCLE, volumeEligible: false };
    case 'edge':
      return { curve: { kind: 'edge', reference: { ...reference, fingerprint } },
        shape: { kind: 'edge', reference: { ...reference, fingerprint } },
        line: fingerprint.curveKind === 'line', circular: fingerprint.curveKind === 'circle', volumeEligible: false };
    case 'face': {
      const face: MathGeometryFace = { kind: 'face', reference: { ...reference, fingerprint } };
      return { shape: face, plane: fingerprint.surfaceKind === 'plane' ? face : undefined,
        ...NOT_A_LINE_OR_CIRCLE, volumeEligible: false };
    }
  }
}

/** Quantities buildable from exactly one resolved target. Never empty for a resolved Target. */
function singleCandidates(only: Target): readonly MathGeometryQuantity[] {
  const result: MathGeometryQuantity[] = [];
  const point = only.point;
  if (point !== undefined) {
    for (const component of ['X', 'Y', 'Z'] as const) result.push({ kind: 'coordinate', point, component });
  }
  const curve = only.curve;
  if (curve !== undefined) {
    result.push({ kind: 'length', curve });
    if (only.circular) result.push({ kind: 'radius', curve }, { kind: 'central-angle', curve, unit: 'degree' });
  }
  const contour = only.contour;
  if (contour !== undefined) result.push({ kind: 'contour-length', sketchId: contour.sketchId, featureId: contour.featureId });
  const shape = only.shape;
  if (shape !== undefined) {
    if (shape.kind === 'body' && only.volumeEligible) result.push({ kind: 'volume', body: shape });
    if (shape.kind === 'body' || shape.kind === 'face') result.push({ kind: 'area', shape });
  }
  return result;
}

type ComparableCurve =
  | { readonly kind: 'segment' | 'circular'; readonly curve: MathGeometryCurve }
  | { readonly kind: 'polygon'; readonly curve: MathGeometryCurve; readonly edgeCount: number };

/**
 * What `congruent`/`similar` would compare `item` as (`mathGeometryCongruence.ts`'s
 * `MathGeometryComparisonShape`), or null when it is not eligible at all: an ellipse/spline curve,
 * a compound contour with any arc or fewer than 3 edges, or a point/shape/frame target.
 */
function comparableCurveOf(item: Target): ComparableCurve | null {
  const curve = item.curve;
  if (curve !== undefined) return { kind: item.circular ? 'circular' : 'segment', curve };
  const contour = item.contour;
  if (contour !== undefined && contour.allStraight && contour.edgeCount >= 3) {
    return { kind: 'polygon', edgeCount: contour.edgeCount,
      curve: { kind: 'sketch-curve', sketchId: contour.sketchId, featureId: contour.featureId } };
  }
  return null;
}

/**
 * `congruent`/`similar` candidates for a pair (G1). The two sides must compare as the same shape
 * (segment/segment, circular/circular or polygon/polygon) — a segment-vs-arc or mismatched-arity
 * polygon pair always resolves to `unsupported` once evaluated, so it is never offered as a candidate.
 */
function congruenceCandidates(first: Target, second: Target): readonly MathGeometryQuantity[] {
  const a = comparableCurveOf(first), b = comparableCurveOf(second);
  if (a === null || b === null || a.kind !== b.kind) return [];
  if (a.kind === 'polygon' && b.kind === 'polygon' && a.edgeCount !== b.edgeCount) return [];
  return [{ kind: 'congruent', first: a.curve, second: b.curve }, { kind: 'similar', first: a.curve, second: b.curve }];
}

/** Quantities buildable from exactly two resolved targets; selection order never matters except as first/second. */
function pairCandidates(first: Target, second: Target): readonly MathGeometryQuantity[] {
  const result: MathGeometryQuantity[] = [];
  const firstPoint = first.point;
  const secondPoint = second.point;
  const firstShape = first.shape;
  const secondShape = second.shape;
  if (firstPoint !== undefined && secondPoint !== undefined) {
    result.push({ kind: 'point-distance', first: firstPoint, second: secondPoint });
  } else if (firstShape !== undefined && secondShape !== undefined) {
    result.push({ kind: 'shape-distance', first: firstShape, second: secondShape });
  } else if (firstPoint !== undefined && second.frame !== undefined) {
    for (const component of ['X', 'Y', 'Z'] as const) result.push({ kind: 'coordinate', point: firstPoint, component, frame: second.frame });
  } else if (secondPoint !== undefined && first.frame !== undefined) {
    for (const component of ['X', 'Y', 'Z'] as const) result.push({ kind: 'coordinate', point: secondPoint, component, frame: first.frame });
  }

  const firstCurve = first.curve;
  const secondCurve = second.curve;
  if (first.line && second.line && firstCurve !== undefined && secondCurve !== undefined) {
    result.push(
      { kind: 'angle', first: firstCurve, second: secondCurve, unit: 'degree' },
      { kind: 'parallel', first: firstCurve, second: secondCurve },
      { kind: 'perpendicular', first: firstCurve, second: secondCurve },
    );
  }
  if (first.line && firstCurve !== undefined && second.plane !== undefined) {
    result.push(
      { kind: 'line-plane-angle', line: firstCurve, plane: second.plane, unit: 'degree' },
      { kind: 'parallel', first: firstCurve, second: second.plane },
      { kind: 'perpendicular', first: firstCurve, second: second.plane },
    );
  }
  if (second.line && secondCurve !== undefined && first.plane !== undefined) {
    result.push(
      { kind: 'line-plane-angle', line: secondCurve, plane: first.plane, unit: 'degree' },
      { kind: 'parallel', first: first.plane, second: secondCurve },
      { kind: 'perpendicular', first: first.plane, second: secondCurve },
    );
  }
  if (first.plane !== undefined && second.plane !== undefined) {
    result.push(
      { kind: 'plane-angle', first: first.plane, second: second.plane, unit: 'degree' },
      { kind: 'parallel', first: first.plane, second: second.plane },
      { kind: 'perpendicular', first: first.plane, second: second.plane },
    );
  }

  result.push(...congruenceCandidates(first, second));
  return result;
}

/** The ∠ABC angle (second = vertex, GR-22) when all three resolved targets are points; otherwise none. */
function tripleCandidates(first: Target, second: Target, third: Target): readonly MathGeometryQuantity[] {
  if (first.point === undefined || second.point === undefined || third.point === undefined) return [];
  return [{ kind: 'point-angle', first: first.point, second: second.point, third: third.point, unit: 'degree' }];
}

/**
 * The quantities the current selection could define (§4(a)). `sketchId`/`sketch` are the sketch
 * being edited (`state.sketch.id` / `state.resolvedSketch`); `bodies` are the current part's
 * resolved bodies; `references` are the document's reference geometry (only a coordinate system
 * among them ever resolves, for `coordinate`'s optional frame). A selection of 1 item offers its
 * intrinsic quantities (coordinate/length/area/volume/radius/central-angle/contour-length); 2 items
 * offer a relation between them (distance, coordinate-in-frame, angle/parallel/perpendicular/
 * congruent/similar) when one exists; exactly 3 items offer ∠ABC when every item is a point.
 * `reason` explains an empty result; GR-19a maps it to text.
 */
export function mathGeometrySelection(
  selection: readonly string[],
  sketchId: string,
  sketch: ResolvedSketch,
  bodies: readonly SolidBody[],
  references: readonly ReferenceFeature[] = [],
): MathGeometryCandidates {
  if (selection.length === 0) return unresolved('nothingSelected');
  if (selection.length > MATH_GEOMETRY_SELECTION_LIMIT) return unresolved('tooMany');
  if (new Set(selection).size !== selection.length) return unresolved('unsupportedPair');
  const resolvedTargets = selection
    .map(id => target(id, sketchId, sketch, bodies, references))
    .filter((value): value is Target => value !== null);
  if (resolvedTargets.length !== selection.length) return unresolved('unsupportedPair');
  const [first, second, third] = resolvedTargets;
  if (first === undefined) return unresolved('unsupportedPair');
  const candidates = second === undefined ? singleCandidates(first)
    : third === undefined ? pairCandidates(first, second)
    : tripleCandidates(first, second, third);
  return candidates.length === 0 ? unresolved('unsupportedPair') : { candidates, reason: null };
}
