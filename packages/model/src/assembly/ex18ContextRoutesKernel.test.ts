/** EX18 route e: manual assembly references must drive completed B-reps, not just saved point coordinates. */
import { stdout } from 'node:process';
import { createKernelApi } from '@pointercad/kernel';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import type { CachedSolid } from '../../../kernel/src/worker/recomputeSolids.js';
import { createShapeCache } from '../../../kernel/src/worker/shapeCache.js';
import { createDirectKernelBridge, type SolidBody } from '../kernelBridge.js';
import { resolveSubShapeReference } from '../kernelBridge/referenceResolution.js';
import { findReference } from '../part/createPartDocument.js';
import { EX18_ORACLE_A_HOLE_X_TWELVE, EX18_ORACLE_B_CONTEXT_MOVED, EX18_ORACLE_C_CONTEXT_MOVED,
  EX18_ORACLE_EXPECTATIONS } from '../part/ex18RouteFixtures.js';
import { compareEx18Shape, measureEx18Shape, type Ex18ShapeExpectation } from '../part/ex18ShapeOracle.js';
import { recomputePart } from '../part/recomputePart.js';
import type { ResolvedPart } from '../part/resolvePart.js';
import type { PartDocument } from '../part/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { commitContextReference, contextPointResolverFromBodies, type ContextReferenceCommit } from './contextReference.js';
import { buildEx18ContextAssembly, buildEx18ContextPart, buildEx18ContextSource, contextPlacement,
  EX18_CONTEXT_POINT_ID, ex18ContextSourceFace, type Ex18ContextShape } from './ex18ContextRouteBuilders.js';
import { embedPart, type PartLibrary } from './partLibrary.js';
import { applyPlacementToPoint } from './placementMath.js';
import type { AssemblyDocument, Placement } from './types.js';

const TIMEOUT_MS = 180_000;
let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
const releases: (() => void)[] = [];
beforeAll(async () => { oc = await loadOcctForNode(); }, TIMEOUT_MS);
afterEach(() => { for (const release of releases.splice(0)) release(); });

function session() {
  const cache = createShapeCache<CachedSolid>(64);
  const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode, cache));
  releases.push(() => { try { bridge.dispose(); } finally { cache.clear(); } });
  return { bridge, cache };
}

function record(label: string, measured: object): void {
  stdout.write(`EX18 W06 ${label}: ${JSON.stringify(measured)}\n`);
}

function closePoint(actual: Vec3, expected: Vec3): void {
  expect(Math.hypot(...actual.map((coordinate, axis) => coordinate - expected[axis]))).toBeLessThanOrEqual(1e-6);
}

function partOf(library: PartLibrary, ref: string): PartDocument {
  const part = library.parts.get(ref);
  if (part === undefined) throw new Error('EX18 embedded part missing');
  return part;
}

function savedPoint(part: PartDocument): Vec3 {
  const point = findReference(part, EX18_CONTEXT_POINT_ID);
  if (point?.kind !== 'referencePoint' || point.definition.kind !== 'coordinate' || point.definition.at.mode !== 'absolute') {
    throw new Error('EX18 coordinate reference point missing');
  }
  const at = point.definition.at;
  return [at.x.value, at.y.value, at.z.value];
}

async function compute(part: PartDocument, finalId: string, context: ReturnType<typeof session>) {
  let resolved: ResolvedPart | undefined;
  const result = await recomputePart(part, context.bridge, { onResolved: next => { resolved = next; } });
  expect(result.cancelled).toBe(false); expect(result.errors).toEqual([]);
  expect(result.bodies.map(body => body.featureId)).toEqual([finalId]);
  const body = result.bodies[0], step = resolved?.steps.find(entry => entry.featureId === finalId);
  if (body === undefined || step === undefined) throw new Error('EX18 completed body/plan missing');
  const cached = context.cache.get(step.key);
  if (cached === undefined) throw new Error('EX18 completed B-rep missing');
  // Borrow synchronously. Only the session cache owns and releases the shape.
  return { body, shape: measureEx18Shape(oc, cached.shape) };
}

function expectShape(label: string, actual: Awaited<ReturnType<typeof compute>>, expected: Ex18ShapeExpectation): void {
  const comparison = compareEx18Shape(actual.shape, expected);
  record(label, { ...comparison, volume: actual.shape.volume, bounds: actual.shape.bounds,
    holes: actual.shape.holes, validity: actual.shape.validity, limitations: actual.shape.limitations });
  expect(actual.shape.validity.valid).toBe(true); expect(actual.shape.validity.solidCount).toBe(1);
  expect(actual.shape.validity.closed).toBe(true); expect(actual.shape.holesComplete).toBe(true);
  expect(actual.shape.throughHoleCount).toBe(expected.holes.length);
  expect(actual.shape.boundsMethod).toBe('analytic-brep'); expect(actual.shape.meshApproximation).toBeNull();
  expect(actual.shape.limitations).toEqual([]);
  expect(comparison.volumeRelativeError).toBeLessThanOrEqual(1e-9);
  expect(comparison.boundsMaximumErrorMm).toBeLessThanOrEqual(1e-6);
  expect(comparison.holeAxisMaximumErrorMm).toBeLessThanOrEqual(1e-6);
  expect(comparison.holeRadiusMaximumErrorMm).toBeLessThanOrEqual(1e-6);
  expect(comparison.holeDirectionMaximumError).toBeLessThanOrEqual(1e-6);
  expect(comparison.failures).toEqual([]); expect(comparison.matches).toBe(true);
}

function resolver(sourceId: string, bodies: readonly SolidBody[]) {
  return contextPointResolverFromBodies(component => component.id === sourceId ? bodies : null, resolveSubShapeReference);
}

function moveSource(document: AssemblyDocument, sourceId: string, placement: Placement): AssemblyDocument {
  return { ...document, components: document.components.map(component => component.id === sourceId ? { ...component, placement } : component) };
}

async function commit(scene: Awaited<ReturnType<typeof buildEx18ContextAssembly>>, bodies: readonly SolidBody[]): Promise<ContextReferenceCommit> {
  const result = await commitContextReference(scene.document, scene.library, scene.link, resolver(scene.b.id, bodies));
  if ('code' in result) throw new Error(JSON.stringify(result));
  expect(result.document.components).toBe(scene.document.components);
  expect(result.library.parts.get(scene.sourceRef)).toBe(scene.library.parts.get(scene.sourceRef));
  expect(result.document.contextReferences).toEqual([scene.link]);
  return result;
}

const cases: readonly { shape: Ex18ContextShape; point: Vec3; sourcePosition: Vec3; movedPoint: Vec3;
  movedPosition: Vec3; expected: Ex18ShapeExpectation }[] = [
  { shape: 'A', point: [10, 15, 10], sourcePosition: [-2, 23, 6], movedPoint: [12, 15, 10],
    movedPosition: [0, 23, 6], expected: EX18_ORACLE_A_HOLE_X_TWELVE },
  { shape: 'B', point: [0, 0, 25], sourcePosition: [-12, 8, 21], movedPoint: [2, 0, 25],
    movedPosition: [-10, 8, 21], expected: EX18_ORACLE_B_CONTEXT_MOVED },
  { shape: 'C', point: [0, 0, 0], sourcePosition: [-12, 8, -4], movedPoint: [7, 3, 2],
    movedPosition: [-5, 11, -2], expected: EX18_ORACLE_C_CONTEXT_MOVED },
];

describe('EX18 three assembly context routes, manual updates and current geometry', () => {
  it.each(cases)('$shape: face centre -> P -> sketch point -> real hole/vertices before and after manual update', async entry => {
    const context = session(), built = await buildEx18ContextPart(entry.shape, context.bridge);
    const sourcePart = buildEx18ContextSource(), source = await compute(sourcePart, 'source-box', context);
    const face = ex18ContextSourceFace(source.body);
    closePoint(face.fingerprint.position, [12, -8, 4]);
    const scene = await buildEx18ContextAssembly(built.part, sourcePart, face, contextPlacement(entry.sourcePosition));
    const original = JSON.stringify([scene.document, [...scene.library.parts], scene.library.partFiles]);
    const initial = await compute(built.part, built.finalId, context);
    expect(compareEx18Shape(initial.shape, EX18_ORACLE_EXPECTATIONS[entry.shape]).matches).toBe(false);
    const first = await commit(scene, [source.body]);
    closePoint(first.point, entry.point); closePoint(savedPoint(partOf(first.library, scene.targetRef)), entry.point);
    expectShape(`${entry.shape} create`, await compute(partOf(first.library, scene.targetRef), built.finalId, context),
      EX18_ORACLE_EXPECTATIONS[entry.shape]);
    expect(JSON.stringify([scene.document, [...scene.library.parts], scene.library.partFiles])).toBe(original);

    const moved = moveSource(first.document, scene.b.id, contextPlacement(entry.movedPosition));
    // Moving the source alone does not update P or its solid. The update is explicitly manual.
    closePoint(savedPoint(partOf(first.library, scene.targetRef)), entry.point);
    expectShape(`${entry.shape} before manual update`, await compute(partOf(first.library, scene.targetRef), built.finalId, context),
      EX18_ORACLE_EXPECTATIONS[entry.shape]);
    const second = await commit({ ...scene, document: moved, library: first.library }, [source.body]);
    closePoint(second.point, entry.movedPoint);
    const after = await compute(partOf(second.library, scene.targetRef), built.finalId, context);
    expectShape(`${entry.shape} manual update`, after, entry.expected);
    expect(compareEx18Shape(after.shape, EX18_ORACLE_EXPECTATIONS[entry.shape]).matches).toBe(false);
    if (entry.shape === 'C') {
      expect(after.body.vertices).toHaveLength(8);
      const expectedVertices: readonly Vec3[] = [[7, 3, 2], [27, 3, 2], [27, 13, 2], [7, 13, 2],
        [12, 3, 12], [32, 3, 12], [32, 13, 12], [12, 13, 12]];
      for (const vertex of expectedVertices) {
        const matches = after.body.vertices.filter(actual => Math.hypot(...actual.position.map((v, axis) => v - vertex[axis])) <= 1e-6);
        expect(matches).toHaveLength(1);
      }
    } else {
      const top = after.shape.holes[0]?.ends[1];
      if (top === undefined) throw new Error('EX18 measured through-hole endpoint missing');
      closePoint(top, entry.movedPoint);
    }
    expect(second.document.contextReferences?.map(link => link.id)).toEqual(['context-1']);
    // Reusing the source after both borrowed-face operations must still produce the identical source shape.
    expect((await compute(sourcePart, 'source-box', context)).shape).toEqual(source.shape);
  }, TIMEOUT_MS);

  it('a different source part refuses the stale face, then same-id repair reconstructs the hole at the new source', async () => {
    const context = session(), built = await buildEx18ContextPart('A', context.bridge);
    const box = buildEx18ContextSource(), oldSource = await compute(box, 'source-box', context);
    const scene = await buildEx18ContextAssembly(built.part, box, ex18ContextSourceFace(oldSource.body), contextPlacement([-2, 23, 6]));
    const first = await commit(scene, [oldSource.body]);
    const cylinder = buildEx18ContextSource('cylinder'), newSource = await compute(cylinder, 'source-cylinder', context);
    expect(newSource.body.volume).not.toBe(oldSource.body.volume);
    const replacement = await embedPart(first.library, cylinder, 'replacement.pcad', 'replacement.pcad');
    expect(replacement.partRef).not.toBe(scene.sourceRef);
    const replaced: AssemblyDocument = { ...first.document, components: first.document.components.map(component =>
      component.id === scene.b.id ? { ...component, source: { kind: 'part', partRef: replacement.partRef },
        placement: contextPlacement([0, 23, 6]) } : component) };
    const before = JSON.stringify([replaced, replacement.library.partFiles, [...replacement.library.parts]]);
    expect(await commitContextReference(replaced, replacement.library, scene.link, resolver(scene.b.id, [newSource.body])))
      .toEqual({ code: 'sourceUnresolved', linkId: scene.link.id });
    expect(JSON.stringify([replaced, replacement.library.partFiles, [...replacement.library.parts]])).toBe(before);
    expectShape('replacement refused keeps last solid', await compute(partOf(replacement.library, scene.targetRef), built.finalId, context),
      EX18_ORACLE_EXPECTATIONS.A);
    const repaired = { ...scene.link, source: ex18ContextSourceFace(newSource.body) };
    const second = await commit({ ...scene, document: replaced, library: replacement.library, link: repaired }, [newSource.body]);
    expect(second.document.contextReferences?.map(link => link.id)).toEqual(first.document.contextReferences?.map(link => link.id));
    closePoint(second.point, [12, 15, 10]);
    expectShape('different source and same-id repair', await compute(partOf(second.library, scene.targetRef), built.finalId, context),
      EX18_ORACLE_A_HOLE_X_TWELVE);
    expect((await compute(cylinder, 'source-cylinder', context)).shape).toEqual(newSource.shape);
  }, TIMEOUT_MS);

  it('rotated source/target placements agree in world space for world and local display arrays', async () => {
    const context = session(), built = await buildEx18ContextPart('A', context.bridge);
    const sourcePart = buildEx18ContextSource(), source = await compute(sourcePart, 'source-box', context);
    const half = Math.SQRT1_2;
    const targetPlacement = contextPlacement([100, 20, 40], [0, 0, half, half]);
    // Source (12,-8,4) -> Rx90 (12,-4,-8) -> (85,30,50). Target inverse -> (10,15,10).
    const scene = await buildEx18ContextAssembly(built.part, sourcePart, ex18ContextSourceFace(source.body),
      contextPlacement([73, 34, 58], [half, 0, 0, half]), targetPlacement);
    const frame: Vec3 = [1000, -2000, 400];
    const previous = source.body.coordinateFrame?.origin ?? [0, 0, 0];
    const localArray = (values: Float32Array): Float32Array => Float32Array.from(values,
      (coordinate, index) => coordinate + previous[index % 3] - frame[index % 3]);
    const local: SolidBody = { ...source.body,
      coordinateFrame: { space: 'local', origin: frame, maximumFloat32ErrorMm: 1e-3 },
      mesh: { ...source.body.mesh, positions: localArray(source.body.mesh.positions), edgePositions: localArray(source.body.mesh.edgePositions) } };
    const world = await commit(scene, [source.body]), inLocal = await commit(scene, [local]);
    closePoint(world.point, [10, 15, 10]); closePoint(inLocal.point, [10, 15, 10]);
    expect(partOf(inLocal.library, scene.targetRef)).toEqual(partOf(world.library, scene.targetRef));
    const measured = await compute(partOf(inLocal.library, scene.targetRef), built.finalId, context);
    expectShape('rotated/local create', measured, EX18_ORACLE_EXPECTATIONS.A);
    const top = measured.shape.holes[0]?.ends[1];
    if (top === undefined) throw new Error('EX18 rotated measured hole missing');
    closePoint(applyPlacementToPoint({ position: [100, 20, 40], rotation: targetPlacement.rotation }, top), [85, 30, 50]);
    const moved = moveSource(inLocal.document, scene.b.id, contextPlacement([73, 36, 58], [half, 0, 0, half]));
    const updated = await commit({ ...scene, document: moved, library: inLocal.library }, [local]);
    const after = await compute(partOf(updated.library, scene.targetRef), built.finalId, context);
    expectShape('rotated/local manual update', after, EX18_ORACLE_A_HOLE_X_TWELVE);
    const newTop = after.shape.holes[0]?.ends[1];
    if (newTop === undefined) throw new Error('EX18 updated rotated measured hole missing');
    const worldPoint = applyPlacementToPoint({ position: [100, 20, 40], rotation: targetPlacement.rotation }, newTop);
    closePoint(worldPoint, [85, 32, 50]);
    record('rotated world endpoint', { actual: worldPoint, expected: [85, 32, 50], errorMm: Math.hypot(worldPoint[0] - 85, worldPoint[1] - 32, worldPoint[2] - 50) });
  }, TIMEOUT_MS);
});
