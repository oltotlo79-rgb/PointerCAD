/** Test-only EX18 route-c inputs. Never import from product code or construct from oracle expectations. */
import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';

import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { createSubShapeReference } from '../kernelBridge/createSubShapeReference.js';
import { resolveSubShapeReference } from '../kernelBridge/referenceResolution.js';
import type { KernelBridge, SolidBody, SolidFaceEntry } from '../kernelBridge.js';
import { absoluteCoordinate, appendFeature, createPointFeature, DEFAULT_FACE_COLOR } from '../sketch/createSketchDocument.js';
import type { SketchDocument, SketchFaceFeature, SketchLineFeature } from '../sketch/types.js';
import { appendSolid, createEmptyPartDocument, replaceSketch } from './createPartDocument.js';
import { createFaceOffsetFeature } from './directFaceEdit.js';
import { recomputePart } from './recomputePart.js';
import type { ImportedShapeBytes } from './resolvePart.js';
import type { ExtrudeFeature, HoleFeature, ImportedSolidFeature, PartDocument, PrimitiveFeature, RevolveFeature } from './types.js';

export type Ex18DirectShape = 'A' | 'B' | 'C';
export interface Ex18DirectSeed {
  readonly part: PartDocument;
  readonly targetId: string;
  readonly importedShapes?: ImportedShapeBytes;
}

export function directExpression(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) throw new Error(`EX18 direct-route invalid expression: ${source}`);
  return result.value;
}

export function directPlanarFace(body: SolidBody, normal: readonly [number, number, number], position: number): SolidFaceEntry {
  const coordinate = normal.findIndex(value => value !== 0);
  const candidates = body.faces.filter(face => face.surfaceKind === 'plane' && face.axis !== null
    && Math.hypot(face.axis[0] - normal[0], face.axis[1] - normal[1], face.axis[2] - normal[2]) <= 1e-9
    && Math.abs(face.centroid[coordinate] - position) <= 1e-6);
  const [face] = candidates;
  if (!body.isValid || candidates.length !== 1 || face === undefined) throw new Error('EX18 direct-route unique planar face missing');
  return face;
}

/** Capture the current face through the product resolver, including its explicit fingerprint fallback policy. */
export function directFaceReference(body: SolidBody, face: SolidFaceEntry): SubShapeRef {
  const semantic = createSubShapeReference(body, 'face', face.index);
  if (semantic !== null) return semantic;
  if (body.origins?.state === 'tracked' && !body.origins.fingerprintFallback?.some(entry =>
    entry.current.kind === 'face' && entry.current.index === face.index)) {
    throw new Error('EX18 direct-route ambiguous semantic face');
  }
  const reference: SubShapeRef = { bodyFeatureId: body.featureId, index: face.index, fingerprint: {
    kind: 'face', surfaceKind: face.surfaceKind, area: face.area, position: face.centroid,
    axis: face.axis, radius: face.radius,
  } };
  const resolved = resolveSubShapeReference(body, reference);
  if (resolved.status !== 'matched' || resolved.match.reference.index !== face.index) {
    throw new Error('EX18 direct-route measured face not uniquely resolved');
  }
  return resolved.match.reference;
}

function xzProfile(sketch: SketchDocument, points: readonly (readonly [number, number, number])[]) {
  const lines: SketchLineFeature[] = points.map((point, index) => {
    const next = points[(index + 1) % points.length], id = `direct-line-${String(index + 1)}`;
    return { id, name: id, kind: 'line', planeId: 'xz', construction: false,
      from: absoluteCoordinate(point[0], point[1], point[2]), to: absoluteCoordinate(next[0], next[1], next[2]) };
  });
  const face: SketchFaceFeature = { id: 'direct-profile', name: 'direct-profile', kind: 'face', planeId: 'xz',
    boundary: lines.map(line => ({ featureId: line.id })), color: DEFAULT_FACE_COLOR };
  return { sketch: { ...sketch, features: [...sketch.features, ...lines, face] }, face };
}

export async function buildEx18DirectSeed(shape: Ex18DirectShape, bridge: KernelBridge): Promise<Ex18DirectSeed> {
  const empty = createEmptyPartDocument();
  if (shape === 'A') {
    let sketch = empty.sketches[0];
    const center = createPointFeature(sketch, absoluteCoordinate(10, 15, 8));
    sketch = appendFeature(sketch, center);
    const box: PrimitiveFeature = { id: 'direct-plate', name: 'direct-plate', kind: 'primitive', suppressed: false,
      origin: { kind: 'coordinate', value: absoluteCoordinate(20, 15, 4) }, axis: { kind: 'world', axis: 'z' },
      shape: { kind: 'box', sizeX: directExpression('40'), sizeY: directExpression('30'), sizeZ: directExpression('8') } };
    const plate = appendSolid(replaceSketch(empty, sketch), box);
    const built = await recomputePart(plate, bridge);
    const [body] = built.bodies;
    if (built.cancelled || built.errors.length > 0 || built.bodies.length !== 1 || body === undefined) {
      throw new Error(`EX18 direct seed plate failed: ${JSON.stringify(built.errors)}`);
    }
    const hole: HoleFeature = { id: 'direct-seed', name: 'direct-seed', kind: 'hole', suppressed: false,
      targetFeatureId: box.id, face: directFaceReference(body, directPlanarFace(body, [0, 0, 1], 8)),
      centers: [{ sketchId: sketch.id, pointFeatureId: center.id }], diameter: directExpression('6'),
      depth: { kind: 'through' }, tiltAngle: directExpression('0'), tiltAzimuth: directExpression('0') };
    return { part: appendSolid(plate, hole), targetId: hole.id };
  }
  const points = shape === 'B'
    ? [[3, 0, 0], [15, 0, 0], [15, 0, 5], [10, 0, 5], [10, 0, 20], [3, 0, 20]] as const
    : [[0, 0, 0], [20, 0, 0], [25, 0, 10], [5, 0, 10]] as const;
  const { sketch, face } = xzProfile(empty.sketches[0], points);
  const profile = { sketchId: sketch.id, faceFeatureId: face.id };
  const solid: RevolveFeature | ExtrudeFeature = shape === 'B'
    ? { id: 'direct-seed', name: 'direct-seed', kind: 'revolve', suppressed: false, profile,
      axis: { kind: 'world', axis: 'z' }, angle: directExpression('360'), reversed: false }
    : { id: 'direct-seed', name: 'direct-seed', kind: 'extrude', suppressed: false, profile,
      distance: directExpression('5'), reversed: true, symmetric: false };
  return { part: appendSolid(replaceSketch(empty, sketch), solid), targetId: solid.id };
}

/** STEP bytes pass through the same bridge import API used by ordinary file import. */
export async function importEx18DirectSeed(bridge: KernelBridge, fileName: string, bytes: Uint8Array): Promise<Ex18DirectSeed> {
  const imported = await bridge.importShape({ format: 'step', fileName, bytes });
  if (imported.kind !== 'imported' || imported.unit !== 'mm' || imported.bodies.length !== 1) {
    throw new Error(`EX18 direct STEP import failed: ${imported.kind}`);
  }
  const [body] = imported.bodies;
  if (body === undefined || body.bodyKind !== 'solid') throw new Error('EX18 STEP seed must contain one solid');
  return directImportedBrep(body.brepBytes, fileName, bytes.byteLength);
}

/** Also used by the multi-solid rejection control; it is not a STEP-path substitute. */
export function directImportedBrep(bytes: Uint8Array, fileName: string, byteLength: number): Ex18DirectSeed {
  const shapeRef = 'direct-imported-brep';
  const feature: ImportedSolidFeature = { id: 'direct-imported', name: 'direct-imported', kind: 'importedSolid',
    suppressed: false, shapeRef, bodyKind: 'solid', source: {
      format: 'step', fileName, unit: 'mm', byteLength, importedAt: '2026-10-24T00:00:00.000Z',
    } };
  return { part: appendSolid(createEmptyPartDocument(), feature), targetId: feature.id,
    importedShapes: new Map([[shapeRef, bytes]]) };
}

export function withEx18UnselectedBody(seed: Ex18DirectSeed): Ex18DirectSeed {
  const box: PrimitiveFeature = { id: 'direct-unselected', name: 'direct-unselected', kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(101, 103, 107) }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'box', sizeX: directExpression('2'), sizeY: directExpression('4'), sizeZ: directExpression('6') } };
  return { ...seed, part: appendSolid(seed.part, box) };
}

export function appendEx18DirectEdit(seed: Ex18DirectSeed, face: SubShapeRef, offset: string): PartDocument {
  return appendSolid(seed.part, createFaceOffsetFeature({ id: 'direct-edit', name: 'direct-edit',
    targetFeatureId: seed.targetId, face, offset: directExpression(offset) }));
}
