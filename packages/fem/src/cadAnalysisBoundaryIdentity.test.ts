import { beforeAll, describe, expect, it } from 'vitest';
import { absoluteCoordinate, appendSolid, createAssemblyDocument, createDirectKernelBridge, createEmptyPartDocument,
  embedPart, EMPTY_PART_LIBRARY, requestAnalysisBoundary, resolveAssembly, resolvePart,
  type AnalysisBoundary, type PartDocument, type PrimitiveFeature, type RigidPlacement } from '@pointercad/model';
import { readSolidCadSavedInput, solidCadFaceKey } from '../../model/src/analysis/solidCadInput.js';
import { applyPlacementToPoint } from '../../model/src/assembly/placementMath.js';
import { createKernelApi } from '../../kernel/src/index.js';
import { loadOcctForNode } from '../../kernel/src/occt/loadOcct.node.js';
import { prepareCadTetraMesh, type CadTetraContext, type CadSavedBoundarySelection } from './cadTetraMesh.js';
import { CurvedRouteRefusal, prepareCurvedCadTetraMesh } from './cadCurvedTetraMesh.js';

type Vector = readonly [number, number, number];
const scalar = (value: number) => ({ source: String(value), value, display: String(value) });
const boundaryOptions = { boundary: 'closed' as const, linearDeflection: 0.05, angularDeflection: 0.2,
  materialValidation: 'native-solid' as const };
const curvedOptions = { boundary: boundaryOptions, nodeToleranceMm: 1e-7,
  maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 10 };
let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

function documentOf(kind: 'box' | 'cylinder' | 'sphere', featureId = 'shape'): PartDocument {
  const shape: PrimitiveFeature['shape'] = kind === 'box'
    ? { kind, sizeX: scalar(2), sizeY: scalar(3), sizeZ: scalar(4) }
    : kind === 'cylinder' ? { kind, radius: scalar(1), height: scalar(2) } : { kind, radius: scalar(1) };
  return appendSolid(createEmptyPartDocument(), { id: featureId, name: kind, kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) }, axis: { kind: 'world', axis: 'z' }, shape });
}

function prepare(boundary: AnalysisBoundary, context: CadTetraContext, selection?: CadSavedBoundarySelection) {
  return context.body.faces.every(face => face.surfaceKind === 'plane')
    ? prepareCadTetraMesh(boundary, context, undefined, selection)
    : prepareCurvedCadTetraMesh(boundary, context, curvedOptions, () => undefined, undefined, selection);
}

async function recomputed(document: PartDocument, revision: number) {
  const resolved = resolvePart(document);
  expect(resolved.errors).toEqual([]);
  const api = createKernelApi(() => Promise.resolve(oc)), bridge = createDirectKernelBridge(api);
  try {
    const result = await bridge.recomputeSolids(resolved.steps, { partId: document.id });
    expect(result.failures).toEqual([]);
    expect(result.bodies).toHaveLength(1);
    const context: CadTetraContext = { documentId: document.id, revision, body: result.bodies[0], steps: resolved.steps };
    const reply = await requestAnalysisBoundary(api, resolved.steps, context.body, boundaryOptions);
    if (reply.kind !== 'ready') throw new Error(`${reply.code}: ${reply.message}`);
    const prepared = prepare(reply.boundary, context);
    return { context, boundary: reply.boundary, prepared };
  } finally {
    await api.releasePart(document.id);
    bridge.dispose();
  }
}

function triangleNormal(boundary: AnalysisBoundary, triangle: number, placement?: RigidPlacement): Vector {
  const point = (corner: number): Vector => {
    const index = boundary.mesh.triangles[3 * triangle + corner], coordinates = boundary.mesh.coordinates;
    const value: Vector = [coordinates[3 * index], coordinates[3 * index + 1], coordinates[3 * index + 2]];
    return placement === undefined ? value : applyPlacementToPoint(placement, value);
  };
  const a = point(0), b = point(1), c = point(2);
  const u = b.map((value, axis) => value - a[axis]), v = c.map((value, axis) => value - a[axis]);
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const length = Math.hypot(...n);
  expect(length).toBeGreaterThan(0);
  return [n[0] / length, n[1] / length, n[2] / length];
}

function outwardDirection(boundary: AnalysisBoundary, triangle: number, context: CadTetraContext): Vector {
  const face = context.body.faces[boundary.mesh.triangleFaces[triangle]];
  if (face.surfaceKind === 'plane' && face.axis !== null) return face.axis;
  const center = [0, 0, 0];
  for (let corner = 0; corner < 3; corner++) {
    const node = boundary.mesh.triangles[3 * triangle + corner];
    for (let axis = 0; axis < 3; axis++) center[axis] += boundary.mesh.coordinates[3 * node + axis] / 3;
  }
  // Independent analytic normals at the triangle centre on the primitive fixtures.
  // These fixtures are centred on the z axis; never use the cancelling whole-face average of a closed surface.
  if (face.surfaceKind === 'cylinder') return [center[0], center[1], 0];
  if (face.surfaceKind === 'sphere') return [center[0], center[1], center[2]];
  throw new Error('Unexpected fixture surface');
}

function savedOf(value: Awaited<ReturnType<typeof recomputed>>) {
  const keys = value.prepared.regions.map(region => solidCadFaceKey(region.reference));
  return readSolidCadSavedInput({ schema: 'pointercad-solid-cad-input/1', id: 'solid-cad', source: { documentId: value.context.documentId },
    bodyFeatureId: value.context.body.featureId, fixedFaces: [keys[0]], loadedFaces: keys,
    youngMPa: 210000, poisson: 0.3, tractionMPa: [0, 0, -2], linearDeflectionMm: 0.05,
    angularDeflectionRad: 0.2, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 10 });
}

function compare(first: Awaited<ReturnType<typeof recomputed>>, second: Awaited<ReturnType<typeof recomputed>>,
  placement?: RigidPlacement): void {
  const raw = savedOf(first);
  expect(new Set(raw.loadedFaces).size).toBe(first.context.body.faces.length);
  const bytes = Buffer.from(JSON.stringify(raw));
  const saved = readSolidCadSavedInput(JSON.parse(bytes.toString('utf8')));
  const previous = first.prepared.boundaryIdentity;
  const previousBytes = Buffer.from(JSON.stringify(previous));
  const identity = prepare(second.boundary, second.context, { savedInput: saved, previous }).boundaryIdentity;
  expect(identity.outward).toBe(true);
  expect(identity.selection?.previousNormalsCompared).toBe(true);
  expect(identity.selection?.loadedFaces.map(face => face.key)).toEqual(saved.loadedFaces);
  expect(identity.selection?.fixedFaces.map(face => face.key)).toEqual(saved.fixedFaces);
  expect(identity.faces).toHaveLength(second.context.body.faces.length);
  for (const face of identity.faces) {
    expect(solidCadFaceKey(face.reference)).toBe(face.key);
    for (const sample of face.samples) {
      expect(second.boundary.mesh.triangleFaces[sample.triangleIndex]).toBe(face.faceIndex);
      expect(sample.normal).toEqual(triangleNormal(second.boundary, sample.triangleIndex));
      expect(Math.abs(Math.hypot(...sample.normal) - 1)).toBeLessThanOrEqual(1e-9);
    }
  }
  for (const key of saved.loadedFaces) {
    const old = first.prepared.regions.filter(region => solidCadFaceKey(region.reference) === key);
    const current = second.prepared.regions.filter(region => solidCadFaceKey(region.reference) === key);
    expect(old).toHaveLength(1); expect(current).toHaveLength(1);
    expect(current[0].triangleIndices.length).toBe(old[0].triangleIndices.length);
    for (let index = 0; index < old[0].triangleIndices.length; index++) {
      for (const [entry, triangle] of [[first, old[0].triangleIndices[index]],
        [second, current[0].triangleIndices[index]]] as const) {
        const n = triangleNormal(entry.boundary, triangle);
        const outward = outwardDirection(entry.boundary, triangle, entry.context);
        expect(n.reduce((sum, value, axis) => sum + value * outward[axis], 0)).toBeGreaterThan(0);
      }
      const a = triangleNormal(first.boundary, old[0].triangleIndices[index], placement);
      const b = triangleNormal(second.boundary, current[0].triangleIndices[index], placement);
      expect(Math.abs(Math.hypot(...a) - 1)).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(Math.hypot(...b) - 1)).toBeLessThanOrEqual(1e-9);
      const dot = a.reduce((sum, value, axis) => sum + value * b[axis], 0);
      expect(dot).toBeGreaterThan(0);
      if (old[0].reference.fingerprint.kind === 'face' && old[0].reference.fingerprint.surfaceKind === 'plane') {
        const cross = Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
        expect(Math.atan2(cross, dot)).toBeLessThanOrEqual(1e-9);
      }
    }
  }
  expect(Buffer.from(JSON.stringify(raw))).toEqual(bytes);
  expect(Buffer.from(JSON.stringify(saved))).toEqual(bytes);
  expect(Buffer.from(JSON.stringify(previous))).toEqual(previousBytes);
}

function rejectedWithoutMutation(document: PartDocument, current: Awaited<ReturnType<typeof recomputed>>,
  boundary: AnalysisBoundary, selection: CadSavedBoundarySelection, reason: RegExp): void {
  const bytes = Buffer.from(JSON.stringify({ document, boundary, context: current.context, selection }));
  let failure: unknown;
  try { prepare(boundary, current.context, selection); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error('Expected a reasoned refusal');
  expect(failure.message).toMatch(reason);
  if (current.context.body.faces.some(face => face.surfaceKind !== 'plane')) expect(failure).toBeInstanceOf(CurvedRouteRefusal);
  expect(Buffer.from(JSON.stringify({ document, boundary, context: current.context, selection }))).toEqual(bytes);
}

describe('actual OCCT boundary identity after independent recomputation', () => {
  beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);
  it.each(['box', 'cylinder', 'sphere'] as const)('retains every saved %s face key and outward triangle normal', async kind => {
    const document = documentOf(kind), bytes = Buffer.from(JSON.stringify(document));
    const first = await recomputed(document, 1), second = await recomputed(document, 2);
    expect(first.prepared.regions).toHaveLength(kind === 'box' ? 6 : kind === 'cylinder' ? 3 : 1);
    compare(first, second);
    expect(Buffer.from(JSON.stringify(document))).toEqual(bytes);
  }, 180_000);
  it('retains part-local identities and world normals on a rotated, translated assembly occurrence', async () => {
    const document = documentOf('box');
    const embedded = await embedPart(EMPTY_PART_LIBRARY, document, 'box.pcad', 'box.pcad');
    const assembly = { ...createAssemblyDocument('Boundary identity'), components: [{ id: 'placed-box', name: 'Placed box',
      source: { kind: 'part' as const, partRef: embedded.partRef }, fixed: true, visible: true, suppressed: false,
      placement: { position: [scalar(10), scalar(20), scalar(30)] as const,
        rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] as const } }] };
    const bytes = Buffer.from(JSON.stringify(assembly));
    const resolved = resolveAssembly(assembly, { library: embedded.library });
    expect(resolved.errors).toEqual([]);
    expect(resolved.partKeys.get('placed-box')).toBe(embedded.partRef);
    const placement = resolved.placements.get('placed-box');
    if (placement === undefined) throw new Error('Missing actual resolved placement');
    const first = await recomputed(document, 1), second = await recomputed(document, 2);
    compare(first, second, placement);
    expect(Buffer.from(JSON.stringify(assembly))).toEqual(bytes);
  }, 180_000);
  it.each(['box', 'cylinder'] as const)('refuses a reversed %s face and reversed whole shell despite positive supplied metrics', async kind => {
    const document = documentOf(kind), current = await recomputed(document, 1);
    const selection = { savedInput: savedOf(current), previous: current.prepared.boundaryIdentity };
    for (const whole of [false, true]) {
      const reversed = structuredClone(current.boundary);
      for (let t = 0; t < reversed.mesh.triangleCount; t++) {
        if (!whole && reversed.mesh.triangleFaces[t] !== 0) continue;
        const a = reversed.mesh.triangles[3 * t];
        reversed.mesh.triangles[3 * t] = reversed.mesh.triangles[3 * t + 1];
        reversed.mesh.triangles[3 * t + 1] = a;
      }
      expect(reversed.mesh.metrics.signedVolumeMm3).toBeGreaterThan(0);
      rejectedWithoutMutation(document, current, reversed, selection, /oriented edge|orientation contradicts/u);
    }
  }, 180_000);
  it.each([['box', 'cylinder'], ['cylinder', 'box']] as const)('refuses an old %s face after the same feature becomes a %s', async (before, after) => {
    const original = documentOf(before), old = await recomputed(original, 1);
    const document = { ...documentOf(after), id: original.id }, current = await recomputed(document, 2);
    rejectedWithoutMutation(document, current, current.boundary, { savedInput: savedOf(old) }, /saved-face-missing/u);
  }, 180_000);
  it.each(['box', 'cylinder'] as const)('refuses another part or its face key on the %s route', async kind => {
    const document = documentOf(kind), current = await recomputed(document, 1);
    const other = await recomputed({ ...documentOf(kind, 'other-shape'), id: `${document.id}-other` }, 1);
    const savedInput = savedOf(other);
    rejectedWithoutMutation(document, current, current.boundary, { savedInput }, /other-document/u);
    rejectedWithoutMutation(document, current, current.boundary,
      { savedInput: { ...savedOf(current), loadedFaces: savedInput.loadedFaces } }, /saved-face-missing/u);
    // Face origins are deliberately part-local: same feature ids can occur in distinct documents.
    rejectedWithoutMutation(document, current, current.boundary,
      { savedInput: { ...savedOf(current), source: savedInput.source } }, /other-document/u);
  }, 180_000);
  it.each(['box', 'sphere'] as const)('checks optional session normals for %s and accepts reloads without them', async kind => {
    const document = documentOf(kind), current = await recomputed(document, 1), savedInput = savedOf(current);
    const identity = prepare(current.boundary, current.context, { savedInput }).boundaryIdentity;
    expect(identity).toMatchObject({ outward: true, selection: { previousNormalsCompared: false } });
    const previous = { ...identity, faces: identity.faces.map(face => ({ ...face,
      samples: face.samples.map(sample => ({ ...sample,
        normal: [-sample.normal[0], -sample.normal[1], -sample.normal[2]] as const })) })) };
    rejectedWithoutMutation(document, current, current.boundary, { savedInput, previous }, /normal-reversed/u);
    rejectedWithoutMutation(document, current, current.boundary,
      { savedInput, previous: { ...identity, faces: [] } }, /previous-face-missing/u);
    const invalid = { ...identity, faces: identity.faces.map(face => ({ ...face,
      samples: face.samples.map(sample => ({ ...sample, normal: [NaN, 0, 0] as const })) })) };
    rejectedWithoutMutation(document, current, current.boundary, { savedInput, previous: invalid }, /invalid-previous-normal/u);
    for (const field of ['normal', 'point'] as const) {
      const sparse = structuredClone(identity);
      Reflect.deleteProperty(sparse.faces[0].samples[0][field], 1);
      rejectedWithoutMutation(document, current, current.boundary, { savedInput, previous: sparse }, /invalid-previous-normal/u);
    }
  }, 180_000);
  it('matches curved face samples by position after triangle and region table ordering changes', async () => {
    const document = documentOf('cylinder'), current = await recomputed(document, 1);
    const boundary = structuredClone(current.boundary), triangles = [], faces = [];
    for (let t = boundary.mesh.triangleCount - 1; t >= 0; t--) {
      triangles.push(...boundary.mesh.triangles.slice(3 * t, 3 * t + 3));
      faces.push(boundary.mesh.triangleFaces[t]);
    }
    boundary.mesh.triangles.set(triangles); boundary.mesh.triangleFaces.set(faces);
    const reordered = { ...boundary, regions: [...boundary.regions].reverse() };
    const selection = { savedInput: savedOf(current), previous: current.prepared.boundaryIdentity };
    const bytes = Buffer.from(JSON.stringify({ document, reordered, selection }));
    const identity = prepare(reordered, current.context, selection).boundaryIdentity;
    expect(identity.selection?.loadedFaces.map(face => face.key)).toEqual(selection.savedInput.loadedFaces);
    expect(identity.selection?.previousNormalsCompared).toBe(true);
    expect(Buffer.from(JSON.stringify({ document, reordered, selection }))).toEqual(bytes);
  }, 180_000);
});
