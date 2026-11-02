/** Test-only route inputs. Analytic expectations must never feed these builders. */
import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';

import { createSubShapeReference } from '../kernelBridge/createSubShapeReference.js';
import { resolveSubShapeReference } from '../kernelBridge/referenceResolution.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import type { KernelBridge, SolidBody } from '../kernelBridge.js';
import { absoluteCoordinate, appendFeature, createPointFeature, DEFAULT_FACE_COLOR } from '../sketch/createSketchDocument.js';
import { DEFAULT_WORK_PLANE_ID } from '../sketch/planeMath.js';
import type { CoordinateInput, SketchArcFeature, SketchDocument, SketchFaceFeature, SketchLineFeature } from '../sketch/types.js';
import { appendSolid, createEmptyPartDocument, replaceSketch, replaceSolid } from './createPartDocument.js';
import { recomputePart } from './recomputePart.js';
import type { BooleanFeature, ExtrudeFeature, HoleFeature, PartDocument, PrimitiveFeature, RevolveFeature, RuledFeature, SewFeature } from './types.js';

export interface Ex18BuiltRoute {
  readonly part: PartDocument;
  readonly centerId: string;
  readonly finalId: string;
}

export function routeExpression(source: string): ExpressionValue {
  const evaluated = evaluateExpression(source);
  if (!evaluated.ok) throw new Error(`EX18 invalid input expression: ${source}`);
  return evaluated.value;
}

function expressionPoint(x: string, y: string, z: string): CoordinateInput {
  return { mode: 'absolute', x: routeExpression(x), y: routeExpression(y), z: routeExpression(z) };
}

/** Capture only the unique top face measured from the current, successfully recomputed plate. */
function currentTop(body: SolidBody, topZ = 10): SubShapeRef {
  const tops = body.faces.filter(face => face.surfaceKind === 'plane' && face.axis !== null
    && Math.abs(Math.abs(face.axis[2]) - 1) < 1e-9 && Math.abs(face.centroid[2] - topZ) < 1e-9);
  const [face] = tops;
  if (!body.isValid || tops.length !== 1 || face === undefined) throw new Error('EX18 unique current top face missing');
  const semantic = createSubShapeReference(body, 'face', face.index);
  if (semantic !== null) return semantic;
  if (body.origins?.state === 'tracked' && !body.origins.fingerprintFallback?.some(entry =>
    entry.current.kind === 'face' && entry.current.index === face.index)) {
    throw new Error('EX18 ambiguous semantic top face');
  }
  const captured: SubShapeRef = { bodyFeatureId: body.featureId, index: face.index, fingerprint: {
    kind: 'face', surfaceKind: face.surfaceKind, area: face.area, position: face.centroid,
    axis: face.axis, radius: face.radius,
  } };
  const matched = resolveSubShapeReference(body, captured);
  if (matched.status !== 'matched' || matched.match.reference.index !== face.index) {
    throw new Error('EX18 measured top face is not uniquely resolved');
  }
  return matched.match.reference;
}

async function drill(plate: PartDocument, targetId: string, centerId: string,
  diameter: string, bridge: KernelBridge, topZ = 10): Promise<Ex18BuiltRoute> {
  const result = await recomputePart(plate, bridge);
  if (result.cancelled || result.errors.length > 0) throw new Error(JSON.stringify(result.errors));
  const bodies = result.bodies.filter(body => body.featureId === targetId);
  const [body] = bodies;
  if (bodies.length !== 1 || body === undefined) throw new Error('EX18 plate body missing');
  const hole: HoleFeature = { id: 'hole-1', name: 'hole-1', kind: 'hole', suppressed: false,
    targetFeatureId: targetId, face: currentTop(body, topZ),
    centers: [{ sketchId: plate.sketches[0].id, pointFeatureId: centerId }],
    diameter: routeExpression(diameter), depth: { kind: 'through' },
    tiltAngle: routeExpression('0'), tiltAzimuth: routeExpression('0') };
  return { part: appendSolid(plate, hole), centerId, finalId: hole.id };
}

/** a: four sketch lines -> a curve-boundary face -> ExtrudeFeature -> machining HoleFeature. */
export async function buildEx18SketchBracket(bridge: KernelBridge): Promise<Ex18BuiltRoute> {
  const empty = createEmptyPartDocument();
  let sketch = empty.sketches[0];
  const corners = [[0, 0, 0], [40, 0, 0], [40, 30, 0], [0, 30, 0]] as const;
  const lines: SketchLineFeature[] = corners.map((corner, index) => {
    const next = corners[(index + 1) % corners.length];
    return {
      id: `line-${String(index + 1)}`, name: `line-${String(index + 1)}`, kind: 'line',
      planeId: DEFAULT_WORK_PLANE_ID, construction: false,
      from: absoluteCoordinate(corner[0], corner[1], corner[2]), to: absoluteCoordinate(next[0], next[1], next[2]),
    };
  });
  const face: SketchFaceFeature = { id: 'face-1', name: 'face-1', kind: 'face', planeId: DEFAULT_WORK_PLANE_ID,
    boundary: lines.map(line => ({ featureId: line.id })), color: DEFAULT_FACE_COLOR };
  sketch = { ...sketch, features: [...sketch.features, ...lines, face] };
  const center = createPointFeature(sketch, absoluteCoordinate(10, 15, 10));
  sketch = appendFeature(sketch, center);
  const extrude: ExtrudeFeature = { id: 'extrude-1', name: 'extrude-1', kind: 'extrude', suppressed: false,
    profile: { sketchId: sketch.id, faceFeatureId: face.id }, distance: routeExpression('10'), reversed: false, symmetric: false };
  return drill(appendSolid(replaceSketch(empty, sketch), extrude), extrude.id, center.id, '6', bridge);
}

/** b: eight shared vertices -> six point-boundary faces -> SewFeature -> machining HoleFeature. */
export async function buildEx18SewnBracket(bridge: KernelBridge): Promise<Ex18BuiltRoute> {
  const empty = createEmptyPartDocument();
  let sketch = empty.sketches[0];
  const ids: string[] = [];
  for (const [x, y, z] of [[0, 0, 0], [40, 0, 0], [40, 30, 0], [0, 30, 0],
    [0, 0, 10], [40, 0, 10], [40, 30, 10], [0, 30, 10]] as const) {
    const point = createPointFeature(sketch, absoluteCoordinate(x, y, z));
    sketch = appendFeature(sketch, point); ids.push(point.id);
  }
  const loops = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5]];
  const faces: SketchFaceFeature[] = loops.map((loop, index) => ({ id: `face-${String(index + 1)}`,
    name: `face-${String(index + 1)}`, kind: 'face', planeId: DEFAULT_WORK_PLANE_ID,
    boundary: loop.map(vertex => ({ featureId: ids[vertex] })), color: DEFAULT_FACE_COLOR }));
  sketch = { ...sketch, features: [...sketch.features, ...faces] };
  const center = createPointFeature(sketch, absoluteCoordinate(10, 15, 10));
  sketch = appendFeature(sketch, center);
  const sew: SewFeature = { id: 'sew-1', name: 'sew-1', kind: 'sew', suppressed: false,
    faces: faces.map(face => ({ sketchId: sketch.id, faceFeatureId: face.id })), tolerance: routeExpression('0.01') };
  return drill(appendSolid(replaceSketch(empty, sketch), sew), sew.id, center.id, '6', bridge);
}

/** d: independently evaluated size/placement expressions -> box primitive -> expression-positioned hole. */
export async function buildEx18ExpressionBracket(bridge: KernelBridge): Promise<Ex18BuiltRoute> {
  const empty = createEmptyPartDocument(), sketch = empty.sketches[0];
  const center = createPointFeature(sketch, expressionPoint('40/4', '30/2', '2*5'));
  const box: PrimitiveFeature = { id: 'box-1', name: 'box-1', kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: expressionPoint('20', '15', '5') }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'box', sizeX: routeExpression('4*10'), sizeY: routeExpression('3*10'), sizeZ: routeExpression('2*5') } };
  const plate = appendSolid(replaceSketch(empty, appendFeature(sketch, center)), box);
  return drill(plate, box.id, center.id, '2*3', bridge);
}

/** b: edit the machining feature's numeric diameter, preserving every other saved field. */
export function editEx18SewnDiameter(route: Ex18BuiltRoute): PartDocument {
  const hole = route.part.solids.find(feature => feature.id === route.finalId);
  if (hole?.kind !== 'hole') throw new Error('EX18 machining hole missing');
  return replaceSolid(route.part, hole.id, { ...hole, diameter: routeExpression('8') });
}

/** a: the sketch-based plate's machining-hole dimension (not a sketch-circle constraint). */
export function editEx18SketchHoleDiameter(route: Ex18BuiltRoute): PartDocument {
  const hole = route.part.solids.find(feature => feature.id === route.finalId);
  if (hole?.kind !== 'hole') throw new Error('EX18 sketch-route hole missing');
  return replaceSolid(route.part, hole.id, { ...hole, diameter: routeExpression('8') });
}

/** d: edit the entered diameter formula from 2*3 to 2*4. */
export function editEx18ExpressionDiameter(route: Ex18BuiltRoute): PartDocument {
  const hole = route.part.solids.find(feature => feature.id === route.finalId);
  if (hole?.kind !== 'hole') throw new Error('EX18 expression hole missing');
  return replaceSolid(route.part, hole.id, { ...hole, diameter: routeExpression('2*4') });
}

/** Negative control: change only the hole point's X formula, keeping the same feature/point identities. */
export function moveEx18ExpressionHole(route: Ex18BuiltRoute): PartDocument {
  const sketch = route.part.sketches[0];
  const moved: SketchDocument = { ...sketch, features: sketch.features.map(feature => {
    if (feature.id !== route.centerId) return feature;
    if (feature.kind !== 'point') throw new Error('EX18 hole point missing');
    return { ...feature, at: expressionPoint('40/4+2', '30/2', '2*5') };
  }) };
  return replaceSketch(route.part, moved);
}

export interface Ex18BCRoute {
  readonly part: PartDocument;
  readonly finalId: string;
}

/** Closed line loop in XZ. Inputs are entered coordinates, never analytic expectation constants. */
function xzLineFace(sketch: SketchDocument, corners: readonly (readonly [number, number, number])[]) {
  const lines: SketchLineFeature[] = corners.map((corner, index) => {
    const next = corners[(index + 1) % corners.length], id = `line-${String(index + 1)}`;
    return { id, name: id, kind: 'line', planeId: 'xz', construction: false,
      from: absoluteCoordinate(corner[0], corner[1], corner[2]), to: absoluteCoordinate(next[0], next[1], next[2]) };
  });
  const face: SketchFaceFeature = { id: 'face-1', name: 'face-1', kind: 'face', planeId: 'xz',
    boundary: lines.map(line => ({ featureId: line.id })), color: DEFAULT_FACE_COLOR };
  return { sketch: { ...sketch, features: [...sketch.features, ...lines, face] }, face };
}

/** B/a: revolve the complete stepped hollow half-section, including its bore, about world Z. */
export function buildEx18RevolvedFlange(): Ex18BCRoute {
  const empty = createEmptyPartDocument();
  const { sketch, face } = xzLineFace(empty.sketches[0], [
    [3, 0, 0], [15, 0, 0], [15, 0, 5], [10, 0, 5], [10, 0, 25], [3, 0, 25],
  ]);
  const revolve: RevolveFeature = { id: 'revolve-1', name: 'revolve-1', kind: 'revolve', suppressed: false,
    profile: { sketchId: sketch.id, faceFeatureId: face.id }, axis: { kind: 'world', axis: 'z' },
    angle: routeExpression('360'), reversed: false };
  return { part: appendSolid(replaceSketch(empty, sketch), revolve), finalId: revolve.id };
}

/** Edit the two inner-radius vertices in the saved half-section; the revolve feature is unchanged. */
export function editEx18RevolvedFlangeRadius(route: Ex18BCRoute): PartDocument {
  const sketch = route.part.sketches[0];
  const radius = (at: CoordinateInput): CoordinateInput => {
    if (at.mode !== 'absolute') throw new Error('EX18 half-section must use absolute coordinates');
    return at.x.value === 3 ? { ...at, x: routeExpression('4') } : at;
  };
  return replaceSketch(route.part, { ...sketch, features: sketch.features.map(feature => feature.kind === 'line'
    ? { ...feature, from: radius(feature.from), to: radius(feature.to) } : feature) });
}

function flangeUnion(part: PartDocument, firstId: string, secondId: string): PartDocument {
  const union: BooleanFeature = { id: 'union-1', name: 'union-1', kind: 'boolean', suppressed: false,
    operation: 'union', targetFeatureId: firstId, toolFeatureId: secondId };
  return appendSolid(part, union);
}

function circleFace(sketch: SketchDocument, id: string, radius: number, z: number) {
  const arc: SketchArcFeature = {
    id: `arc-${id}`, name: `arc-${id}`, kind: 'arc', planeId: DEFAULT_WORK_PLANE_ID,
    center: absoluteCoordinate(0, 0, z), radius: routeExpression(String(radius)),
    startAngle: routeExpression('0'), endAngle: routeExpression('360'), construction: false,
  };
  const face: SketchFaceFeature = { id: `face-${id}`, name: `face-${id}`, kind: 'face', planeId: DEFAULT_WORK_PLANE_ID,
    boundary: [{ featureId: arc.id }], color: DEFAULT_FACE_COLOR };
  return { sketch: appendFeature(appendFeature(sketch, arc), face), face };
}

/** B/b: equal-radius circle pairs -> two straight ruled solids -> union -> through bore. No loft. */
export async function buildEx18RuledFlange(bridge: KernelBridge): Promise<Ex18BCRoute> {
  const empty = createEmptyPartDocument();
  let sketch = empty.sketches[0];
  const faces: string[] = [];
  for (const [radius, z] of [[15, 0], [15, 5], [10, 5], [10, 25]] as const) {
    const added = circleFace(sketch, String(faces.length + 1), radius, z);
    sketch = added.sketch; faces.push(added.face.id);
  }
  const center = createPointFeature(sketch, absoluteCoordinate(0, 0, 25));
  sketch = appendFeature(sketch, center);
  const ruled = (id: string, first: string, second: string): RuledFeature => ({
    id, name: id, kind: 'ruled', suppressed: false,
    first: { kind: 'sketchFace', ref: { sketchId: sketch.id, faceFeatureId: first } },
    second: { kind: 'sketchFace', ref: { sketchId: sketch.id, faceFeatureId: second } },
    twist: routeExpression('0'), sphereSegments: 24,
  });
  let part = replaceSketch(empty, sketch);
  part = appendSolid(part, ruled('ruled-1', faces[0], faces[1]));
  part = appendSolid(part, ruled('ruled-2', faces[2], faces[3]));
  part = flangeUnion(part, 'ruled-1', 'ruled-2');
  return drill(part, 'union-1', center.id, '6', bridge, 25);
}

/** B/d: independently entered expressions -> analytic cylinder primitives -> union -> formula-sized bore. */
export async function buildEx18ExpressionFlange(bridge: KernelBridge): Promise<Ex18BCRoute> {
  const empty = createEmptyPartDocument(), sketch = empty.sketches[0];
  const center = createPointFeature(sketch, expressionPoint('0*5', '0*5', '5+2*10'));
  const cylinder = (id: string, radius: string, height: string, z: string): PrimitiveFeature => ({
    id, name: id, kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: expressionPoint('0*5', '0*5', z) }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'cylinder', radius: routeExpression(radius), height: routeExpression(height) },
  });
  let part = replaceSketch(empty, appendFeature(sketch, center));
  part = appendSolid(part, cylinder('cylinder-1', '3*5', '10/2', '0*5'));
  part = appendSolid(part, cylinder('cylinder-2', '20/2', '2*10', '10/2'));
  part = flangeUnion(part, 'cylinder-1', 'cylinder-2');
  return drill(part, 'union-1', center.id, '2*3', bridge, 25);
}

/** B/b,d: edit only the machining diameter. a instead edits the actual revolved profile above. */
export function editEx18FlangeBore(route: Ex18BCRoute, formula = '8'): PartDocument {
  const hole = route.part.solids.find(feature => feature.id === route.finalId);
  if (hole?.kind !== 'hole') throw new Error('EX18 flange through bore missing');
  return replaceSolid(route.part, hole.id, { ...hole, diameter: routeExpression(formula) });
}

/** C/a: the XZ parallelogram is extruded normal to its plane, toward positive Y. */
export function buildEx18ExtrudedOblique(): Ex18BCRoute {
  const empty = createEmptyPartDocument();
  const { sketch, face } = xzLineFace(empty.sketches[0], [[0, 0, 0], [20, 0, 0], [25, 0, 10], [5, 0, 10]]);
  const extrude: ExtrudeFeature = { id: 'extrude-1', name: 'extrude-1', kind: 'extrude', suppressed: false,
    profile: { sketchId: sketch.id, faceFeatureId: face.id }, distance: routeExpression('10'), reversed: true, symmetric: false };
  return { part: appendSolid(replaceSketch(empty, sketch), extrude), finalId: extrude.id };
}

function sewObliqueCoordinates(coordinates: readonly CoordinateInput[], planeId: string): Ex18BCRoute {
  const empty = createEmptyPartDocument();
  let sketch = empty.sketches[0];
  const ids: string[] = [];
  for (const at of coordinates) {
    const point = { ...createPointFeature(sketch, at), planeId };
    sketch = appendFeature(sketch, point); ids.push(point.id);
  }
  const loops = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5]];
  const faces: SketchFaceFeature[] = loops.map((loop, index) => ({
    id: `face-${String(index + 1)}`, name: `face-${String(index + 1)}`, kind: 'face', planeId,
    boundary: loop.map(vertex => ({ featureId: ids[vertex] })), color: DEFAULT_FACE_COLOR,
  }));
  sketch = { ...sketch, features: [...sketch.features, ...faces] };
  const sew: SewFeature = { id: 'sew-1', name: 'sew-1', kind: 'sew', suppressed: false,
    faces: faces.map(face => ({ sketchId: sketch.id, faceFeatureId: face.id })), tolerance: routeExpression('0.01') };
  return { part: appendSolid(replaceSketch(empty, sketch), sew), finalId: sew.id };
}

/** C/b: eight numeric vertices define six planar faces, which are sewn into the oblique prism. */
export function buildEx18SewnOblique(): Ex18BCRoute {
  const vertices = [[0, 0, 0], [20, 0, 0], [20, 10, 0], [0, 10, 0],
    [5, 0, 10], [25, 0, 10], [25, 10, 10], [5, 10, 10]] as const;
  return sewObliqueCoordinates(vertices.map(point => absoluteCoordinate(point[0], point[1], point[2])), 'free');
}

/** C/d: eight independently entered coordinate expressions, including x_top=x_base+5, in a 3D sketch. */
export function buildEx18ExpressionOblique(): Ex18BCRoute {
  return sewObliqueCoordinates([
    expressionPoint('0', '0', '0'), expressionPoint('4*5', '0', '0'),
    expressionPoint('4*5', '2*5', '0'), expressionPoint('0', '2*5', '0'),
    expressionPoint('0+5', '0', '2*5'), expressionPoint('4*5+5', '0', '2*5'),
    expressionPoint('4*5+5', '2*5', '2*5'), expressionPoint('0+5', '2*5', '2*5'),
  ], 'free');
}

/** C/a changes extrusion distance; C/b,d change the saved Y coordinates, keeping topology/identities. */
export function editEx18ObliqueDepth(route: Ex18BCRoute, formula = '12'): PartDocument {
  const feature = route.part.solids.find(solid => solid.id === route.finalId);
  if (feature?.kind === 'extrude') return replaceSolid(route.part, feature.id, { ...feature, distance: routeExpression(formula) });
  if (feature?.kind !== 'sew') throw new Error('EX18 oblique extrusion/sew missing');
  const sketch = route.part.sketches[0];
  return replaceSketch(route.part, { ...sketch, features: sketch.features.map(point => {
    if (point.kind !== 'point' || point.at.mode !== 'absolute' || point.at.y.value !== 10) return point;
    return { ...point, at: { ...point.at, y: routeExpression(formula) } };
  }) });
}
