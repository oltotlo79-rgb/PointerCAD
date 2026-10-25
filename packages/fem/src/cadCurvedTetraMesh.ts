/**
 * Separately versioned CURVED CAD-boundary tetra route (AUTHOR-ONLY, UNEXECUTED; GO-22/23).
 * Product path packages/fem/src/cadCurvedTetraMesh.ts (NEW). CAD request ownership is shared with the planar route;
 * its geometry and exact-volume contract are unchanged.
 * r2 (GO-24): regions must cover every boundary triangle exactly once with its own triangleFaces tag (no duplicate face
 * region, no duplicate/out-of-range index); dimensions are checked against the unchanged TETRA_LIMITS before copying.
 *
 * The native PLC contract stays pointercad-plc/2 UNCHANGED (embedded, closed, oriented, per-label coplanar, 1e-10
 * tetra-to-PLC volume). Every triangle of a curved CAD face receives its own PLC label (a single triangle is planar);
 * planar CAD faces keep one label each. labelFaces maps every PLC label back to its CAD face address; regions keep the
 * actual CAD-face ownership resolved through analysisRegionTriangles.
 *
 * Acceptance needs BOTH required explicit caller limits (no defaults):
 *  - maximumChordDeviationMm against the conservative actual-coordinate per-triangle bound (curvedPlcBound.ts);
 *  - maximumVolumeDeviationMm3 against |native valid material volume (current body.volume) - tetra mesh volume|.
 * The volume comparison is a practical numerical accuracy check, not a formal enclosure; sum(area x bound) is reported
 * only as the bound module's labelled estimate and is never an acceptance ceiling. exactProof/globalCertified false.
 * Supported primitives: cylinder, sphere, cone and embedded ring torus with native analytic parameters.
 * Spline faces additionally require same-copy control-net distance evidence for every retained triangle.
 * The first spline family is nonperiodic, clamped C1 BSpline/Bezier with positive rational weights.
 * Primitive distance is not distance to a trimmed subset. Trimming, seams and poles come from the current native
 * face triangulation and persistent face inventory; cylinderSpan, when present, is an additional axial trim check.
 */
import { analysisRegionTriangles, requestAnalysisBoundary, type AnalysisBoundary, type AnalysisBoundaryOptions,
  type AnalysisBoundarySource, type SolidBody } from '@pointercad/model';
import type { FemClient, FemOptions } from './client.js';
import { diagnoseTetraMeshQuality, readTetraMeshQualityLimits, type TetraMeshQuality, type TetraMeshQualityLimits } from './tetraMeshQuality.js';
import { claimCadMeshRequest, isCurrentCadMeshRequest, releaseCadMeshRequest } from './cadMeshRequestOwner.js';
import { bindCadBoundaryIdentity, type CadAnalysisBoundaryIdentity, type CadSavedBoundarySelection,
  type CadTetraContext, type CadTetraRegion } from './cadTetraMesh.js';
import { boundCurvedPlc, CurvedPlcRefusal, type CurvedPlcBound, type CurvedSurface, type FreeformPlcSurface } from './curvedPlcBound.js';
import { readTetraMeshInput, readTetraMeshingControls, type TetraMeshingControls, PLANAR_TETRA_MESH_SCHEMA, TETRA_LIMITS, type TetraMeshInput, type TetraMeshResult } from './tetraMesh.js';

export const CURVED_CAD_TETRA_SCHEMA = 'pointercad-curved-cad-tetra/1';

export interface CurvedCadTetraOptions {
  readonly boundary: AnalysisBoundaryOptions;
  /** Admission filter: every curved-face node must lie this close to its native surface (mm, > 0). */
  readonly nodeToleranceMm: number;
  /** Required: largest allowed conservative chord deviation of any curved-face triangle (mm, finite, >= 0). */
  readonly maximumChordDeviationMm: number;
  /** Required: largest allowed |native material volume - tetra volume| (mm^3, finite, >= 0). */
  readonly maximumVolumeDeviationMm3: number;
}

export interface CurvedCadTetraVolume {
  readonly nativeMaterialMm3: number;
  readonly tetraMm3: number;
  readonly absoluteDifferenceMm3: number;
  readonly maximumMm3: number;
}

export type CurvedCadTetraOutcome =
  | { readonly kind: 'result'; readonly schema: typeof CURVED_CAD_TETRA_SCHEMA; readonly mesh: TetraMeshResult;
      readonly regions: readonly CadTetraRegion[]; readonly labelFaces: readonly number[]; readonly bound: CurvedPlcBound;
      readonly volume: CurvedCadTetraVolume; readonly maximumChordDeviationMm: number;
      readonly exactProof: false; readonly globalCertified: false; readonly quality?: TetraMeshQuality }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string; readonly quality?: TetraMeshQuality }
  | { readonly kind: 'cancelled'; readonly reason: 'abort' | 'superseded' | 'disposed' };

export type CurvedRouteRefusalCode = 'invalid-options' | 'unsupported-geometry' | 'planar-body' | 'unsupported-boundary'
  | 'missing-origin' | 'stale-region' | 'missing-surface-parameters' | 'patch-mismatch' | 'curved-chord-limit';
export class CurvedRouteRefusal extends Error {
  override readonly name = 'CurvedRouteRefusal';
  constructor(readonly code: CurvedRouteRefusalCode, message: string) { super(message); }
}
class CurvedRouteCancelled extends Error { override readonly name = 'CurvedRouteCancelled'; }

const finiteNonnegative = (value: number): boolean => Number.isFinite(value) && value >= 0;

function checkedOptions(options: CurvedCadTetraOptions): void {
  if (options.boundary.boundary !== 'closed' || !Number.isFinite(options.nodeToleranceMm) || !(options.nodeToleranceMm > 0)
    || !finiteNonnegative(options.maximumChordDeviationMm) || !finiteNonnegative(options.maximumVolumeDeviationMm3)) {
    throw new CurvedRouteRefusal('invalid-options',
      'curved route needs a closed boundary, a positive node tolerance and finite nonnegative chord and volume limits');
  }
}

function supportedCurvedBody(body: SolidBody): void {
  if (!body.isValid || body.bodyKind !== 'solid' || body.faces.length === 0 || !Number.isFinite(body.volume) || !(body.volume > 0)
    || body.faces.some(face => face.surfaceKind !== 'plane' && face.surfaceKind !== 'cylinder' && face.surfaceKind !== 'sphere'
      && face.surfaceKind !== 'cone' && face.surfaceKind !== 'torus' && face.surfaceKind !== 'other')) {
    throw new CurvedRouteRefusal('unsupported-geometry', 'a valid solid of analytic or evaluated spline faces is required');
  }
  if (body.faces.every(face => face.surfaceKind === 'plane')) {
    throw new CurvedRouteRefusal('planar-body', 'this body is planar; use the planar route (exact CAD volume contract)');
  }
}

/** Analytic parameters or same-copy spline evidence, bound to the CURRENT body's CAD face addresses. */
function surfacesOf(body: SolidBody, boundary: AnalysisBoundary): (CurvedSurface | FreeformPlcSurface)[] {
  const evidence = boundary.mesh.freeform;
  const seen = new Set<number>();
  if (evidence !== undefined) {
    if (evidence.schema !== 'pointercad-freeform-distance/1' || evidence.faces.length > body.faces.length) {
      throw new CurvedRouteRefusal('missing-surface-parameters', 'invalid native freeform schema');
    }
    for (const face of evidence.faces) {
      if (!Number.isSafeInteger(face.faceIndex) || face.faceIndex < 0 || face.faceIndex >= body.faces.length
        || body.faces[face.faceIndex].surfaceKind !== 'other' || seen.has(face.faceIndex)) {
        throw new CurvedRouteRefusal('missing-surface-parameters', 'native freeform face correspondence');
      }
      seen.add(face.faceIndex);
    }
  }
  return body.faces.map((face): CurvedSurface | FreeformPlcSurface => {
    if (face.surfaceKind === 'plane') return { kind: 'plane' };
    if (face.surfaceKind === 'other') {
      const actual = evidence?.faces.find(row => row.faceIndex === face.index);
      if (actual === undefined) throw new CurvedRouteRefusal('missing-surface-parameters', `face ${String(face.index)} has no native spline distance evidence`);
      return { kind: 'freeform', surfaceKind: actual.surfaceKind, triangles: actual.triangles };
    }
    if (face.surfaceKind === 'cone' || face.surfaceKind === 'torus') {
      const primitive = face.analyticSurface;
      if (primitive === undefined || primitive.kind !== face.surfaceKind) {
        throw new CurvedRouteRefusal('missing-surface-parameters', `face ${String(face.index)} has no matching native primitive`);
      }
      // Never infer the cone sign from the legacy material-oriented axis. No fallback to centroid or radius alone.
      return structuredClone(primitive);
    }
    const origin = face.axisOrigin ?? null, radius = face.radius;
    if (origin === null || radius === null || !origin.every(Number.isFinite) || !Number.isFinite(radius) || !(radius > 0)) {
      throw new CurvedRouteRefusal('missing-surface-parameters', `face ${String(face.index)} has no analytic parameters`);
    }
    if (face.surfaceKind === 'sphere') return { kind: 'sphere', center: [origin[0], origin[1], origin[2]], radius };
    const axis = face.axis;
    if (axis === null || !axis.every(Number.isFinite)) {
      throw new CurvedRouteRefusal('missing-surface-parameters', `cylinder face ${String(face.index)} has no axis`);
    }
    return { kind: 'cylinder', origin: [origin[0], origin[1], origin[2]], axis: [axis[0], axis[1], axis[2]], radius };
  });
}

/** Native trimmed-patch correspondence where the kernel supplies it: every node of a full-band cylinder face lies in its span. */
function checkCylinderSpans(body: SolidBody, coordinates: Float64Array, triangles: Uint32Array, faces: Uint32Array,
  tolerance: number): void {
  for (let t = 0; t < faces.length; t += 1) {
    const face = body.faces[faces[t]];
    const span = face.cylinderSpan ?? null, origin = face.axisOrigin ?? null, axis = face.axis;
    if (face.surfaceKind !== 'cylinder' || span === null || origin === null || axis === null) continue;
    const length = Math.hypot(axis[0], axis[1], axis[2]);
    for (let k = 0; k < 3; k += 1) {
      const n = triangles[3 * t + k];
      const along = ((coordinates[3 * n] - origin[0]) * axis[0] + (coordinates[3 * n + 1] - origin[1]) * axis[1]
        + (coordinates[3 * n + 2] - origin[2]) * axis[2]) / length;
      if (!(along >= Math.min(span[0], span[1]) - tolerance && along <= Math.max(span[0], span[1]) + tolerance)) {
        throw new CurvedRouteRefusal('patch-mismatch', `face ${String(face.index)} triangle leaves its native cylinder span`);
      }
    }
  }
}

/** Bind actual origins, bound curved faces and build the unchanged PLC/2 input with per-curved-triangle labels. */
export function prepareCurvedCadTetraMesh(boundary: AnalysisBoundary, context: CadTetraContext, options: CurvedCadTetraOptions,
  checkpoint: () => void, requestedMeshing?: TetraMeshingControls, savedBoundary?: CadSavedBoundarySelection): {
    readonly input: TetraMeshInput; readonly regions: readonly CadTetraRegion[]; readonly labelFaces: readonly number[];
    readonly bound: CurvedPlcBound; readonly boundaryIdentity: CadAnalysisBoundaryIdentity;
  } {
  checkedOptions(options);
  supportedCurvedBody(context.body);
  const { mesh } = boundary;
  if (mesh.boundary !== 'closed' || mesh.metrics.freeEdges !== 0 || mesh.shells === undefined
    || mesh.shells.length !== mesh.metrics.components || !mesh.mesher.done || mesh.mesher.status !== 0) {
    throw new CurvedRouteRefusal('unsupported-boundary', 'closed boundary with explicit native shell provenance required');
  }
  if (mesh.faces.length !== context.body.faces.length) throw new CurvedRouteRefusal('stale-region', 'face table differs from the current body');
  // Capacity before any copy or long loop (existing TETRA_LIMITS, unchanged).
  if (!Number.isSafeInteger(mesh.triangleCount) || mesh.triangleCount < 1 || mesh.triangleCount > TETRA_LIMITS.boundaryTriangles
    || !Number.isSafeInteger(mesh.nodeCount) || mesh.nodeCount < 1 || mesh.nodeCount > TETRA_LIMITS.boundaryNodes
    || mesh.triangles.length !== 3 * mesh.triangleCount || mesh.triangleFaces.length !== mesh.triangleCount
    || mesh.coordinates.length !== 3 * mesh.nodeCount || boundary.regions.length !== mesh.faces.length) {
    throw new CurvedRouteRefusal('unsupported-boundary', 'boundary dimensions disagree or exceed the tetra mesh limits');
  }
  const owner = new Int32Array(mesh.triangleCount).fill(-1), regionFaces = new Set<number>();
  const regions = boundary.regions.map((region): CadTetraRegion => {
    checkpoint();
    const reference = region.reference;
    if (reference === null || reference.origin === undefined) {
      throw new CurvedRouteRefusal('missing-origin', 'every CAD face requires a unique persistent origin');
    }
    const found = analysisRegionTriangles(boundary, context.body, context.steps, reference);
    if (found.status !== 'matched' || found.faceIndex !== region.faceIndex
      || found.triangles.length !== region.triangleCount || region.triangleCount === 0) {
      throw new CurvedRouteRefusal('stale-region', `current origin lookup ${found.status}`);
    }
    if (regionFaces.has(region.faceIndex)) throw new CurvedRouteRefusal('stale-region', `duplicate region for face ${String(region.faceIndex)}`);
    regionFaces.add(region.faceIndex);
    for (let i = 0; i < found.triangles.length; i += 1) {
      if (i % 1024 === 0) checkpoint();
      const triangle = found.triangles[i];
      if (!(triangle < mesh.triangleCount) || owner[triangle] !== -1 || mesh.triangleFaces[triangle] !== region.faceIndex) {
        throw new CurvedRouteRefusal('stale-region', `triangle ${String(triangle)} is out of range, repeated or tagged for another face`);
      }
      owner[triangle] = region.faceIndex;
    }
    return { tag: region.faceIndex, reference: structuredClone(reference), triangleIndices: Array.from(found.triangles) };
  });
  if (owner.includes(-1)) throw new CurvedRouteRefusal('stale-region', 'regions do not cover every boundary triangle exactly once');
  const surfaces = surfacesOf(context.body, boundary);
  checkCylinderSpans(context.body, mesh.coordinates, mesh.triangles, mesh.triangleFaces, options.nodeToleranceMm);
  const bound = boundCurvedPlc(Array.from(mesh.coordinates), Array.from(mesh.triangles), Array.from(mesh.triangleFaces),
    surfaces, options.nodeToleranceMm, checkpoint);
  if (!(bound.maxChordDeviationBoundMm <= options.maximumChordDeviationMm)) {
    throw new CurvedRouteRefusal('curved-chord-limit',
      `chord deviation bound ${String(bound.maxChordDeviationBoundMm)} mm exceeds the requested ${String(options.maximumChordDeviationMm)} mm`);
  }
  // Labels: one per planar CAD face, one per curved-face triangle; dense 0..labelFaces.length-1 in first-use order.
  const labels: number[] = [], labelFaces: number[] = [], planarLabel = new Map<number, number>();
  for (const face of mesh.triangleFaces) {
    if (surfaces[face].kind === 'plane') {
      const existing = planarLabel.get(face);
      if (existing !== undefined) { labels.push(existing); continue; }
      planarLabel.set(face, labelFaces.length);
    }
    labels.push(labelFaces.length);
    labelFaces.push(face);
  }
  checkpoint();
  let input: TetraMeshInput;
  try {
    input = readTetraMeshInput({ schema: PLANAR_TETRA_MESH_SCHEMA,
      ...(requestedMeshing === undefined ? {} : { meshing: readTetraMeshingControls(requestedMeshing) }),
      source: { documentId: context.documentId, revision: context.revision,
        featureId: boundary.revision.featureId, bodyKey: boundary.revision.bodyKey },
      units: mesh.units, coordinates: Array.from(mesh.coordinates), triangles: Array.from(mesh.triangles),
      tags: labels, tagCount: labelFaces.length,
      shells: mesh.shells.map(shell => ({ role: shell.role, triangles: Array.from(shell.triangles) })) });
  } catch (error) {
    throw new CurvedRouteRefusal('unsupported-boundary', error instanceof Error ? error.message : 'Invalid oriented boundary');
  }
  const boundaryIdentity = bindCadBoundaryIdentity(input, context, regions, savedBoundary,
    (code, reason) => { throw new CurvedRouteRefusal(code, reason); });
  return { input, regions, labelFaces, bound, boundaryIdentity };
}

function refusalOf(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof CurvedRouteRefusal || error instanceof CurvedPlcRefusal) return { code: error.code, message: error.message };
  return { code: 'cad-mesh', message: error instanceof Error ? error.message : 'CAD curved mesh preparation failed' };
}

/** Actual kernel boundary (native-solid validated) -> unchanged PLC/2 -> existing FEM Worker -> volume/chord limits.
 * Optional tetra quality is checked only after the current CAD geometric contract passes; no implicit refinement. */
export async function meshCadCurvedBoundary(client: Pick<FemClient, 'meshTetrahedra'>, kernel: AnalysisBoundarySource,
  readCurrent: () => CadTetraContext, options: CurvedCadTetraOptions, femOptions: FemOptions = {},
  requestedQuality?: TetraMeshQualityLimits, requestedMeshing?: TetraMeshingControls): Promise<CurvedCadTetraOutcome> {
  const owner = claimCadMeshRequest(client);
  const abort = (): void => owner.abort();
  femOptions.signal?.addEventListener('abort', abort, { once: true });
  if (femOptions.signal?.aborted) owner.abort();
  const cancelled = (): CurvedCadTetraOutcome | null => !isCurrentCadMeshRequest(client, owner)
    ? { kind: 'cancelled', reason: 'superseded' }
    : owner.signal.aborted ? { kind: 'cancelled', reason: 'abort' } : null;
  const checkpoint = (): void => { if (cancelled() !== null) throw new CurvedRouteCancelled('cancelled'); };
  try {
    // Capture both policies before the first await; caller mutation cannot retarget this request.
    const meshing = requestedMeshing === undefined ? undefined : readTetraMeshingControls(requestedMeshing);
    const diagnosticLimits = requestedQuality === undefined ? undefined : readTetraMeshQualityLimits(requestedQuality);
    const qualityLimits = meshing === undefined ? diagnosticLimits : diagnosticLimits === undefined ? meshing.quality : {
      minimumMeanRatio: Math.max(diagnosticLimits.minimumMeanRatio, meshing.quality.minimumMeanRatio),
      maximumEdgeRatio: Math.min(diagnosticLimits.maximumEdgeRatio, meshing.quality.maximumEdgeRatio),
    };
    checkedOptions(options);
    const initial = readCurrent();
    const documentId = initial.documentId, revision = initial.revision;
    supportedCurvedBody(initial.body);
    const beforeBoundary = cancelled();
    if (beforeBoundary !== null) return beforeBoundary;
    const boundary = await requestAnalysisBoundary(kernel, initial.steps, initial.body,
      { boundary: options.boundary.boundary, linearDeflection: options.boundary.linearDeflection,
        angularDeflection: options.boundary.angularDeflection, materialValidation: 'native-solid',
        ...(initial.body.faces.some(face => face.surfaceKind === 'other') ? {
          freeformRefinement: { maximumChordDeviationMm: options.maximumChordDeviationMm,
            maximumVolumeDeviationMm3: options.maximumVolumeDeviationMm3,
            maximumNodes: TETRA_LIMITS.boundaryNodes, maximumTriangles: TETRA_LIMITS.boundaryTriangles },
        } : {}) });
    const afterBoundary = cancelled();
    if (afterBoundary !== null) return afterBoundary;
    if (boundary.kind === 'failed') return { kind: 'failed', code: boundary.code, message: boundary.message };
    const current = readCurrent();
    if (current.documentId !== documentId || current.revision !== revision) {
      return { kind: 'failed', code: 'stale', message: 'CAD revision changed while obtaining its boundary' };
    }
    const prepared = prepareCurvedCadTetraMesh(boundary.boundary, current, options, checkpoint, meshing);
    const completion = await client.meshTetrahedra(prepared.input, { ...femOptions, signal: owner.signal });
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
    const rebound = prepareCurvedCadTetraMesh(boundary.boundary, latest, options, checkpoint, meshing);
    if (JSON.stringify(rebound.input) !== JSON.stringify(prepared.input)
      || JSON.stringify(rebound.regions) !== JSON.stringify(prepared.regions)
      || JSON.stringify(rebound.labelFaces) !== JSON.stringify(prepared.labelFaces)
      || JSON.stringify(rebound.bound) !== JSON.stringify(prepared.bound)) {
      return { kind: 'failed', code: 'stale', message: 'CAD face provenance changed during native meshing' };
    }
    const nativeMaterialMm3 = latest.body.volume, tetraMm3 = completion.result.volumeMm3;
    const absoluteDifferenceMm3 = Math.abs(nativeMaterialMm3 - tetraMm3);
    if (!Number.isFinite(absoluteDifferenceMm3)) return { kind: 'failed', code: 'cad-volume', message: 'nonfinite volume comparison' };
    if (!(absoluteDifferenceMm3 <= options.maximumVolumeDeviationMm3)) {
      return { kind: 'failed', code: 'curved-volume-limit', message: `|native material volume - tetra volume| = ${String(absoluteDifferenceMm3)} mm^3 exceeds the requested ${String(options.maximumVolumeDeviationMm3)} mm^3` };
    }
    const quality = qualityLimits === undefined ? undefined : diagnoseTetraMeshQuality(completion.result, qualityLimits);
    if (quality !== undefined && !quality.meetsRequestedLimits) {
      return { kind: 'failed', code: 'mesh-quality', message: 'Tetrahedra do not meet the explicit quality limits', quality };
    }
    return { kind: 'result', schema: CURVED_CAD_TETRA_SCHEMA, mesh: completion.result, regions: prepared.regions,
      labelFaces: prepared.labelFaces, bound: prepared.bound,
      volume: { nativeMaterialMm3, tetraMm3, absoluteDifferenceMm3, maximumMm3: options.maximumVolumeDeviationMm3 },
      maximumChordDeviationMm: options.maximumChordDeviationMm, exactProof: false, globalCertified: false,
      ...(quality === undefined ? {} : { quality }) };
  } catch (error) {
    return cancelled() ?? { kind: 'failed', ...refusalOf(error) };
  } finally {
    femOptions.signal?.removeEventListener('abort', abort);
    releaseCadMeshRequest(client, owner);
  }
}
