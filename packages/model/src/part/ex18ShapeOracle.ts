/**
 * Test-only EX-18 oracle. Never import this module from product code.
 * Measures the supplied B-rep afresh; no route, cached mesh or construction dimensions are inputs.
 * Exact bounds are certified for bounded planar/cylindrical faces with line/circle boundaries,
 * including degree-one, two-pole Bezier/BSpline representations proven to cover their full segment.
 * Other surfaces/curves remain explicitly unsupported, never silently approximated by a mesh.
 */
import { createAllocations, type Allocations } from '../../../kernel/src/occt/allocations.js';
import { isValidShape, measureVolume } from '../../../kernel/src/occt/solidMesh.js';

type Occt = Parameters<typeof measureVolume>[0];
type Shape = Parameters<typeof measureVolume>[1];
type Face = ReturnType<Occt['TopoDS']['Face_1']>;
type Edge = ReturnType<Occt['TopoDS']['Edge_1']>;
type Point = readonly [number, number, number];

/** Geometric identification tolerance, independent of the comparison tolerances. */
const GEOMETRY_MM = 1e-7;
const LINEAR_POLE_MATCH_MM = 1e-9;
const DIRECTION_TOLERANCE = 1e-10;
const TWO_PI = 2 * Math.PI;

export interface Ex18ThroughHole {
  /** Closest point on the infinite axis to the global origin. */
  readonly axisOrigin: Point;
  /** Unit direction with the largest component positive (axis sign is immaterial). */
  readonly direction: Point;
  readonly radius: number;
  readonly ends: readonly [Point, Point];
  readonly wallFaceIndices: readonly number[];
}

export interface Ex18ShapeMeasurement {
  readonly validity: {
    readonly valid: boolean;
    readonly brepValid: boolean;
    readonly solidCount: number;
    readonly shellCount: number;
    readonly closed: boolean;
    readonly onlySolidContent: boolean;
    readonly outward: boolean;
  };
  readonly volume: number;
  readonly volumeMethod: 'occt-gprop';
  readonly bounds: { readonly low: Point; readonly high: Point } | null;
  readonly boundsMethod: 'analytic-brep' | 'unsupported';
  /** No tessellation is used, so there is no mesh approximation error to hide. */
  readonly meshApproximation: null;
  readonly holes: readonly Ex18ThroughHole[];
  readonly throughHoleCount: number;
  readonly holesComplete: boolean;
  readonly limitations: readonly string[];
}

export interface Ex18ShapeExpectation {
  readonly volume: number;
  readonly low: Point;
  readonly high: Point;
  readonly holes: readonly {
    readonly axisOrigin: Point;
    readonly direction: Point;
    readonly radius: number;
  }[];
}

interface Circle {
  readonly origin: Point;
  readonly direction: Point;
  readonly radius: number;
  readonly sweep: number;
}

interface EdgeData {
  readonly shape: Edge;
  readonly points: readonly Point[];
  readonly circle: Circle | null;
  readonly supported: boolean;
  readonly faceIndices: number[];
}

interface Cylinder {
  readonly origin: Point;
  readonly direction: Point;
  readonly radius: number;
  readonly interior: boolean;
}

interface FaceData {
  readonly shape: Face;
  readonly edges: readonly number[];
  readonly kind: 'plane' | 'cylinder' | 'unsupported';
  readonly cylinder: Cylinder | null;
  readonly area: number;
}

function xyz(point: { X(): number; Y(): number; Z(): number }): Point {
  return [point.X(), point.Y(), point.Z()];
}

function dot(a: Point, b: Point): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function subtract(a: Point, b: Point): Point { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function along(origin: Point, direction: Point, distance: number): Point {
  return [origin[0] + distance * direction[0], origin[1] + distance * direction[1], origin[2] + distance * direction[2]];
}
function distance(a: Point, b: Point): number { return Math.hypot(...subtract(a, b)); }
function directionError(a: Point, b: Point): number {
  return Math.min(distance(a, b), distance(a, [-b[0], -b[1], -b[2]]));
}
function canonicalDirection(axis: Point): Point {
  const largest = axis.reduce((best, value, index) => Math.abs(value) > Math.abs(axis[best]) ? index : best, 0);
  const scale = (axis[largest] < 0 ? -1 : 1) / Math.hypot(...axis);
  return [axis[0] * scale, axis[1] * scale, axis[2] * scale];
}
function axisOrigin(point: Point, direction: Point): Point { return along(point, direction, -dot(point, direction)); }
function sameCylinder(left: Cylinder, right: Cylinder): boolean {
  return Math.abs(left.radius - right.radius) <= GEOMETRY_MM
    && directionError(left.direction, right.direction) <= DIRECTION_TOLERANCE
    && distance(left.origin, right.origin) <= GEOMETRY_MM;
}

/** Owned adaptor/geometry/point wrappers are deleted here. The borrowed edge itself is untouched. */
function readEdge(oc: Occt, shape: Edge): EdgeData {
  const { keep, release } = createAllocations();
  try {
    const curve = keep(new oc.BRepAdaptor_Curve_2(shape));
    const first = curve.FirstParameter(), last = curve.LastParameter();
    const points: Point[] = [xyz(keep(curve.Value(first))), xyz(keep(curve.Value(last)))];
    const kind = curve.GetType();
    if (kind === oc.GeomAbs_CurveType.GeomAbs_Line) return { shape, points, circle: null, supported: true, faceIndices: [] };
    const bezier = kind === oc.GeomAbs_CurveType.GeomAbs_BezierCurve;
    if (bezier || kind === oc.GeomAbs_CurveType.GeomAbs_BSplineCurve) {
      let supported = false;
      if (curve.Degree() === 1 && curve.NbPoles() === 2
        && (bezier || (!curve.IsPeriodic() && !curve.IsRational() && curve.NbKnots() === 2))) {
        // BRepAdaptor returns a handle to geometry with the edge location applied. Own the
        // handle and returned point copies, never its borrowed get() result (rules/06 10.13).
        const handle = bezier ? keep(curve.Bezier()) : keep(curve.BSpline());
        const geometry = handle.get();
        const startPole = xyz(keep(geometry.Pole(1))), endPole = xyz(keep(geometry.Pole(2)));
        // Use actual trim endpoints for measurement. Even a linear supporting curve is
        // uncertified here if the edge covers a different interval from its two poles.
        supported = distance(points[0], startPole) <= LINEAR_POLE_MATCH_MM
          && distance(points[1], endPole) <= LINEAR_POLE_MATCH_MM;
      }
      return { shape, points, circle: null, supported, faceIndices: [] };
    }
    if (kind !== oc.GeomAbs_CurveType.GeomAbs_Circle) return { shape, points, circle: null, supported: false, faceIndices: [] };
    const circle = keep(curve.Circle());
    const frame = keep(circle.Position());
    const x = xyz(keep(frame.XDirection())), y = xyz(keep(frame.YDirection()));
    const direction = canonicalDirection(xyz(keep(frame.Direction())));
    // p(t) = centre + r (x cos(t) + y sin(t)); each coordinate is stationary at atan2(y, x) + k*pi.
    // Only include extrema inside the actual trimmed arc, not the full supporting circle.
    for (let coordinate = 0; coordinate < 3; coordinate++) {
      for (const offset of [0, Math.PI]) {
        const base = Math.atan2(y[coordinate], x[coordinate]) + offset;
        const parameter = base + TWO_PI * Math.ceil((first - base) / TWO_PI);
        if (parameter >= first && parameter <= last) points.push(xyz(keep(curve.Value(parameter))));
      }
    }
    return { shape, points, supported: true, faceIndices: [], circle: {
      origin: xyz(keep(circle.Location())), direction, radius: circle.Radius(), sweep: last - first,
    } };
  } finally { release(); }
}

function readFace(oc: Occt, shape: Face, edges: readonly number[]): FaceData {
  const { keep, release } = createAllocations();
  try {
    const adaptor = keep(new oc.BRepAdaptor_Surface_2(shape, true));
    const type = adaptor.GetType();
    const properties = keep(new oc.GProp_GProps_1());
    oc.BRepGProp.SurfaceProperties_1(shape, properties, false, false);
    const area = properties.Mass();
    if (type === oc.GeomAbs_SurfaceType.GeomAbs_Plane) return { shape, edges, area, kind: 'plane', cylinder: null };
    if (type !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) return { shape, edges, area, kind: 'unsupported', cylinder: null };
    const cylinder = keep(adaptor.Cylinder()), axis = keep(cylinder.Axis());
    const direction = canonicalDirection(xyz(keep(axis.Direction())));
    const origin = axisOrigin(xyz(keep(cylinder.Location())), direction);
    const reversed = shape.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
    return { shape, edges, area, kind: 'cylinder', cylinder: {
      origin, direction, radius: cylinder.Radius(), interior: cylinder.Direct() === reversed,
    } };
  } finally { release(); }
}

/** Count solid occurrences, rejecting detached faces, edges and empty containers. */
function solidContent(oc: Occt, shape: Shape): { count: number; onlySolids: boolean } {
  const type = shape.ShapeType();
  if (type === oc.TopAbs_ShapeEnum.TopAbs_SOLID) return { count: 1, onlySolids: true };
  if (type !== oc.TopAbs_ShapeEnum.TopAbs_COMPOUND && type !== oc.TopAbs_ShapeEnum.TopAbs_COMPSOLID) {
    return { count: 0, onlySolids: false };
  }
  const iterator = new oc.TopoDS_Iterator_2(shape, true, true);
  let count = 0, onlySolids = true, children = 0;
  try {
    for (; iterator.More(); iterator.Next()) {
      const child = iterator.Value();
      try {
        const result = solidContent(oc, child);
        count += result.count; onlySolids = onlySolids && result.onlySolids; children++;
      } finally { child.delete(); }
    }
  } finally { iterator.delete(); }
  return { count, onlySolids: onlySolids && children > 0 };
}

/** A circular rim is open only when all adjacent end faces exclude its centre from their trimmed region. */
function openRim(oc: Occt, centre: Point, boundary: readonly number[], faces: readonly FaceData[],
  edges: readonly EdgeData[], walls: ReadonlySet<number>, direction: Point): boolean {
  const { keep, release } = createAllocations();
  try {
    const point = keep(new oc.gp_Pnt_3(...centre));
    for (const edgeIndex of boundary) {
      const outside = edges[edgeIndex].faceIndices.filter(index => !walls.has(index));
      if (outside.length !== 1) return false;
      const face = faces[outside[0]];
      if (face.kind !== 'plane') return false;
      const adaptor = keep(new oc.BRepAdaptor_Surface_2(face.shape, false));
      const plane = keep(adaptor.Plane()), planeAxis = keep(plane.Axis());
      if (directionError(xyz(keep(planeAxis.Direction())), direction) > DIRECTION_TOLERANCE) return false;
      const classifier = keep(new oc.BRepClass_FaceClassifier_4(face.shape, point, GEOMETRY_MM, false, GEOMETRY_MM));
      if (classifier.State() !== oc.TopAbs_State.TopAbs_OUT) return false;
    }
    return boundary.length > 0;
  } finally { release(); }
}

function throughHoles(oc: Occt, faces: readonly FaceData[], edges: readonly EdgeData[],
  limitations: string[]): Ex18ThroughHole[] {
  const unseen = new Set(faces.flatMap((face, index) => face.cylinder?.interior === true ? [index] : []));
  const holes: Ex18ThroughHole[] = [];
  for (const seed of unseen) {
    const cylinder = faces[seed].cylinder;
    if (cylinder === null) continue;
    const group = new Set([seed]), queue = [seed];
    unseen.delete(seed);
    for (let head = 0; head < queue.length; head++) {
      for (const edgeIndex of faces[queue[head]].edges) {
        for (const neighbour of edges[edgeIndex].faceIndices) {
          const other = faces[neighbour].cylinder;
          if (unseen.has(neighbour) && other !== null && sameCylinder(cylinder, other)) {
            unseen.delete(neighbour); group.add(neighbour); queue.push(neighbour);
          }
        }
      }
    }
    const groupEdges = new Set(queue.flatMap(index => [...faces[index].edges]));
    const boundary = [...groupEdges].filter(index => edges[index].faceIndices.some(face => !group.has(face))
      || (edges[index].faceIndices.length === 1 && !oc.BRep_Tool.IsClosed_2(edges[index].shape, faces[edges[index].faceIndices[0]].shape)));
    const distances = [...groupEdges].flatMap(index => edges[index].points.map(point => dot(subtract(point, cylinder.origin), cylinder.direction)));
    const low = Math.min(...distances), high = Math.max(...distances);
    if (!Number.isFinite(low) || !Number.isFinite(high) || high - low <= GEOMETRY_MM) continue;
    // A slot or partial cylindrical patch is not a full passage. Seams inside the group are not openings.
    const area = queue.reduce((sum, index) => sum + faces[index].area, 0);
    const fullArea = TWO_PI * cylinder.radius * (high - low);
    if (Math.abs(area - fullArea) > GEOMETRY_MM * Math.max(1, fullArea)) continue;
    const ends: [Point, Point] = [along(cylinder.origin, cylinder.direction, low), along(cylinder.origin, cylinder.direction, high)];
    const rims: [number[], number[]] = [[], []];
    let circularBoundary = boundary.length > 0;
    for (const index of boundary) {
      const circle = edges[index].circle;
      if (circle === null || Math.abs(circle.radius - cylinder.radius) > GEOMETRY_MM
        || directionError(circle.direction, cylinder.direction) > DIRECTION_TOLERANCE) { circularBoundary = false; break; }
      const end = distance(circle.origin, ends[0]) <= GEOMETRY_MM ? 0 : distance(circle.origin, ends[1]) <= GEOMETRY_MM ? 1 : -1;
      if (end === -1) { circularBoundary = false; break; }
      rims[end].push(index);
    }
    if (!circularBoundary) continue;
    const open = rims.every((rim, end) => {
      const sweep = rim.reduce((sum, index) => sum + (edges[index].circle?.sweep ?? 0), 0);
      return Math.abs(sweep - TWO_PI) * cylinder.radius <= GEOMETRY_MM
        && openRim(oc, ends[end], rim, faces, edges, group, cylinder.direction);
    });
    if (open) {
      // Two separate equal-radius sections of a stepped bore are not two independent passages.
      // EX-18 A/B have a straight bore spanning the body. Other open partial-span components are
      // explicitly uncertified until a more general void-connectivity oracle is supplied.
      const bodyDistances = edges.flatMap(edge => edge.points.map(point => dot(subtract(point, cylinder.origin), cylinder.direction)));
      if (Math.abs(low - Math.min(...bodyDistances)) > GEOMETRY_MM || Math.abs(high - Math.max(...bodyDistances)) > GEOMETRY_MM) {
        limitations.push('open cylindrical passage does not span the body: stepped/partial-span bore unsupported');
        continue;
      }
      holes.push({ axisOrigin: cylinder.origin, direction: cylinder.direction, radius: cylinder.radius,
        ends, wallFaceIndices: [...queue].sort((a, b) => a - b) });
    }
  }
  return holes;
}

function topology(oc: Occt, shape: Shape, owner: Allocations): {
  faces: FaceData[]; edges: EdgeData[]; vertices: Point[]; shells: Shape[]; solids: Shape[];
} {
  const { keep } = owner;
  const map = keep(new oc.TopTools_IndexedMapOfShape_1());
  oc.TopExp.MapShapes_2(shape, map, true, true);
  const nativeFaces: Face[] = [], edges: EdgeData[] = [], vertices: Point[] = [], shells: Shape[] = [], solids: Shape[] = [];
  const edgeIndices = new Map<number, number>();
  for (let index = 1; index <= map.Size(); index++) {
    const member = keep(map.FindKey(index)), kind = member.ShapeType();
    if (kind === oc.TopAbs_ShapeEnum.TopAbs_FACE) nativeFaces.push(keep(oc.TopoDS.Face_1(member)));
    if (kind === oc.TopAbs_ShapeEnum.TopAbs_EDGE) {
      edgeIndices.set(index, edges.length); edges.push(readEdge(oc, keep(oc.TopoDS.Edge_1(member))));
    }
    if (kind === oc.TopAbs_ShapeEnum.TopAbs_VERTEX) vertices.push(xyz(keep(oc.BRep_Tool.Pnt(keep(oc.TopoDS.Vertex_1(member))))));
    if (kind === oc.TopAbs_ShapeEnum.TopAbs_SHELL) shells.push(member);
    if (kind === oc.TopAbs_ShapeEnum.TopAbs_SOLID) solids.push(member);
  }
  const faces = nativeFaces.map((face, faceIndex) => {
    const own = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(face, own, true, true);
    const indices: number[] = [];
    for (let index = 1; index <= own.Size(); index++) {
      const member = keep(own.FindKey(index));
      if (member.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_EDGE) continue;
      const edgeIndex = edgeIndices.get(map.FindIndex(member));
      if (edgeIndex === undefined) throw new Error('EX-18: face edge missing from the shape topology');
      indices.push(edgeIndex); edges[edgeIndex].faceIndices.push(faceIndex);
    }
    return readFace(oc, face, indices);
  });
  return { faces, edges, vertices, shells, solids };
}

/** Borrow shape for the duration of this call. No builders, triangulation, mutation or deletion of shape. */
export function measureEx18Shape(oc: Occt, shape: Shape): Ex18ShapeMeasurement {
  if (shape.IsNull()) return {
    validity: { valid: false, brepValid: false, solidCount: 0, shellCount: 0, closed: false, onlySolidContent: false, outward: false },
    volume: NaN, volumeMethod: 'occt-gprop', bounds: null, boundsMethod: 'unsupported', meshApproximation: null,
    holes: [], throughHoleCount: 0, holesComplete: false, limitations: ['null-shape'],
  };
  const owner = createAllocations();
  try {
    const { faces, edges, vertices, shells, solids } = topology(oc, shape, owner);
    const content = solidContent(oc, shape), brepValid = isValidShape(oc, shape);
    const closed = shells.length > 0 && shells.every(shell => oc.BRep_Tool.IsClosed_1(shell));
    const outward = solids.length > 0 && solids.every(solid => {
      const classifier = owner.keep(new oc.BRepClass3d_SolidClassifier_2(solid));
      classifier.PerformInfinitePoint(GEOMETRY_MM);
      return classifier.State() === oc.TopAbs_State.TopAbs_OUT;
    });
    const valid = content.count === 1 && content.onlySolids && brepValid && closed && outward;
    const limitations: string[] = [];
    if (faces.some(face => face.kind === 'unsupported')) limitations.push('non-planar/non-cylindrical surface');
    if (edges.some(edge => !edge.supported)) limitations.push('non-linear/non-circular boundary');
    const points = [...vertices, ...edges.flatMap(edge => [...edge.points])];
    if (points.length === 0 || points.some(point => point.some(value => !Number.isFinite(value)))) limitations.push('missing/non-finite boundary');
    const low: [number, number, number] = [Infinity, Infinity, Infinity], high: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const point of points) for (let axis = 0; axis < 3; axis++) {
      low[axis] = Math.min(low[axis], point[axis]); high[axis] = Math.max(high[axis], point[axis]);
    }
    const supported = limitations.length === 0;
    const holes = valid && supported ? throughHoles(oc, faces, edges, limitations) : [];
    return {
      validity: { valid, brepValid, solidCount: content.count, shellCount: shells.length, closed, onlySolidContent: content.onlySolids, outward },
      volume: measureVolume(oc, shape), volumeMethod: 'occt-gprop',
      bounds: supported ? { low, high } : null, boundsMethod: supported ? 'analytic-brep' : 'unsupported', meshApproximation: null,
      holes, throughHoleCount: holes.length, holesComplete: valid && limitations.length === 0, limitations,
    };
  } finally { owner.release(); }
}

export interface Ex18ShapeComparison {
  readonly matches: boolean;
  readonly failures: readonly string[];
  readonly volumeRelativeError: number;
  readonly boundsMaximumErrorMm: number;
  readonly holeAxisMaximumErrorMm: number;
  readonly holeRadiusMaximumErrorMm: number;
  readonly holeDirectionMaximumError: number;
}

/** Independent comparison, with a one-to-one match of hole axes; expected values never feed construction. */
export function compareEx18Shape(actual: Ex18ShapeMeasurement, expected: Ex18ShapeExpectation): Ex18ShapeComparison {
  const failures: string[] = [];
  const volumeRelativeError = Math.abs(actual.volume - expected.volume) / Math.abs(expected.volume);
  const boundsMaximumErrorMm = actual.bounds === null ? Infinity : Math.max(
    ...actual.bounds.low.map((value, axis) => Math.abs(value - expected.low[axis])),
    ...actual.bounds.high.map((value, axis) => Math.abs(value - expected.high[axis])),
  );
  if (!actual.validity.valid) failures.push('validity');
  if (!(volumeRelativeError <= 1e-9)) failures.push('volume');
  if (actual.boundsMethod !== 'analytic-brep' || !(boundsMaximumErrorMm <= 1e-6)) failures.push('bounds');
  if (!actual.holesComplete) failures.push('holes-unsupported');
  if (actual.throughHoleCount !== expected.holes.length) failures.push('hole-count');
  const available = new Set(actual.holes.map((_, index) => index));
  let holeAxisMaximumErrorMm = 0, holeRadiusMaximumErrorMm = 0, holeDirectionMaximumError = 0;
  for (const hole of expected.holes) {
    const direction = canonicalDirection(hole.direction), origin = axisOrigin(hole.axisOrigin, direction);
    const index = [...available].sort((a, b) => distance(actual.holes[a].axisOrigin, origin) - distance(actual.holes[b].axisOrigin, origin))[0];
    if (index === undefined) { holeAxisMaximumErrorMm = Infinity; holeRadiusMaximumErrorMm = Infinity; holeDirectionMaximumError = Infinity; continue; }
    available.delete(index);
    const measured = actual.holes[index];
    // Check the finite passage too: a tiny angular error can exceed 1e-6 mm at its far end.
    holeAxisMaximumErrorMm = Math.max(holeAxisMaximumErrorMm, distance(measured.axisOrigin, origin),
      ...measured.ends.map(point => distance(point, along(origin, direction, dot(subtract(point, origin), direction)))));
    holeRadiusMaximumErrorMm = Math.max(holeRadiusMaximumErrorMm, Math.abs(measured.radius - hole.radius));
    holeDirectionMaximumError = Math.max(holeDirectionMaximumError, directionError(measured.direction, direction));
  }
  if (!(holeAxisMaximumErrorMm <= 1e-6)) failures.push('hole-axis');
  if (!(holeRadiusMaximumErrorMm <= 1e-6)) failures.push('hole-radius');
  if (!(holeDirectionMaximumError <= 1e-6)) failures.push('hole-direction');
  return { matches: failures.length === 0, failures, volumeRelativeError, boundsMaximumErrorMm,
    holeAxisMaximumErrorMm, holeRadiusMaximumErrorMm, holeDirectionMaximumError };
}
