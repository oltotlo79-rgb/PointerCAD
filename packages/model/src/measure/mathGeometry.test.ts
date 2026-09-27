import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { expressionValueFromNumber } from '@pointercad/expression';
import { createKernelApi, SUB_SHAPE_MATCH_THRESHOLD } from '@pointercad/kernel';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, selectMateTargetGeometry, type KernelBridge, type MeasureOutcome, type SolidBody,
  type SolidEdgeEntry, type SolidFaceEntry, type SolidVertexEntry } from '../kernelBridge.js';
import { scoreSubShapeMatch } from '../kernelBridge/subShapeMatching.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import type { Vec3 } from '../sketch/vec3.js';
import { evaluateMathGeometry, MATH_GEOMETRY_AMBIGUITY_MARGIN } from './mathGeometry.js';
import { mathGeometryTargetsOf } from './mathGeometryIdentity.js';
import { analyzeMathGeometryDependencies } from './mathGeometryDependencies.js';
import { mathGeometryCoefficientValue } from './mathGeometryCoefficients.js';
import { appendSolid, createEmptyPartDocument, createPrimitiveFeature, replaceSketch } from '../part/createPartDocument.js';
import { recomputePart, type PartRecomputeResult } from '../part/recomputePart.js';
import type { PartDocument, ReferenceCoordinateSystemFeature } from '../part/types.js';
import { absoluteCoordinate, appendFeature, createPointFeature } from '../sketch/createSketchDocument.js';
import type { SketchArcFeature, SketchFeature, SketchLineFeature } from '../sketch/types.js';
import { affectsShape } from '../part/documentChange.js';
import { compareDocuments } from '../diff/compareDocuments.js';
import { resolvePart } from '../part/resolvePart.js';
import type { MathGeometryCurve, MathGeometryFace, MathGeometryFrame, MathGeometryPoint, MathGeometryQuantity, MathGeometryRequest,
  MathSubShapeReference } from './mathGeometryTypes.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
const bridges: KernelBridge[] = [];
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);
afterEach(() => { for (const bridge of bridges.splice(0)) bridge.dispose(); });
function kernel(): KernelBridge {
  const bridge = createDirectKernelBridge(createKernelApi(() => Promise.resolve(oc)));
  bridges.push(bridge);
  return bridge;
}
const tolerance = { linearMm: 1e-6, angularRadians: 1e-8 };
function requests(document: PartDocument, ...quantities: readonly MathGeometryQuantity[]): readonly MathGeometryRequest[] {
  return quantities.map((quantity, index) => ({ id: `measurement-${String(index)}`, documentId: document.id, quantity, tolerance }));
}
function values(result: PartRecomputeResult): readonly (number | boolean)[] {
  expect(result.cancelled).toBe(false);
  return (result.mathGeometry ?? []).map(outcome => {
    if (outcome.status !== 'value') throw new Error(JSON.stringify(outcome));
    expect(outcome.representation).toBe('geometry-double');
    expect(outcome.tolerance).toEqual(tolerance);
    return outcome.value;
  });
}
function pointPart(x = 3): { document: PartDocument; first: MathGeometryPoint; second: MathGeometryPoint } {
  const document = createEmptyPartDocument();
  let sketch = document.sketches[0];
  const a = createPointFeature(sketch, absoluteCoordinate(0, 0, 0));
  sketch = appendFeature(sketch, a);
  const b = createPointFeature(sketch, absoluteCoordinate(x, 4, 0));
  sketch = appendFeature(sketch, b);
  return { document: replaceSketch(document, sketch),
    first: { kind: 'sketch-point', sketchId: sketch.id, reference: { kind: 'point', pointId: a.id } },
    second: { kind: 'sketch-point', sketchId: sketch.id, reference: { kind: 'point', pointId: b.id } } };
}
function boxPart(sizeX = 20): { document: PartDocument; id: string } {
  const document = createEmptyPartDocument(), feature = createPrimitiveFeature(document, 'box');
  return { document: appendSolid(document, { ...feature, shape: { kind: 'box',
    sizeX: expressionValueFromNumber(sizeX), sizeY: expressionValueFromNumber(30), sizeZ: expressionValueFromNumber(40) } }), id: feature.id };
}
function joinedBoxes(sizeX = 20): { document: PartDocument; originalId: string } {
  const initial = boxPart(sizeX);
  let document = initial.document;
  const second = createPrimitiveFeature(document, 'box');
  document = appendSolid(document, { ...second, origin: { kind: 'coordinate', value: absoluteCoordinate(10, 0, 0) },
    shape: { kind: 'box', sizeX: expressionValueFromNumber(20), sizeY: expressionValueFromNumber(30), sizeZ: expressionValueFromNumber(40) } });
  document = appendSolid(document, { kind: 'boolean', id: 'joined', name: '結合', suppressed: false,
    operation: 'union', targetFeatureId: initial.id, toolFeatureId: second.id });
  return { document, originalId: initial.id };
}
/** Two equal 20×30×40 boxes 100 mm apart in one united body; swapping the operands renumbers the faces. */
function separatedBoxes(swapped = false): PartDocument {
  const near = boxPart();
  let document = near.document;
  const far = createPrimitiveFeature(document, 'box');
  document = appendSolid(document, { ...far, origin: { kind: 'coordinate', value: absoluteCoordinate(100, 0, 0) },
    shape: { kind: 'box', sizeX: expressionValueFromNumber(20), sizeY: expressionValueFromNumber(30), sizeZ: expressionValueFromNumber(40) } });
  return appendSolid(document, { kind: 'boolean', id: 'joined', name: '結合', suppressed: false, operation: 'union',
    targetFeatureId: swapped ? far.id : near.id, toolFeatureId: swapped ? near.id : far.id });
}
function faceReference(bodyFeatureId: string, face: SolidFaceEntry): MathSubShapeReference<'face'> {
  return { bodyFeatureId, index: face.index, fingerprint: { kind: 'face', surfaceKind: face.surfaceKind, area: face.area,
    position: face.centroid, axis: face.axis, radius: face.radius } };
}
function edgeReference(bodyFeatureId: string, edge: SolidEdgeEntry): MathSubShapeReference<'edge'> {
  return { bodyFeatureId, index: edge.index, fingerprint: { kind: 'edge', curveKind: edge.curveKind, length: edge.length,
    position: edge.midpoint, axis: edge.axis, radius: edge.radius } };
}
function vertexReference(bodyFeatureId: string, vertex: SolidVertexEntry): MathSubShapeReference<'vertex'> {
  return { bodyFeatureId, index: vertex.index, fingerprint: { kind: 'vertex', position: vertex.position } };
}
/** Every face, edge and vertex of a body, referenced by the fingerprint it has now. */
function referencesOf(body: SolidBody) {
  return { faces: body.faces.map(face => faceReference(body.featureId, face)),
    edges: body.edges.map(edge => edgeReference(body.featureId, edge)),
    vertices: body.vertices.map(vertex => vertexReference(body.featureId, vertex)) };
}
function everyReference(body: SolidBody): readonly SubShapeRef[] {
  const references = referencesOf(body);
  return [...references.faces, ...references.edges, ...references.vertices];
}
/** Face area, edge length and vertex X, in the order of the body's current numbering. */
function everyQuantity(body: SolidBody): readonly MathGeometryQuantity[] {
  const references = referencesOf(body);
  return [...references.faces.map((reference): MathGeometryQuantity => ({ kind: 'area', shape: { kind: 'face', reference } })),
    ...references.edges.map((reference): MathGeometryQuantity => ({ kind: 'length', curve: { kind: 'edge', reference } })),
    ...references.vertices.map((reference): MathGeometryQuantity => ({ kind: 'coordinate', point: { kind: 'vertex', reference }, component: 'X' }))];
}
function everyValue(body: SolidBody): readonly number[] {
  return [...body.faces.map(face => face.area), ...body.edges.map(edge => edge.length), ...body.vertices.map(vertex => vertex.position[0])];
}
/** The two equal top faces of `separatedBoxes`, the near one (smaller X) first. */
function topFaces(body: SolidBody): readonly [SolidFaceEntry, SolidFaceEntry] {
  const top = Math.max(...body.faces.map(face => face.centroid[2]));
  const faces = body.faces.filter(face => Math.abs(face.centroid[2] - top) < 1e-6).sort((a, b) => a.centroid[0] - b.centroid[0]);
  if (faces.length !== 2) throw new Error('Two equal top faces are expected');
  return [faces[0], faces[1]];
}
function positionAt(body: SolidBody, reference: SubShapeRef, index: number): Vec3 | undefined {
  switch (reference.fingerprint.kind) {
    case 'face': return body.faces.find(face => face.index === index)?.centroid;
    case 'edge': return body.edges.find(edge => edge.index === index)?.midpoint;
    case 'vertex': return body.vertices.find(vertex => vertex.index === index)?.position;
  }
}
const AMBIGUOUS_MESSAGE = '形が変わり、参照先を1つに決められません。選び直してください。';

function boxFace(body: SolidBody, axis: 0 | 1 | 2, side = 1): MathGeometryFace {
  const face = body.faces.find(candidate => candidate.axis !== null && Math.abs(candidate.axis[axis]) > 1 - 1e-8
    && candidate.centroid[axis] * side > 0);
  if (face === undefined) throw new Error('Expected box face');
  return { kind: 'face', reference: faceReference(body.featureId, face) };
}
function boxEdge(body: SolidBody, axis: 0 | 1 | 2): MathGeometryCurve {
  const edge = body.edges.find(candidate => candidate.axis !== null && Math.abs(candidate.axis[axis]) > 1 - 1e-8);
  if (edge === undefined) throw new Error('Expected straight box edge');
  return { kind: 'edge', reference: edgeReference(body.featureId, edge) };
}
function threePointPart(positions: readonly [Vec3, Vec3, Vec3]) {
  const document = createEmptyPartDocument();
  let sketch = document.sketches[0];
  const targets = positions.map((position): MathGeometryPoint => {
    const feature = createPointFeature(sketch, absoluteCoordinate(...position));
    sketch = appendFeature(sketch, feature);
    return { kind: 'sketch-point', sketchId: sketch.id, reference: { kind: 'point', pointId: feature.id } };
  });
  return { document: replaceSketch(document, sketch), first: targets[0], second: targets[1], third: targets[2] };
}
function rotateBox(document: PartDocument, id: string, degrees: number): PartDocument {
  return appendSolid(document, { kind: 'transform', id: 'tilted', name: '傾けた箱', suppressed: false,
    targetFeatureId: id, translation: [expressionValueFromNumber(0), expressionValueFromNumber(0), expressionValueFromNumber(0)],
    rotationAxis: { kind: 'world', axis: 'y' }, rotationAngle: expressionValueFromNumber(degrees) });
}

describe('GR-09 平面と3点の角度・平行・垂直', () => {
  it.each(['degree', 'radian'] as const)('箱の隣り合う面の直角を %s で返す', async unit => {
    const { document } = boxPart(), bridge = kernel();
    const body = (await recomputePart(document, bridge)).bodies[0];
    const result = await recomputePart(document, bridge, { mathGeometry: requests(document,
      { kind: 'plane-angle', first: boxFace(body, 0), second: boxFace(body, 2), unit }) });
    expect(values(result)[0]).toBeCloseTo(unit === 'degree' ? 90 : Math.PI / 2, 12);
    expect(result.mathGeometry?.[0]).toMatchObject({ kind: 'real', unit });
  });
  it('箱の向かい合う面は向きによらず0度になる', async () => {
    const { document } = boxPart(), bridge = kernel();
    const body = (await recomputePart(document, bridge)).bodies[0];
    const first = boxFace(body, 2), second = boxFace(body, 2, -1);
    expect(first.reference.index).not.toBe(second.reference.index);
    const result = await recomputePart(document, bridge, { mathGeometry: requests(document,
      { kind: 'plane-angle', first, second, unit: 'degree' }, { kind: 'plane-angle', first: second, second: first, unit: 'degree' }) });
    expect(values(result)).toEqual([0, 0]);
  });
  it.each(['parallel', 'perpendicular'] as const)('平面どうしの %s を判定する', async kind => {
    const { document } = boxPart(), bridge = kernel();
    const body = (await recomputePart(document, bridge)).bodies[0];
    const first = boxFace(body, 2);
    const result = await recomputePart(document, bridge, { mathGeometry: requests(document,
      { kind, first, second: boxFace(body, 2, -1) }, { kind, first, second: boxFace(body, 0) }) });
    expect(values(result)).toEqual(kind === 'parallel' ? [true, false] : [false, true]);
  });
  it.each([0, 2] as const)('平面と方向%dの辺の角度・平行・垂直は選択順によらない', async axis => {
    const { document } = boxPart(), bridge = kernel();
    const body = (await recomputePart(document, bridge)).bodies[0];
    const line = boxEdge(body, axis), plane = boxFace(body, 2);
    const result = await recomputePart(document, bridge, { mathGeometry: requests(document,
      { kind: 'line-plane-angle', line, plane, unit: 'degree' },
      { kind: 'parallel', first: line, second: plane }, { kind: 'parallel', first: plane, second: line },
      { kind: 'perpendicular', first: line, second: plane }, { kind: 'perpendicular', first: plane, second: line }) });
    expect(values(result)).toEqual(axis === 0 ? [0, true, true, false, false] : [90, false, false, true, true]);
  });
  it('30度傾けた実形状の面と元の辺・面を測り、保存した法線を答えに使わない', async () => {
    const initial = boxPart(), bridge = kernel();
    const body = (await recomputePart(initial.document, bridge)).bodies[0];
    const document = rotateBox(initial.document, initial.id, 30);
    const tilted = (await recomputePart(document, bridge)).bodies[0];
    const face = tilted.faces.find(candidate => candidate.axis !== null && Math.abs(Math.abs(candidate.axis[2]) - Math.cos(Math.PI / 6)) < 1e-8);
    if (face === undefined) throw new Error('Expected tilted plane');
    const reference = faceReference(tilted.featureId, face);
    // A slightly old fingerprint must still select the current plane, whose normal is 30 degrees off Z.
    const plane: MathGeometryFace = { kind: 'face', reference: { ...reference,
      fingerprint: { ...reference.fingerprint, axis: [0, 0, 1] } } };
    const result = await recomputePart(document, bridge, { mathGeometry: requests(document,
      { kind: 'line-plane-angle', line: boxEdge(body, 0), plane, unit: 'degree' },
      { kind: 'line-plane-angle', line: boxEdge(body, 0), plane, unit: 'radian' },
      { kind: 'plane-angle', first: boxFace(body, 2), second: plane, unit: 'degree' }) });
    expect(result.errors).toEqual([]);
    expect(values(result)[0]).toBeCloseTo(30, 9);
    expect(values(result)[1]).toBeCloseTo(Math.PI / 6, 12);
    expect(values(result)[2]).toBeCloseTo(30, 9);
  });
  it.each(['degree', 'radian'] as const)('3・4・5の三角形の2番目の点を頂点とする直角を %s で返す', async unit => {
    const { document, first, second, third } = threePointPart([[3, 0, 0], [0, 0, 0], [0, 4, 0]]);
    const result = await recomputePart(document, kernel(), { mathGeometry: requests(document,
      { kind: 'point-angle', first, second, third, unit }, { kind: 'point-distance', first, second: third }) });
    expect(values(result)[0]).toBeCloseTo(unit === 'degree' ? 90 : Math.PI / 2, 12);
    expect(values(result)[1]).toBe(5);
    expect(result.mathGeometry?.[0]).toMatchObject({ kind: 'real', unit });
  });
  it.each([
    { thirdPosition: [-1, 1, 0] as Vec3, degrees: 135 },
    { thirdPosition: [-2, 0, 0] as Vec3, degrees: 180 },
    { thirdPosition: [2, 0, 0] as Vec3, degrees: 0 },
  ])('3点の角は鈍角を折り返さず $degrees 度になる', async ({ thirdPosition, degrees }) => {
    const { document, first, second, third } = threePointPart([[1, 0, 0], [0, 0, 0], thirdPosition]);
    const result = await recomputePart(document, kernel(), { mathGeometry: requests(document,
      { kind: 'point-angle', first, second, third, unit: 'degree' },
      { kind: 'point-angle', first: third, second, third: first, unit: 'radian' }) });
    expect(values(result)[0]).toBeCloseTo(degrees, 12);
    expect(values(result)[1]).toBeCloseTo(degrees * Math.PI / 180, 12);
  });
  it.each(['first', 'third'] as const)('頂点と%sが比べる幅以内なら角度を捏造しない', async collapsed => {
    const { document, first, second, third } = threePointPart([[0.5e-6, 0, 0], [0, 0, 0], [0, 4, 0]]);
    const quantity: MathGeometryQuantity = { kind: 'point-angle', first: collapsed === 'first' ? first : third,
      second, third: collapsed === 'third' ? first : third, unit: 'degree' };
    const result = await recomputePart(document, kernel(), { mathGeometry: requests(document, quantity) });
    expect(result.mathGeometry?.[0]).toMatchObject({ status: 'unresolved', reason: 'unsupported',
      message: 'この種類の図形からは指定した量を求められません。' });
  });
  it.each(['plane-angle', 'line-plane-angle', 'parallel', 'perpendicular'] as const)('円柱の曲面の%sは理由付きで非対応になる', async kind => {
    const initial = createEmptyPartDocument();
    const document = appendSolid(initial, createPrimitiveFeature(initial, 'cylinder')), bridge = kernel();
    const body = (await recomputePart(document, bridge)).bodies[0];
    const side = body.faces.find(face => face.surfaceKind === 'cylinder');
    const cap = body.faces.find(face => face.surfaceKind === 'plane');
    const straight = body.edges.find(edge => edge.curveKind === 'line');
    if (side === undefined || cap === undefined || straight === undefined) throw new Error('Expected cylinder topology');
    const first: MathGeometryFace = { kind: 'face', reference: faceReference(body.featureId, side) };
    const second: MathGeometryFace = { kind: 'face', reference: faceReference(body.featureId, cap) };
    const quantity: MathGeometryQuantity = kind === 'line-plane-angle'
      ? { kind, line: { kind: 'edge', reference: edgeReference(body.featureId, straight) }, plane: first, unit: 'degree' }
      : kind === 'plane-angle' ? { kind, first, second, unit: 'degree' } : { kind, first, second };
    const result = await recomputePart(document, bridge, { mathGeometry: requests(document, quantity) });
    expect(result.mathGeometry?.[0]).toMatchObject({ status: 'unresolved', reason: 'unsupported',
      message: '平面でない面からは角度・平行・垂直を求められません。' });
  });
  it('円の辺の軸を直線の方向として平面との角度に流用しない', async () => {
    const initial = createEmptyPartDocument();
    const document = appendSolid(initial, createPrimitiveFeature(initial, 'cylinder')), bridge = kernel();
    const body = (await recomputePart(document, bridge)).bodies[0];
    const circle = body.edges.find(edge => edge.curveKind === 'circle'), cap = body.faces.find(face => face.surfaceKind === 'plane');
    if (circle === undefined || cap === undefined) throw new Error('Expected circular edge and plane');
    const line: MathGeometryCurve = { kind: 'edge', reference: edgeReference(body.featureId, circle) };
    const plane: MathGeometryFace = { kind: 'face', reference: faceReference(body.featureId, cap) };
    const result = await recomputePart(document, bridge, { mathGeometry: requests(document,
      { kind: 'line-plane-angle', line, plane, unit: 'degree' }, { kind: 'parallel', first: line, second: plane }) });
    expect(result.mathGeometry).toHaveLength(2);
    for (const outcome of result.mathGeometry ?? []) expect(outcome).toMatchObject({ status: 'unresolved', reason: 'unsupported' });
  });
  it('T3: 実際の2直線が0.5度ずれると幅1e-6 radで平行でなく1度で平行になる', async () => {
    const initial = createEmptyPartDocument();
    let sketch = initial.sketches[0];
    const lines: readonly SketchLineFeature[] = [
      { kind: 'line', id: 'base', name: '基準', planeId: 'xy', construction: false,
        from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(50, 0, 0) },
      { kind: 'line', id: 'offset', name: '傾斜', planeId: 'xy', construction: false,
        from: absoluteCoordinate(0, 20, 0), to: absoluteCoordinate(50, 20 + 50 * Math.tan(Math.PI / 360), 0) },
    ];
    for (const line of lines) sketch = appendFeature(sketch, line);
    const document = replaceSketch(initial, sketch), bridge = kernel();
    const first: MathGeometryCurve = { kind: 'sketch-curve', sketchId: sketch.id, featureId: 'base' };
    const second: MathGeometryCurve = { ...first, featureId: 'offset' };
    const [angle, parallel] = requests(document, { kind: 'angle', first, second, unit: 'degree' }, { kind: 'parallel', first, second });
    const result = await recomputePart(document, bridge, { mathGeometry: [angle,
      { ...parallel, id: 'narrow', tolerance: { linearMm: 1e-6, angularRadians: 1e-6 } },
      { ...parallel, id: 'wide', tolerance: { linearMm: 1e-6, angularRadians: Math.PI / 180 } }] });
    expect(result.errors).toEqual([]);
    expect(result.mathGeometry?.[0]).toMatchObject({ status: 'value', kind: 'real', unit: 'degree' });
    const measured = result.mathGeometry?.[0];
    expect(measured?.status === 'value' ? measured.value : null).toBeCloseTo(0.5, 10);
    expect(result.mathGeometry?.slice(1)).toMatchObject([
      { status: 'value', kind: 'boolean', value: false, tolerance: { angularRadians: 1e-6 } },
      { status: 'value', kind: 'boolean', value: true, tolerance: { angularRadians: Math.PI / 180 } },
    ]);
  });
  it.each(['plane-angle', 'line-plane-angle', 'point-angle'] as const)('%sだけでも非表示の元の箱を読み、依存対象を漏らさない', async kind => {
    const initial = boxPart(), bridge = kernel();
    const body = (await recomputePart(initial.document, bridge)).bodies[0];
    const first = boxFace(body, 0), second = boxFace(body, 2), line = boxEdge(body, 0);
    const vertices = body.vertices.map((vertex): MathGeometryPoint => ({ kind: 'vertex', reference: vertexReference(body.featureId, vertex) }));
    const quantity: MathGeometryQuantity = kind === 'plane-angle' ? { kind, first, second, unit: 'degree' }
      : kind === 'line-plane-angle' ? { kind, line, plane: second, unit: 'degree' }
        : { kind, first: vertices[0], second: vertices[1], third: vertices[2], unit: 'degree' };
    const expectedTargets = kind === 'plane-angle' ? [first, second] : kind === 'line-plane-angle'
      ? [line, second] : vertices.slice(0, 3);
    expect(mathGeometryTargetsOf(quantity)).toEqual(expectedTargets);
    const input = requests(initial.document, quantity);
    const expected = values(await recomputePart(initial.document, bridge, { mathGeometry: input }));
    if (bridge.readCachedBodies === undefined) throw new Error('Real bridge must expose cached topology');
    const read = vi.spyOn(bridge, 'readCachedBodies'), recompute = vi.spyOn(bridge, 'recomputeSolids');
    const document = rotateBox(initial.document, initial.id, 30);
    const result = await recomputePart(document, bridge, { mathGeometry: input });
    expect(result.errors).toEqual([]);
    expect(values(result)).toEqual(expected);
    expect(result.bodies.map(body => body.featureId)).toEqual(['tilted']);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[1]).toEqual([initial.id]);
    expect(recompute).toHaveBeenCalledTimes(1);
  });
});

describe('数学で使う図形量は現在の再計算から取得する', () => {
  it('結合の材料となった形を表示へ戻さず測り、寸法変更にも追従する', async () => {
    const { document, originalId } = joinedBoxes(), api = createKernelApi(() => Promise.resolve(oc));
    const bridge = createDirectKernelBridge(api); bridges.push(bridge);
    const recompute = vi.spyOn(bridge, 'recomputeSolids'), read = vi.spyOn(api, 'readCachedBodies');
    const request = requests(document, { kind: 'volume', body: { kind: 'body', featureId: originalId } },
      { kind: 'area', shape: { kind: 'body', featureId: originalId } });
    const result = await recomputePart(document, bridge, { partId: 'measured-part', mathGeometry: request });
    expect(result.errors).toEqual([]);
    expect(result.bodies.map(value => value.featureId)).toEqual(['joined']);
    expect(result.bodies[0].volume).toBeCloseTo(36_000, 6);
    expect(values(result)[0]).toBeCloseTo(24_000, 6);
    expect(values(result)[1]).toBeCloseTo(5_200, 6);
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    const steps = resolvePart(document).steps, finalKeys = steps.filter(step => step.visible).map(step => step.key);
    expect((await api.checkShapeAvailability('measured-part', finalKeys)).missingKeys).toEqual([]);
    const changed = joinedBoxes(40).document;
    const updated = await recomputePart(changed, bridge, { partId: 'measured-part', mathGeometry: request });
    expect(values(updated)[0]).toBeCloseTo(48_000, 6);
    expect(values(updated)[1]).toBeCloseTo(8_000, 6);
    expect(updated.bodies.map(value => value.featureId)).toEqual(['joined']);
    expect(document.solids).toHaveLength(3);
  });
  it('上流の形が計算部から失われたら代わりの形や古い数値を返さない', async () => {
    const { document, originalId } = joinedBoxes(), bridge = kernel();
    if (bridge.readCachedBodies === undefined) throw new Error('Real bridge must expose cached topology');
    const read = vi.spyOn(bridge, 'readCachedBodies').mockResolvedValue({ bodies: [], cacheHits: 0, cancelled: false,
      failures: [{ featureId: originalId, message: '形が失われました。' }] });
    const result = await recomputePart(document, bridge, { mathGeometry: requests(document,
      { kind: 'volume', body: { kind: 'body', featureId: originalId } }) });
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.mathGeometry?.[0]).toMatchObject({ status: 'unresolved', reason: 'failed-geometry' });
    expect(result.bodies.map(value => value.featureId)).toEqual(['joined']);
  });
  it('上流の形の読取り中に取り消しても数値と完了通知を残さない', async () => {
    const { document, originalId } = joinedBoxes(), bridge = kernel(), onResolved = vi.fn();
    if (bridge.readCachedBodies === undefined) throw new Error('Real bridge must expose cached topology');
    const original = bridge.readCachedBodies.bind(bridge);
    let cancelled = false;
    vi.spyOn(bridge, 'readCachedBodies').mockImplementation(async (...args) => {
      const result = await original(...args); cancelled = true; return result;
    });
    const result = await recomputePart(document, bridge, { onResolved, shouldCancel: () => cancelled,
      mathGeometry: requests(document, { kind: 'volume', body: { kind: 'body', featureId: originalId } }) });
    expect(result.cancelled).toBe(true);
    expect(result.mathGeometry).toBeUndefined();
    expect(onResolved).not.toHaveBeenCalled();
  });
  it('保存した定義だけから再計算し、定義の編集と取消を文書差分と同じように扱う', async () => {
    const original = boxPart(), bridge = kernel();
    const definition = { ...requests(original.document, { kind: 'volume', body: { kind: 'body', featureId: original.id } })[0], name: '箱の体積' };
    const source = { ...original.document, mathGeometry: [definition] };
    const changed = { ...source, mathGeometry: [{ ...definition, quantity: { kind: 'area' as const, shape: { kind: 'body' as const, featureId: original.id } } }] };
    expect(affectsShape(source, changed)).toBe(true);
    expect(compareDocuments(source, changed, { relationship: 'versions', beforeAttachmentsDigest: '', afterAttachmentsDigest: '' }).changes).toHaveLength(1);
    expect(values(await recomputePart(source, bridge, { generation: 1 }))[0]).toBeCloseTo(24_000, 6);
    expect(values(await recomputePart(changed, bridge, { generation: 2 }))[0]).toBeCloseTo(5_200, 6);
    expect(values(await recomputePart(source, bridge, { generation: 3 }))[0]).toBeCloseTo(24_000, 6);
    const resized = { ...boxPart(40).document, mathGeometry: [definition] };
    expect(values(await recomputePart(resized, bridge, { generation: 4 }))[0]).toBeCloseTo(48_000, 6);
    expect(source.mathGeometry[0]).toEqual(definition);
  });
  it('点の距離と成分は既知の3・4・5を返し、文書と世代と単位を保つ', async () => {
    const { document, first, second } = pointPart();
    const result = await recomputePart(document, kernel(), { generation: 17, mathGeometry: requests(document,
      { kind: 'point-distance', first, second }, { kind: 'coordinate', point: second, component: 'X' }) });
    expect(values(result)).toEqual([5, 3]);
    for (const outcome of result.mathGeometry ?? []) expect(outcome).toMatchObject({ documentId: document.id, generation: 17, unit: 'mm' });
  });
  it('同じ参照の上流を変更すると値も追従し、別のスケッチの同名IDへ探し直さない', async () => {
    const a = pointPart(), b = pointPart(0), bridge = kernel();
    const input = requests(a.document, { kind: 'point-distance', first: a.first, second: a.second });
    expect(values(await recomputePart(a.document, bridge, { mathGeometry: input }))).toEqual([5]);
    expect(values(await recomputePart(b.document, bridge, { mathGeometry: input }))).toEqual([4]);
    const missing = { ...b.document, sketches: b.document.sketches.map(sketch => ({ ...sketch, id: 'different-sketch' })) };
    const result = await recomputePart(missing, bridge, { mathGeometry: input });
    expect(result.mathGeometry?.[0]).toMatchObject({ status: 'unresolved', reason: 'missing-reference' });
  });
  it('20×30×40の箱の体積と表面積を実カーネルで求め、上流寸法の変更に追従する', async () => {
    const original = boxPart(), changed = boxPart(40), bridge = kernel();
    const input = requests(original.document, { kind: 'volume', body: { kind: 'body', featureId: original.id } },
      { kind: 'area', shape: { kind: 'body', featureId: original.id } });
    const first = await recomputePart(original.document, bridge, { mathGeometry: input });
    expect(values(first)[0]).toBeCloseTo(24_000, 6);
    expect(values(first)[1]).toBeCloseTo(5_200, 6);
    expect(first.mathGeometry?.map(item => item.status === 'value' && item.kind === 'real' ? item.unit : null)).toEqual(['mm3', 'mm2']);
    const second = await recomputePart(changed.document, bridge, { mathGeometry: input });
    expect(values(second)[0]).toBeCloseTo(48_000, 6);
    expect(values(second)[1]).toBeCloseTo(8_000, 6);
  });
  it('離れた2つの実体の最短距離を求め、中心間の距離と混同しない', async () => {
    const initial = boxPart(), id = initial.id;
    let document = initial.document;
    const other = { ...createPrimitiveFeature(document, 'box'), shape: document.solids[0].kind === 'primitive'
      ? document.solids[0].shape : createPrimitiveFeature(document, 'box').shape,
      origin: { kind: 'coordinate' as const, value: absoluteCoordinate(100, 0, 0) } };
    document = appendSolid(document, other);
    const result = await recomputePart(document, kernel(), { mathGeometry: requests(document,
      { kind: 'shape-distance', first: { kind: 'body', featureId: id }, second: { kind: 'body', featureId: other.id } }) });
    expect(values(result)[0]).toBeCloseTo(80, 6);
  });
  it('実際の辺・面・頂点を指紋で選び直し、保存した位置そのものを答えにしない', async () => {
    const { document, id } = boxPart(), bridge = kernel();
    const result = await recomputePart(document, bridge), body = result.bodies[0];
    const edge = body.edges.find(candidate => Math.abs(candidate.length - 20) < 1e-6);
    const face = body.faces.find(candidate => Math.abs(candidate.area - 600) < 1e-6);
    const vertex = body.vertices[0];
    if (edge === undefined || face === undefined) throw new Error('Known box topology missing');
    const edgeRef: MathSubShapeReference<'edge'> = { bodyFeatureId: id, index: edge.index, fingerprint: {
      kind: 'edge', curveKind: edge.curveKind, length: edge.length, position: edge.midpoint, axis: edge.axis, radius: edge.radius } };
    const faceRef: MathSubShapeReference<'face'> = { bodyFeatureId: id, index: face.index, fingerprint: {
      kind: 'face', surfaceKind: face.surfaceKind, area: face.area, position: face.centroid, axis: face.axis, radius: face.radius } };
    const vertexRef: MathSubShapeReference<'vertex'> = { bodyFeatureId: id, index: vertex.index, fingerprint: {
      kind: 'vertex', position: [vertex.position[0] + 0.01, vertex.position[1], vertex.position[2]] } };
    const measured = await recomputePart(document, bridge, { mathGeometry: requests(document,
      { kind: 'length', curve: { kind: 'edge', reference: edgeRef } }, { kind: 'area', shape: { kind: 'face', reference: faceRef } },
      { kind: 'coordinate', point: { kind: 'vertex', reference: vertexRef }, component: 'X' }) });
    expect(values(measured)).toEqual([edge.length, face.area, vertex.position[0]]);
    expect(values(measured)[2]).not.toBe(vertexRef.fingerprint.position[0]);
  });
  it.each(['deleted', 'suppressed', 'invalid'] as const)('%sの参照は数値の代用品を返さない', async state => {
    const { document, id } = boxPart();
    const changed: PartDocument = { ...document, solids: state === 'deleted' ? [] : document.solids.map(feature =>
      state === 'suppressed' ? { ...feature, suppressed: true } : feature.kind === 'primitive'
        ? { ...feature, shape: { kind: 'box', sizeX: expressionValueFromNumber(-1), sizeY: expressionValueFromNumber(30), sizeZ: expressionValueFromNumber(40) } }
        : feature) };
    const result = await recomputePart(changed, kernel(), { mathGeometry: requests(document, { kind: 'volume', body: { kind: 'body', featureId: id } }) });
    expect(result.mathGeometry?.[0].status).toBe('unresolved');
  });
  it('文書の違い・重複ID・不正な許容差を拒否し、測定部へ渡さない', async () => {
    const { document, id } = boxPart(), bridge = kernel(), measure = vi.spyOn(bridge, 'measure');
    const source = requests(document, { kind: 'area', shape: { kind: 'body', featureId: id } })[0];
    const result = await recomputePart(document, bridge, { mathGeometry: [
      { ...source, id: 'other', documentId: 'other-part' }, source, source,
      { ...source, id: 'zero', tolerance: { ...tolerance, linearMm: 0 } },
      { ...source, id: 'nan', tolerance: { ...tolerance, angularRadians: Number.NaN } },
    ] });
    expect(result.mathGeometry).toHaveLength(5);
    for (const item of result.mathGeometry ?? []) expect(item).toMatchObject({ status: 'unresolved', reason: 'invalid-request' });
    expect(measure).not.toHaveBeenCalled();
  });
  it('直線の角度・平行・垂直を明示単位と許容差で求める', async () => {
    let document = createEmptyPartDocument(), sketch = document.sketches[0];
    const line = (id: string, to: ReturnType<typeof absoluteCoordinate>): SketchLineFeature => ({
      kind: 'line', id, name: id, planeId: 'xy', from: absoluteCoordinate(0, 0, 0), to, construction: false });
    sketch = appendFeature(sketch, line('horizontal', absoluteCoordinate(10, 0, 0)));
    sketch = appendFeature(sketch, line('vertical', absoluteCoordinate(0, 10, 0)));
    document = replaceSketch(document, sketch);
    const first = { kind: 'sketch-curve' as const, sketchId: sketch.id, featureId: 'horizontal' };
    const second = { ...first, featureId: 'vertical' };
    const result = await recomputePart(document, kernel(), { mathGeometry: requests(document,
      { kind: 'angle', first, second, unit: 'degree' }, { kind: 'angle', first, second, unit: 'radian' },
      { kind: 'parallel', first, second }, { kind: 'perpendicular', first, second }) });
    expect(values(result)).toEqual([90, Math.PI / 2, false, true]);
  });
  it('測定中の取消は既に求めた値も含めて全て捨てる', async () => {
    const { document, id } = boxPart(), bridge = kernel();
    const onResolved = vi.fn();
    let cancelled = false;
    const original = bridge.measure.bind(bridge);
    vi.spyOn(bridge, 'measure').mockImplementation(async (...args) => {
      const result = await original(...args); cancelled = true; return result;
    });
    const result = await recomputePart(document, bridge, { onResolved, shouldCancel: () => cancelled, mathGeometry: requests(document,
      { kind: 'volume', body: { kind: 'body', featureId: id } }, { kind: 'area', shape: { kind: 'body', featureId: id } }) });
    expect(result.cancelled).toBe(true);
    expect(result.mathGeometry).toBeUndefined();
    expect(onResolved).not.toHaveBeenCalled();
  });
  it.each(['failed', 'non-finite', 'negative'] as const)('測定の%sを正しい形の数値と取り違えない', async mode => {
    const { document, id } = boxPart(), bridge = kernel();
    const outcome: MeasureOutcome = mode === 'failed' ? { kind: 'failed', message: '計算部から測定できません。' }
      : { kind: 'massProperties', area: mode === 'non-finite' ? Number.NaN : -1, volume: 1,
        centreOfMass: [0, 0, 0], principalMoments: [1, 1, 1], principalAxes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] };
    vi.spyOn(bridge, 'measure').mockResolvedValue(outcome);
    const result = await recomputePart(document, bridge, { mathGeometry: requests(document, { kind: 'area', shape: { kind: 'body', featureId: id } }) });
    expect(result.mathGeometry?.[0]).toMatchObject({ status: 'unresolved', reason: 'failed-geometry' });
    expect(result.bodies).toHaveLength(1);
  });
  it('結合の順序を入れ替えて同じ向き・大きさの面の番号が入れ替わると、どちらかを推測せず曖昧と返す', async () => {
    const bridge = kernel(), measure = vi.spyOn(bridge, 'measure'), before = separatedBoxes(), after = separatedBoxes(true);
    const first = await recomputePart(before, bridge);
    expect(first.errors).toEqual([]);
    const [near, far] = topFaces(first.bodies[0]);
    expect(far.centroid[0] - near.centroid[0]).toBeCloseTo(100, 6);
    expect(far.area).toBeCloseTo(near.area, 9);
    const middle = (near.centroid[0] + far.centroid[0]) / 2;
    const reference = faceReference('joined', near);
    const area: MathGeometryQuantity = { kind: 'area', shape: { kind: 'face', reference } };
    // Before the change the saved number still names the near face, so it is measured as before.
    expect(values(await recomputePart(before, bridge, { mathGeometry: requests(before, area) }))).toEqual([near.area]);
    const changed = await recomputePart(after, bridge, { mathGeometry: requests(after, area,
      { kind: 'shape-distance', first: { kind: 'face', reference }, second: { kind: 'body', featureId: 'joined' } }) });
    const body = changed.bodies[0];
    expect(changed.errors).toEqual([]);
    // The saved number now belongs to the far top face, while the saved position still names the near one.
    const [nearNow, farNow] = topFaces(body);
    expect(farNow.index).toBe(reference.index);
    expect(nearNow.index).not.toBe(reference.index);
    expect(nearNow.centroid[0]).toBeCloseTo(near.centroid[0], 9);
    expect(farNow.centroid[0]).toBeCloseTo(far.centroid[0], 9);
    expect(changed.mathGeometry).toHaveLength(2);
    for (const outcome of changed.mathGeometry ?? []) {
      expect(outcome).toMatchObject({ status: 'unresolved', reason: 'ambiguous-reference', message: AMBIGUOUS_MESSAGE });
    }
    // Neither face reaches the kernel measurement, which would otherwise pick one silently.
    expect(measure).not.toHaveBeenCalled();
    const scores = scoreSubShapeMatch(body, reference);
    expect(scores?.runnerUpScore ?? Number.NaN).toBeCloseTo(scores?.score ?? 0, 12);
    // The shared pick for machining, appearance and mates is unchanged and still returns one of the two faces.
    const guessed = selectMateTargetGeometry(body, reference);
    expect(guessed === null ? null : Math.abs(guessed.position[0] - middle)).toBeCloseTo(50, 6);
  });
  it.each([[7, 'ambiguous-reference'], [9, 'value']] as const)(
    '同じ大きさの2面の中間から近い面へ%imm寄せた指紋は%s（次点との差0.05が境目）', async (shift, expected) => {
      const bridge = kernel(), document = separatedBoxes();
      const body = (await recomputePart(document, bridge)).bodies[0];
      const [near, far] = topFaces(body);
      const middle = (near.centroid[0] + far.centroid[0]) / 2;
      // A renumbered shape keeps no saved number, so only direction, size and position decide.
      const reference: MathSubShapeReference<'face'> = { bodyFeatureId: 'joined', index: body.faces.length, fingerprint: {
        kind: 'face', surfaceKind: near.surfaceKind, area: near.area, position: [middle - shift, near.centroid[1], near.centroid[2]],
        axis: near.axis, radius: near.radius } };
      const scores = scoreSubShapeMatch(body, reference);
      // Half the diagonal of the 120×30×40 extent is 65 mm, so the position weight 0.2 separates them by 0.4×shift/65.
      expect(scores === null || scores.runnerUpScore === null ? null : scores.score - scores.runnerUpScore).toBeCloseTo(0.4 * shift / 65, 9);
      expect(scores?.runnerUpScore ?? 0).toBeGreaterThanOrEqual(SUB_SHAPE_MATCH_THRESHOLD);
      expect(scores?.index).toBe(near.index);
      const result = await recomputePart(document, bridge, { mathGeometry: requests(document, { kind: 'area', shape: { kind: 'face', reference } }) });
      const outcome = result.mathGeometry?.[0];
      expect(outcome?.status === 'unresolved' ? outcome.reason : outcome?.status).toBe(expected);
      expect(outcome?.status === 'value' ? outcome.value : null).toBe(expected === 'value' ? near.area : null);
    });
  it('通常の箱の面・辺・頂点26個は曖昧にならず、横20→25でも同じ番号の形を測る', async () => {
    const bridge = kernel(), original = boxPart(), resized = boxPart(25);
    expect(resized.id).toBe(original.id);
    const source = (await recomputePart(original.document, bridge)).bodies[0];
    const quantities = everyQuantity(source), references = everyReference(source);
    expect(quantities).toHaveLength(26);
    for (const [document, surface] of [[original.document, 5_200], [resized.document, 5_900]] as const) {
      const result = await recomputePart(document, bridge, { mathGeometry: requests(document, ...quantities) });
      const body = result.bodies[0], measured = values(result);
      expect(measured).toEqual(everyValue(body));
      expect(measured.slice(0, body.faces.length).reduce<number>((sum, value) => sum + (typeof value === 'number' ? value : Number.NaN), 0))
        .toBeCloseTo(surface, 6);
      // Even the closest runner-up of a plain box trails by more than five times the ambiguity margin.
      const margins = references.map(reference => {
        const scores = scoreSubShapeMatch(body, reference);
        return scores === null ? Number.NaN : scores.score - (scores.runnerUpScore ?? 0);
      });
      expect(Math.min(...margins)).toBeGreaterThan(5 * MATH_GEOMETRY_AMBIGUITY_MARGIN);
    }
  });
  it('次点付きの採点は既存の選び直しと同じ候補を選び（既存の実測値を変えない）、別の形や候補の無い形には答えない', async () => {
    const bridge = kernel();
    const bodies = [(await recomputePart(boxPart().document, bridge)).bodies[0],
      (await recomputePart(separatedBoxes(), bridge)).bodies[0], (await recomputePart(separatedBoxes(true), bridge)).bodies[0]];
    let compared = 0;
    for (const source of bodies) {
      for (const reference of everyReference(source)) {
        expect(scoreSubShapeMatch(source, reference)?.index).toBe(reference.index);
        // Read against every body, including the renumbered union where two top faces tie.
        for (const body of bodies) {
          const scores = scoreSubShapeMatch(body, reference), picked = selectMateTargetGeometry(body, reference);
          expect(scores === null ? null : positionAt(body, reference, scores.index)).toEqual(picked === null ? null : picked.position);
          if (scores !== null) {
            expect(scores.score).toBeGreaterThanOrEqual(SUB_SHAPE_MATCH_THRESHOLD);
            expect(scores.runnerUpScore ?? SUB_SHAPE_MATCH_THRESHOLD).toBeGreaterThanOrEqual(SUB_SHAPE_MATCH_THRESHOLD);
            expect(scores.runnerUpScore ?? 0).toBeLessThanOrEqual(scores.score);
            compared += 1;
          }
        }
        expect(scoreSubShapeMatch({ ...source, featureId: 'other' }, reference)).toBeNull();
        expect(scoreSubShapeMatch({ ...source, faces: [], edges: [], vertices: [] }, reference)).toBeNull();
      }
    }
    // Every reference resolves on its own body (26 + 2 × 52); faces and edges also resolve across the two unions.
    expect(compared).toBeGreaterThan(26 + 2 * 52);
    // A plain box face has no second face at the threshold, so its runner-up is absent rather than a low number.
    expect(referencesOf(bodies[0]).faces.map(reference => scoreSubShapeMatch(bodies[0], reference)?.runnerUpScore))
      .toEqual(Array.from({ length: 6 }, () => null));
  });
});

function contourPart(feature: SketchFeature) {
  const initial = createEmptyPartDocument(), sketch = appendFeature(initial.sketches[0], feature);
  return { document: replaceSketch(initial, sketch),
    curve: { kind: 'sketch-curve' as const, sketchId: sketch.id, featureId: feature.id },
    contour: { kind: 'contour-length' as const, sketchId: sketch.id, featureId: feature.id } };
}
function arcFeature(start = 0, end = 90, radius = 10): SketchArcFeature {
  return { kind: 'arc', id: 'arc-measured', name: '円弧', planeId: 'xy', construction: false,
    center: absoluteCoordinate(0, 0, 0), radius: expressionValueFromNumber(radius),
    startAngle: expressionValueFromNumber(start), endAngle: expressionValueFromNumber(end) };
}

describe('GR-10 半径・中心角・輪郭全体の長さ', () => {
  it('半径10の円弧の半径と長さを現在のスケッチから求める', async () => {
    const { document, curve } = contourPart(arcFeature());
    const result = await recomputePart(document, kernel(), { mathGeometry: requests(document,
      { kind: 'radius', curve }, { kind: 'length', curve }) });
    expect(values(result)[0]).toBe(10);
    expect(values(result)[1]).toBeCloseTo(5 * Math.PI, 12);
    expect(result.mathGeometry?.[0]).toMatchObject({ unit: 'mm' });
  });
  it.each([
    { start: 0, end: 90, degrees: 90 }, { start: 90, end: 0, degrees: 90 },
    { start: 0, end: 270, degrees: 270 }, { start: 0, end: -270, degrees: 270 },
    { start: 30, end: 390, degrees: 360 },
  ])('円弧の中心角 $start → $end は $degrees 度で折り返さない', async ({ start, end, degrees }) => {
    const { document, curve } = contourPart(arcFeature(start, end));
    const result = await recomputePart(document, kernel(), { mathGeometry: requests(document,
      { kind: 'central-angle', curve, unit: 'degree' }, { kind: 'central-angle', curve, unit: 'radian' }) });
    expect(values(result)[0]).toBeCloseTo(degrees, 10);
    expect(values(result)[1]).toBeCloseTo(degrees * Math.PI / 180, 12);
    expect(result.mathGeometry?.map(outcome => outcome.status === 'value' && outcome.kind === 'real' ? outcome.unit : null))
      .toEqual(['degree', 'radian']);
  });
  it('同じ円弧の半径・角度の変更に追従する', async () => {
    const first = contourPart(arcFeature()), next = contourPart(arcFeature(0, 180, 25)), bridge = kernel();
    const input = requests(first.document, { kind: 'radius', curve: first.curve },
      { kind: 'central-angle', curve: first.curve, unit: 'degree' });
    expect(values(await recomputePart(first.document, bridge, { mathGeometry: input }))).toEqual([10, 90]);
    expect(values(await recomputePart(next.document, bridge, { mathGeometry: input }))).toEqual([25, 180]);
  });
  it('現在の円の辺から半径と360度を求め、古い指紋の半径・長さを値にしない', async () => {
    const initial = createEmptyPartDocument(), feature = createPrimitiveFeature(initial, 'cylinder');
    const document = appendSolid(initial, { ...feature, shape: { kind: 'cylinder',
      radius: expressionValueFromNumber(10), height: expressionValueFromNumber(30) } }), bridge = kernel();
    const body = (await recomputePart(document, bridge)).bodies[0];
    const circle = body.edges.find(edge => edge.curveKind === 'circle');
    if (circle === undefined) throw new Error('Expected circular edge');
    const reference = edgeReference(body.featureId, circle);
    const curve: MathGeometryCurve = { kind: 'edge', reference: { ...reference,
      fingerprint: { ...reference.fingerprint, radius: 9.9, length: circle.length - 0.1 } } };
    const input = requests(document, { kind: 'radius', curve }, { kind: 'central-angle', curve, unit: 'degree' },
      { kind: 'central-angle', curve, unit: 'radian' });
    const measured = await recomputePart(document, bridge, { mathGeometry: input });
    expect(values(measured)[0]).toBeCloseTo(10, 12);
    expect(values(measured)[1]).toBeCloseTo(360, 10);
    expect(values(measured)[2]).toBeCloseTo(2 * Math.PI, 12);
    // Transform hides the original body; radius and central-angle must request its current cached metadata.
    const moved = rotateBox(document, feature.id, 30);
    const read = vi.spyOn(bridge, 'readCachedBodies');
    const hidden = await recomputePart(moved, bridge, { mathGeometry: input });
    expect(values(hidden)).toEqual(values(measured));
    expect(read).toHaveBeenCalled();
    expect(hidden.bodies.map(value => value.featureId)).toEqual(['tilted']);
  });
  it('20×30の矩形は最初の辺だけでなく周長100を返す', async () => {
    const { document, contour, curve } = contourPart({ kind: 'rectangle', id: 'rectangle-measured', name: '矩形',
      planeId: 'xy', construction: false, corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(20, 30, 0) });
    const result = await recomputePart(document, kernel(), { mathGeometry: requests(document, contour) });
    expect(values(result)).toEqual([100]);
    expect(mathGeometryTargetsOf(contour)).toEqual([curve]);
  });
  it('長穴の2線分と2円弧を全部合計する', async () => {
    const { document, contour } = contourPart({ kind: 'slot', id: 'slot-measured', name: '長穴',
      planeId: 'xy', construction: false, center1: absoluteCoordinate(0, 0, 0), center2: absoluteCoordinate(20, 0, 0),
      width: expressionValueFromNumber(10) });
    const result = await recomputePart(document, kernel(), { mathGeometry: requests(document, contour) });
    expect(values(result)[0]).toBeCloseTo(40 + 10 * Math.PI, 10);
  });
  it('単独の円弧も輪郭全体として測る', async () => {
    const { document, contour } = contourPart(arcFeature());
    const result = await recomputePart(document, kernel(), { mathGeometry: requests(document, contour) });
    expect(values(result)[0]).toBeCloseTo(5 * Math.PI, 12);
  });
  it.each(['ellipse', 'spline'] as const)('%sを含む輪郭は理由付きunsupported', async kind => {
    const base = { id: 'unsupported-contour', name: '輪郭', planeId: 'xy', construction: false };
    const feature: SketchFeature = kind === 'ellipse' ? { ...base, kind, center: absoluteCoordinate(0, 0, 0),
      majorRadius: expressionValueFromNumber(20), minorRadius: expressionValueFromNumber(10),
      rotation: expressionValueFromNumber(0), startAngle: expressionValueFromNumber(0), endAngle: expressionValueFromNumber(360) }
      : { ...base, kind, mode: 'interpolate', closed: false,
        points: [absoluteCoordinate(0, 0, 0), absoluteCoordinate(10, 10, 0), absoluteCoordinate(20, 0, 0)] };
    const { document, contour } = contourPart(feature);
    const result = await recomputePart(document, kernel(), { mathGeometry: requests(document, contour) });
    expect(result.mathGeometry?.[0]).toMatchObject({ status: 'unresolved', reason: 'unsupported',
      message: '楕円や自由曲線を含む輪郭の長さには対応していません。' });
  });
  it.each(['radius', 'central-angle'] as const)('直線の%sは非対応', async kind => {
    const { document, curve } = contourPart({ kind: 'line', id: 'line-measured', name: '直線', planeId: 'xy',
      construction: false, from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(10, 0, 0) });
    const quantity: MathGeometryQuantity = kind === 'radius' ? { kind, curve } : { kind, curve, unit: 'degree' };
    const result = await recomputePart(document, kernel(), { mathGeometry: requests(document, quantity) });
    expect(result.mathGeometry?.[0]).toMatchObject({ status: 'unresolved', reason: 'unsupported' });
    expect(mathGeometryTargetsOf(quantity)).toEqual([curve]);
  });
  it.each(['feature', 'sketch'] as const)('輪郭の%sが失われたときは0や別の形を返さない', async missing => {
    const { document, contour } = contourPart(arcFeature());
    const quantity = { ...contour, ...(missing === 'feature' ? { featureId: 'gone' } : { sketchId: 'gone' }) };
    const result = await recomputePart(document, kernel(), { mathGeometry: requests(document, quantity) });
    expect(result.mathGeometry?.[0]).toMatchObject({ status: 'unresolved', reason: 'missing-reference' });
  });
});


function coordinateFramePart(origin: Vec3 = [1, 2, 3], visible = true) {
  const { document, first, second } = threePointPart([[4, 6, 8], origin, [0, 0, 0]]);
  if (second.kind !== 'sketch-point') throw new Error('Expected sketch origin');
  const frame: ReferenceCoordinateSystemFeature = { kind: 'referenceCoordinateSystem', id: 'measured-frame',
    name: '測定座標系', visible, origin: second.reference,
    xAxis: { kind: 'world', axis: 'y' }, yAxis: { kind: 'world', axis: 'z' } };
  const withFrame: PartDocument = { ...document, references: [frame] };
  const quantities = (['X', 'Y', 'Z'] as const).map((component): MathGeometryQuantity => ({ kind: 'coordinate',
    point: first, component, frame: { kind: 'reference', featureId: frame.id } }));
  return { document: withFrame, point: first, frame, quantities };
}

describe('GR-10b 現在の座標系で測る座標', () => {
  it.each([
    { component: 'X', local: 4, world: 4 },
    { component: 'Y', local: 5, world: 6 },
    { component: 'Z', local: 3, world: 8 },
  ] as const)('回転した座標系の$component成分とframeなしの世界座標を区別する', async ({ component, local, world }) => {
    const { document, point, frame } = coordinateFramePart();
    const result = await recomputePart(document, kernel(), { mathGeometry: requests(document,
      { kind: 'coordinate', point, component, frame: { kind: 'reference', featureId: frame.id } },
      { kind: 'coordinate', point, component }) });
    expect(result.errors).toEqual([]);
    expect(values(result)).toEqual([local, world]);
    expect(result.mathGeometry?.map(value => value.status === 'value' && value.kind === 'real' ? value.unit : null)).toEqual(['mm', 'mm']);
  });

  it('同じ保存定義で原点の変更に追従し、負の座標も丸めず返す', async () => {
    const initial = coordinateFramePart(), bridge = kernel();
    const definitions = requests(initial.document, ...initial.quantities).map(request => ({ ...request, name: request.id }));
    expect(values(await recomputePart({ ...initial.document, mathGeometry: definitions }, bridge))).toEqual([4, 5, 3]);
    const moved = coordinateFramePart([5, 7, 9]);
    expect(values(await recomputePart({ ...moved.document, mathGeometry: definitions }, bridge))).toEqual([-1, -1, -1]);
  });

  it('同じ保存定義で軸の向きの変更に追従する', async () => {
    const { document, frame, quantities } = coordinateFramePart(), bridge = kernel();
    const definitions = requests(document, ...quantities).map(request => ({ ...request, name: request.id }));
    expect(values(await recomputePart({ ...document, mathGeometry: definitions }, bridge))).toEqual([4, 5, 3]);
    const changed: PartDocument = { ...document, mathGeometry: definitions, references: [{ ...frame,
      xAxis: { kind: 'world', axis: 'x' }, yAxis: { kind: 'world', axis: 'y' } }] };
    expect(values(await recomputePart(changed, bridge))).toEqual([3, 4, 5]);
  });

  it('非表示の座標系も現在の解決結果から測る', async () => {
    const { document, quantities } = coordinateFramePart([1, 2, 3], false);
    expect(resolvePart(document).references.coordinateSystems[0].visible).toBe(false);
    expect(values(await recomputePart(document, kernel(), { mathGeometry: requests(document, ...quantities) }))).toEqual([4, 5, 3]);
  });

  it.each(['deleted', 'other-id', 'wrong-kind'] as const)('座標系の%sを理由付き未解決にし、世界座標や同名の別座標系へ戻さない', async scenario => {
    const { document, frame, quantities } = coordinateFramePart();
    const references: PartDocument['references'] = scenario === 'deleted' ? [] : scenario === 'other-id'
      ? [{ ...frame, id: 'another-frame' }]
      : [{ id: frame.id, name: frame.name, visible: true, kind: 'referencePoint',
        definition: { kind: 'coordinate', at: absoluteCoordinate(1, 2, 3) } }];
    const result = await recomputePart({ ...document, references }, kernel(), { mathGeometry: requests(document, ...quantities) });
    expect(result.mathGeometry).toHaveLength(3);
    for (const outcome of result.mathGeometry ?? []) expect(outcome).toMatchObject({ status: 'unresolved', reason: 'missing-reference',
      message: '参照する現在の図形を確認できません。参照先を選び直してください。' });
  });

  it('軸が平行で座標系を解決できなければ、その理由を測定にも返す', async () => {
    const { document, frame, quantities } = coordinateFramePart();
    const changed: PartDocument = { ...document, references: [{ ...frame, yAxis: frame.xAxis }] };
    const resolved = resolvePart(changed);
    expect(resolved.references.coordinateSystems).toEqual([]);
    expect(resolved.references.errors[0].code).toBe('degenerate');
    const result = await recomputePart(changed, kernel(), { mathGeometry: requests(changed, ...quantities) });
    for (const outcome of result.mathGeometry ?? []) expect(outcome).toMatchObject({ status: 'unresolved', reason: 'failed-geometry',
      message: resolved.references.errors[0].message });
    expect(result.mathGeometry).toHaveLength(3);
  });

  it.each(['failedIds', 'reference-error'] as const)('%sを解決済み座標系より優先し、古い値を返さない', async failure => {
    const { document, frame, quantities } = coordinateFramePart(), current = resolvePart(document);
    const message = '座標系の上流を解決できません。';
    const resolved = failure === 'reference-error' ? { ...current, references: { ...current.references,
      errors: [{ featureId: frame.id, code: 'missingAxis' as const, message }] } } : current;
    const outcomes = await evaluateMathGeometry(requests(document, ...quantities), { documentId: document.id, generation: 9,
      resolved, bodies: [], failedIds: new Set(failure === 'failedIds' ? [frame.id] : []), bridge: kernel(), shouldCancel: () => false });
    expect(outcomes).toHaveLength(3);
    for (const outcome of outcomes ?? []) expect(outcome).toMatchObject({ status: 'unresolved', reason: 'failed-geometry',
      message: failure === 'reference-error' ? message : '参照先の座標系を正しく計算できませんでした。' });
  });

  it.each(['origin', 'xAxis', 'yAxis', 'zAxis'] as const)('座標系の%sが非有限なら選んだ成分に関わらず拒否する', async field => {
    const { document, quantities } = coordinateFramePart(), current = resolvePart(document);
    const invalid: Vec3 = [Number.NaN, 0, 0];
    const resolved = { ...current, references: { ...current.references,
      coordinateSystems: current.references.coordinateSystems.map(frame => ({ ...frame, [field]: invalid })) } };
    const outcomes = await evaluateMathGeometry(requests(document, ...quantities), { documentId: document.id, generation: 10,
      resolved, bodies: [], failedIds: new Set(), bridge: kernel(), shouldCancel: () => false });
    expect(outcomes).toHaveLength(3);
    for (const outcome of outcomes ?? []) expect(outcome).toMatchObject({ status: 'unresolved', reason: 'failed-geometry',
      message: '座標系の原点と軸を正しく取得できませんでした。' });
  });

  it('同じIDの解決済み座標系が複数なら先頭を選ばない', async () => {
    const { document, quantities } = coordinateFramePart(), current = resolvePart(document);
    const resolved = { ...current, references: { ...current.references,
      coordinateSystems: [...current.references.coordinateSystems, ...current.references.coordinateSystems] } };
    const outcomes = await evaluateMathGeometry(requests(document, ...quantities), { documentId: document.id, generation: 11,
      resolved, bodies: [], failedIds: new Set(), bridge: kernel(), shouldCancel: () => false });
    expect(outcomes).toHaveLength(3);
    for (const outcome of outcomes ?? []) expect(outcome).toMatchObject({ status: 'unresolved', reason: 'missing-reference' });
  });

  it('座標の対象列挙は点と座標系の両方を返し、省略時は点だけを返す', () => {
    const { point, frame } = coordinateFramePart();
    const target: MathGeometryFrame = { kind: 'reference', featureId: frame.id };
    expect(mathGeometryTargetsOf({ kind: 'coordinate', point, component: 'X', frame: target })).toEqual([point, target]);
    expect(mathGeometryTargetsOf({ kind: 'coordinate', point, component: 'X' })).toEqual([point]);
  });
});

function comparisonPart(firstFeature: SketchFeature, secondFeature: SketchFeature) {
  const initial = createEmptyPartDocument();
  const sketch = appendFeature(appendFeature(initial.sketches[0], firstFeature), secondFeature);
  const first: MathGeometryCurve = { kind: 'sketch-curve', sketchId: sketch.id, featureId: firstFeature.id };
  const second: MathGeometryCurve = { kind: 'sketch-curve', sketchId: sketch.id, featureId: secondFeature.id };
  const quantities: readonly MathGeometryQuantity[] = [{ kind: 'congruent', first, second }, { kind: 'similar', first, second }];
  return { document: replaceSketch(initial, sketch), first, second, quantities };
}
function comparisonRectangle(id: string, width: number, height: number): SketchFeature {
  return { kind: 'rectangle', id, name: id, planeId: 'xy', construction: false,
    corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(width, height, 0) };
}

describe('GR-11 現在の図形による合同・相似と参照の接続', () => {
  it('位置と向きの違う等長線分を実スケッチから比べる', async () => {
    const first: SketchLineFeature = { kind: 'line', id: 'a', name: 'a', planeId: 'xy', construction: false,
      from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(3, 4, 0) };
    const second: SketchLineFeature = { ...first, id: 'b', from: absoluteCoordinate(20, 30, 0), to: absoluteCoordinate(20, 25, 0) };
    const { document, quantities } = comparisonPart(first, second);
    const result = await recomputePart(document, kernel(), { mathGeometry: requests(document, ...quantities) });
    expect(result.errors).toEqual([]);
    expect(values(result)).toEqual([true, true]);
    for (const outcome of result.mathGeometry ?? []) expect(outcome).toMatchObject({ documentId: document.id,
      generation: result.generation, kind: 'boolean', representation: 'geometry-double', tolerance });
  });
  it('円弧の向きと開始位置を除いて中心角と半径を比較する', async () => {
    const { document, quantities } = comparisonPart(arcFeature(0, 90), { ...arcFeature(180, 90), id: 'b' });
    expect(values(await recomputePart(document, kernel(), { mathGeometry: requests(document, ...quantities) }))).toEqual([true, true]);
    const changed = comparisonPart(arcFeature(0, 90), { ...arcFeature(180, 0), id: 'b' });
    expect(values(await recomputePart(changed.document, kernel(), { mathGeometry: requests(document, ...quantities) })))
      .toEqual([false, false]);
  });
  it('四角形の全辺を比べ、形と同じIDの寸法の変更を測り直す', async () => {
    const first = comparisonPart(comparisonRectangle('a', 4, 2), comparisonRectangle('b', 4, 2));
    const doubled = comparisonPart(comparisonRectangle('a', 4, 2), comparisonRectangle('b', 8, 4));
    const distorted = comparisonPart(comparisonRectangle('a', 4, 2), comparisonRectangle('b', 8, 3));
    const input = requests(first.document, ...first.quantities), bridge = kernel();
    expect(values(await recomputePart(first.document, bridge, { mathGeometry: input }))).toEqual([true, true]);
    expect(values(await recomputePart(doubled.document, bridge, { mathGeometry: input }))).toEqual([false, true]);
    expect(values(await recomputePart(distorted.document, bridge, { mathGeometry: input }))).toEqual([false, false]);
  });
  it('定義ごとのT3を評価し、判定結果は係数へ渡さない', async () => {
    const { document, quantities } = comparisonPart(comparisonRectangle('a', 4, 2), comparisonRectangle('b', 4.001, 2));
    const inputs = requests(document, quantities[0], quantities[0]).map((input, index) => ({ ...input,
      tolerance: { linearMm: index === 0 ? 0.0009 : 0.0011, angularRadians: 1e-6 } }));
    const result = await recomputePart(document, kernel(), { mathGeometry: inputs });
    expect(result.mathGeometry?.map(outcome => outcome.status === 'value' ? outcome.value : null)).toEqual([false, true]);
    for (const [index, input] of inputs.entries()) {
      const definition = { ...input, name: '判定' };
      expect(mathGeometryCoefficientValue(document, definition, result.mathGeometry?.[index])).toEqual({ status: 'boolean' });
      expect(result.mathGeometry?.[index]).toMatchObject({ tolerance: input.tolerance });
    }
  });
  it('線分と円弧、三角形と四角形は偽でなくunsupportedになる', async () => {
    const line: SketchLineFeature = { kind: 'line', id: 'a', name: 'a', planeId: 'xy', construction: false,
      from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(5, 0, 0) };
    const triangle: SketchFeature = { kind: 'polygon', id: 'triangle', name: '三角形', planeId: 'xy', construction: false,
      center: absoluteCoordinate(0, 0, 0), radiusMode: 'circumscribed', radius: expressionValueFromNumber(3), sides: expressionValueFromNumber(3) };
    for (const pair of [comparisonPart(line, arcFeature()), comparisonPart(triangle, comparisonRectangle('rectangle', 4, 2))]) {
      const result = await recomputePart(pair.document, kernel(), { mathGeometry: requests(pair.document, ...pair.quantities) });
      expect(result.mathGeometry).toHaveLength(2);
      for (const outcome of result.mathGeometry ?? []) expect(outcome).toMatchObject({ status: 'unresolved', reason: 'unsupported' });
    }
  });
  it('対象列挙と依存解析へ両方のスケッチを渡し、削除した参照を残す', async () => {
    const { document, first, second, quantities } = comparisonPart(comparisonRectangle('a', 4, 2), comparisonRectangle('b', 4, 2));
    const source = document.sketches[0], other = { ...source, id: 'other-sketch', name: '別スケッチ' };
    const otherTarget: MathGeometryCurve = { ...second, sketchId: other.id, kind: 'sketch-curve', featureId: 'b' };
    for (const kind of ['congruent', 'similar'] as const) {
      const quantity = { kind, first, second: otherTarget };
      const definition = { ...requests(document, quantity)[0], name: '形の比較' };
      const withDefinition = { ...document, sketches: [source, other], mathGeometry: [definition] };
      expect(mathGeometryTargetsOf(quantity)).toEqual([first, otherTarget]);
      expect(analyzeMathGeometryDependencies(withDefinition).targets.get(definition.id)).toEqual(new Set([source.id, other.id]));
      const removed = { ...withDefinition, sketches: [source] };
      const result = await recomputePart(removed, kernel());
      expect(result.mathGeometry?.[0]).toMatchObject({ status: 'unresolved', reason: 'missing-reference' });
      expect(removed.mathGeometry).toEqual([definition]);
    }
    expect(quantities).toHaveLength(2);
  });
  it('立体の線分も現在の長さを使い、スケッチの線分と比べられる', async () => {
    const box = boxPart(), bridge = kernel();
    const body = (await recomputePart(box.document, bridge)).bodies[0];
    const edge = boxEdge(body, 0);
    const line: SketchLineFeature = { kind: 'line', id: 'line20', name: '線分', planeId: 'xy', construction: false,
      from: absoluteCoordinate(100, 0, 0), to: absoluteCoordinate(120, 0, 0) };
    const document = replaceSketch(box.document, appendFeature(box.document.sketches[0], line));
    const target: MathGeometryCurve = { kind: 'sketch-curve', sketchId: document.sketches[0].id, featureId: line.id };
    const quantities: readonly MathGeometryQuantity[] = [{ kind: 'congruent', first: edge, second: target },
      { kind: 'similar', first: edge, second: target }];
    expect(values(await recomputePart(document, bridge, { mathGeometry: requests(document, ...quantities) }))).toEqual([true, true]);
    expect(mathGeometryTargetsOf(quantities[0])).toEqual([edge, target]);
  });
  it('円の辺は古い指紋の寸法を使わず、隠れた上流の円も読取専用で比較する', async () => {
    const initial = createEmptyPartDocument(), feature = createPrimitiveFeature(initial, 'cylinder');
    const cylinder = appendSolid(initial, { ...feature, shape: { kind: 'cylinder',
      radius: expressionValueFromNumber(10), height: expressionValueFromNumber(30) } }), bridge = kernel();
    const circle = (await recomputePart(cylinder, bridge)).bodies[0].edges.find(edge => edge.curveKind === 'circle');
    if (circle === undefined) throw new Error('Expected circular edge');
    const reference = edgeReference(feature.id, circle);
    const edge: MathGeometryCurve = { kind: 'edge', reference: { ...reference,
      fingerprint: { ...reference.fingerprint, radius: 9.9, length: circle.length - 0.1 } } };
    const arc = arcFeature(30, 390, 10);
    const document = replaceSketch(cylinder, appendFeature(cylinder.sketches[0], arc));
    const sketch: MathGeometryCurve = { kind: 'sketch-curve', sketchId: document.sketches[0].id, featureId: arc.id };
    const input = requests(document, { kind: 'congruent', first: edge, second: sketch }, { kind: 'similar', first: edge, second: sketch });
    const read = vi.spyOn(bridge, 'readCachedBodies');
    const result = await recomputePart(rotateBox(document, feature.id, 30), bridge, { mathGeometry: input });
    expect(values(result)).toEqual([true, true]);
    expect(result.bodies.map(body => body.featureId)).toEqual(['tilted']);
    expect(read).toHaveBeenCalled();
  });
});
