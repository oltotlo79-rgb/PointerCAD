import { createSubShapeReference, requestAnalysisBoundary, type AnalysisBoundary, type AnalysisBoundaryOptions,
  type AnalysisBoundarySource, type ResolvedAssembly } from '@pointercad/model';
import type { FemClient, FemOptions } from './client.js';
import { prepareCadTetraMesh, type CadTetraContext } from './cadTetraMesh.js';
import { prepareCurvedCadTetraMesh, type CurvedCadTetraOptions } from './cadCurvedTetraMesh.js';
import { meshAssemblyTetrahedra, type AssemblyTetraBudget, type AssemblyTetraContext,
  type AssemblyTetraOutcome, type AssemblyTetraPart } from './assemblyTetraMesh.js';
import { claimCadMeshRequest, isCurrentCadMeshRequest, releaseCadMeshRequest } from './cadMeshRequestOwner.js';
import { readTetraMeshingControls, TETRA_LIMITS, type TetraMeshingControls } from './tetraMesh.js';
import { readTetraMeshQualityLimits, type TetraMeshQualityLimits } from './tetraMeshQuality.js';

export type CadAssemblyTetraPart = {
  readonly context: CadTetraContext;
  readonly quality?: TetraMeshQualityLimits;
  readonly meshing?: TetraMeshingControls;
} & ({ readonly kind: 'planar'; readonly boundary: AnalysisBoundaryOptions }
  | { readonly kind: 'curved'; readonly options: CurvedCadTetraOptions });

/** CAD bodies are part-local; placement remains on the resolved occurrence, never on the shared PLC. */
export interface CadAssemblyTetraContext {
  readonly documentId: string;
  readonly revision: number;
  readonly assembly: ResolvedAssembly;
  readonly parts: ReadonlyMap<string, CadAssemblyTetraPart>;
}

export type CadAssemblyTetraOutcome = Exclude<AssemblyTetraOutcome, { readonly kind: 'result' }>
  | { readonly kind: 'result'; readonly result: Extract<AssemblyTetraOutcome, { readonly kind: 'result' }>['result'];
      /** Additional retained CAD preparation, separate from result.reservation's native/assembly payload. */
      readonly cadPreparationNumericBytes: number; readonly totalReservedNumericBytes: number }
  | { readonly kind: 'failed'; readonly code: 'cad-boundary' | 'cad-volume'; readonly message: string };

class CadAssemblyRefusal extends Error {
  constructor(readonly code: 'input' | 'budget' | 'stale' | 'cad-boundary' | 'cad-volume', message: string) { super(message); }
}
function requireCad(condition: boolean, message: string): asserts condition {
  if (!condition) throw new CadAssemblyRefusal('input', message);
}
function policy(part: CadAssemblyTetraPart): object {
  requireCad(part.kind === 'planar' || part.kind === 'curved', 'An explicit planar or curved CAD route is required');
  return { ...(part.kind === 'planar' ? { kind: 'planar', boundary: structuredClone(part.boundary) }
    : { kind: 'curved', options: structuredClone(part.options) }),
  ...(part.quality === undefined ? {} : { quality: readTetraMeshQualityLimits(part.quality) }),
  ...(part.meshing === undefined ? {} : { meshing: readTetraMeshingControls(part.meshing) }) };
}
/** Snapshot only analysis-relevant body data, never copy a display mesh or the entire shape history. */
function sourceSignature(part: CadAssemblyTetraPart): string {
  const { context } = part, { body } = context;
  requireCad(context.documentId.length > 0 && Number.isSafeInteger(context.revision) && context.revision >= 0
    && body.isValid && body.bodyKind === 'solid' && Number.isFinite(body.volume) && body.volume > 0
    && body.faces.length > 0 && body.faces.length <= TETRA_LIMITS.boundaryTriangles, 'Invalid or oversized CAD source');
  const step = context.steps.filter(value => value.featureId === body.featureId);
  requireCad(step.length === 1 && step[0].key.length > 0, 'CAD body must identify one current resolved step');
  const references = body.faces.map(face => createSubShapeReference(body, 'face', face.index));
  requireCad(references.every(reference => reference?.origin !== undefined), 'Every CAD face needs its persistent origin');
  return JSON.stringify({ documentId: context.documentId, revision: context.revision, step: step[0],
    bodyFeatureId: body.featureId, volume: body.volume, faces: body.faces, references, policy: policy(part) });
}
function prepare(part: CadAssemblyTetraPart, boundary: AnalysisBoundary): AssemblyTetraPart {
  const quality = part.quality === undefined ? undefined : readTetraMeshQualityLimits(part.quality);
  if (part.kind === 'planar') {
    const value = prepareCadTetraMesh(boundary, part.context, part.meshing);
    return { input: value.input, regions: { regions: value.regions,
      labelFaces: Array.from({ length: value.input.tagCount }, (_, index) => index) },
    ...(quality === undefined ? {} : { quality }) };
  }
  const value = prepareCurvedCadTetraMesh(boundary, part.context, part.options, () => undefined, part.meshing);
  return { input: value.input, regions: { regions: value.regions, labelFaces: value.labelFaces },
    ...(quality === undefined ? {} : { quality }) };
}

/**
 * Current CAD boundaries -> existing Netgen client -> shared assembly meshes with persistent face selection.
 * This does not solve continuum mechanics or join parts. Existing result.physicsValidated stays false.
 * CAD error budgets are additional to the unchanged PLC/native quality checks.
 */
export async function meshCadAssemblyTetrahedra(client: Pick<FemClient, 'meshTetrahedra'>,
  kernel: AnalysisBoundarySource, readCurrent: () => CadAssemblyTetraContext | null,
  requestedBudget: AssemblyTetraBudget, options: FemOptions = {}): Promise<CadAssemblyTetraOutcome> {
  const owner = claimCadMeshRequest(client);
  const abort = (): void => owner.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) owner.abort();
  let handedOff = false;
  const cancelled = (): CadAssemblyTetraOutcome | undefined => !isCurrentCadMeshRequest(client, owner)
    ? { kind: 'cancelled', reason: 'superseded' }
    : owner.signal.aborted ? { kind: 'cancelled', reason: 'abort' } : undefined;
  try {
    const early = cancelled();
    if (early) return early;
    const budget = { ...requestedBudget };
    requireCad(Object.keys(budget).length === 6 && Object.values(budget).every(value => Number.isSafeInteger(value) && value > 0)
      && budget.occurrences <= 1000 && budget.uniqueParts <= 1000 && budget.concurrentGenerations === 1, 'Invalid assembly reservation');
    const initial = readCurrent();
    requireCad(initial !== null && initial.documentId.length > 0 && Number.isSafeInteger(initial.revision)
      && initial.revision >= 0, 'Missing current CAD assembly');
    requireCad(initial.assembly.errors.length === 0 && (initial.assembly.subAssemblies?.size ?? 0) === 0
      && initial.parts.size > 0 && initial.parts.size === initial.assembly.parts.size
      && initial.assembly.placements.size === initial.assembly.partKeys.size, 'Incomplete or unsupported assembly');
    if (initial.parts.size > budget.uniqueParts || initial.assembly.placements.size > budget.occurrences
      || initial.parts.size * TETRA_LIMITS.nodes > budget.nodes
      || initial.parts.size * TETRA_LIMITS.tetrahedra > budget.tetrahedra) {
      throw new CadAssemblyRefusal('budget', 'CAD assembly exceeds reserved native maxima');
    }
    // Reserve the additional retained CAD boundary plus prepared PLC payload before asking the kernel.
    // Includes face/edge/shell/freeform records, not merely coordinate and index arrays.
    const boundaryNumbers = TETRA_LIMITS.boundaryNodes * 4 + TETRA_LIMITS.boundaryTriangles * 64;
    const preparationBytes = initial.parts.size * boundaryNumbers * 2 * 8;
    if (!Number.isSafeInteger(preparationBytes) || preparationBytes >= budget.numericBytes)
      throw new CadAssemblyRefusal('budget', 'CAD preparation exceeds numeric reservation');
    const assemblyBudget = { ...budget, numericBytes: budget.numericBytes - preparationBytes };
    const documentId = initial.documentId, revision = initial.revision;
    const resolvedParts = new Map(initial.assembly.parts);
    const signature = new Map<string, string>(), plans = new Map<string, CadAssemblyTetraPart>();
    const placements = JSON.stringify([...initial.assembly.placements]), partKeys = JSON.stringify([...initial.assembly.partKeys]);
    for (const [key, part] of initial.parts) {
      const resolved = initial.assembly.parts.get(key);
      requireCad(resolved !== undefined && resolved.errors.length === 0
        && resolved.steps.some(step => step.featureId === part.context.body.featureId
          && part.context.steps.some(current => current.featureId === step.featureId && current.key === step.key)),
      'CAD body is not the requested resolved assembly part');
      signature.set(key, sourceSignature(part));
      plans.set(key, part.kind === 'planar'
        ? { ...part, boundary: structuredClone(part.boundary) }
        : { ...part, options: structuredClone(part.options) });
    }
    const boundaries = new Map<string, AnalysisBoundary>(), prepared = new Map<string, AssemblyTetraPart>();
    const currentContext = (): CadAssemblyTetraContext => {
      const current = readCurrent();
      if (!current || current.documentId !== documentId || current.revision !== revision
        || current.parts.size !== plans.size || current.assembly.parts.size !== plans.size
        || current.assembly.errors.length !== 0 || (current.assembly.subAssemblies?.size ?? 0) !== 0
        || JSON.stringify([...current.assembly.placements]) !== placements
        || JSON.stringify([...current.assembly.partKeys]) !== partKeys) throw new CadAssemblyRefusal('stale', 'CAD assembly changed');
      for (const [key] of plans) {
        const part = current.parts.get(key);
        if (!part || current.assembly.parts.get(key) !== resolvedParts.get(key)
          || sourceSignature(part) !== signature.get(key)) throw new CadAssemblyRefusal('stale', 'CAD part or face identity changed');
      }
      return current;
    };
    for (const [key, part] of plans) {
      const before = cancelled();
      if (before) return before;
      currentContext();
      const boundaryOptions = part.kind === 'planar' ? part.boundary : part.options.boundary;
      requireCad(boundaryOptions.boundary === 'closed', 'Volume meshing requires a closed CAD boundary');
      const reply = await requestAnalysisBoundary(kernel, part.context.steps, part.context.body,
        { boundary: 'closed', linearDeflection: boundaryOptions.linearDeflection,
          angularDeflection: boundaryOptions.angularDeflection, materialValidation: 'native-solid',
          ...(part.kind === 'curved' && part.context.body.faces.some(face => face.surfaceKind === 'other') ? {
            freeformRefinement: { maximumChordDeviationMm: part.options.maximumChordDeviationMm,
              maximumVolumeDeviationMm3: part.options.maximumVolumeDeviationMm3,
              maximumNodes: TETRA_LIMITS.boundaryNodes, maximumTriangles: TETRA_LIMITS.boundaryTriangles },
          } : {}) });
      const after = cancelled();
      if (after) return after;
      const current = currentContext().parts.get(key);
      if (!current) throw new CadAssemblyRefusal('stale', 'CAD part was removed');
      if (reply.kind === 'failed') throw new CadAssemblyRefusal('cad-boundary', reply.message);
      if (reply.boundary.mesh.nodeCount > TETRA_LIMITS.boundaryNodes
        || reply.boundary.mesh.triangleCount > TETRA_LIMITS.boundaryTriangles)
        throw new CadAssemblyRefusal('budget', 'CAD boundary exceeds the existing tetra input caps');
      // Keep the validated analysis evidence private. Edge polylines are not consumed by either prepare route;
      // do not retain an unrelated, potentially large native edge inventory through the selection closure.
      const capturedBoundary = structuredClone({ ...reply.boundary, mesh: { ...reply.boundary.mesh, edges: [] } });
      const value = prepare(current, capturedBoundary);
      boundaries.set(key, capturedBoundary);
      prepared.set(key, value);
    }
    const readPrepared = (): AssemblyTetraContext | null => {
      try {
        const current = currentContext();
        for (const [key, boundary] of boundaries) {
          const part = current.parts.get(key);
          if (!part || JSON.stringify(prepare(part, boundary)) !== JSON.stringify(prepared.get(key))) return null;
        }
        return { documentId: current.documentId, revision: current.revision, assembly: current.assembly, parts: prepared };
      } catch { return null; }
    };
    const beforeNative = cancelled();
    if (beforeNative) return beforeNative;
    // No await or user callback between release and the existing route's synchronous ownership claim.
    releaseCadMeshRequest(client, owner);
    handedOff = true;
    const outcome = await meshAssemblyTetrahedra(client, readPrepared, assemblyBudget, options);
    if (outcome.kind !== 'result') return outcome;
    const current = currentContext();
    for (const [key, value] of outcome.result.parts) {
      const part = current.parts.get(key);
      if (!part) throw new CadAssemblyRefusal('stale', 'CAD part was removed');
      const difference = Math.abs(value.mesh.volumeMm3 - part.context.body.volume);
      const maximum = part.kind === 'planar' ? part.context.body.volume * 1e-10 : part.options.maximumVolumeDeviationMm3;
      if (!Number.isFinite(difference) || !(difference <= maximum))
        throw new CadAssemblyRefusal('cad-volume', 'Assembly part tetra volume exceeds its CAD error budget');
    }
    return { ...outcome, cadPreparationNumericBytes: preparationBytes,
      totalReservedNumericBytes: preparationBytes + outcome.result.reservation.numericBytes };
  } catch (error) {
    return (!handedOff ? cancelled() : undefined) ?? { kind: 'failed',
      code: error instanceof CadAssemblyRefusal ? error.code : 'input',
      message: error instanceof Error ? error.message : 'Invalid CAD assembly meshing input' };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    releaseCadMeshRequest(client, owner);
  }
}
