import { isSameSubShape, QUATERNION_TOLERANCE, type ResolvedAssembly, type ResolvedPart, type RigidPlacement,
  type SubShapeRef } from '@pointercad/model';
import type { FemClient, FemOptions } from './client.js';
import type { CadTetraRegion } from './cadTetraMesh.js';
import { claimCadMeshRequest, isCurrentCadMeshRequest, releaseCadMeshRequest } from './cadMeshRequestOwner.js';
import { readTetraMeshInput, TETRA_LIMITS, tetraMeshInputSha256, tetraMeshResultMatches,
  type TetraMeshInput, type TetraMeshResult } from './tetraMesh.js';
import { diagnoseTetraMeshQuality, readTetraMeshQualityLimits,
  type TetraMeshQuality, type TetraMeshQualityLimits } from './tetraMeshQuality.js';
import { exactTetrahedronOrientation } from './plcTopology.js';

export interface TetraMeshVolumeCounts {
  readonly total: number;
  readonly positive: number;
  readonly inverted: number;
  readonly zero: number;
  readonly allPositive: boolean;
}

/** Count EVERY supplied cell, including failures, without repairing its node order.
 * Uses the decoder's exact sign on the supplied binary64 coordinates. This is an
 * orientation diagnostic, not a boundary/overlap proof or a solver accuracy claim;
 * the decoder's dimensional degeneracy threshold remains unchanged.
 */
export function countTetraMeshVolumes(value: unknown): TetraMeshVolumeCounts {
  requireInput(typeof value === 'object' && value !== null && 'coordinates' in value && 'tetrahedra' in value,
    'Tetra volume coordinates and cells required');
  function numbers(array: unknown, stride: number, maximum: number): asserts array is number[] {
    requireInput(Array.isArray(array) && array.length > 0 && array.length % stride === 0 && array.length <= maximum,
      'Invalid bounded tetra volume array');
    for (let i = 0; i < array.length; i++) {
      const item: unknown = array[i];
      requireInput(Object.hasOwn(array, i) && typeof item === 'number' && Number.isFinite(item),
        'Nonfinite or sparse tetra volume array');
    }
  }
  const coordinates = value.coordinates, tetrahedra = value.tetrahedra;
  numbers(coordinates, 3, TETRA_LIMITS.nodes * 3);
  numbers(tetrahedra, 4, TETRA_LIMITS.tetrahedra * 4);
  for (const node of tetrahedra) requireInput(Number.isSafeInteger(node) && node >= 0 && node < coordinates.length / 3,
    'Tetra volume index outside nodes');
  const orientation = exactTetrahedronOrientation(coordinates);
  let positive = 0, inverted = 0, zero = 0;
  for (let i = 0; i < tetrahedra.length; i += 4) {
    const sign = orientation(tetrahedra[i], tetrahedra[i + 1], tetrahedra[i + 2], tetrahedra[i + 3]);
    if (sign > 0) positive++;
    else if (sign < 0) inverted++;
    else zero++;
  }
  const total = tetrahedra.length / 4;
  return { total, positive, inverted, zero, allPositive: positive === total };
}

/** Prepared, part-local PLCs. CAD boundary extraction and its geometric proof remain upstream. */
export interface AssemblyTetraPart {
  readonly input: TetraMeshInput;
  readonly quality?: TetraMeshQualityLimits;
  /** Prepared by the CAD boundary route; omitted for legacy/non-CAD PLCs. */
  readonly regions?: AssemblyTetraRegions;
}
/** Native boundary labels may address individual curved triangles, not CAD faces. */
export interface AssemblyTetraRegions {
  readonly regions: readonly CadTetraRegion[];
  readonly labelFaces: readonly number[];
}
export interface AssemblyTetraContext {
  readonly documentId: string;
  readonly revision: number;
  readonly assembly: ResolvedAssembly;
  readonly parts: ReadonlyMap<string, AssemblyTetraPart>;
}
export interface AssemblyTetraBudget {
  readonly occurrences: number;
  readonly uniqueParts: number;
  /** Counts shared, part-local storage, not an expanded assembly mesh. */
  readonly nodes: number;
  readonly tetrahedra: number;
  /** Conservative retained numeric payload at eight bytes per number; NOT JS heap or GPU memory. */
  readonly numericBytes: number;
  /** The existing FemClient has one active request. This route deliberately serializes parts. */
  readonly concurrentGenerations: 1;
}
export interface AssemblyTetraOccurrence {
  readonly componentId: string;
  readonly partKey: string;
  readonly placement: RigidPlacement;
}
export interface AssemblyTetraMesh {
  readonly parts: ReadonlyMap<string, { readonly mesh: TetraMeshResult; readonly quality?: TetraMeshQuality;
    readonly regions?: AssemblyTetraRegions }>;
  readonly occurrences: readonly AssemblyTetraOccurrence[];
  readonly reservation: AssemblyTetraBudget;
  readonly physicsValidated: false;
}
export type AssemblyTetraBoundarySelection =
  | { readonly kind: 'selected'; readonly componentId: string; readonly partKey: string;
      readonly reference: SubShapeRef; readonly placement: RigidPlacement;
      /** All indices address the shared part-local mesh, not a welded assembly mesh. */
      readonly triangleIndices: readonly number[]; readonly nodeIndices: readonly number[] }
  | { readonly kind: 'refused'; readonly reason: 'stale' | 'missing-component' | 'missing-regions' | 'missing-face' | 'invalid' };

// Only a result published by this route carries a current-source observation. Nothing is serialized as a CAD proof.
const currentAssembly = new WeakMap<AssemblyTetraMesh, {
  readonly current: () => boolean;
  readonly occurrences: readonly AssemblyTetraOccurrence[];
  readonly parts: ReadonlyMap<string, AssemblyTetraPart>;
}>();
export type AssemblyTetraOutcome = { readonly kind: 'result'; readonly result: AssemblyTetraMesh }
  | { readonly kind: 'cancelled'; readonly reason: 'abort' | 'superseded' | 'disposed' }
  | { readonly kind: 'failed'; readonly code: 'input' | 'budget' | 'stale' | 'mesh' | 'quality'; readonly message: string };

type Client = Pick<FemClient, 'meshTetrahedra'>;
class Refusal extends Error {
  constructor(readonly code: 'input' | 'budget' | 'stale' | 'mesh' | 'quality', message: string) { super(message); }
}
function requireInput(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Refusal('input', message);
}
function placementCopy(value: RigidPlacement): RigidPlacement {
  requireInput(Object.keys(value).length === 2 && Array.isArray(value.position) && value.position.length === 3
    && Array.isArray(value.rotation) && value.rotation.length === 4
    && [...value.position, ...value.rotation].every(Number.isFinite)
    && Math.abs(Math.hypot(...value.rotation) - 1) <= QUATERNION_TOLERANCE, 'A finite rigid placement is required');
  return { position: [value.position[0], value.position[1], value.position[2]],
    rotation: [value.rotation[0], value.rotation[1], value.rotation[2], value.rotation[3]] };
}
function numericLength(input: TetraMeshInput): number {
  return input.coordinates.length + input.triangles.length + input.tags.length
    + (input.meshing === undefined ? 0 : 5)
    + (input.schema === 'pointercad-plc/2' ? input.shells.reduce((n, shell) => n + shell.triangles.length, 0) : 0);
}
function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) if (!Object.hasOwn(a, i) || a[i] !== b[i]) return false;
  return true;
}
function sameMetadata(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (actual === null || expected === null || typeof actual !== 'object' || typeof expected !== 'object') return false;
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  if (Array.isArray(actual) && Array.isArray(expected) && actual.length !== expected.length) return false;
  const left = actual as Record<string, unknown>, right = expected as Record<string, unknown>;
  const keys = Object.keys(right);
  return Object.keys(left).length === keys.length
    && keys.every(key => Object.hasOwn(left, key) && sameMetadata(left[key], right[key]));
}
function samePart(entry: AssemblyTetraPart, input: TetraMeshInput, quality?: TetraMeshQualityLimits,
  regions?: AssemblyTetraRegions): boolean {
  requireInput(Object.keys(entry).every(name => name === 'input' || name === 'quality' || name === 'regions'), 'Unknown part meshing condition');
  if (Object.hasOwn(entry, 'regions') !== (regions !== undefined)
    || (regions !== undefined && !sameMetadata(entry.regions, regions))) return false;
  const actual = entry.input;
  if (Object.keys(actual).length !== (input.schema === 'pointercad-plc/2' ? 8 : 7) + (input.meshing === undefined ? 0 : 1)
    || actual.schema !== input.schema || actual.units !== input.units || actual.tagCount !== input.tagCount
    || Object.keys(actual.source).length !== 4 || actual.source.documentId !== input.source.documentId
    || actual.source.revision !== input.source.revision || actual.source.featureId !== input.source.featureId
    || actual.source.bodyKey !== input.source.bodyKey || !sameNumbers(actual.coordinates, input.coordinates)
    || !sameNumbers(actual.triangles, input.triangles) || !sameNumbers(actual.tags, input.tags)) return false;
  if (Object.hasOwn(actual, 'meshing') !== Object.hasOwn(input, 'meshing')) return false;
  if (input.meshing !== undefined) {
    const expected = input.meshing, observed = actual.meshing;
    if (observed === undefined || observed === null || typeof observed !== 'object' || Object.keys(observed).length !== 4
      || observed.targetSizeMm !== expected.targetSizeMm || observed.grading !== expected.grading
      || observed.maximumOptimizationPasses !== expected.maximumOptimizationPasses
      || observed.quality === undefined || observed.quality === null || typeof observed.quality !== 'object' || Object.keys(observed.quality).length !== 2
      || observed.quality.minimumMeanRatio !== expected.quality.minimumMeanRatio
      || observed.quality.maximumEdgeRatio !== expected.quality.maximumEdgeRatio) return false;
  }
  if (input.schema === 'pointercad-plc/2') {
    if (actual.schema !== 'pointercad-plc/2') return false;
    // Keep the declared readonly element type; the runtime array guard narrows the property to any[].
    const shells = actual.shells;
    if (!Array.isArray(actual.shells) || shells.length !== input.shells.length) return false;
    for (let i = 0; i < input.shells.length; i++) {
      const shell = shells[i], expected = input.shells[i];
      if (!shell || Object.keys(shell).length !== 2 || shell.role !== expected.role || !sameNumbers(shell.triangles, expected.triangles)) return false;
    }
  }
  return quality === undefined ? entry.quality === undefined : entry.quality !== undefined
    && Object.keys(entry.quality).length === 2 && entry.quality.minimumMeanRatio === quality.minimumMeanRatio
    && entry.quality.maximumEdgeRatio === quality.maximumEdgeRatio;
}

/** Counts/validates retained numeric metadata before cloning. Strings are not claimed to be JS heap accounting. */
function metadataNumbers(value: unknown, ancestors = new Set<object>()): number {
  if (typeof value === 'number') { requireInput(Number.isFinite(value), 'Non-finite CAD region metadata'); return 1; }
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return 0;
  requireInput(typeof value === 'object' && !ancestors.has(value), 'CAD region metadata must be acyclic data');
  ancestors.add(value);
  let count = 0;
  const record = value as Record<string, unknown>;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) requireInput(Object.hasOwn(value, i), 'Sparse CAD region metadata');
  } else requireInput(Object.getPrototypeOf(value) === Object.prototype, 'CAD region metadata must be plain data');
  for (const name of Object.keys(record)) count += metadataNumbers(record[name], ancestors);
  ancestors.delete(value);
  requireInput(Number.isSafeInteger(count), 'CAD region metadata exceeds numeric capacity');
  return count;
}

function checkedRegions(value: AssemblyTetraRegions, input: TetraMeshInput): void {
  requireInput(value !== null && typeof value === 'object' && Object.keys(value).length === 2,
    'Explicit CAD regions and label mapping are required');
  const regions = value.regions, labels = value.labelFaces, triangles = input.triangles.length / 3;
  requireInput(Number.isSafeInteger(triangles) && triangles > 0 && triangles <= TETRA_LIMITS.boundaryTriangles
    && Number.isSafeInteger(input.tagCount) && input.tagCount > 0 && input.tagCount <= triangles
    && Array.isArray(value.regions) && regions.length > 0 && regions.length <= triangles
    && Array.isArray(value.labelFaces) && labels.length === input.tagCount, 'Invalid CAD region dimensions');
  const covered = new Set<number>(), faces = new Set<number>();
  const references: SubShapeRef[] = [];
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i];
    requireInput(Object.hasOwn(regions, i) && region !== undefined && region !== null
      && Object.keys(region).length === 3 && Number.isSafeInteger(region.tag) && region.tag >= 0 && region.tag < regions.length
      && !faces.has(region.tag), 'Repeated or invalid CAD face');
    const reference = region.reference;
    requireInput(reference !== undefined && reference !== null && reference.bodyFeatureId === input.source.featureId
      && Number.isSafeInteger(reference.index) && reference.index === region.tag
      && reference.fingerprint?.kind === 'face' && reference.origin?.shapeKind === 'face'
      && reference.origin.version === 1 && typeof reference.origin.identity?.kind === 'string'
      && typeof reference.origin.identity.featureId === 'string' && reference.origin.identity.featureId.length > 0,
    'A prepared persistent CAD face reference is required');
    requireInput(!references.some(previous => isSameSubShape(previous, reference)), 'Ambiguous persistent CAD face');
    references.push(reference); faces.add(region.tag);
    const indices = region.triangleIndices;
    requireInput(Array.isArray(region.triangleIndices) && indices.length > 0 && indices.length <= triangles,
      'Invalid CAD face triangle list');
    for (let j = 0; j < indices.length; j++) {
      const triangle = indices[j];
      requireInput(Object.hasOwn(indices, j) && Number.isSafeInteger(triangle) && triangle >= 0 && triangle < triangles
        && !covered.has(triangle) && labels[input.tags[triangle]] === region.tag, 'Invalid CAD face triangle membership');
      covered.add(triangle);
    }
  }
  for (let i = 0; i < labels.length; i++) requireInput(Object.hasOwn(labels, i)
    && Number.isSafeInteger(labels[i]) && faces.has(labels[i]), 'Native label has no CAD face');
  requireInput(covered.size === triangles, 'CAD regions must partition every boundary triangle');
}

/** Select the current occurrence's prepared CAD face without sharing nodes across contacting parts.
 * CAD extraction/history proof stays upstream; this checks captured provenance, current source and mesh membership. */
export function selectAssemblyTetraBoundary(result: AssemblyTetraMesh, componentId: string,
  reference: SubShapeRef): AssemblyTetraBoundarySelection {
  try {
    const observation = currentAssembly.get(result);
    if (!observation?.current()) return { kind: 'refused', reason: 'stale' };
    const matches = observation.occurrences.filter(occurrence => occurrence.componentId === componentId);
    if (matches.length !== 1) return { kind: 'refused', reason: 'missing-component' };
    const occurrence = matches[0], part = observation.parts.get(occurrence.partKey);
    if (!part?.regions) return { kind: 'refused', reason: 'missing-regions' };
    if (reference?.fingerprint?.kind !== 'face' || reference.origin?.shapeKind !== 'face')
      return { kind: 'refused', reason: 'missing-face' };
    const found = part.regions.regions.filter(region => isSameSubShape(region.reference, reference));
    if (found.length !== 1) return { kind: 'refused', reason: 'missing-face' };
    const region = found[0], nodes = new Set<number>();
    for (const triangle of region.triangleIndices) {
      for (let offset = 0; offset < 3; offset++) nodes.add(part.input.triangles[3 * triangle + offset]);
    }
    return { kind: 'selected', componentId, partKey: occurrence.partKey, reference: structuredClone(region.reference),
      placement: placementCopy(occurrence.placement), triangleIndices: Array.from(region.triangleIndices),
      nodeIndices: Array.from(nodes).sort((a, b) => a - b) };
  } catch { return { kind: 'refused', reason: 'invalid' }; }
}

/** Flat resolved assemblies only. Nested assemblies must be resolved to an explicit occurrence table upstream;
 * they are refused here, never silently omitted. No coordinates are transformed or duplicated per occurrence. */
export async function meshAssemblyTetrahedra(client: Client, readCurrent: () => AssemblyTetraContext | null,
  requestedBudget: AssemblyTetraBudget, options: FemOptions = {}): Promise<AssemblyTetraOutcome> {
  const owner = claimCadMeshRequest(client);
  const abort = (): void => owner.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) owner.abort();
  const cancelled = (): AssemblyTetraOutcome | undefined => !isCurrentCadMeshRequest(client, owner)
    ? { kind: 'cancelled', reason: 'superseded' } : owner.signal.aborted ? { kind: 'cancelled', reason: 'abort' } : undefined;
  try {
    const initialCancellation = cancelled();
    if (initialCancellation) return initialCancellation;
    const budget = { ...requestedBudget };
    requireInput(Object.keys(budget).length === 6 && Object.values(budget).every(n => Number.isSafeInteger(n) && n > 0)
      && budget.occurrences <= 1000 && budget.uniqueParts <= 1000 && budget.concurrentGenerations === 1, 'Invalid explicit assembly budget');
    const context = readCurrent();
    requireInput(context !== null && context.documentId.length > 0 && Number.isSafeInteger(context.revision)
      && context.revision >= 0, 'Missing assembly source');
    const { assembly, documentId, revision } = context;
    requireInput(assembly.errors.length === 0 && (assembly.subAssemblies?.size ?? 0) === 0,
      'Unresolved or nested assemblies require an explicit supported occurrence table');
    if (assembly.placements.size > budget.occurrences || assembly.parts.size > budget.uniqueParts)
      throw new Refusal('budget', 'Assembly part count exceeds reservation');
    requireInput(assembly.placements.size > 0 && assembly.partKeys.size === assembly.placements.size
      && context.parts.size === assembly.parts.size, 'Incomplete part or occurrence table');
    const occurrences: AssemblyTetraOccurrence[] = [];
    const used = new Set<string>();
    for (const [componentId, placement] of assembly.placements) {
      const partKey = assembly.partKeys.get(componentId);
      requireInput(componentId.length > 0 && partKey !== undefined && assembly.parts.has(partKey), 'Missing occurrence part');
      used.add(partKey);
      occurrences.push({ componentId, partKey, placement: placementCopy(placement) });
    }
    requireInput(used.size === assembly.parts.size, 'Unreferenced part table entries');
    const reservation: AssemblyTetraBudget = { occurrences: occurrences.length, uniqueParts: used.size,
      nodes: used.size * TETRA_LIMITS.nodes, tetrahedra: used.size * TETRA_LIMITS.tetrahedra,
      numericBytes: 0, concurrentGenerations: 1 };
    if (reservation.nodes > budget.nodes || reservation.tetrahedra > budget.tetrahedra)
      throw new Refusal('budget', 'Per-part native maxima exceed assembly reservation');
    // Reserve bounded input and output maxima BEFORE cloning PLC arrays or starting a Worker.
    const inputMaximum = TETRA_LIMITS.boundaryNodes * 3 + TETRA_LIMITS.boundaryTriangles * 5;
    const outputMaximum = TETRA_LIMITS.nodes * 3 + TETRA_LIMITS.tetrahedra * 4 + TETRA_LIMITS.boundaryTriangles * 4;
    const hasRegions = [...used].some(key => context.parts.get(key)?.regions !== undefined);
    // Region-aware publication owns a second placement copy; selection retains the original private snapshot.
    let reservedNumbers = occurrences.length * 7 * (hasRegions ? 2 : 1) + used.size * (inputMaximum * 2 + outputMaximum);
    for (const key of used) {
      const entry = context.parts.get(key);
      requireInput(entry !== undefined, 'Missing part-local PLC');
      const controlled = Object.hasOwn(entry.input, 'meshing');
      if (controlled) reservedNumbers += 10; // Five controls in each of two retained input copies.
      if (entry.quality !== undefined || controlled) reservedNumbers += TETRA_LIMITS.tetrahedra * 7;
      if (Object.hasOwn(entry, 'regions')) {
        requireInput(entry.regions !== undefined, 'Present CAD regions must have a value');
        checkedRegions(entry.regions, entry.input);
        // Private capture and public copy, once per unique part, never once per occurrence.
        reservedNumbers += 2 * metadataNumbers(entry.regions);
      }
    }
    const fullReservation = { ...reservation, numericBytes: reservedNumbers * 8 };
    if (!Number.isSafeInteger(fullReservation.numericBytes) || fullReservation.numericBytes > budget.numericBytes)
      throw new Refusal('budget', 'Retained numeric payload exceeds assembly reservation');
    const captured = new Map<string, { input: TetraMeshInput; quality?: TetraMeshQualityLimits;
      part: ResolvedPart; regions?: AssemblyTetraRegions }>();
    for (const key of used) {
      const entry = context.parts.get(key), part = assembly.parts.get(key);
      requireInput(entry !== undefined && part !== undefined && part.errors.length === 0, 'Invalid resolved part');
      const input = readTetraMeshInput(entry.input);
      requireInput(part.steps.some(step => step.featureId === input.source.featureId && step.key === input.source.bodyKey),
        'PLC source does not identify a resolved solid step');
      const quality = entry.quality === undefined ? undefined : readTetraMeshQualityLimits(entry.quality);
      if (entry.regions !== undefined) checkedRegions(entry.regions, input);
      const regions = entry.regions === undefined ? undefined : structuredClone(entry.regions);
      requireInput(samePart(entry, input, quality, regions), 'Unknown or changed part meshing condition');
      captured.set(key, { input, quality, part, regions });
    }
    const stillCurrent = (activeKey?: string): boolean => {
      const current = readCurrent();
      if (!current || current.documentId !== documentId || current.revision !== revision
        || current.assembly.errors.length !== 0 || (current.assembly.subAssemblies?.size ?? 0) !== 0
        || current.assembly.parts.size !== captured.size || current.parts.size !== captured.size
        || current.assembly.placements.size !== occurrences.length || current.assembly.partKeys.size !== occurrences.length) return false;
      for (const occurrence of occurrences) {
        const placement = current.assembly.placements.get(occurrence.componentId);
        if (!placement || current.assembly.partKeys.get(occurrence.componentId) !== occurrence.partKey
          || JSON.stringify(placementCopy(placement)) !== JSON.stringify(occurrence.placement)) return false;
      }
      for (const [key, value] of captured) {
        if (activeKey !== undefined && key !== activeKey) continue;
        const part = current.assembly.parts.get(key), entry = current.parts.get(key);
        if (!part || part !== value.part || part.errors.length !== 0
          || !part.steps.some(step => step.featureId === value.input.source.featureId && step.key === value.input.source.bodyKey)
          || !entry || !samePart(entry, value.input, value.quality, value.regions)) return false;
      }
      return true;
    };
    const results = new Map<string, { mesh: TetraMeshResult; quality?: TetraMeshQuality; regions?: AssemblyTetraRegions }>();
    let retainedNumbers = occurrences.length * 7 * (hasRegions ? 2 : 1);
    for (const [key, entry] of captured) {
      const hash = await tetraMeshInputSha256(entry.input);
      const before = cancelled();
      if (before) return before;
      if (!stillCurrent(key)) throw new Refusal('stale', 'Assembly source or placement changed');
      const completion = await client.meshTetrahedra(entry.input, { signal: owner.signal, onPhase: options.onPhase });
      const after = cancelled();
      if (after) return after;
      if (!stillCurrent(key)) throw new Refusal('stale', 'Assembly source or placement changed');
      if (completion.kind === 'cancelled') return { kind: 'cancelled', reason: completion.reason };
      if (completion.kind === 'failed') throw new Refusal('mesh', completion.failure.message);
      const mesh = completion.result;
      if (!tetraMeshResultMatches(mesh, entry.input, hash)) throw new Refusal('mesh', 'Part mesh provenance or geometry mismatch');
      if (!countTetraMeshVolumes(mesh).allPositive) throw new Refusal('quality', 'Part mesh has nonpositive tetrahedra');
      const nativeLimits = entry.input.meshing?.quality;
      const limits = nativeLimits === undefined ? entry.quality : entry.quality === undefined ? nativeLimits : {
        minimumMeanRatio: Math.max(entry.quality.minimumMeanRatio, nativeLimits.minimumMeanRatio),
        maximumEdgeRatio: Math.min(entry.quality.maximumEdgeRatio, nativeLimits.maximumEdgeRatio),
      };
      const quality = limits === undefined ? undefined : diagnoseTetraMeshQuality(mesh, limits);
      if (quality && !quality.meetsRequestedLimits) throw new Refusal('quality', 'Part mesh fails requested quality');
      retainedNumbers += numericLength(mesh.input) + mesh.coordinates.length + mesh.tetrahedra.length
        + mesh.boundaryTriangles.length + mesh.boundaryTags.length + (quality ? quality.elements.length * 7 : 0)
        + (entry.regions === undefined ? 0 : 2 * metadataNumbers(entry.regions));
      if (retainedNumbers * 8 > fullReservation.numericBytes) throw new Refusal('budget', 'Result exceeds reserved numeric payload');
      results.set(key, { mesh, ...(quality === undefined ? {} : { quality }),
        ...(entry.regions === undefined ? {} : { regions: structuredClone(entry.regions) }) });
    }
    const finalCancellation = cancelled();
    if (finalCancellation) return finalCancellation;
    if (!stillCurrent()) throw new Refusal('stale', 'Assembly changed before publication');
    const result: AssemblyTetraMesh = { parts: results,
      occurrences: hasRegions ? occurrences.map(value => ({ ...value, placement: placementCopy(value.placement) })) : occurrences,
      reservation: fullReservation, physicsValidated: false };
    const published = new Map(results);
    currentAssembly.set(result, { occurrences, parts: captured, current: () => {
      if (!stillCurrent() || !sameMetadata(result.occurrences, occurrences) || result.parts.size !== published.size) return false;
      for (const [key, expected] of published) {
        const part = captured.get(key), actual = result.parts.get(key);
        if (!part || !actual || actual !== expected || !sameMetadata(actual.regions, part.regions)
          || !samePart({ input: actual.mesh.input }, part.input)
          || !sameNumbers(actual.mesh.boundaryTriangles, part.input.triangles)
          || !sameNumbers(actual.mesh.boundaryTags, part.input.tags)) return false;
        // Selection addresses the immutable PLC boundary prefix of the returned mesh.
        for (let i = 0; i < part.input.coordinates.length; i++)
          if (actual.mesh.coordinates[i] !== part.input.coordinates[i]) return false;
      }
      return true;
    } });
    return { kind: 'result', result };
  } catch (error) {
    const cancellation = cancelled();
    if (cancellation) return cancellation;
    return { kind: 'failed', code: error instanceof Refusal ? error.code : 'input',
      message: error instanceof Error ? error.message : 'Invalid assembly mesh request' };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    releaseCadMeshRequest(client, owner);
  }
}
