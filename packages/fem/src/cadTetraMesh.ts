import { analysisRegionTriangles, requestAnalysisBoundary, type AnalysisBoundary, type AnalysisBoundaryOptions,
  type AnalysisBoundarySource, type SolidBody, type SubShapeRef } from '@pointercad/model';
import type { FemClient, FemOptions } from './client.js';
import { readSolidCadSavedInput, solidCadFaceKey, type SolidCadSavedInput } from '../../model/src/analysis/solidCadInput.js';
import { diagnoseTetraMeshQuality, readTetraMeshQualityLimits, type TetraMeshQuality, type TetraMeshQualityLimits } from './tetraMeshQuality.js';
import { claimCadMeshRequest, isCurrentCadMeshRequest, releaseCadMeshRequest } from './cadMeshRequestOwner.js';
import { readTetraMeshInput, readTetraMeshingControls, type TetraMeshingControls, PLANAR_TETRA_MESH_SCHEMA, TETRA_LIMITS, type TetraMeshInput, type TetraMeshResult } from './tetraMesh.js';

export interface CadTetraContext {
  readonly documentId: string;
  readonly revision: number;
  readonly body: SolidBody;
  readonly steps: readonly { readonly featureId: string; readonly key: string }[];
}
export interface CadTetraRegion {
  readonly tag: number;
  readonly reference: SubShapeRef;
  readonly triangleIndices: readonly number[];
}
type BoundaryVector = readonly [number, number, number];
export interface CadBoundaryNormal {
  readonly triangleIndex: number;
  readonly point: BoundaryVector;
  readonly normal: BoundaryVector;
}
export interface CadBoundaryFaceIdentity {
  readonly key: string;
  readonly faceIndex: number;
  readonly reference: SubShapeRef;
  readonly samples: readonly CadBoundaryNormal[];
}
/** Runtime evidence in part coordinates, never part of either saved input schema. */
export interface CadAnalysisBoundaryIdentity {
  readonly documentId: string;
  readonly bodyFeatureId: string;
  /** Established by the unchanged PLC topology/material-orientation validation before constructing this result. */
  readonly outward: true;
  readonly faces: readonly CadBoundaryFaceIdentity[];
  readonly selection?: {
    readonly fixedFaces: readonly CadBoundaryFaceIdentity[];
    readonly loadedFaces: readonly CadBoundaryFaceIdentity[];
    readonly previousNormalsCompared: boolean;
  };
}
export interface CadSavedBoundarySelection {
  readonly savedInput: SolidCadSavedInput;
  /** Optional session snapshot. Reloading the saved input alone cannot reconstruct past normals. */
  readonly previous?: CadAnalysisBoundaryIdentity;
}

/** Shared by the two prepare routes, ONLY after readTetraMeshInput has validated the actual oriented PLC.
 * Per-triangle normals avoid the zero average of a sphere/cylinder face. Nearest-centre comparison is local
 * direction evidence on the same semantic face, not a geometric equivalence or remeshing accuracy certificate. */
export function bindCadBoundaryIdentity(input: TetraMeshInput, context: CadTetraContext, regions: readonly CadTetraRegion[],
  requested: CadSavedBoundarySelection | undefined,
  refuse: (code: 'stale-region' | 'unsupported-boundary', reason: string) => never): CadAnalysisBoundaryIdentity {
  const point = (node: number): BoundaryVector => [input.coordinates[3 * node], input.coordinates[3 * node + 1], input.coordinates[3 * node + 2]];
  const sample = (triangleIndex: number): CadBoundaryNormal => {
    const [a, b, c] = input.triangles.slice(3 * triangleIndex, 3 * triangleIndex + 3).map(point);
    const u = b.map((value, axis) => value - a[axis]), v = c.map((value, axis) => value - a[axis]);
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...cross);
    if (!Number.isFinite(length) || !(length > 0)) refuse('unsupported-boundary', 'invalid-boundary-normal');
    const normal: BoundaryVector = [cross[0] / length, cross[1] / length, cross[2] / length];
    if (Math.abs(Math.hypot(...normal) - 1) > 1e-9) refuse('unsupported-boundary', 'invalid-boundary-normal: unit length required');
    return { triangleIndex, point: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3],
      normal };
  };
  const faces = regions.map((region): CadBoundaryFaceIdentity => ({ key: solidCadFaceKey(region.reference),
    faceIndex: region.tag, reference: structuredClone(region.reference), samples: region.triangleIndices.map(sample) }));
  const byKey = new Map(faces.map(face => [face.key, face]));
  if (byKey.size !== faces.length) refuse('stale-region', 'duplicate-face-key: boundary faces must have unique semantic keys');
  const identity = { documentId: context.documentId, bodyFeatureId: context.body.featureId, outward: true as const, faces };
  if (requested === undefined) return identity;
  const saved = readSolidCadSavedInput(requested.savedInput);
  const sameSource = (documentId: string, bodyFeatureId: string): void => {
    if (documentId !== context.documentId) refuse('stale-region', 'other-document: boundary selection belongs to another part');
    if (bodyFeatureId !== context.body.featureId) refuse('stale-region', 'other-body: boundary selection belongs to another body');
  };
  sameSource(saved.source.documentId, saved.bodyFeatureId);
  const selected = (keys: readonly string[]): CadBoundaryFaceIdentity[] => keys.map(key => {
    const face = byKey.get(key);
    if (face === undefined) return refuse('stale-region', 'saved-face-missing: saved face has no unique current counterpart');
    return face;
  });
  const fixedFaces = selected(saved.fixedFaces), loadedFaces = selected(saved.loadedFaces), previous = requested.previous;
  if (previous !== undefined) {
    sameSource(previous.documentId, previous.bodyFeatureId);
    // The current PLC limits already bound the selected face/sample counts. Bound the separate session data as well.
    if (!previous.outward || previous.faces.length > TETRA_LIMITS.boundaryTriangles
      || previous.faces.reduce((count, face) => count + face.samples.length, 0) > TETRA_LIMITS.boundaryTriangles) {
      refuse('unsupported-boundary', 'invalid-previous-normals: oversized or unvalidated session snapshot');
    }
    const oldFaces = new Map(previous.faces.map(face => [face.key, face]));
    if (oldFaces.size !== previous.faces.length) refuse('stale-region', 'duplicate-previous-face-key');
    for (const face of new Set([...fixedFaces, ...loadedFaces])) {
      const old = oldFaces.get(face.key);
      if (old === undefined || old.samples.length === 0) refuse('stale-region', 'previous-face-missing');
      for (const before of old.samples) {
        if (before.point.length !== 3 || before.normal.length !== 3
          || ![0, 1, 2].every(axis => Number.isFinite(before.point[axis]) && Number.isFinite(before.normal[axis]))
          || !(Math.abs(Math.hypot(...before.normal) - 1) <= 1e-9)) {
          refuse('unsupported-boundary', 'invalid-previous-normal: finite unit normal and position required');
        }
        let closest = face.samples[0], distance = Infinity;
        for (const candidate of face.samples) {
          const next = Math.hypot(...candidate.point.map((value, axis) => value - before.point[axis]));
          if (next < distance) { closest = candidate; distance = next; }
        }
        if (!(before.normal.reduce((sum, value, axis) => sum + value * closest.normal[axis], 0) > 0)) {
          refuse('unsupported-boundary', 'normal-reversed: saved and current face normals must have positive dot product');
        }
      }
    }
  }
  return { ...identity, selection: { fixedFaces, loadedFaces, previousNormalsCompared: previous !== undefined } };
}
export type CadTetraOutcome =
  | { readonly kind: 'result'; readonly mesh: TetraMeshResult; readonly regions: readonly CadTetraRegion[]; readonly quality?: TetraMeshQuality }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string; readonly quality?: TetraMeshQuality }
  | { readonly kind: 'cancelled'; readonly reason: 'abort' | 'superseded' | 'disposed' };

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'CAD mesh preparation failed'; }
function supportedBody(context: CadTetraContext): void {
  const { body } = context;
  if (!body.isValid || body.bodyKind !== 'solid' || body.faces.length < 4
    || body.faces.some(face => face.surfaceKind !== 'plane') || !Number.isFinite(body.volume) || body.volume <= 0) {
    throw new Error('unsupported-geometry: a valid closed planar solid is required; curved faces are not approximated silently');
  }
}
/** Bind actual origins before converting runtime face addresses to native boundary labels. */
export function prepareCadTetraMesh(boundary: AnalysisBoundary, context: CadTetraContext, requestedMeshing?: TetraMeshingControls,
  savedBoundary?: CadSavedBoundarySelection): {
  readonly input: TetraMeshInput; readonly regions: readonly CadTetraRegion[]; readonly boundaryIdentity: CadAnalysisBoundaryIdentity;
} {
  supportedBody(context);
  const { mesh } = boundary;
  if (mesh.boundary !== 'closed' || mesh.metrics.freeEdges !== 0 || mesh.shells === undefined
    || mesh.shells.length !== mesh.metrics.components || !mesh.mesher.done || mesh.mesher.status !== 0) {
    throw new Error('unsupported-boundary: closed boundary with explicit native shell provenance required');
  }
  const regions = boundary.regions.map((region): CadTetraRegion => {
    const reference = region.reference;
    if (reference === null || reference.origin === undefined) throw new Error('missing-origin: every CAD face requires a unique persistent origin');
    const found = analysisRegionTriangles(boundary, context.body, context.steps, reference);
    if (found.status !== 'matched' || found.faceIndex !== region.faceIndex
      || found.triangles.length !== region.triangleCount || region.triangleCount === 0) {
      throw new Error(`stale-region: current origin lookup ${found.status}`);
    }
    return { tag: region.faceIndex, reference: structuredClone(reference), triangleIndices: Array.from(found.triangles) };
  });
  const input = readTetraMeshInput({ schema: PLANAR_TETRA_MESH_SCHEMA,
    ...(requestedMeshing === undefined ? {} : { meshing: readTetraMeshingControls(requestedMeshing) }),
    source: { documentId: context.documentId, revision: context.revision,
      featureId: boundary.revision.featureId, bodyKey: boundary.revision.bodyKey },
    units: mesh.units, coordinates: Array.from(mesh.coordinates), triangles: Array.from(mesh.triangles),
    tags: Array.from(mesh.triangleFaces), tagCount: regions.length,
    shells: mesh.shells.map(shell => ({ role: shell.role, triangles: Array.from(shell.triangles) })) });
  const boundaryIdentity = bindCadBoundaryIdentity(input, context, regions, savedBoundary,
    (code, reason) => { throw new Error(`${code}: ${reason}`); });
  return { input, regions, boundaryIdentity };
}

/** Actual kernel boundary -> existing owned FEM Worker -> native Netgen -> current region table.
 * readCurrent is checked after BOTH asynchronous calls. No document or last-valid result is mutated here.
 * The caller may retain its last valid mesh on failure/cancellation; it must only publish this returned result.
 * Optional quality limits are captured before awaiting; a rejected quality returns diagnostics without a mesh.
 */
export async function meshCadBoundary(client: Pick<FemClient, 'meshTetrahedra'>, kernel: AnalysisBoundarySource,
  readCurrent: () => CadTetraContext, boundaryOptions: AnalysisBoundaryOptions, options: FemOptions = {},
  requestedQuality?: TetraMeshQualityLimits, requestedMeshing?: TetraMeshingControls): Promise<CadTetraOutcome> {
  const owner = claimCadMeshRequest(client);
  const abort = (): void => owner.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) owner.abort();
  const cancelled = (): CadTetraOutcome | null => !isCurrentCadMeshRequest(client, owner)
    ? { kind: 'cancelled', reason: 'superseded' }
    : owner.signal.aborted ? { kind: 'cancelled', reason: 'abort' } : null;
  try {
    // Capture both policies before the first await; caller mutation cannot retarget this request.
    const meshing = requestedMeshing === undefined ? undefined : readTetraMeshingControls(requestedMeshing);
    const diagnosticLimits = requestedQuality === undefined ? undefined : readTetraMeshQualityLimits(requestedQuality);
    const qualityLimits = meshing === undefined ? diagnosticLimits : diagnosticLimits === undefined ? meshing.quality : {
      minimumMeanRatio: Math.max(diagnosticLimits.minimumMeanRatio, meshing.quality.minimumMeanRatio),
      maximumEdgeRatio: Math.min(diagnosticLimits.maximumEdgeRatio, meshing.quality.maximumEdgeRatio),
    };
    const initial = readCurrent();
    const documentId = initial.documentId, revision = initial.revision;
    supportedBody(initial);
    if (boundaryOptions.boundary !== 'closed') throw new Error('unsupported-boundary: volume meshing requires a closed surface');
    const beforeBoundary = cancelled();
    if (beforeBoundary !== null) return beforeBoundary;
    // Volume meshing needs a material domain: request the kernel's native solid validation explicitly.
    const boundary = await requestAnalysisBoundary(kernel, initial.steps, initial.body,
      { ...boundaryOptions, materialValidation: 'native-solid' });
    const afterBoundary = cancelled();
    if (afterBoundary !== null) return afterBoundary;
    if (boundary.kind === 'failed') return { kind: 'failed', code: boundary.code, message: boundary.message };
    const current = readCurrent();
    if (current.documentId !== documentId || current.revision !== revision) {
      return { kind: 'failed', code: 'stale', message: 'CAD revision changed while obtaining its boundary' };
    }
    const prepared = prepareCadTetraMesh(boundary.boundary, current, meshing);
    const completion = await client.meshTetrahedra(prepared.input, { ...options, signal: owner.signal });
    const afterNative = cancelled();
    if (afterNative !== null) return afterNative;
    if (completion.kind === 'cancelled') return { kind: 'cancelled', reason: completion.reason };
    if (completion.kind === 'failed') return { kind: 'failed', ...completion.failure };
    if (JSON.stringify(completion.result.input) !== JSON.stringify(prepared.input)) {
      return { kind: 'failed', code: 'stale', message: 'Native result input differs from the captured CAD request' };
    }
    const latest = readCurrent();
    if (latest.documentId !== documentId || latest.revision !== revision) {
      return { kind: 'failed', code: 'stale', message: 'CAD revision changed during native meshing' };
    }
    const rebound = prepareCadTetraMesh(boundary.boundary, latest, meshing);
    if (JSON.stringify(rebound.input) !== JSON.stringify(prepared.input)
      || JSON.stringify(rebound.regions) !== JSON.stringify(prepared.regions)) {
      return { kind: 'failed', code: 'stale', message: 'CAD face provenance changed during native meshing' };
    }
    if (Math.abs(completion.result.volumeMm3 - latest.body.volume) > latest.body.volume * 1e-10) {
      return { kind: 'failed', code: 'cad-volume', message: 'Native mesh volume differs from the current exact CAD solid' };
    }
    const quality = qualityLimits === undefined ? undefined : diagnoseTetraMeshQuality(completion.result, qualityLimits);
    if (quality !== undefined && !quality.meetsRequestedLimits) {
      return { kind: 'failed', code: 'mesh-quality', message: 'Tetrahedra do not meet the explicit quality limits', quality };
    }
    return { kind: 'result', mesh: completion.result, regions: prepared.regions,
      ...(quality === undefined ? {} : { quality }) };
  } catch (error) { return cancelled() ?? { kind: 'failed', code: 'cad-mesh', message: errorMessage(error) }; }
  finally {
    options.signal?.removeEventListener('abort', abort);
    releaseCadMeshRequest(client, owner);
  }
}
