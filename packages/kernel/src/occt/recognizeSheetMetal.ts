/** Read an open tree of constant-thickness panels from the trimmed, oriented B-rep. */
import type { OpenCascadeInstance, TopoDS_Face, TopoDS_Shape, TopoDS_Wire } from 'opencascade.js/dist/opencascade.full.js';
import type { SegmentSpec, SheetMetalRecognition, SheetMetalRecognitionReason, SheetMetalRecognizedBend,
  SheetMetalRecognizedPanel, SheetMetalRecognizedRim, SolidEdgeInfo, SolidFaceInfo, Vec3Tuple } from '../types.js';
import { createAllocations, type Allocations } from './allocations.js';
import { countSheetMetalSolids } from './sheetMetalJoin.js';
import { addVec, crossVec, dotVec, lengthVec, scaleVec, subVec } from './sketchCorner.js';
import { isValidShape } from './solidMesh.js';
import { collectSubShapes } from './subShapes.js';
import { APPROXIMATION_TOLERANCE_MM, exceedsMagnitude, GEOMETRIC_CONFUSION_MM } from './tolerances.js';

/** The shape itself never yields `sourceChanged`; that is the Worker's fingerprint lookup. */
type Reason = Exclude<SheetMetalRecognitionReason, 'sourceChanged'>;
type Rim = SheetMetalRecognizedRim;
type Panel = SheetMetalRecognizedPanel;
type Bend = SheetMetalRecognizedBend;
type Result = SheetMetalRecognition;
interface Occurrence { edge: SolidEdgeInfo; reversed: boolean }
type Face = SolidFaceInfo & { outer: Occurrence[]; holes: Occurrence[][] };
type Plane = Face & { axis: Vec3Tuple };
type Skin = Face & { axis: Vec3Tuple; axisOrigin: Vec3Tuple; radius: number; cylinderExterior: boolean };
interface Pair { front: Plane; back: Plane }
interface Topology { faces: Face[]; owners: Map<number, Face[]> }
const DIRECTION_TOLERANCE = 1e-12;

class Refusal extends Error {
  constructor(readonly reason: Reason) { super(reason); }
}
function refuse(reason: Reason): never { throw new Refusal(reason); }
function nearLength(delta: number): boolean {
  return Number.isFinite(delta) && !exceedsMagnitude(delta, APPROXIMATION_TOLERANCE_MM);
}
function nearAngle(delta: number): boolean {
  return Number.isFinite(delta) && !exceedsMagnitude(delta, DIRECTION_TOLERANCE);
}
function positiveLength(value: number): boolean {
  return Number.isFinite(value) && value > 0 && exceedsMagnitude(value, GEOMETRIC_CONFUSION_MM);
}
function samePoint(a: Vec3Tuple, b: Vec3Tuple): boolean { return nearLength(lengthVec(subVec(a, b))); }
function parallel(a: Vec3Tuple, b: Vec3Tuple): boolean { return nearAngle(lengthVec(crossVec(a, b))); }
function unit(axis: Vec3Tuple | null | undefined): axis is Vec3Tuple {
  return !!axis && nearAngle(lengthVec(axis) - 1);
}
function plane(face: Face): face is Plane {
  return face.surfaceKind === 'plane' && unit(face.axis);
}
function cylinder(face: Face): Skin {
  if (face.surfaceKind !== 'cylinder' || !unit(face.axis) || !face.axisOrigin?.every(Number.isFinite)
    || face.radius == null || !positiveLength(face.radius) || face.cylinderExterior === undefined) refuse('unsupportedBend');
  return { ...face, axis: face.axis, axisOrigin: face.axisOrigin, radius: face.radius, cylinderExterior: face.cylinderExterior };
}
function axisOffset(p: Vec3Tuple, origin: Vec3Tuple, axis: Vec3Tuple): Vec3Tuple {
  const delta = subVec(p, origin);
  return subVec(delta, scaleVec(axis, dotVec(delta, axis)));
}
function edgesOf(face: Face): Occurrence[] { return face.outer.concat(...face.holes); }
function neighbor(top: Topology, face: Face, edge: SolidEdgeInfo): Face {
  const owners = top.owners.get(edge.index);
  if (owners?.length !== 2) refuse('unsupportedBoundary');
  if (owners[0].index === face.index) return owners[1];
  if (owners[1].index === face.index) return owners[0];
  return refuse('unsupportedBoundary');
}

// Read the native face and edge numbering once. Recognition has no display triangles or segments.
function indexShape(oc: OpenCascadeInstance, shape: TopoDS_Shape, owned: Allocations) {
  const { keep } = owned, kinds = oc.TopAbs_ShapeEnum;
  let solid = shape;
  while (solid.ShapeType() === kinds.TopAbs_COMPOUND || solid.ShapeType() === kinds.TopAbs_COMPSOLID) {
    const children = keep(new oc.TopoDS_Iterator_2(solid, true, true));
    if (!children.More()) refuse('invalidSource');
    solid = keep(children.Value());
    children.Next();
    if (children.More()) refuse('invalidSource');
  }
  if (solid.ShapeType() !== kinds.TopAbs_SOLID) refuse('invalidSource');
  const map = keep(new oc.TopTools_IndexedMapOfShape_1());
  oc.TopExp.MapShapes_2(shape, map, true, true);
  const faces: TopoDS_Face[] = [], edges = new Map<number, number>();
  for (let i = 1; i <= map.Size(); i++) {
    const item = keep(map.FindKey(i)), kind = item.ShapeType();
    if (kind === kinds.TopAbs_FACE) {
      const face = keep(oc.TopoDS.Face_1(item));
      if (!oc.BRep_Tool.IsGeometric_1(face)) refuse('invalidSource');
      faces.push(face);
    }
    if (kind === kinds.TopAbs_EDGE) edges.set(i, edges.size);
    if (kind === kinds.TopAbs_SHELL && !oc.BRep_Tool.IsClosed_1(item)) refuse('invalidSource');
  }
  if (!faces.length) refuse('invalidSource');
  return { faces, edgeIndex: (edge: TopoDS_Shape) => edges.get(map.FindIndex(edge)), edgeCount: edges.size };
}

function orderedWire(oc: OpenCascadeInstance, wire: TopoDS_Wire, face: TopoDS_Face,
  edgeInfo: (shape: TopoDS_Shape) => SolidEdgeInfo, owned: Allocations): Occurrence[] {
  const { keep } = owned;
  const children = keep(new oc.TopoDS_Iterator_2(wire, true, true));
  let count = 0;
  while (children.More()) { count++; children.Next(); }
  const walk = keep(new oc.BRepTools_WireExplorer_3(wire, face)), result: Occurrence[] = [];
  while (walk.More()) {
    const edge = keep(walk.Current()), sense = edge.Orientation_1();
    const reversed = sense === oc.TopAbs_Orientation.TopAbs_REVERSED;
    if (!reversed && sense !== oc.TopAbs_Orientation.TopAbs_FORWARD) refuse('unsupportedBoundary');
    result.push({ edge: edgeInfo(edge), reversed });
    walk.Next();
  }
  if (!oc.BRep_Tool.IsClosed_1(wire) || !count || result.length !== count) refuse('unsupportedBoundary');
  for (const [i, item] of result.entries()) {
    const next = result[(i + 1) % count];
    if (!samePoint(item.reversed ? item.edge.start : item.edge.end, next.reversed ? next.edge.end : next.edge.start)) refuse('unsupportedBoundary');
  }
  return result;
}

function readFace(oc: OpenCascadeInstance, native: TopoDS_Face, info: SolidFaceInfo,
  edgeInfo: (shape: TopoDS_Shape) => SolidEdgeInfo): Face {
  const owned = createAllocations(), { keep } = owned;
  try {
    const sense = native.Orientation_1(), reversed = sense === oc.TopAbs_Orientation.TopAbs_REVERSED;
    if (!reversed && sense !== oc.TopAbs_Orientation.TopAbs_FORWARD) refuse('unsupportedBoundary');
    const forward = reversed ? keep(oc.TopoDS.Face_1(keep(native.Reversed()))) : native;
    const outside = keep(oc.BRepTools.OuterWire(forward));
    const wires = keep(new oc.TopoDS_Iterator_2(forward, true, true));
    let outer: Occurrence[] | undefined;
    const holes: Occurrence[][] = [];
    while (wires.More()) {
      const member = keep(wires.Value());
      if (member.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_WIRE) refuse('unsupportedBoundary');
      const wire = keep(oc.TopoDS.Wire_1(member));
      const loop = orderedWire(oc, wire, forward, edgeInfo, owned);
      // Orient the result about the inward material normal, used for panel extrusion.
      const inward = reversed ? loop : loop.reverse().map(item => ({ edge: item.edge, reversed: !item.reversed }));
      if (wire.IsSame(outside)) outer = inward;
      else holes.push(inward);
      wires.Next();
    }
    if (!outer || !info.boundaryEdgeIndices?.length || !info.centroid.every(Number.isFinite)
      || !Number.isFinite(info.area) || info.area <= 0) refuse('unsupportedBoundary');
    const visited = new Set(outer.concat(...holes).map(item => item.edge.index));
    if (visited.size !== info.boundaryEdgeIndices.length || info.boundaryEdgeIndices.some(i => !visited.has(i))) refuse('unsupportedBoundary');
    return { ...info, outer, holes };
  } finally { owned.release(); }
}

function topology(oc: OpenCascadeInstance, shape: TopoDS_Shape, index: ReturnType<typeof indexShape>): Topology {
  const tables = collectSubShapes(oc, shape, index.faces.map(() => ({ triangleOffset: 0, triangleCount: 0 })),
    Array.from({ length: index.edgeCount }, () => ({ segmentOffset: 0, segmentCount: 0 })));
  const edgeInfo = (shapeEdge: TopoDS_Shape) => {
    const i = index.edgeIndex(shapeEdge);
    if (i === undefined) refuse('unsupportedBoundary');
    return tables.edges[i];
  };
  const faces = tables.faces.map(info => readFace(oc, index.faces[info.index], info, edgeInfo));
  const owners = new Map<number, Face[]>();
  for (const face of faces) {
    for (const index of face.boundaryEdgeIndices ?? []) {
      const group = owners.get(index);
      if (group) group.push(face);
      else owners.set(index, [face]);
    }
  }
  return { faces, owners };
}

function rim({ edge, reversed }: Occurrence): Rim {
  const edgeIndex = edge.index;
  if (![...edge.start, ...edge.end, ...edge.midpoint].every(Number.isFinite) || !positiveLength(edge.length)) refuse('unsupportedBoundary');
  if (edge.curveKind === 'line') {
    return { edgeIndex, curve: { kind: 'segment', from: reversed ? edge.end : edge.start, to: reversed ? edge.start : edge.end } };
  }
  const basis = edge.circleBasis;
  if (edge.curveKind !== 'circle' || !basis || edge.radius == null || !positiveLength(edge.radius)) refuse('unsupportedBoundary');
  const [first, last] = basis.parameterRange;
  return { edgeIndex, curve: { kind: 'arc', center: basis.origin, radius: edge.radius, xAxis: basis.xAxis,
    normal: reversed ? scaleVec(basis.normal, -1) : basis.normal,
    startAngle: reversed ? -last : first, endAngle: reversed ? -first : last } };
}

function translatedEdge(a: SolidEdgeInfo, b: SolidEdgeInfo, shift: Vec3Tuple): boolean {
  if (a.curveKind !== b.curveKind || !nearLength(a.length - b.length)) return false;
  const at = (p: Vec3Tuple, q: Vec3Tuple) => samePoint(addVec(p, shift), q);
  if (!at(a.midpoint, b.midpoint)) return false;
  if (a.curveKind === 'circle') {
    if (!a.circleBasis || !b.circleBasis || a.radius == null || b.radius == null
      || !nearLength(a.radius - b.radius) || !at(a.circleBasis.origin, b.circleBasis.origin)
      || !parallel(a.circleBasis.normal, b.circleBasis.normal)) return false;
    const sweep = (basis: NonNullable<SolidEdgeInfo['circleBasis']>) => basis.parameterRange[1] - basis.parameterRange[0];
    if (!nearAngle(sweep(a.circleBasis) - sweep(b.circleBasis))) return false;
    if (nearAngle(sweep(a.circleBasis) - 2 * Math.PI)) return true;
  }
  return (at(a.start, b.start) && at(a.end, b.end)) || (at(a.start, b.end) && at(a.end, b.start));
}

type EdgePair = readonly [SolidEdgeInfo, SolidEdgeInfo];
function matchLoop(a: Occurrence[], b: Occurrence[], shift: Vec3Tuple): EdgePair[] | undefined {
  if (a.length !== b.length) return undefined;
  // The two copies bound opposite material faces. Match in reverse cyclic order.
  const matches: EdgePair[][] = [];
  for (let start = 0; start < b.length; start++) {
    if (!translatedEdge(a[0].edge, b[start].edge, shift)) continue;
    const pairs: EdgePair[] = a.map(({ edge }, i) => [edge, b[(start - i + b.length) % b.length].edge]);
    if (pairs.every(([first, second]) => translatedEdge(first, second, shift))) matches.push(pairs);
  }
  if (matches.length > 1) refuse('ambiguousPair');
  return matches[0];
}

function matchBoundaries(pair: Pair, shift: Vec3Tuple): EdgePair[] {
  const { front, back } = pair, outer = matchLoop(front.outer, back.outer, shift);
  if (!outer || front.holes.length !== back.holes.length) refuse('variableThickness');
  const remaining = new Set(back.holes);
  for (const hole of front.holes) {
    const matches = [...remaining].map(other => ({ other, pairs: matchLoop(hole, other, shift) })).filter(m => m.pairs);
    if (matches.length > 1) refuse('ambiguousPair');
    const match = matches[0];
    if (!match?.pairs) refuse('variableThickness');
    remaining.delete(match.other);
    outer.push(...match.pairs);
  }
  return outer;
}

interface Contact { edge: SolidEdgeInfo; plane: Plane }
interface EndArc { edge: SolidEdgeInfo; wall: Plane }
interface Strip {
  skin: Skin;
  entry: Contact;
  exit: Contact;
  ends: EndArc[];
  sweep: number;
}
function contact(top: Topology, skin: Skin, edge: SolidEdgeInfo): Contact {
  const face = neighbor(top, skin, edge);
  if (!plane(face) || !unit(edge.axis) || !parallel(edge.axis, skin.axis)) refuse('unsupportedBend');
  const radial = axisOffset(edge.start, skin.axisOrigin, skin.axis);
  const normal = scaleVec(radial, (skin.cylinderExterior ? 1 : -1) / skin.radius);
  if (!unit(normal) || !parallel(normal, face.axis) || dotVec(normal, face.axis) <= 0) refuse('unsupportedBend');
  return { edge, plane: face };
}
function endArc(top: Topology, skin: Skin, edge: SolidEdgeInfo): EndArc {
  const wall = neighbor(top, skin, edge), basis = edge.circleBasis;
  if (!plane(wall) || !parallel(wall.axis, skin.axis) || !basis || !parallel(basis.normal, skin.axis)
    || edge.radius == null || !nearLength(edge.radius - skin.radius)
    || !nearLength(lengthVec(axisOffset(basis.origin, skin.axisOrigin, skin.axis)))) refuse('cutAcrossBend');
  return { edge, wall };
}

function readStrip(top: Topology, face: Face, entryEdge: SolidEdgeInfo): Strip {
  const skin = cylinder(face), edges = skin.outer.map(item => item.edge);
  const lines = edges.filter(e => e.curveKind === 'line'), arcs = edges.filter(e => e.curveKind === 'circle');
  if (skin.holes.length || lines.length !== 2 || arcs.length !== 2 || edges.length !== 4
    || new Set(edges.map(e => e.index)).size !== 4) refuse('cutAcrossBend');
  const extent = skin.cylinderAxialExtent;
  if (!extent || !extent.every(Number.isFinite)) refuse('unsupportedBoundary');
  const width = extent[1] - extent[0];
  if (!positiveLength(width) || !lines.every(line => nearLength(line.length - width))) refuse('cutAcrossBend');
  const ends = arcs.map(arc => endArc(top, skin, arc));
  if (ends[0].wall.index === ends[1].wall.index) refuse('cutAcrossBend');
  const sweep = arcs[0].length / skin.radius;
  if (!Number.isFinite(sweep) || nearAngle(sweep) || sweep >= Math.PI || nearAngle(sweep - Math.PI)) refuse('unsupportedBend');
  if (!nearAngle(arcs[1].length / skin.radius - sweep)) refuse('cutAcrossBend');
  const exitEdge = lines.find(edge => edge.index !== entryEdge.index);
  if (!exitEdge || !lines.some(edge => edge.index === entryEdge.index)) refuse('cutAcrossBend');
  return { skin, entry: contact(top, skin, entryEdge), exit: contact(top, skin, exitEdge), ends, sweep };
}
function panelStrips(top: Topology, face: Plane): Strip[] {
  const strips: Strip[] = [];
  for (const { edge } of edgesOf(face)) {
    const other = neighbor(top, face, edge);
    if (edge.curveKind === 'line' && other.surfaceKind === 'cylinder') strips.push(readStrip(top, other, edge));
    if (edge.curveKind === 'line' && other.surfaceKind !== 'cylinder' && other.surfaceKind !== 'plane') refuse('unsupportedBend');
  }
  return strips;
}

function matchingSkins(a: Strip, b: Strip, thickness: number): boolean {
  const left = a.skin, right = b.skin;
  return left.cylinderExterior !== right.cylinderExterior && parallel(left.axis, right.axis)
    && nearLength(lengthVec(axisOffset(right.axisOrigin, left.axisOrigin, left.axis)))
    && nearLength((left.radius - right.radius) * (left.cylinderExterior ? 1 : -1) - thickness)
    && samePoint(addVec(a.entry.edge.midpoint, scaleVec(a.entry.plane.axis, -thickness)), b.entry.edge.midpoint);
}
function segmentAlong(edge: SolidEdgeInfo, axis: Vec3Tuple): SegmentSpec {
  const increasing = dotVec(subVec(edge.end, edge.start), axis) > 0;
  return { kind: 'segment', from: increasing ? edge.start : edge.end, to: increasing ? edge.end : edge.start };
}
interface Joint { bend: Bend; next: Pair; ends: EndArc[]; cheekArea: number }
function joint(a: Strip, b: Strip, thickness: number): Joint {
  if (!nearAngle(a.sweep - b.sweep) || !nearLength(a.entry.edge.length - b.entry.edge.length)
    || !a.ends.every(end => b.ends.some(other => other.wall.index === end.wall.index))) refuse('cutAcrossBend');
  const next = { front: a.exit.plane, back: b.exit.plane };
  const entryShift = scaleVec(a.entry.plane.axis, -thickness), exitShift = scaleVec(next.front.axis, -thickness);
  if (!translatedEdge(a.entry.edge, b.entry.edge, entryShift) || !translatedEdge(a.exit.edge, b.exit.edge, exitShift)
    || !parallel(next.front.axis, next.back.axis) || dotVec(next.front.axis, next.back.axis) >= 0) refuse('unsupportedBend');
  const turn = crossVec(a.entry.plane.axis, next.front.axis), sine = lengthVec(turn);
  const sign = a.skin.cylinderExterior ? 1 : -1;
  const radians = Math.atan2(sine, dotVec(a.entry.plane.axis, next.front.axis));
  if (nearAngle(sine) || !nearAngle(a.sweep - radians)) refuse('unsupportedBend');
  const axis = scaleVec(turn, sign / sine);
  if (!parallel(axis, a.skin.axis)) refuse('unsupportedBend');
  const inner = a.skin.cylinderExterior ? b.skin : a.skin, outer = a.skin.cylinderExterior ? a.skin : b.skin;
  const bend = { fromFaceIndex: a.entry.plane.index, toFaceIndex: next.front.index,
    innerFaceIndex: inner.index, outerFaceIndex: outer.index, radius: inner.radius, width: a.entry.edge.length,
    angleDegrees: sign * radians * 180 / Math.PI, axis, axisOrigin: inner.axisOrigin,
    fromTangent: segmentAlong(a.entry.edge, axis), toTangent: segmentAlong(a.exit.edge, axis) };
  return { bend, next, ends: a.ends, cheekArea: (outer.radius + inner.radius) * thickness * radians / 2 };
}

function panelJoints(top: Topology, pair: Pair, thickness: number): Joint[] {
  const front = panelStrips(top, pair.front), back = new Set(panelStrips(top, pair.back));
  if (front.length !== back.size) refuse('unsupportedBend');
  return front.map(strip => {
    const matches = [...back].filter(other => matchingSkins(strip, other, thickness));
    if (matches.length > 1) refuse('ambiguousPair');
    if (matches.length !== 1) refuse('unsupportedBend');
    back.delete(matches[0]);
    return joint(strip, matches[0], thickness);
  });
}
interface WallCoverage { area: number; length: number }
function cover(walls: Map<number, WallCoverage>, face: Face, area: number, length: number): void {
  const part = walls.get(face.index) ?? { area: 0, length: 0 };
  walls.set(face.index, { area: part.area + area, length: part.length + length });
}
function panelWall(top: Topology, pair: Pair, edges: EdgePair, thickness: number, walls: Map<number, WallCoverage>): void {
  const [a, b] = edges, wall = neighbor(top, pair.front, a);
  if (wall.index !== neighbor(top, pair.back, b).index) refuse('variableThickness');
  if (a.curveKind === 'line') {
    if (!plane(wall) || !nearAngle(dotVec(wall.axis, pair.front.axis))) refuse('variableThickness');
  } else {
    const skin = cylinder(wall), basis = a.circleBasis;
    if (!basis || !parallel(skin.axis, pair.front.axis) || !nearLength(skin.radius - (a.radius ?? NaN))
      || !nearLength(lengthVec(axisOffset(basis.origin, skin.axisOrigin, skin.axis)))) refuse('variableThickness');
    if (nearAngle(basis.parameterRange[1] - basis.parameterRange[0] - 2 * Math.PI)) {
      const span = skin.cylinderSpan;
      if (!span || !nearLength(span[1] - span[0] - thickness)) refuse('unsupportedBoundary');
    }
  }
  cover(walls, wall, a.length * thickness, a.length + thickness);
}

function solve(top: Topology, root: Pair, thickness: number, panels: Panel[]): Extract<Result, { ok: true }> {
  const bends: Bend[] = [];
  const walls = new Map<number, WallCoverage>(), skins = new Map<number, number>();
  const queue = [root], panelFaces = new Set([root.front.index, root.back.index]);
  for (let i = 0; i < queue.length; i++) {
    const pair = queue[i], { front, back } = pair, inward = scaleVec(front.axis, -1);
    const distance = dotVec(subVec(back.centroid, front.centroid), inward);
    if (!nearLength(distance - thickness)) refuse('variableThickness');
    const outer = front.outer.map(rim), holes = front.holes.map(hole => hole.map(rim));
    const joints = panelJoints(top, pair, thickness);
    const pairs = matchBoundaries(pair, scaleVec(inward, thickness));
    for (const edges of pairs) {
      const a = neighbor(top, front, edges[0]), b = neighbor(top, back, edges[1]);
      if (a.index === b.index) panelWall(top, pair, edges, thickness, walls);
      else if (!joints.some(({ bend }) => (bend.innerFaceIndex === a.index && bend.outerFaceIndex === b.index)
        || (bend.innerFaceIndex === b.index && bend.outerFaceIndex === a.index))) refuse('variableThickness');
    }
    panels.push({ faceIndex: front.index, oppositeFaceIndex: back.index, inward, outer, holes });
    for (const { bend, next, ends, cheekArea } of joints) {
      if (skins.get(bend.innerFaceIndex) === bend.outerFaceIndex) continue;
      if (skins.has(bend.innerFaceIndex) || skins.has(bend.outerFaceIndex)
        || panelFaces.has(next.front.index) || panelFaces.has(next.back.index)) refuse('unsupportedConnection');
      skins.set(bend.innerFaceIndex, bend.outerFaceIndex);
      skins.set(bend.outerFaceIndex, bend.innerFaceIndex);
      panelFaces.add(next.front.index);
      panelFaces.add(next.back.index);
      bends.push(bend);
      queue.push(next);
      for (const { wall, edge } of ends) cover(walls, wall, cheekArea, edge.length + thickness);
    }
  }
  // A cheek can be a single planar face along an entire chain. Account for its
  // panel rectangles and annular sectors together; a through-hole wall has just its own strip.
  for (const face of top.faces) {
    const wall = walls.get(face.index);
    const roles = Number(!!wall) + Number(panelFaces.has(face.index)) + Number(skins.has(face.index));
    if (roles !== 1 || (wall && !nearLength((face.area - wall.area) / wall.length))) refuse('unsupportedBoundary');
  }
  return { ok: true, thickness, panels, bends };
}

function plausibleMate(top: Topology, pair: Pair, shift: Vec3Tuple): boolean {
  const other = edgesOf(pair.back);
  return edgesOf(pair.front).some(({ edge }) => other.some(({ edge: mate }) => {
    if (!translatedEdge(edge, mate, shift)) return false;
    const a = neighbor(top, pair.front, edge), b = neighbor(top, pair.back, mate);
    return a.index === b.index || (a.surfaceKind === 'cylinder' && b.surfaceKind === 'cylinder');
  }));
}
function fromReference(top: Topology, index: number): Result {
  const front = top.faces[index];
  if (!Number.isSafeInteger(index) || !front || !plane(front)) refuse('ambiguousPair');
  // An unsupported reference outline must retain its boundary diagnosis even if no mate can be compared.
  for (const item of edgesOf(front)) rim(item);
  const inward = scaleVec(front.axis, -1);
  let answer: Extract<Result, { ok: true }> | undefined;
  const failures = new Set<Reason>();
  let mostConfirmed = -1;
  for (const back of top.faces) {
    if (!plane(back) || !parallel(front.axis, back.axis) || dotVec(front.axis, back.axis) >= 0) continue;
    const thickness = dotVec(subVec(back.centroid, front.centroid), inward), pair = { front, back };
    if (!positiveLength(thickness) || !plausibleMate(top, pair, scaleVec(inward, thickness))) continue;
    const panels: Panel[] = [];
    let candidate: Extract<Result, { ok: true }>;
    try { candidate = solve(top, pair, thickness, panels); }
    catch (error) {
      if (!(error instanceof Refusal)) throw error;
      // A distant parallel face may share a cheek with the reference. Its failed
      // first pair supplies no evidence against a closed chain of confirmed pairs.
      if (panels.length > mostConfirmed) { mostConfirmed = panels.length; failures.clear(); }
      if (panels.length === mostConfirmed) failures.add(error.reason);
      continue;
    }
    if (answer) refuse('ambiguousPair');
    answer = candidate;
  }
  if (answer) return answer;
  if (failures.size === 1) return refuse([...failures][0]);
  return refuse(failures.size ? 'ambiguousPair' : 'variableThickness');
}

/** Face indices use collectSubShapes numbering. The caller retains ownership of the solid. */
export function recognizeSheetMetal(oc: OpenCascadeInstance, shape: TopoDS_Shape, referenceFaceIndex: number): Result {
  const owned = createAllocations();
  let nativeFailure: Reason = 'invalidSource';
  try {
    if (shape.IsNull() || countSheetMetalSolids(oc, shape) !== 1) refuse('invalidSource');
    const index = indexShape(oc, shape, owned);
    if (!isValidShape(oc, shape)) refuse('invalidSource');
    nativeFailure = 'unsupportedBoundary';
    return fromReference(topology(oc, shape, index), referenceFaceIndex);
  } catch (error) {
    return { ok: false, reason: error instanceof Refusal ? error.reason : nativeFailure };
  } finally { owned.release(); }
}
