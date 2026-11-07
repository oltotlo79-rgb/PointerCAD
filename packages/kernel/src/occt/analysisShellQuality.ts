import type { BRepAdaptor_Curve, OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import type { AnalysisSurfaceMesh, AnalysisSurfaceMeshOptions } from './analysisSurfaceMesh.js';
import { createAllocations } from './allocations.js';
import { mapShape } from './subShapeOrigins.js';
import { GEOMETRIC_CONFUSION_MM } from './tolerances.js';

export interface CylindricalShellQuality {
  readonly kind: 'cylindrical-rectangle';
  readonly maximumNodes: number;
  readonly maximumTriangles: number;
  readonly minimumTriangleAreaMm2: number;
  readonly minimumAngleDeg: number;
  readonly maximumAspectRatio: number;
}
export interface CylindricalShellEvidence {
  readonly schema: 'pointercad-cylindrical-shell-quality/1';
  readonly circumferentialSegments: number;
  readonly axialSegments: number;
  readonly maximumNodeResidualMm: number;
  readonly maximumChordDeviationMm: number;
  readonly maximumNormalDeviationRad: number;
}
type Point = readonly [number, number, number];
type UV = readonly [number, number];
type Side = 'u0' | 'u1' | 'v0' | 'v1';
interface Edge {
  readonly index: number;
  readonly side: Side;
  readonly first: number;
  readonly last: number;
  readonly increasing: boolean;
  readonly curve: BRepAdaptor_Curve;
}
export class CylindricalShellRefusal extends Error {
  constructor(message: string, readonly code: 'unsupported-shell-quality' | 'limit' = 'unsupported-shell-quality') {
    super(`円筒シェルの品質分割: ${message}`);
  }
}
function fail(message: string): never { throw new CylindricalShellRefusal(message); }
const distance = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const difference = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Point, b: Point): Point => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Point, b: Point): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Public request data is closed and bounded; unsupported geometry is never silently downgraded. */
export function validCylindricalShellQuality(value: unknown): value is CylindricalShellQuality {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Reflect.ownKeys(value).map(String).sort().join(',') !== 'kind,maximumAspectRatio,maximumNodes,maximumTriangles,minimumAngleDeg,minimumTriangleAreaMm2'
    || !('kind' in value) || value.kind !== 'cylindrical-rectangle'
    || !('maximumNodes' in value) || typeof value.maximumNodes !== 'number'
    || !('maximumTriangles' in value) || typeof value.maximumTriangles !== 'number'
    || !('minimumTriangleAreaMm2' in value) || typeof value.minimumTriangleAreaMm2 !== 'number'
    || !('minimumAngleDeg' in value) || typeof value.minimumAngleDeg !== 'number'
    || !('maximumAspectRatio' in value) || typeof value.maximumAspectRatio !== 'number') return false;
  return Number.isSafeInteger(value.maximumNodes) && value.maximumNodes >= 4
    && Number.isSafeInteger(value.maximumTriangles) && value.maximumTriangles >= 2
    && Number.isFinite(value.minimumTriangleAreaMm2) && value.minimumTriangleAreaMm2 >= 0
    && Number.isFinite(value.minimumAngleDeg) && value.minimumAngleDeg >= 0 && value.minimumAngleDeg <= 60
    && Number.isFinite(value.maximumAspectRatio) && value.maximumAspectRatio >= 1;
}

function checkedTriangleNormal(ids: number[], xyz: (id: number) => Point, quality: CylindricalShellQuality): Point {
  const normal = cross(difference(xyz(ids[1]), xyz(ids[0])), difference(xyz(ids[2]), xyz(ids[0])));
  // The analytic count estimate is not a substitute for checking the actual 3D elements.
  const twiceArea = Math.hypot(...normal);
  let longest = 0, minimumAngle = 180;
  for (let side = 0; side < 3; side++) {
    const a = xyz(ids[side]), b = xyz(ids[(side + 1) % 3]), c = xyz(ids[(side + 2) % 3]);
    const ab = difference(b, a), ac = difference(c, a);
    longest = Math.max(longest, Math.hypot(...ab));
    minimumAngle = Math.min(minimumAngle, Math.atan2(twiceArea, dot(ab, ac)) * 180 / Math.PI);
  }
  const aspect = longest * longest / twiceArea;
  if (![twiceArea, minimumAngle, aspect].every(Number.isFinite)
    || !(twiceArea / 2 > quality.minimumTriangleAreaMm2)
    || minimumAngle < quality.minimumAngleDeg || aspect > quality.maximumAspectRatio) fail('生成した3D要素が要求品質を満たしません。');
  return normal;
}

function cylinderProjection(point: Point, origin: Point, axis: Point, radius: number): Point {
  const delta = difference(point, origin), h = dot(delta, axis);
  const radial: Point = [delta[0] - h * axis[0], delta[1] - h * axis[1], delta[2] - h * axis[2]];
  const length = Math.hypot(...radial);
  if (!(length > 0) || !Number.isFinite(length)) fail('native円筒への節点残差を確定できません。');
  return [origin[0] + h * axis[0] + radial[0] * radius / length,
    origin[1] + h * axis[1] + radial[1] * radius / length,
    origin[2] + h * axis[2] + radial[2] * radius / length];
}

function shellBoundaryEdges(sides: Map<Side, Edge>, nu: number, nv: number,
  node: (i: number, j: number) => number, checkpoint: () => void) {
  return [...sides.values()].map(edge => {
      const ids = edge.side === 'u0' || edge.side === 'u1'
        ? Array.from({ length: nv + 1 }, (_, j) => { checkpoint(); return node(edge.side === 'u0' ? 0 : nu, j); })
        : Array.from({ length: nu + 1 }, (_, i) => { checkpoint(); return node(i, edge.side === 'v0' ? 0 : nv); });
      return { index: edge.index, degenerated: false, uses: 1, nodes: edge.increasing ? ids : ids.reverse() };
  }).sort((a, b) => a.index - b.index);
}

/** A chart mesh of a real native face, not an independent benchmark grid or a geometric certificate. */
export function buildCylindricalShellQuality(oc: OpenCascadeInstance, shape: TopoDS_Shape,
  base: AnalysisSurfaceMesh, options: AnalysisSurfaceMeshOptions, quality: CylindricalShellQuality,
  checkpoint: () => void): Pick<AnalysisSurfaceMesh, 'coordinates' | 'nodeKinds' | 'triangles' | 'triangleFaces'
    | 'nodeCount' | 'triangleCount' | 'faces' | 'edges'> & { readonly shellQuality: CylindricalShellEvidence } {
  checkpoint();
  const owned = createAllocations();
  try {
    if (!validCylindricalShellQuality(quality) || options.boundary !== 'open') fail('開いた面の明示的な品質条件が必要です。');
    if (quality.minimumAngleDeg > 45 || quality.maximumAspectRatio < 2) fail('長方形セルの直角三角形で要求品質を満たせません。');
    const original = mapShape(oc, shape, owned);
    if (original.face.Size() !== 1 || original.edge.Size() !== 4 || original.vertex.Size() !== 4) fail('単一円筒面の4辺だけに対応しています。');
    const copier = owned.keep(new oc.BRepBuilderAPI_Copy_2(shape, false, false));
    if (!copier.IsDone()) fail('解析用の形を複製できません。');
    const copy = owned.keep(copier.Shape()), maps = mapShape(oc, copy, owned);
    const valid = owned.keep(new oc.BRepCheck_Analyzer(copy, true, false));
    if (!valid.IsValid_2() || maps.face.Size() !== 1 || maps.edge.Size() !== 4 || maps.vertex.Size() !== 4) fail('有効な4辺の円筒面ではありません。');
    // Same shipped MapShapes binding as mapShape; a local complete map includes wires as well.
    const all = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(copy, all, true, true);
    let wireCount = 0;
    for (let index = 1; index <= all.Size(); index++) {
      checkpoint();
      if (owned.keep(all.FindKey(index)).ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_WIRE) wireCount++;
    }
    if (wireCount !== 1) fail('穴や複数の輪郭には対応していません。');
    const faceImage = owned.keep(copier.ModifiedShape(owned.keep(original.face.FindKey(1))));
    if (maps.face.FindIndex(faceImage) !== 1) fail('元の面と複製の対応がありません。');
    const copiedVertices = new Set<number>();
    for (let index = 1; index <= original.vertex.Size(); index++) {
      checkpoint();
      const image = owned.keep(copier.ModifiedShape(owned.keep(original.vertex.FindKey(index))));
      const current = maps.vertex.FindIndex(image);
      if (current < 1 || copiedVertices.has(current)) fail('元の頂点と複製の対応がありません。');
      copiedVertices.add(current);
    }
    const face = owned.keep(oc.TopoDS.Face_1(faceImage));
    const orientation = face.Orientation_1();
    const reversed = orientation === oc.TopAbs_Orientation.TopAbs_REVERSED;
    if (!reversed && orientation !== oc.TopAbs_Orientation.TopAbs_FORWARD) fail('面の向きを確定できません。');
    const surface = owned.keep(new oc.BRepAdaptor_Surface_2(face, true));
    if (surface.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) fail('解析的な円筒面だけに対応しています。');
    const cylinder = owned.keep(surface.Cylinder()), radius = cylinder.Radius();
    const nativeAxis = owned.keep(cylinder.Axis()), nativeDirection = owned.keep(nativeAxis.Direction());
    const nativeOrigin = owned.keep(cylinder.Location());
    const axisLength = Math.hypot(nativeDirection.X(), nativeDirection.Y(), nativeDirection.Z());
    const axis: Point = [nativeDirection.X() / axisLength, nativeDirection.Y() / axisLength, nativeDirection.Z() / axisLength];
    const origin: Point = [nativeOrigin.X(), nativeOrigin.Y(), nativeOrigin.Z()];
    if (![...axis, ...origin].every(Number.isFinite) || !(axisLength > 0)) fail('native円筒の軸と姿勢を確定できません。');
    const u0 = surface.FirstUParameter(), u1 = surface.LastUParameter(), v0 = surface.FirstVParameter(), v1 = surface.LastVParameter();
    if (![radius, u0, u1, v0, v1].every(Number.isFinite) || !(radius > 0) || !(u1 > u0)
      || !(v1 > v0) || !(u1 - u0 < 2 * Math.PI)) fail('有限の1周未満の円筒区間が必要です。');
    const readSurface = (u: number, v: number): Point => {
      const p = surface.Value(u, v);
      try { return [p.X(), p.Y(), p.Z()]; } finally { p.delete(); }
    };
    // V is a native parameter, not necessarily millimetres when Location carries scale.
    const vSpan = v1 - v0, height = distance(readSurface(u0, v0), readSurface(u0, v1));
    const vScale = height / vSpan;
    if (!Number.isFinite(height) || !(height > 0) || !Number.isFinite(vScale) || !(vScale > 0)) fail('軸方向の実長を確定できません。');
    const uvNear = (a: UV, b: UV): boolean => Math.hypot(radius * (a[0] - b[0]), vScale * (a[1] - b[1])) <= GEOMETRIC_CONFUSION_MM;
    const corners: readonly UV[] = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    const sideCorners: Readonly<Record<Side, readonly [number, number]>> = { v0: [0, 1], u1: [1, 2], v1: [3, 2], u0: [0, 3] };
    const cornerVertices = new Map<number, number>();
    const cornerPoints = new Map<number, Point>();
    const sides = new Map<Side, Edge>();
    const readEdge = (edge: Edge, t: number): Point => {
      const p = edge.curve.Value(t);
      try { return [p.X(), p.Y(), p.Z()]; } finally { p.delete(); }
    };
    for (let index = 0; index < 4; index++) {
      checkpoint();
      const image = owned.keep(copier.ModifiedShape(owned.keep(original.edge.FindKey(index + 1))));
      if (maps.edge.FindIndex(image) < 1) fail('元の辺と複製の対応がありません。');
      const edge = owned.keep(oc.TopoDS.Edge_1(image));
      if (oc.BRep_Tool.Degenerated(edge) || oc.BRep_Tool.IsClosed_2(edge, face)
        || !oc.BRep_Tool.SameParameter(edge) || !oc.BRep_Tool.SameRange(edge)) fail('シーム・退化辺・未確定パラメータには対応していません。');
      const pcurve = owned.keep(new oc.BRepAdaptor_Curve2d_2(edge, face));
      if (pcurve.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line) fail('4本の等パラメータ境界が必要です。');
      const first = pcurve.FirstParameter(), last = pcurve.LastParameter();
      if (!Number.isFinite(first) || !Number.isFinite(last) || !(last > first)) fail('辺の区間が不正です。');
      const p0 = owned.keep(pcurve.Value(first)), p1 = owned.keep(pcurve.Value(last));
      const start: UV = [p0.X(), p0.Y()], end: UV = [p1.X(), p1.Y()];
      const matches: { side: Side; increasing: boolean; a: number; b: number }[] = [];
      for (const side of ['u0', 'u1', 'v0', 'v1'] as const) {
        const [a, b] = sideCorners[side];
        if (uvNear(start, corners[a]) && uvNear(end, corners[b])) matches.push({ side, increasing: true, a, b });
        if (uvNear(start, corners[b]) && uvNear(end, corners[a])) matches.push({ side, increasing: false, a: b, b: a });
      }
      if (matches.length !== 1 || sides.has(matches[0].side)) fail('円筒面を長方形に展開できません。');
      const match = matches[0], curve = owned.keep(new oc.BRepAdaptor_Curve_2(edge));
      const expectedType = match.side === 'u0' || match.side === 'u1' ? oc.GeomAbs_CurveType.GeomAbs_Line : oc.GeomAbs_CurveType.GeomAbs_Circle;
      if (curve.GetType() !== expectedType) fail('母線2本と円弧2本の境界が必要です。');
      const descriptor: Edge = { index, side: match.side, increasing: match.increasing, first, last, curve };
      const nativeVertices = [owned.keep(oc.TopExp.FirstVertex(edge, false)), owned.keep(oc.TopExp.LastVertex(edge, false))];
      for (const [endpoint, corner] of [[0, match.a], [1, match.b]] as const) {
        const address = maps.vertex.FindIndex(nativeVertices[endpoint]);
        if (address < 1 || (cornerVertices.has(corner) && cornerVertices.get(corner) !== address)) fail('境界の共有頂点が一致しません。');
        cornerVertices.set(corner, address);
        const nativePoint = owned.keep(oc.BRep_Tool.Pnt(nativeVertices[endpoint]));
        const expected = readSurface(...corners[corner]), actual: Point = [nativePoint.X(), nativePoint.Y(), nativePoint.Z()];
        if (distance(actual, expected) > GEOMETRIC_CONFUSION_MM
          || distance(readEdge(descriptor, endpoint === 0 ? first : last), actual) > GEOMETRIC_CONFUSION_MM) fail('辺と面の端点が一致しません。');
        cornerPoints.set(corner, actual);
      }
      sides.set(match.side, descriptor);
    }
    if (cornerVertices.size !== 4 || new Set(cornerVertices.values()).size !== 4 || sides.size !== 4) fail('4隅の入射が一致しません。');
    const span = u1 - u0;
    const maximumStep = Math.min(options.angularDeflection,
      2 * Math.acos(Math.max(-1, 1 - options.linearDeflection / radius)));
    if (!(maximumStep > 0) || !Number.isFinite(maximumStep)) fail('要求偏差を満たす分割幅がありません。');
    const nativeSegments = [...sides.values()].filter(edge => edge.side === 'v0' || edge.side === 'v1').map(edge => {
      const chain = base.edges.find(chain => chain.index === edge.index);
      if (chain === undefined || chain.degenerated || chain.uses !== 1 || chain.nodes.length < 2) fail('元のnative円弧分割がありません。');
      return chain.nodes.length - 1;
    });
    let nu = Math.max(...nativeSegments, Math.ceil(span / maximumStep), Math.ceil(radius * span / height), 1);
    let nv = 0;
    for (;;) {
      checkpoint();
      const chord = 2 * radius * Math.sin(span / (2 * nu));
      nv = Math.max(1, Math.ceil(height / chord));
      const nodes = (nu + 1) * (nv + 1), triangles = 2 * nu * nv;
      if (!Number.isSafeInteger(nodes) || !Number.isSafeInteger(triangles)
        || nodes > quality.maximumNodes || triangles > quality.maximumTriangles || triangles > options.maximumTriangles) throw new CylindricalShellRefusal('要求された節点・三角形上限を超えます。', 'limit');
      const axial = height / nv, area = chord * axial / 2;
      if (!(area > quality.minimumTriangleAreaMm2)) fail('最小面積と要求偏差を同時に満たせません。');
      const angle = Math.atan(Math.min(chord, axial) / Math.max(chord, axial)) * 180 / Math.PI;
      const aspect = chord / axial + axial / chord;
      if (angle >= quality.minimumAngleDeg && aspect <= quality.maximumAspectRatio) break;
      nu++;
    }
    const nodeCount = (nu + 1) * (nv + 1), triangleCount = 2 * nu * nv;
    const coordinates = new Float64Array(3 * nodeCount), nodeKinds = new Uint8Array(nodeCount);
    const triangles = new Uint32Array(3 * triangleCount), triangleFaces = new Uint32Array(triangleCount);
    const node = (i: number, j: number): number => j * (nu + 1) + i;
    let maximumNodeResidualMm = 0;
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      checkpoint();
      const u = u0 + span * i / nu, v = v0 + vSpan * j / nv, onU = i === 0 || i === nu, onV = j === 0 || j === nv;
      const expected = readSurface(u, v);
      const side: Side | undefined = onU ? (i === 0 ? 'u0' : 'u1') : onV ? (j === 0 ? 'v0' : 'v1') : undefined;
      let actual = expected;
      if (side !== undefined) {
        const edge = sides.get(side);
        if (edge === undefined) fail('境界の節点列がありません。');
        const fraction = onU ? j / nv : i / nu;
        const f = edge.increasing ? fraction : 1 - fraction;
        actual = readEdge(edge, edge.first + (edge.last - edge.first) * f);
      }
      if (onU && onV) {
        const corner = j === 0 ? (i === 0 ? 0 : 1) : (i === 0 ? 3 : 2);
        const vertexPoint = cornerPoints.get(corner);
        if (vertexPoint === undefined) fail('native頂点がありません。');
        actual = vertexPoint;
      }
      const residual = Math.max(distance(actual, expected), distance(actual, cylinderProjection(actual, origin, axis, radius)));
      maximumNodeResidualMm = Math.max(maximumNodeResidualMm, residual);
      if (residual > GEOMETRIC_CONFUSION_MM) fail('native面からの節点残差を満たせません。');
      if (!actual.every(Number.isFinite)) fail('節点が有限ではありません。');
      coordinates.set(actual, 3 * node(i, j));
      nodeKinds[node(i, j)] = onU && onV ? 0 : onU || onV ? 1 : 2;
    }
    let offset = 0, maximumNormalDeviationRad = 0;
    const xyz = (id: number): Point => [coordinates[3 * id], coordinates[3 * id + 1], coordinates[3 * id + 2]];
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      checkpoint();
      for (const ids of [[node(i, j), node(i + 1, j), node(i + 1, j + 1)], [node(i, j), node(i + 1, j + 1), node(i, j + 1)]]) {
        if (reversed) [ids[1], ids[2]] = [ids[2], ids[1]];
        triangles.set(ids, offset); offset += 3;
        const normal = checkedTriangleNormal(ids, xyz, quality);
        const u = u0 + span * (i + 0.5) / nu, v = v0 + vSpan * (j + 0.5) / nv;
        const p = new oc.gp_Pnt_1(), du = new oc.gp_Vec_1(), dv = new oc.gp_Vec_1();
        try {
          surface.D1(u, v, p, du, dv);
          const native = cross([du.X(), du.Y(), du.Z()], [dv.X(), dv.Y(), dv.Z()]);
          const signed: Point = reversed ? [-native[0], -native[1], -native[2]] : native;
          if (!(dot(normal, signed) > 0)) fail('三角形の向きがnative面の法線と一致しません。');
          const angle = Math.atan2(Math.hypot(...cross(normal, signed)), dot(normal, signed));
          const normalBound = angle + span / (2 * nu);
          maximumNormalDeviationRad = Math.max(maximumNormalDeviationRad, normalBound);
          if (normalBound > options.angularDeflection) fail('法線の偏差を満たせません。');
        } finally { p.delete(); du.delete(); dv.delete(); }
      }
    }
    const maximumChordDeviationMm = radius * (1 - Math.cos(span / (2 * nu))) + maximumNodeResidualMm;
    if (maximumChordDeviationMm > options.linearDeflection) fail('弦の偏差を満たせません。');
    const edges = shellBoundaryEdges(sides, nu, nv, node, checkpoint);
    return { coordinates, nodeKinds, triangles, triangleFaces, nodeCount, triangleCount, edges,
      faces: [{ index: 0, triangleCount, reversed, seamEdges: 0, degeneratedEdges: 0, collapsedPoleTriangles: 0 }],
      shellQuality: { schema: 'pointercad-cylindrical-shell-quality/1', circumferentialSegments: nu, axialSegments: nv,
        maximumNodeResidualMm, maximumChordDeviationMm, maximumNormalDeviationRad } };
  } finally { owned.release(); }
}
