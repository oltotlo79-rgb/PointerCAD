/**
 * Analysis boundary of one current body, bound to that body's revision and to saved face identities.
 *
 * The kernel (`occt/analysisSurfaceMesh.ts`) returns a topology-connected double-precision boundary whose triangles
 * carry a 0-based face address. A face address is a runtime position in one revision only; it is never an identity
 * and is never saved. This module binds the boundary to:
 *
 * - the body revision it was built from: the body's `featureId` plus its shape-cache key (`ResolvedSolidStep.key`,
 *   which changes whenever anything upstream changes);
 * - a region table: one entry per face, holding the `SubShapeRef` that `createSubShapeReference` gives for that face
 *   only when the body's current origin table proves a strict unique `SubShapeOrigin` for it, round-trip checked
 *   through `resolveCurrentOrigin`.
 *
 * Looking a region up again (`analysisRegionTriangles`) refuses a stale revision, another body, an ambiguous (split or
 * merged) origin and a missing origin instead of falling back to an index or a fingerprint.
 *
 * Dependency direction: `geometry/` does not import `@pointercad/kernel` (see `subShapeRef.ts`). The kernel reply is
 * mirrored structurally here, and the caller passes any source with the kernel's `buildAnalysisSurfaceMesh` method
 * (the kernel API object or its Worker proxy). The reply is validated, not trusted.
 */
import type { SolidBody } from '../kernelBridge/solidContracts.js';
import { createSubShapeReference, resolveCurrentOrigin } from '../kernelBridge/createSubShapeReference.js';
import type { SubShapeRef } from './subShapeRef.js';

export type AnalysisBoundaryMode = 'closed' | 'open';

/** Structural mirror of the kernel `AnalysisSurfaceMesh` (fields this side reads). Units are mm. */
export interface AnalysisBoundaryMesh {
  readonly units: 'mm';
  readonly boundary: AnalysisBoundaryMode;
  readonly coordinates: Float64Array;
  readonly nodeKinds: Uint8Array;
  readonly triangles: Uint32Array;
  readonly triangleFaces: Uint32Array;
  readonly nodeCount: number;
  readonly triangleCount: number;
  /** Optional on legacy/open replies; when supplied, exactly partitions this revision's triangle addresses. */
  readonly shells?: readonly { readonly role: 'outer' | 'cavity'; readonly triangles: readonly number[] }[];
  readonly faces: readonly {
    readonly index: number;
    readonly triangleCount: number;
    readonly reversed: boolean;
    readonly seamEdges: number;
    readonly degeneratedEdges: number;
    readonly collapsedPoleTriangles: number;
  }[];
  readonly edges: readonly {
    readonly index: number;
    readonly degenerated: boolean;
    readonly uses: number;
    readonly nodes: readonly number[];
  }[];
  readonly metrics: {
    readonly totalAreaMm2: number;
    readonly signedVolumeMm3: number;
    readonly minTriangleAreaMm2: number;
    readonly maxTriangleAreaMm2: number;
    readonly minAngleDeg: number;
    readonly maxAngleDeg: number;
    readonly maxBoundNodeOffsetMm: number;
    readonly freeEdges: number;
    readonly components: number;
  };
  readonly mesher: { readonly done: boolean; readonly status: number };
  readonly deflection: { readonly linear: number; readonly angular: number };
  /** Native same-copy evidence; never inferred from the mesher's requested deflection. */
  readonly freeform?: { readonly schema: 'pointercad-freeform-distance/1'; readonly faces: readonly {
    readonly faceIndex: number;
    readonly surfaceKind: 'bspline' | 'bezier' | 'extrusion';
    readonly triangles: readonly {
      readonly triangleIndex: number;
      readonly maxNodeOffsetMm: number;
      readonly maxChordDeviationMm: number;
    }[];
  }[] };
}

/** Clonable limits for bounded native freeform remeshing inside one existing worker request. */
export interface AnalysisFreeformRefinement {
  readonly maximumChordDeviationMm: number;
  readonly maximumVolumeDeviationMm3: number;
  readonly maximumNodes: number;
  readonly maximumTriangles: number;
}

export interface AnalysisBoundaryRequest {
  readonly bodyKey: string;
  readonly boundary: AnalysisBoundaryMode;
  readonly linearDeflection: number;
  readonly angularDeflection: number;
  /** Explicit FEM opt-in (kernel native solid-material validation); omitted for generic boundaries. */
  readonly materialValidation?: 'native-solid';
  readonly freeformRefinement?: AnalysisFreeformRefinement;
}

export type AnalysisBoundaryReply =
  | { readonly kind: 'mesh'; readonly bodyKey: string; readonly mesh: AnalysisBoundaryMesh }
  | { readonly kind: 'failed'; readonly bodyKey: string; readonly code: string; readonly message: string;
      readonly faceIndex: number | null };

/** The kernel API (`AnalysisBoundaryKernelApi`) or its Worker proxy satisfies this structurally. */
export interface AnalysisBoundarySource {
  buildAnalysisSurfaceMesh(request: AnalysisBoundaryRequest): Promise<AnalysisBoundaryReply>;
}

export interface AnalysisBoundaryOptions {
  readonly boundary: AnalysisBoundaryMode;
  readonly linearDeflection: number;
  readonly angularDeflection: number;
  /** Only volume (FEM) callers set this; it requires boundary 'closed'. */
  readonly materialValidation?: 'native-solid';
  readonly freeformRefinement?: AnalysisFreeformRefinement;
}

function validRefinement(value: AnalysisFreeformRefinement): boolean {
  return value !== null && typeof value === 'object' && Object.keys(value).length === 4
    && Object.keys(value).every(key => ['maximumChordDeviationMm', 'maximumVolumeDeviationMm3', 'maximumNodes', 'maximumTriangles'].includes(key))
    && Number.isFinite(value.maximumChordDeviationMm) && value.maximumChordDeviationMm >= 0
    && Number.isFinite(value.maximumVolumeDeviationMm3) && value.maximumVolumeDeviationMm3 >= 0
    && Number.isSafeInteger(value.maximumNodes) && value.maximumNodes > 0
    && Number.isSafeInteger(value.maximumTriangles) && value.maximumTriangles > 0;
}

/** One face of the boundary. `faceIndex` is valid for `AnalysisBoundary.revision` only; never persist it. */
export interface AnalysisRegion {
  readonly faceIndex: number;
  /** Saved-identity reference for this face, or null when the body proves no strict unique origin for it. */
  readonly reference: SubShapeRef | null;
  readonly triangleCount: number;
}

export interface AnalysisBoundary {
  readonly revision: { readonly featureId: string; readonly bodyKey: string };
  readonly mesh: AnalysisBoundaryMesh;
  readonly regions: readonly AnalysisRegion[];
}

export type AnalysisBoundaryFailureCode =
  | 'invalid-options' | 'invalid-body' | 'unsupported-body' | 'missing-body' | 'ambiguous-body'
  | 'kernel-failed' | 'invalid-reply' | 'stale';

export type AnalysisBoundaryOutcome =
  | { readonly kind: 'ready'; readonly boundary: AnalysisBoundary }
  /** `code` is an `AnalysisBoundaryFailureCode` from this side or the kernel's refusal code passed through as is. */
  | { readonly kind: 'failed'; readonly code: string; readonly message: string; readonly faceIndex: number | null };

const failed = (code: string, message: string, faceIndex: number | null = null): AnalysisBoundaryOutcome =>
  ({ kind: 'failed', code, message, faceIndex });

const positiveFinite = (value: number): boolean => Number.isFinite(value) && value > 0;

/** Structural provenance only. The volume consumer independently verifies topology, orientation and containment. */
function validShells(shells: unknown, triangleCount: number): boolean {
  if (!Array.isArray(shells) || shells.length === 0) return false;
  const claimed = new Uint8Array(triangleCount);
  let previousFirst = -1, count = 0;
  for (const value of shells) {
    const entry: unknown = value;
    if (entry === null || typeof entry !== 'object' || !('role' in entry) || !('triangles' in entry)
      || (entry.role !== 'outer' && entry.role !== 'cavity')
      || !Array.isArray(entry.triangles) || entry.triangles.length === 0) return false;
    let previous = -1, first = -1;
    for (const value of entry.triangles) {
      const triangle: unknown = value;
      if (typeof triangle !== 'number' || !Number.isSafeInteger(triangle) || triangle < 0
        || triangle >= triangleCount || triangle <= previous || claimed[triangle] !== 0) return false;
      claimed[triangle] = 1;
      if (first === -1) first = triangle;
      previous = triangle;
      count += 1;
    }
    if (first <= previousFirst) return false;
    previousFirst = first;
  }
  return count === triangleCount;
}

/** The cache key of exactly one step for this body; anything else is refused rather than guessed. */
function bodyKeyOf(steps: readonly { readonly featureId: string; readonly key: string }[],
  featureId: string): { readonly key: string } | { readonly code: 'missing-body' | 'ambiguous-body' } {
  const matches = steps.filter(step => step.featureId === featureId);
  if (matches.length === 0) return { code: 'missing-body' };
  if (matches.length > 1) return { code: 'ambiguous-body' };
  return { key: matches[0].key };
}

/** Check the reply against the body it claims to describe; returns a reason or null. */
function invalidReply(mesh: AnalysisBoundaryMesh, body: SolidBody, boundary: AnalysisBoundaryMode): string | null {
  if (mesh.units !== 'mm') return 'units';
  if (mesh.boundary !== boundary) return 'boundary mode';
  if (!Number.isSafeInteger(mesh.nodeCount) || !Number.isSafeInteger(mesh.triangleCount)
    || mesh.nodeCount <= 0 || mesh.triangleCount <= 0) return 'counts';
  if (!(mesh.coordinates instanceof Float64Array) || mesh.coordinates.length !== 3 * mesh.nodeCount) return 'coordinates';
  if (!(mesh.nodeKinds instanceof Uint8Array) || mesh.nodeKinds.length !== mesh.nodeCount) return 'node kinds';
  if (!(mesh.triangles instanceof Uint32Array) || mesh.triangles.length !== 3 * mesh.triangleCount) return 'triangles';
  if (!(mesh.triangleFaces instanceof Uint32Array) || mesh.triangleFaces.length !== mesh.triangleCount) return 'triangle faces';
  if (mesh.faces.length !== body.faces.length) return 'face count differs from the current body';
  const perFace = new Array<number>(mesh.faces.length).fill(0);
  for (const face of mesh.triangleFaces) {
    if (face >= perFace.length) return 'triangle face address';
    perFace[face] += 1;
  }
  for (let index = 0; index < mesh.faces.length; index += 1) {
    if (mesh.faces[index].index !== index || mesh.faces[index].triangleCount !== perFace[index]) return 'face table';
  }
  for (const node of mesh.triangles) if (node >= mesh.nodeCount) return 'node index';
  for (const value of mesh.coordinates) if (!Number.isFinite(value)) return 'nonfinite coordinate';
  if (mesh.shells !== undefined && !validShells(mesh.shells, mesh.triangleCount)) return 'shell table';
  if (mesh.freeform !== undefined && !validFreeform(mesh.freeform, mesh, body)) return 'freeform distance table';
  return null;
}

/** Exact face/triangle coverage and finite numerical evidence, not a caller-created material certificate. */
function validFreeform(value: unknown, mesh: AnalysisBoundaryMesh, body: SolidBody): boolean {
  if (value === null || typeof value !== 'object' || !('schema' in value)
    || value.schema !== 'pointercad-freeform-distance/1' || !('faces' in value) || !Array.isArray(value.faces)
    || value.faces.length > mesh.faces.length) return false;
  const claimed = new Set<number>();
  let previousFace = -1;
  for (const item of value.faces) {
    const face: unknown = item;
    if (face === null || typeof face !== 'object' || !('faceIndex' in face) || typeof face.faceIndex !== 'number'
      || !Number.isSafeInteger(face.faceIndex) || face.faceIndex <= previousFace || face.faceIndex >= body.faces.length
      || body.faces[face.faceIndex].surfaceKind !== 'other' || !('surfaceKind' in face)
      || (face.surfaceKind !== 'bspline' && face.surfaceKind !== 'bezier' && face.surfaceKind !== 'extrusion') || !('triangles' in face)
      || !Array.isArray(face.triangles) || face.triangles.length !== mesh.faces[face.faceIndex].triangleCount) return false;
    previousFace = face.faceIndex;
    let previousTriangle = -1;
    for (const item of face.triangles) {
      const row: unknown = item;
      if (row === null || typeof row !== 'object' || !('triangleIndex' in row) || typeof row.triangleIndex !== 'number'
        || !Number.isSafeInteger(row.triangleIndex) || row.triangleIndex <= previousTriangle || row.triangleIndex >= mesh.triangleCount
        || mesh.triangleFaces[row.triangleIndex] !== face.faceIndex || claimed.has(row.triangleIndex)
        || !('maxNodeOffsetMm' in row) || typeof row.maxNodeOffsetMm !== 'number' || !Number.isFinite(row.maxNodeOffsetMm)
        || row.maxNodeOffsetMm < 0 || !('maxChordDeviationMm' in row) || typeof row.maxChordDeviationMm !== 'number'
        || !Number.isFinite(row.maxChordDeviationMm) || row.maxChordDeviationMm < row.maxNodeOffsetMm) return false;
      previousTriangle = row.triangleIndex;
      claimed.add(row.triangleIndex);
    }
  }
  for (let t = 0; t < mesh.triangleCount; t += 1) {
    if (body.faces[mesh.triangleFaces[t]].surfaceKind === 'other' && !claimed.has(t)) return false;
  }
  return true;
}

/** A face reference is kept only when its origin is unique and resolves back to the same face address. */
function regionReference(body: SolidBody, faceIndex: number): SubShapeRef | null {
  const reference = createSubShapeReference(body, 'face', faceIndex);
  if (reference === null || reference.origin === undefined) return null;
  const lookup = resolveCurrentOrigin(body, reference);
  return lookup.status === 'matched' && lookup.address.kind === 'face' && lookup.address.index === faceIndex
    ? reference : null;
}

/**
 * Build the analysis boundary of the current `body`. `steps` are the current resolved solid steps; the body's
 * revision is its step key. Nothing is cached here and no document is changed, so a refusal keeps the caller's last
 * good boundary.
 */
export async function requestAnalysisBoundary(source: AnalysisBoundarySource,
  steps: readonly { readonly featureId: string; readonly key: string }[], body: SolidBody,
  options: AnalysisBoundaryOptions): Promise<AnalysisBoundaryOutcome> {
  if (!positiveFinite(options.linearDeflection) || !positiveFinite(options.angularDeflection)
    || (options.boundary !== 'closed' && options.boundary !== 'open')
    || (options.materialValidation !== undefined
      && (options.materialValidation !== 'native-solid' || options.boundary !== 'closed'))
    || (options.freeformRefinement !== undefined
      && (options.materialValidation !== 'native-solid' || options.boundary !== 'closed'
        || !validRefinement(options.freeformRefinement)))) {
    return failed('invalid-options', '解析用の境界の細かさと境界の種類を確かめてください。');
  }
  if (!body.isValid || body.featureId.length === 0) return failed('invalid-body', 'このボディは計算できていないため、解析用の境界を作れません。');
  if (body.bodyKind === 'mesh') return failed('unsupported-body', '読み込んだ三角形のボディからは解析用の境界を作れません。');
  const key = bodyKeyOf(steps, body.featureId);
  if ('code' in key) {
    return failed(key.code, key.code === 'missing-body'
      ? 'このボディの計算結果が見つかりません。再計算してからやり直してください。'
      : 'このボディに当たる計算結果が複数あります。再計算してからやり直してください。');
  }
  // The generic request stays exactly the old object; the opt-in field is present only when requested.
  const request: AnalysisBoundaryRequest = { bodyKey: key.key, boundary: options.boundary,
    linearDeflection: options.linearDeflection, angularDeflection: options.angularDeflection,
    ...(options.materialValidation === undefined ? {} : { materialValidation: options.materialValidation }),
    ...(options.freeformRefinement === undefined ? {} : { freeformRefinement: { ...options.freeformRefinement } }) };
  let reply: AnalysisBoundaryReply;
  try {
    reply = await source.buildAnalysisSurfaceMesh(request);
  } catch (error) {
    return failed('kernel-failed', error instanceof Error ? error.message : String(error));
  }
  if (reply.bodyKey !== key.key) return failed('invalid-reply', '解析用の境界の応答が別のボディのものでした。');
  if (reply.kind === 'failed') return failed(reply.code, reply.message, reply.faceIndex);
  if (reply.mesh.freeform !== undefined && options.materialValidation !== 'native-solid') {
    return failed('invalid-reply', '自由曲面の距離検査には同じ形の材料領域の確認が必要です。');
  }
  const reason = invalidReply(reply.mesh, body, options.boundary);
  if (reason !== null) return failed('invalid-reply', `解析用の境界の応答が現在のボディと合いません(${reason})。再計算してからやり直してください。`);
  const refinement = request.freeformRefinement;
  if (refinement !== undefined && (reply.mesh.deflection.linear > request.linearDeflection
    || reply.mesh.deflection.angular > request.angularDeflection)) {
    return failed('invalid-reply', '自由曲面の再分割が要求より粗い分割を返しました。');
  }
  const regions = reply.mesh.faces.map((face): AnalysisRegion => ({ faceIndex: face.index,
    reference: regionReference(body, face.index), triangleCount: face.triangleCount }));
  return { kind: 'ready', boundary: { revision: { featureId: body.featureId, bodyKey: key.key }, mesh: reply.mesh, regions } };
}

export type AnalysisRegionLookup =
  | { readonly status: 'matched'; readonly faceIndex: number; readonly triangles: Uint32Array }
  | { readonly status: 'stale' }
  | { readonly status: 'other-body' }
  | { readonly status: 'not-a-face' }
  | { readonly status: 'ambiguous'; readonly reason: 'split' | 'merged' }
  | { readonly status: 'missing'; readonly reason: string };

/**
 * Triangle indices of the face a saved reference names, on this boundary. The boundary must still be the current
 * revision of `body` (same feature and the same current step key); the reference must carry a strict origin that
 * resolves uniquely in the body's current origin table. No index or fingerprint fallback.
 */
export function analysisRegionTriangles(boundary: AnalysisBoundary, body: SolidBody,
  steps: readonly { readonly featureId: string; readonly key: string }[], reference: SubShapeRef): AnalysisRegionLookup {
  const key = bodyKeyOf(steps, body.featureId);
  if (body.featureId !== boundary.revision.featureId || !('key' in key) || key.key !== boundary.revision.bodyKey
    || !body.isValid || body.faces.length !== boundary.regions.length) {
    return { status: 'stale' };
  }
  if (reference.bodyFeatureId !== boundary.revision.featureId) return { status: 'other-body' };
  if (reference.fingerprint.kind !== 'face' || (reference.origin !== undefined && reference.origin.shapeKind !== 'face')) {
    return { status: 'not-a-face' };
  }
  const lookup = resolveCurrentOrigin(body, reference);
  switch (lookup.status) {
    case 'ambiguous': return { status: 'ambiguous', reason: lookup.reason };
    case 'missing': return { status: 'missing', reason: lookup.reason };
    case 'matched': {
      const faceIndex = lookup.address.index;
      if (lookup.address.kind !== 'face' || faceIndex < 0 || faceIndex >= boundary.regions.length) {
        return { status: 'missing', reason: 'origin-index-missing' };
      }
      // A unique binding for this origin is insufficient if another origin also
      // claims this face (directly, through a merge, or as a split candidate).
      // Reuse the same complete claim check used when publishing the region.
      if (regionReference(body, faceIndex) === null) {
        return { status: 'missing', reason: 'history-missing' };
      }
      const triangles: number[] = [];
      boundary.mesh.triangleFaces.forEach((face, triangle) => { if (face === faceIndex) triangles.push(triangle); });
      return { status: 'matched', faceIndex, triangles: Uint32Array.from(triangles) };
    }
  }
}
