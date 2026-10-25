/** Conservative interior bounds for the generated non-rational C1 bicubic surface. */
import type {
  Bnd_Box2d, BRepAdaptor_Curve, Handle_Geom2d_Curve, OpenCascadeInstance, TopoDS_Face, TopoDS_Shape,
} from 'opencascade.js/dist/opencascade.full.js';
import type { Vec3Tuple } from '../types.js';
import { createAllocations, type Allocations } from './allocations.js';
import { borrowHandle } from './borrowHandle.js';
import { isValidShape } from './solidMesh.js';

export interface CubicKnotDirection {
  readonly knots: readonly number[];
  readonly multiplicities: readonly number[];
}

export interface CubicSurfaceCoefficients {
  readonly u: CubicKnotDirection;
  readonly v: CubicKnotDirection;
  /** Row-major in U, as in the native B-spline pole array. */
  readonly poles: readonly Vec3Tuple[];
}

export interface SurfaceParameterCell {
  readonly u0: number;
  readonly u1: number;
  readonly v0: number;
  readonly v1: number;
}

interface CoordinateBox {
  readonly minimum: Vec3Tuple;
  readonly maximum: Vec3Tuple;
}

interface Interval {
  readonly lo: number;
  readonly hi: number;
}

interface BernsteinCell extends SurfaceParameterCell {
  readonly coefficients: readonly Interval[];
  readonly depth: number;
  readonly uStart: Interval;
  readonly uEnd: Interval;
  readonly vStart: Interval;
  readonly vEnd: Interval;
}

export interface SurfaceInteriorBudget {
  readonly maxCells: number;
  readonly maxDepth: number;
}

export type SurfaceInteriorCertificate =
  | { readonly certified: true; readonly visitedCells: number }
  | { readonly certified: false; readonly reason: 'invalid' | 'budget' | 'unresolved'; readonly visitedCells: number };

const MAX_POLES = 200_000;
const DEFAULT_BUDGET: SurfaceInteriorBudget = { maxCells: 250_000, maxDepth: 48 };
const adjacentBuffer = new DataView(new ArrayBuffer(8));

/** One representable step, including signed zero and the subnormal range. */
function nextUp(value: number): number {
  if (Number.isNaN(value) || value === Number.POSITIVE_INFINITY) return value;
  if (value === 0) return Number.MIN_VALUE;
  adjacentBuffer.setFloat64(0, value);
  const bits = adjacentBuffer.getBigUint64(0);
  adjacentBuffer.setBigUint64(0, value > 0 ? bits + 1n : bits - 1n);
  return adjacentBuffer.getFloat64(0);
}

function nextDown(value: number): number { return -nextUp(-value); }
function exact(value: number): Interval { return { lo: value, hi: value }; }

function add(a: Interval, b: Interval): Interval {
  return { lo: nextDown(a.lo + b.lo), hi: nextUp(a.hi + b.hi) };
}

function subtract(a: Interval, b: Interval): Interval {
  return { lo: nextDown(a.lo - b.hi), hi: nextUp(a.hi - b.lo) };
}

function multiply(a: Interval, b: Interval): Interval {
  const products = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi];
  return { lo: nextDown(Math.min(...products)), hi: nextUp(Math.max(...products)) };
}

function dividePositive(a: Interval, b: Interval): Interval {
  if (!(b.lo > 0) || !Number.isFinite(b.hi)) throw new Error('Unresolved spline denominator');
  return multiply(a, { lo: nextDown(1 / b.hi), hi: nextUp(1 / b.lo) });
}

function mix(a: Interval, b: Interval, weight: Interval): Interval {
  return add(multiply(subtract(exact(1), weight), a), multiply(weight, b));
}

function midpoint(a: Interval, b: Interval): Interval {
  return add(multiply(exact(0.5), a), multiply(exact(0.5), b));
}

function finiteInterval(value: Interval): boolean {
  return Number.isFinite(value.lo) && Number.isFinite(value.hi) && value.lo <= value.hi;
}

function expandedKnots(direction: CubicKnotDirection): number[] {
  const { knots, multiplicities } = direction;
  if (knots.length < 2 || knots.length > MAX_POLES || knots.length !== multiplicities.length) {
    throw new Error('Invalid cubic knot sequence');
  }
  const expanded: number[] = [];
  for (let index = 0; index < knots.length; index++) {
    const knot = knots[index], count = multiplicities[index];
    if (!Number.isFinite(knot) || (index > 0 && !(knot > knots[index - 1]))) {
      throw new Error('Invalid cubic knot value');
    }
    // Endpoint clamping and internal multiplicity <= 2 certify C1 across all span seams.
    if (index === 0 || index === knots.length - 1 ? count !== 4 : count !== 1 && count !== 2) {
      throw new Error('Cubic surface must be clamped and C1');
    }
    for (let repetition = 0; repetition < count; repetition++) expanded.push(knot);
  }
  return expanded;
}

/** De Boor evaluation on the specified closed polynomial span, with outward rounding. */
function deBoor(knots: readonly number[], span: number, degree: number, parameter: number,
  coefficient: (index: number) => Interval): Interval {
  const work = Array.from({ length: degree + 1 }, (_, index) => coefficient(span - degree + index));
  for (let level = 1; level <= degree; level++) {
    for (let index = degree; index >= level; index--) {
      const first = span - degree + index;
      const weight = dividePositive(subtract(exact(parameter), exact(knots[first])),
        subtract(exact(knots[span + 1 + index - level]), exact(knots[first])));
      work[index] = mix(work[index - 1], work[index], weight);
    }
  }
  return work[degree];
}

/**
 * On one cubic span, endpoint values and one-sided derivatives determine its four
 * Bernstein coefficients: P(a), P(a)+hP'(a)/3, P(b)-hP'(b)/3, P(b).
 * The derivative B-spline has degree 2 and knot sequence U[1:-1]. This is exact
 * polynomial conversion with interval arithmetic, not a fit or sampled bound.
 */
function bezierSpan(knots: readonly number[], span: number,
  coefficient: (index: number) => Interval): readonly Interval[] {
  const a = knots[span], b = knots[span + 1];
  const derivative = (index: number): Interval => dividePositive(
    multiply(exact(3), subtract(coefficient(index + 1), coefficient(index))),
    subtract(exact(knots[index + 4]), exact(knots[index + 1])));
  // Shifted knot access without copying the entire direction for each span.
  const derivativeAt = (parameter: number): Interval => {
    const work = [derivative(span - 3), derivative(span - 2), derivative(span - 1)];
    for (let level = 1; level <= 2; level++) {
      for (let index = 2; index >= level; index--) {
        const first = span - 2 + index;
        const weight = dividePositive(subtract(exact(parameter), exact(knots[first])),
          subtract(exact(knots[span + 1 + index - level]), exact(knots[first])));
        work[index] = mix(work[index - 1], work[index], weight);
      }
    }
    return work[2];
  };
  const first = deBoor(knots, span, 3, a, coefficient);
  const last = deBoor(knots, span, 3, b, coefficient);
  const thirdSpan = dividePositive(subtract(exact(b), exact(a)), exact(3));
  return [first, add(first, multiply(thirdSpan, derivativeAt(a))),
    subtract(last, multiply(thirdSpan, derivativeAt(b))), last];
}

function* scalarPatches(spec: CubicSurfaceCoefficients, uKnots: readonly number[],
  vKnots: readonly number[], axis: number): Generator<BernsteinCell> {
  const columns = vKnots.length - 4;
  for (let u = 3; u < uKnots.length - 4; u++) {
    if (uKnots[u] === uKnots[u + 1]) continue;
    for (let v = 3; v < vKnots.length - 4; v++) {
      if (vKnots[v] === vKnots[v + 1]) continue;
      const rows = Array.from({ length: 4 }, (_, index) => bezierSpan(uKnots, u,
        pole => exact(spec.poles[pole * columns + v - 3 + index][axis])));
      const coefficients: Interval[] = [];
      for (let index = 0; index < 4; index++) {
        coefficients.push(...bezierSpan(vKnots, v, pole => rows[pole - v + 3][index]));
      }
      yield { u0: uKnots[u], u1: uKnots[u + 1], v0: vKnots[v], v1: vKnots[v + 1],
        uStart: exact(uKnots[u]), uEnd: exact(uKnots[u + 1]),
        vStart: exact(vKnots[v]), vEnd: exact(vKnots[v + 1]), coefficients, depth: 0 };
    }
  }
}

function hasNonzeroPartial(coefficients: readonly Interval[]): boolean {
  for (const stride of [1, 4]) {
    const differences: Interval[] = [];
    for (let u = 0; u < (stride === 4 ? 3 : 4); u++) {
      for (let v = 0; v < (stride === 1 ? 3 : 4); v++) {
        const index = 4 * u + v;
        differences.push(subtract(coefficients[index + stride], coefficients[index]));
      }
    }
    if (differences.every(value => value.lo > 0) || differences.every(value => value.hi < 0)) return true;
  }
  return false;
}

function splitCurve(values: readonly Interval[]): readonly [readonly Interval[], readonly Interval[]] {
  const a = midpoint(values[0], values[1]), b = midpoint(values[1], values[2]);
  const c = midpoint(values[2], values[3]), d = midpoint(a, b), e = midpoint(b, c), f = midpoint(d, e);
  return [[values[0], a, d, f], [f, e, c, values[3]]];
}

function splitCell(cell: BernsteinCell): readonly [BernsteinCell, BernsteinCell] | null {
  const alongU = cell.depth % 2 === 0;
  const first: Interval[] = [...cell.coefficients], second: Interval[] = [...cell.coefficients];
  for (let row = 0; row < 4; row++) {
    const indices = Array.from({ length: 4 }, (_, index) => alongU ? 4 * index + row : 4 * row + index);
    const [left, right] = splitCurve(indices.map(index => cell.coefficients[index]));
    indices.forEach((index, offset) => { first[index] = left[offset]; second[index] = right[offset]; });
  }
  const middle = alongU ? midpoint(cell.uStart, cell.uEnd) : midpoint(cell.vStart, cell.vEnd);
  if (!finiteInterval(middle) || (alongU
    ? !(middle.lo > cell.u0 && middle.hi < cell.u1)
    : !(middle.lo > cell.v0 && middle.hi < cell.v1))) return null;
  return [
    { ...cell, coefficients: first, depth: cell.depth + 1,
      ...(alongU ? { u1: middle.hi, uEnd: middle } : { v1: middle.hi, vEnd: middle }) },
    { ...cell, coefficients: second, depth: cell.depth + 1,
      ...(alongU ? { u0: middle.lo, uStart: middle } : { v0: middle.lo, vStart: middle }) },
  ];
}

/**
 * This proves only the interior-extremum part of the bounds postcondition. The
 * caller MUST independently bound every complete mapped trim curve and vertex.
 * `isOutside` may return true only for an entire closed parameter rectangle;
 * a center-point OUT classification alone does not establish that condition.
 *
 * C1 across spans means a coordinate extremum inside the face has zero gradient,
 * including at artificial subdivision/span seams. Bernstein derivative signs
 * exclude such points. Remaining stationary cells must have a contained hull or
 * be proved outside the trimmed face. Exhaustion is never an acceptance.
 */
export function certifyCubicSurfaceInterior(spec: CubicSurfaceCoefficients, limits: CoordinateBox,
  tolerance: number, isOutside: (cell: SurfaceParameterCell) => boolean,
  budget: SurfaceInteriorBudget = DEFAULT_BUDGET): SurfaceInteriorCertificate {
  let visitedCells = 0;
  try {
    if (!Number.isFinite(tolerance) || tolerance < 0 || !Number.isSafeInteger(budget.maxCells)
      || budget.maxCells < 1 || budget.maxCells > DEFAULT_BUDGET.maxCells
      || !Number.isSafeInteger(budget.maxDepth) || budget.maxDepth < 0 || budget.maxDepth > DEFAULT_BUDGET.maxDepth) {
      return { certified: false, reason: 'invalid', visitedCells };
    }
    const uKnots = expandedKnots(spec.u), vKnots = expandedKnots(spec.v);
    const count = (uKnots.length - 4) * (vKnots.length - 4);
    if (count > MAX_POLES || count !== spec.poles.length
      || !spec.poles.every(pole => pole.length === 3 && pole.every(Number.isFinite))) {
      return { certified: false, reason: 'invalid', visitedCells };
    }
    for (let axis = 0; axis < 3; axis++) {
      const minimum = limits.minimum[axis] - tolerance, maximum = limits.maximum[axis] + tolerance;
      if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || !(minimum < maximum)) {
        return { certified: false, reason: 'invalid', visitedCells };
      }
      for (const patch of scalarPatches(spec, uKnots, vKnots, axis)) {
        const pending = [patch];
        while (pending.length > 0) {
          const cell = pending.pop();
          if (cell === undefined) break;
          if (++visitedCells > budget.maxCells) return { certified: false, reason: 'budget', visitedCells };
          if (!cell.coefficients.every(finiteInterval)) return { certified: false, reason: 'invalid', visitedCells };
          if (cell.coefficients.every(value => value.lo >= minimum && value.hi <= maximum)) continue;
          if (hasNonzeroPartial(cell.coefficients)) continue;
          if (isOutside(cell)) continue;
          if (cell.depth >= budget.maxDepth) return { certified: false, reason: 'unresolved', visitedCells };
          const halves = splitCell(cell);
          if (halves === null) return { certified: false, reason: 'unresolved', visitedCells };
          pending.push(...halves);
        }
      }
    }
    return { certified: true, visitedCells };
  } catch {
    // Overflow, a zero span/denominator, or a failed native trim query is not evidence of containment.
    return { certified: false, reason: 'invalid', visitedCells };
  }
}

const NATIVE_CURVE_PRECISION = 1e-8;
const MAX_TRIM_NODES = 32_768;
const MAX_TRIM_CHECKS = 131_072;
const MAX_TRIM_DEPTH = 20;

function pointInside(point: Vec3Tuple, limits: CoordinateBox, tolerance: number): boolean {
  return point.every((coordinate, axis) => Number.isFinite(coordinate)
    && coordinate >= limits.minimum[axis] - tolerance && coordinate <= limits.maximum[axis] + tolerance);
}

/** Keep the native enlargement; a loose topology tolerance does not enlarge acceptance. */
function curveInside(oc: OpenCascadeInstance, curve: BRepAdaptor_Curve,
  limits: CoordinateBox, tolerance: number): boolean {
  const owner = createAllocations();
  try {
    if (!Number.isFinite(curve.FirstParameter()) || !Number.isFinite(curve.LastParameter())
      || curve.FirstParameter() > curve.LastParameter()) return false;
    const bounds = owner.keep(new oc.Bnd_Box_1());
    oc.BndLib_Add3dCurve.AddOptimal_1(curve, NATIVE_CURVE_PRECISION, bounds);
    if (bounds.IsVoid()) return false;
    const low = owner.keep(bounds.CornerMin()), high = owner.keep(bounds.CornerMax());
    return pointInside([low.X(), low.Y(), low.Z()], limits, tolerance)
      && pointInside([high.X(), high.Y(), high.Z()], limits, tolerance);
  } finally { owner.release(); }
}

interface TrimInterval {
  readonly curve: Handle_Geom2d_Curve;
  readonly first: number;
  readonly last: number;
  readonly depth: number;
  readonly bounds: Bnd_Box2d;
  children?: readonly [TrimInterval, TrimInterval];
}

/**
 * OCCT7.6.2 BndLib_Add2dCurve::Add(handle,range) uses segmented control-pole
 * hulls for Bezier/B-spline and analytic extrema for lines/conics. Its Other/
 * offset path samples33 points, so those types are deliberately not admitted.
 * BRepAdaptor_Curve2d exposes the exact face-specific pcurve and its edge range.
 */
function outsideTrimmedFace(oc: OpenCascadeInstance, face: TopoDS_Face,
  owner: Allocations): ((cell: SurfaceParameterCell) => boolean) | null {
  const { keep } = owner;
  const edges = keep(new oc.TopTools_IndexedMapOfShape_1());
  oc.TopExp.MapShapes_1(face, oc.TopAbs.ShapeTypeFromString_1('EDGE'), edges);
  if (edges.Size() < 1 || edges.Size() > MAX_TRIM_NODES) return null;
  const precision = oc.Precision.PConfusion_2();
  if (!Number.isFinite(precision) || precision <= 0) return null;
  let nodeCount = 0, checks = 0;
  const makeNode = (curve: Handle_Geom2d_Curve, first: number, last: number, depth: number): TrimInterval => {
    if (++nodeCount > MAX_TRIM_NODES) throw new Error('Trim bound node budget exceeded');
    const bounds = keep(new oc.Bnd_Box2d());
    oc.BndLib_Add2dCurve.Add_4(curve, first, last, precision, bounds);
    if (bounds.IsVoid() || bounds.IsWhole() || bounds.IsOpenXmin() || bounds.IsOpenXmax()
      || bounds.IsOpenYmin() || bounds.IsOpenYmax() || !Number.isFinite(bounds.SquareExtent())) {
      throw new Error('Unresolved complete trim-curve bounds');
    }
    return { curve, first, last, depth, bounds };
  };
  const roots: TrimInterval[] = [];
  for (let index = 1; index <= edges.Size(); index++) {
    const edge = keep(oc.TopoDS.Edge_1(keep(edges.FindKey(index))));
    const adaptor = keep(new oc.BRepAdaptor_Curve2d_2(edge, face));
    const type = adaptor.GetType(), types = oc.GeomAbs_CurveType;
    if (![types.GeomAbs_Line, types.GeomAbs_Circle, types.GeomAbs_Ellipse,
      types.GeomAbs_Parabola, types.GeomAbs_Hyperbola, types.GeomAbs_BezierCurve,
      types.GeomAbs_BSplineCurve].includes(type)) return null;
    const first = adaptor.FirstParameter(), last = adaptor.LastParameter();
    if (!Number.isFinite(first) || !Number.isFinite(last) || first > last) return null;
    const curve = keep(adaptor.Curve());
    if (curve.IsNull()) return null;
    roots.push(makeNode(curve, first, last, 0));
  }
  const separated = (node: TrimInterval, rectangle: Bnd_Box2d): boolean => {
    if (++checks > MAX_TRIM_CHECKS) throw new Error('Trim bound query budget exceeded');
    if (node.bounds.IsOut_4(rectangle)) return true;
    if (node.depth >= MAX_TRIM_DEPTH) return false;
    const middle = node.first / 2 + node.last / 2;
    if (!(middle > node.first && middle < node.last)) return false;
    // Both closed parameter intervals share the same representable endpoint;
    // their union remains the complete original curve interval.
    node.children ??= [makeNode(node.curve, node.first, middle, node.depth + 1),
      makeNode(node.curve, middle, node.last, node.depth + 1)];
    return separated(node.children[0], rectangle) && separated(node.children[1], rectangle);
  };
  return cell => {
    const temporary = createAllocations();
    try {
      const rectangle = temporary.keep(new oc.Bnd_Box2d());
      rectangle.Update_1(cell.u0, cell.v0, cell.u1, cell.v1);
      const guard = Math.max(precision, 32 * Number.EPSILON
        * Math.max(1, Math.abs(cell.u0), Math.abs(cell.u1), Math.abs(cell.v0), Math.abs(cell.v1)));
      rectangle.Enlarge(guard);
      if (!roots.every(node => separated(node, rectangle))) return false;
      // All trim curves are separated from this connected rectangle. Only now
      // may a representative classification establish the state of the whole cell.
      const point = temporary.keep(new oc.gp_Pnt2d_3(cell.u0 / 2 + cell.u1 / 2, cell.v0 / 2 + cell.v1 / 2));
      const classifier = temporary.keep(new oc.BRepClass_FaceClassifier_3(face, point, guard, false, guard));
      return classifier.State() === oc.TopAbs_State.TopAbs_OUT;
    } finally { temporary.release(); }
  };
}

function nativeCoefficients(oc: OpenCascadeInstance, face: TopoDS_Face,
  owner: Allocations): CubicSurfaceCoefficients | null {
  const adaptor = owner.keep(new oc.BRepAdaptor_Surface_2(face, true));
  if (adaptor.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_BSplineSurface) return null;
  // BRepAdaptor_Surface::BSpline returns the surface with its location applied.
  const handle = owner.keep(adaptor.BSpline());
  if (handle.IsNull()) return null;
  const surface = borrowHandle(handle);
  if (Number(surface.UDegree()) !== 3 || Number(surface.VDegree()) !== 3
    || surface.IsURational() || surface.IsVRational() || surface.IsUPeriodic() || surface.IsVPeriodic()
    || !surface.IsCNu(1) || !surface.IsCNv(1)) return null;
  const rows = Number(surface.NbUPoles()), columns = Number(surface.NbVPoles());
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(columns) || rows < 4 || columns < 4
    || rows * columns > MAX_POLES) return null;
  const readDirection = (count: number, knot: (index: number) => number,
    multiplicity: (index: number) => number): CubicKnotDirection => {
    if (!Number.isSafeInteger(count) || count < 2 || count > MAX_POLES) throw new Error('Invalid native knot count');
    return { knots: Array.from({ length: count }, (_, index) => knot(index + 1)),
      multiplicities: Array.from({ length: count }, (_, index) => multiplicity(index + 1)) };
  };
  const u = readDirection(Number(surface.NbUKnots()), index => surface.UKnot(index), index => Number(surface.UMultiplicity(index)));
  const v = readDirection(Number(surface.NbVKnots()), index => surface.VKnot(index), index => Number(surface.VMultiplicity(index)));
  const poles: Vec3Tuple[] = [];
  for (let row = 1; row <= rows; row++) {
    for (let column = 1; column <= columns; column++) {
      const point = surface.Pole(row, column);
      try { poles.push([point.X(), point.Y(), point.Z()]); } finally { point.delete(); }
    }
  }
  return { u, v, poles };
}

/**
 * Fallback only when the general whole-shape enclosure is inconclusive. Both
 * native 3D edges and the actual face-mapped pcurves must fit the unchanged XYZ
 * limits. Native curve bounds retain their numerical precision contract;
 * topology tolerances, empty Booleans and sampled faces never grant acceptance.
 */
export function certifyTrimmedCubicShapeBounds(oc: OpenCascadeInstance, shape: TopoDS_Shape,
  limits: CoordinateBox, tolerance: number): boolean {
  const owner = createAllocations(), { keep } = owner;
  try {
    if (!isValidShape(oc, shape)) return false;
    const parts = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, parts, true, true);
    let faceCount = 0;
    for (let index = 1; index <= parts.Size(); index++) {
      const item = keep(parts.FindKey(index));
      if (item.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_VERTEX) {
        const vertex = keep(oc.TopoDS.Vertex_1(item)), point = keep(oc.BRep_Tool.Pnt(vertex));
        if (!pointInside([point.X(), point.Y(), point.Z()], limits, tolerance)) return false;
      } else if (item.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_EDGE) {
        const edge = keep(oc.TopoDS.Edge_1(item));
        if (!oc.BRep_Tool.Degenerated(edge)
          && !curveInside(oc, keep(new oc.BRepAdaptor_Curve_2(edge)), limits, tolerance)) return false;
      } else if (item.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_FACE) {
        const faceOwner = createAllocations();
        try {
          const face = faceOwner.keep(oc.TopoDS.Face_1(item));
          const spec = nativeCoefficients(oc, face, faceOwner);
          if (spec === null) return false;
          const edges = faceOwner.keep(new oc.TopTools_IndexedMapOfShape_1());
          oc.TopExp.MapShapes_1(face, oc.TopAbs.ShapeTypeFromString_1('EDGE'), edges);
          if (edges.Size() < 1) return false;
          for (let edgeIndex = 1; edgeIndex <= edges.Size(); edgeIndex++) {
            const edge = faceOwner.keep(oc.TopoDS.Edge_1(faceOwner.keep(edges.FindKey(edgeIndex))));
            // A degenerate 3D edge still has a surface-domain boundary to check.
            const mapped = faceOwner.keep(new oc.BRepAdaptor_Curve_3(edge, face));
            if (!curveInside(oc, mapped, limits, tolerance)) return false;
          }
          const outside = outsideTrimmedFace(oc, face, faceOwner);
          if (outside === null || !certifyCubicSurfaceInterior(spec, limits, tolerance, outside).certified) return false;
          faceCount++;
        } finally { faceOwner.release(); }
      }
    }
    return faceCount > 0;
  } finally { owner.release(); }
}
