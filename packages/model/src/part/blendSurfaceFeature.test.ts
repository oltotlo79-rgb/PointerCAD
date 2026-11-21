import { expressionValueFromNumber as mm } from '@pointercad/expression';
import { createAllocations, createShapeCache, isValidShape, recomputeSolids, type CachedSolid, type SolidBodyMesh } from '@pointercad/kernel';
import { loadOcctForNode } from '@pointercad/kernel/testing/occt-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toSolidStepRequest } from '../kernelBridge/solidRequests.js';
import { absoluteCoordinate } from '../sketch/createSketchDocument.js';
import { appendSolid, consumedBodyIds, createEmptyPartDocument, DEFAULT_PRIMITIVE_AXIS, nextSolidName, removeSolid, replaceSolid } from './createPartDocument.js';
import { reevaluatePartDocument } from './reevaluatePart.js';
import { resolvePart } from './resolvePart.js';
import { dependenciesOf } from './timelineOrder.js';
import type { PartDocument, PrimitiveFeature, SubShapeRef, SurfaceFeature, SurfaceOperation } from './types.js';

type Blend = Extract<SurfaceOperation, { kind: 'blend' }>;
const cache = createShapeCache<CachedSolid>();
let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
let sheets: PartDocument, blend: Blend;
let boxA: PrimitiveFeature, boxB: PrimitiveFeature, supportA: SubShapeRef;
let otherA: SubShapeRef, otherB: SubShapeRef;
const near = (actual: number, expected: number) => Math.abs(actual - expected) < 1e-6;

function box(id: string, y: number, z: number): PrimitiveFeature {
  return { kind: 'primitive', id, name: id, suppressed: false, axis: DEFAULT_PRIMITIVE_AXIS,
    origin: { kind: 'coordinate', value: absoluteCoordinate(5, y, z) },
    shape: { kind: 'box', sizeX: mm(10), sizeY: mm(2), sizeZ: mm(2) } };
}

function surface(id: string, operation: SurfaceOperation, name: string): SurfaceFeature {
  return { id, name, kind: 'surface', suppressed: false, operation };
}

function requests(document: PartDocument) {
  const resolved = resolvePart(document);
  expect(resolved.errors).toEqual([]);
  return resolved.steps.map(toSolidStepRequest);
}

function body(bodies: readonly SolidBodyMesh[], id: string): SolidBodyMesh {
  const found = bodies.filter(value => value.id === id);
  expect(found).toHaveLength(1);
  return found[0];
}

function faceRef(source: SolidBodyMesh, axis: 1 | 2, offset: number): SubShapeRef {
  const faces = source.faces.filter(face => face.surfaceKind === 'plane' && face.axis !== null
    && near(Math.abs(face.axis[axis]), 1) && near(face.centroid[axis], offset));
  expect(faces).toHaveLength(1);
  const [face] = faces;
  return { bodyFeatureId: source.id, index: face.index, fingerprint: { kind: 'face', surfaceKind: face.surfaceKind,
    area: face.area, position: face.centroid, axis: face.axis, radius: face.radius } };
}

function boundary(source: SolidBodyMesh, y: number, z: number) {
  const edges = source.edges.filter(edge => edge.curveKind === 'line' && edge.axis !== null
    && near(Math.abs(edge.axis[0]), 1) && near(edge.midpoint[1], y) && near(edge.midpoint[2], z));
  expect(edges).toHaveLength(1);
  const [edge] = edges;
  const ref: SubShapeRef = { bodyFeatureId: source.id, index: edge.index, fingerprint: { kind: 'edge',
    curveKind: edge.curveKind, length: edge.length, position: edge.midpoint, axis: edge.axis, radius: edge.radius } };
  return { ref, start: edge.start };
}

function documentWith(operation = blend, base = sheets) {
  return appendSolid(base, surface('blend', operation, nextSolidName(base, 'surface')));
}

beforeAll(async () => {
  oc = await loadOcctForNode();
  boxA = box('box-a', -1, -1);
  boxB = box('box-b', 4, 4);
  const boxes = appendSolid(appendSolid(createEmptyPartDocument(), boxA), boxB);
  const solids = await recomputeSolids({ oc, cache }, { generation: 1, steps: requests(boxes) });
  expect(solids.failures).toEqual([]);
  supportA = faceRef(body(solids.bodies, boxA.id), 2, 0);
  const supportB = faceRef(body(solids.bodies, boxB.id), 1, 3);
  const extract = (id: string, face: SubShapeRef, name: string) => surface(id, { kind: 'face', targetFeatureId: face.bodyFeatureId, face }, name);
  sheets = appendSolid(appendSolid(boxes, extract('a', supportA, '曲面1')), extract('b', supportB, '曲面2'));
  const faces = await recomputeSolids({ oc, cache }, { generation: 2, steps: requests(sheets) });
  expect(faces.failures).toEqual([]);
  const a = boundary(body(faces.bodies, 'a'), 0, 0), b = boundary(body(faces.bodies, 'b'), 3, 3);
  otherA = boundary(body(faces.bodies, 'a'), -2, 0).ref;
  otherB = boundary(body(faces.bodies, 'b'), 3, 5).ref;
  blend = { kind: 'blend', a: a.ref, b: b.ref, weightA: mm(3), weightB: mm(6), flipB: !near(a.start[0], b.start[0]) };
}, 180_000);
afterAll(() => cache.clear());

describe('実測した直交 2 面の境界辺から作るつなぎ', () => {
  it('両方の面を残し、辺の位置と支持面への接線を満たす面を Worker で作る', async () => {
    const document = documentWith(), steps = requests(document);
    expect([...consumedBodyIds(document)]).toEqual([]);
    expect(dependenciesOf(document, 'blend')).toEqual(expect.arrayContaining(['a', 'b']));
    const result = await recomputeSolids({ oc, cache }, { generation: 3, steps, measureAreas: true });
    expect(result.failures).toEqual([]);
    expect(result.bodies.map(value => value.id)).toEqual([boxA.id, boxB.id, 'a', 'b', 'blend']);
    const mesh = body(result.bodies, 'blend');
    expect(mesh.bodyKind).toBe('shell');
    expect(mesh.faces).toHaveLength(1);
    expect(mesh.area).toBeGreaterThan(10 * Math.hypot(3, 3));
    const entry = cache.get(steps[4].key);
    if (!entry) throw new Error('つなぎ面がありません。');
    expect(isValidShape(oc, entry.shape)).toBe(true);
    const owner = createAllocations();
    try {
      const adaptor = owner.keep(new oc.BRepAdaptor_Surface_2(owner.keep(oc.TopoDS.Face_1(entry.shape)), true));
      const point = owner.keep(new oc.gp_Pnt_1()), du = owner.keep(new oc.gp_Vec_1()), dv = owner.keep(new oc.gp_Vec_1());
      for (const v of [0, 1]) {
        adaptor.D1(0.5, v, point, du, dv);
        expect(Math.hypot(point.X() - 5, point.Y() - 3 * v, point.Z() - 3 * v)).toBeLessThan(1e-6);
        const along = v === 0 ? dv.Y() : dv.Z(), across = v === 0 ? dv.Z() : dv.Y();
        expect(Math.atan2(Math.hypot(dv.X(), across), along) * 180 / Math.PI).toBeLessThan(0.01);
      }
    } finally { owner.release(); }
  });

  it('両方の段の鍵・指紋と向き・重みがキャッシュを区別し、両方の式を再評価する', () => {
    const key = (value: Blend, base = sheets) => requests(documentWith(value, base))[4].key;
    const original = key(blend);
    for (const value of [{ ...blend, weightA: mm(4) }, { ...blend, weightB: mm(5) }, { ...blend, flipB: !blend.flipB },
      { ...blend, a: otherA }, { ...blend, b: otherB }, { ...blend, a: blend.b, b: blend.a }]) expect(key(value)).not.toBe(original);
    for (const feature of [boxA, boxB]) {
      const moved = { ...feature, origin: { kind: 'coordinate' as const, value: absoluteCoordinate(10, 4, 4) } };
      expect(key(blend, replaceSolid(sheets, feature.id, moved))).not.toBe(original);
    }
    const variable = (name: string) => ({ source: name, display: name, value: 1 });
    const evaluated = reevaluatePartDocument(documentWith({ ...blend, weightA: variable('p'), weightB: variable('q') }),
      new Map([['p', 7], ['q', 8]]));
    expect(evaluated.failures).toEqual([]);
    const step = requests(evaluated.document)[4].step;
    expect(step).toMatchObject({ kind: 'blend', weightA: 7, weightB: 8, flipB: blend.flipB,
      a: { query: { kind: 'edge', index: blend.a.index } }, b: { query: { kind: 'edge', index: blend.b.index } } });
  });

  it('境界辺・長さ・先行段を検査し、版を追加と差し替えで引き上げる', () => {
    for (const operation of [{ ...blend, a: supportA }, { ...blend, b: blend.a },
      { ...blend, weightA: mm(0) }, { ...blend, weightB: mm(-1) }]) {
      expect(resolvePart(documentWith(operation)).errors.map(error => error.code)).toEqual(['invalidValue']);
    }
    for (const side of ['a', 'b'] as const) {
      const operation = { ...blend, [side]: { ...blend[side], bodyFeatureId: 'missing' } };
      expect(resolvePart(documentWith(operation)).errors.map(error => error.code)).toEqual(['missingBody']);
    }
    for (const version of [22, 23]) {
      const base = { ...sheets, schemaVersion: version }, added = documentWith(blend, base);
      expect(added.schemaVersion).toBe(24);
      expect(removeSolid(added, 'blend').schemaVersion).toBe(24);
      expect(replaceSolid(base, 'b', surface('b', blend, '曲面2')).schemaVersion).toBe(24);
      expect(nextSolidName(added, 'surface')).toBe('曲面4');
    }
  });

  it('段の途中の取り消しで失敗やキャッシュを残さず、同じ段を再実行できる', async () => {
    const steps = requests(documentWith({ ...blend, weightA: mm(2) }));
    let fitting = false;
    const stop = await recomputeSolids({ oc, cache }, { steps, generation: 4 }, {},
      progress => { fitting = progress.stepId === 'blend'; }, () => Promise.resolve(fitting));
    expect(stop.cancelled).toBe(true);
    expect(stop.failures).toEqual([]);
    expect(cache.has(steps[4].key)).toBe(false);
    const replay = await recomputeSolids({ oc, cache }, { steps, generation: 5 });
    expect(replay.cancelled).toBe(false);
    expect(replay.failures).toEqual([]);
    expect(body(replay.bodies, 'blend').bodyKind).toBe('shell');
  });
});
