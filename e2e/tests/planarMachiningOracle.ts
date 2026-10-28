import { createHash } from 'node:crypto';
import { expect, type TestInfo } from '@playwright/test';
import { expressionValueFromNumber } from '../../packages/expression/src/index.js';
import { appendSolid, createEmptyPartDocument, createSubShapeReference,
  type HoleFeature, type ThreadHoleFeature, type SubShapeRef } from '../../packages/model/src/index.js';
import type { PartDocument } from '../../packages/model/src/part/types.js';
import type { ResolvedPart } from '../../packages/model/src/part/resolvePart.js';
import { recomputePart } from '../../packages/model/src/part/recomputePart.js';
import { toSolidStepRequest } from '../../packages/model/src/kernelBridge/solidRequests.js';
import { createInspectableNativeKernelForNodeTests } from '../../packages/model/src/testing/createNativeKernelBridge.node.js';
import { writePcadFile } from '../../packages/io/src/index.js';
import { createAllocations } from '../../packages/kernel/src/occt/allocations.js';
import { loadOcctForNode } from '../../packages/kernel/src/occt/loadOcct.node.js';
import { readBrepBytes, writeBrepBytes } from '../../packages/kernel/src/occt/brepBytes.js';
import { collectSubShapes } from '../../packages/kernel/src/occt/subShapes.js';
import { tessellate } from '../../packages/kernel/src/occt/tessellate.js';
import { extractEdges } from '../../packages/kernel/src/occt/extractEdges.js';
import { resolveHoleFrame } from '../../packages/kernel/src/occt/makeHole.js';
import type { Vec3Tuple } from '../../packages/kernel/src/types.js';
import { ex18ReadPart } from './ex18RoutesOracle.js';
import { machiningOracleMath } from './machiningSurfaceOracle.js';

export type PlanarOperation = 'plain' | 'thread';
export type PlanarPhase = 'blank' | 'single-created' | 'single-edited'
  | 'two-original' | 'two-edited' | 'missing-reference';
export const PLANAR_OPERATIONS: readonly PlanarOperation[] = ['plain', 'thread'];
export const STOCK_ID = 'planar-xy-stock';
export const STOCK_NAME = '面内XY素材';
export const TWO_ID = 'planar-two-machining';

/** native平面を固定入力で構成する。期待は後から読んだ面の値から作らない。 */
export async function createPlanarFixture(operation: PlanarOperation, kind: 'stock' | 'two' | 'missing'): Promise<Uint8Array> {
  const oc = await loadOcctForNode(), owned = createAllocations();
  const native = await createInspectableNativeKernelForNodeTests();
  try {
    const axes = owned.keep(new oc.gp_Ax3_3(
      owned.keep(new oc.gp_Pnt_3(0, 0, 10)),
      owned.keep(new oc.gp_Dir_4(0, 0, 1)), owned.keep(new oc.gp_Dir_4(1, 0, 0)),
    ));
    const plane = owned.keep(new oc.gp_Pln_2(axes));
    const maker = owned.keep(new oc.BRepBuilderAPI_MakeFace_9(plane, -20, 20, -15, 15));
    const face = owned.keep(maker.Face());
    const prism = owned.keep(new oc.BRepPrimAPI_MakePrism_1(
      face, owned.keep(new oc.gp_Vec_4(0, 0, -10)), true, true,
    ));
    const shape = owned.keep(prism.Shape()), brep = writeBrepBytes(oc, shape);
    const shapes = new Map([['planar-native-stock', brep]]);
    let document = appendSolid(createEmptyPartDocument(), {
      id: STOCK_ID, name: STOCK_NAME, kind: 'importedSolid', suppressed: false,
      shapeRef: 'planar-native-stock', bodyKind: 'solid',
      source: { format: 'step', fileName: 'fixed-planar-stock.step', unit: 'mm', byteLength: brep.byteLength },
    });
    if (kind !== 'stock') {
      const stock = await recomputePart(document, native.bridge, { importedShapes: shapes });
      expect(stock.errors).toEqual([]);
      const body = stock.bodies.find(item => item.featureId === STOCK_ID);
      const top = body?.faces.find(item => item.surfaceKind === 'plane' && item.axis !== null
        && Math.hypot(item.axis[0], item.axis[1], item.axis[2] - 1) <= 1e-9);
      if (body === undefined || top === undefined) throw new Error('固定素材の上面がありません');
      // imported固定素材にはsemantic originが無い。旧保存参照を固定入力から構成する。
      expect(createSubShapeReference(body, 'face', top.index)).toBeNull();
      const reference: SubShapeRef = { bodyFeatureId: STOCK_ID, index: top.index, fingerprint: {
        kind: 'face', surfaceKind: 'plane', area: 40 * 30,
        position: [0, 0, 10], axis: [0, 0, 1], radius: null,
      } };
      const n = expressionValueFromNumber;
      const planar: NonNullable<HoleFeature['planar']> = { kind: 'plane-face', locations: [
        { x: n(6), y: n(-4) }, { x: n(-3), y: n(5) },
      ] };
      const common = { id: TWO_ID, name: operation === 'plain' ? '面内2位置穴' : '面内2位置ねじ穴',
        suppressed: kind === 'missing', targetFeatureId: STOCK_ID,
        face: kind === 'missing' ? { bodyFeatureId: 'retired-planar-stock', index: reference.index,
          fingerprint: reference.fingerprint } : reference,
        centers: [], planar, depth: { kind: 'through' }, tiltAngle: n(0), tiltAzimuth: n(0) };
      const feature: HoleFeature | ThreadHoleFeature = operation === 'plain'
        ? { ...common, kind: 'hole', depth: { kind: 'through' }, diameter: n(6) }
        : { ...common, kind: 'threadHole', depth: { kind: 'through' }, designation: 'M6', series: 'coarse',
          pitch: n(1), drillDiameter: n(6 - 1.0825317547305482), threadLength: n(1), representation: 'simplified' };
      document = appendSolid(document, feature);
    }
    return writePcadFile(document, { savedAt: '2026-10-26T00:00:00.000Z', lengthUnit: 'mm',
      attachments: { shapes, meshes: new Map(), canvases: new Map() } });
  } finally { native.dispose(); owned.release(); }
}

/** O=(0,0,10), U=(1,0,0), N=(0,0,1), V=(0,1,0)。固定入力だけから導く。 */
function expectedLocations(phase: PlanarPhase): readonly Vec3Tuple[] {
  switch (phase) {
    case 'blank': case 'missing-reference': return [];
    case 'single-created': return [[6, -4, 10]];
    case 'single-edited': return [[6, -5, 10]];
    case 'two-original': return [[6, -4, 10], [-3, 5, 10]];
    case 'two-edited': return [[6, -4, 10], [-8, 5, 10]];
  }
}
function close(actual: Vec3Tuple, expected: Vec3Tuple, tolerance: number): void {
  expect(Math.hypot(actual[0] - expected[0], actual[1] - expected[1], actual[2] - expected[2])).toBeLessThanOrEqual(tolerance);
}
export function planarFeature(document: PartDocument) {
  const feature = document.solids.find(item => item.kind === 'hole' || item.kind === 'threadHole');
  if (feature?.kind !== 'hole' && feature?.kind !== 'threadHole') throw new Error('画面の穴featureがありません');
  return feature;
}

/** 毎回新native session/空cacheで、UIが保存した文書を実再生成する。 */
export async function expectPlanarNative(bytes: Uint8Array, operation: PlanarOperation,
  phase: PlanarPhase, info: TestInfo, label: string) {
  const read = ex18ReadPart(bytes), native = await createInspectableNativeKernelForNodeTests();
  const entries = expectedLocations(phase), radius = operation === 'plain' ? 3 : (6 - 1.0825317547305482) / 2;
  if (entries.length === 2) {
    const [a, b] = entries;
    if (a === undefined || b === undefined) throw new Error('独立位置がありません');
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThan(2 * radius);
  }
  try {
    let resolved: ResolvedPart | undefined;
    const result = await recomputePart(read.document, native.bridge, {
      importedShapes: read.attachments.shapes, math: machiningOracleMath(read.document),
      onResolved: value => { resolved = value; },
    });
    expect(result.errors).toEqual([]); expect(result.cancelled).toBe(false); expect(result.cacheHits).toBe(0);
    expect(result.bodies).toHaveLength(1);
    const body = result.bodies[0], step = resolved?.steps.find(item => item.featureId === body?.featureId);
    if (body === undefined || step === undefined) throw new Error('再生成したnative形がありません');
    const inspection = native.inspectShape(step.key), measured = inspection.measure(), brep = inspection.readBrepBytes();
    // 独立測定の対象外条件も、assertで止まる前に実測のまま残す。
    await info.attach(`planar-xy-${label}-measurement`, {
      body: JSON.stringify({ operation, phase, measured }), contentType: 'application/json',
    });
    expect(measured.validity).toMatchObject({ valid: true, solidCount: 1, closed: true });
    expect(measured.holesComplete).toBe(true); expect(measured.meshApproximation).toBeNull();
    const volume = 12000 - entries.length * Math.PI * radius ** 2 * 10;
    expect(Math.abs(measured.volume - volume) / volume).toBeLessThanOrEqual(1e-9);
    if (measured.bounds === null) throw new Error('native境界がありません');
    close(measured.bounds.low, [-20, -15, 0], 1e-7); close(measured.bounds.high, [20, 15, 10], 1e-7);
    expect(measured.throughHoleCount).toBe(entries.length);
    const bores = body.faces.filter(face => face.surfaceKind === 'cylinder');
    expect(bores).toHaveLength(entries.length);
    for (const entry of entries) {
      const matches = bores.filter(face => face.axisOrigin != null && face.radius !== null
        && Math.hypot(face.axisOrigin[0] - entry[0], face.axisOrigin[1] - entry[1]) <= 1e-7);
      expect(matches).toHaveLength(1);
      const bore = matches[0];
      if (bore?.radius == null || bore.axis === null) throw new Error('native穴軸がありません');
      expect(Math.abs(bore.radius - radius)).toBeLessThanOrEqual(1e-7);
      expect(Math.abs(Math.abs(bore.axis[2]) - 1)).toBeLessThanOrEqual(1e-9);
    }
    if (entries.length !== 0) {
      const feature = planarFeature(read.document), request = toSolidStepRequest(step);
      if (request.step.kind !== 'hole' && request.step.kind !== 'thread') throw new Error('native穴依頼がありません');
      expect(feature.centers).toEqual([]); expect(feature.cylindrical).toBeUndefined();
      expect(feature.planar?.locations).toHaveLength(entries.length);
      expect(feature.depth.kind).toBe('through');
      const target = readBrepBytes(await loadOcctForNode(), native.inspectShape(request.step.targetKey).readBrepBytes());
      try {
        const oc = await loadOcctForNode(), mesh = tessellate(oc, target), edges = extractEdges(oc, target);
        const faces = collectSubShapes(oc, target, mesh.faceRanges, edges.edgeRanges).faces;
        const featureIndex = read.document.solids.findIndex(item => item.id === feature.id);
        const prefix = await recomputePart({ ...read.document, solids: read.document.solids.slice(0, featureIndex) }, native.bridge,
          { importedShapes: read.attachments.shapes, math: machiningOracleMath(read.document) });
        expect(prefix.errors).toEqual([]);
        const stock = prefix.bodies.find(item => item.featureId === STOCK_ID);
        if (stock === undefined) throw new Error('素材の参照履歴がありません');
        const frame = resolveHoleFrame(oc, target, faces, request.step, stock.origins);
        expect(frame.origins).toHaveLength(entries.length); close(frame.direction, [0, 0, -1], 1e-9);
        frame.origins.forEach((point, index) => {
          const entry = entries[index]; if (entry === undefined) throw new Error('独立期待位置がありません');
          close(point, entry, 1e-7);
        });
      } finally { target.delete(); }
    }
    expect(body.threadMarks).toHaveLength(operation === 'thread' ? entries.length : 0);
    if (operation === 'thread') for (const entry of entries) {
      const marks = body.threadMarks.filter(mark => Math.hypot(mark.origin[0] - entry[0], mark.origin[1] - entry[1], mark.origin[2] - entry[2]) <= 1e-7);
      expect(marks).toHaveLength(1);
      const mark = marks[0]; if (mark === undefined) throw new Error('ねじ印がありません');
      close(mark.direction, [0, 0, -1], 1e-9); expect(mark.majorDiameter).toBe(6); expect(mark.length).toBe(1);
    }
    const hash = createHash('sha256').update(JSON.stringify({ faces: body.faces, edges: body.edges, vertices: body.vertices, marks: body.threadMarks }));
    for (const array of [body.mesh.positions, body.mesh.normals, body.mesh.indices, body.mesh.edgePositions]) {
      hash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    }
    const observation = { document: read.document, shapeSha: hash.digest('hex'),
      brepSha: createHash('sha256').update(brep).digest('hex'), volume: measured.volume };
    await info.attach(`planar-xy-${label}-native`, { body: JSON.stringify({ ...observation, operation, phase, entries, expectedVolume: volume },
      (_key: string, value: unknown): unknown => typeof value === 'bigint' ? String(value) : value),
      contentType: 'application/json' });
    return observation;
  } finally { native.dispose(); }
}
