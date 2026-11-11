import { resolveCurrentOrigin } from '@pointercad/model';
import { InputIssue, readSolidContactInput, type SolidContactSavedInput, type Vector3 } from '@pointercad/model/beam-analysis';
import { bindCadBoundaryIdentity, type CadAnalysisBoundaryIdentity, type CadTetraContext, type CadTetraRegion } from './cadTetraMesh.js';
import { buildSolidContactPlan, type SolidContactPlan } from './solidContactModel.js';
import { searchContactFacets, type SolidContactFacetCandidate, type SolidContactSearchMesh } from './solidContactSearch.js';
import { isTetraMeshResult, tetraMeshInputSha256, type TetraMeshResult } from './tetraMesh.js';
import { sha256Hex } from './sha256.js';
import type { FemClient, FemOptions } from './client.js';
import { bindSolidContactInput, decodeSolidContactResult, type SolidContactInput, type SolidContactResult,
  type SolidContactSolveSettings, type SolidContactFailureDiagnostics } from './solidContactBinding.js';

/** Captured CAD/native-meshing output in a common coordinate frame. Occurrence
 * placements are not part of this interface; repeated bodies need a later binding. */
export interface CadSolidContactBody {
  readonly context: CadTetraContext;
  readonly mesh: TetraMeshResult;
  readonly regions: readonly CadTetraRegion[];
  readonly labelFaces: readonly number[];
}
export interface CadSolidContactBodySource {
  readonly bodyFeatureId: string;
  readonly bodyKey: string;
  readonly inputSha256: string;
  /** Actual volume nodes, tetrahedra, boundary triangles and boundary tags. */
  readonly meshSha256: string;
}
 interface CadSolidContactBodyMap {
  readonly bodyFeatureId: string;
  readonly localToGlobalNodes: readonly number[];
  readonly tetrahedronOffset: number;
  readonly tetrahedronCount: number;
}
 interface CadSolidContactCandidate {
  readonly geometry: SolidContactFacetCandidate;
  readonly masterGlobalNodes: readonly [number, number, number];
  readonly slaveGlobalNodes: readonly [number, number, number];
}
export interface CadSolidContactPrepared {
  readonly kind: 'cad-solid-contact-prepared';
  readonly source: {
    readonly documentId: string;
    readonly revision: number;
    readonly bodies: readonly CadSolidContactBodySource[];
  };
  readonly plan: SolidContactPlan;
  readonly searchMeshes: readonly SolidContactSearchMesh[];
  readonly nodesMm: readonly Vector3[];
  readonly tetrahedra: readonly (readonly [number, number, number, number])[];
  readonly bodyMaps: readonly CadSolidContactBodyMap[];
  readonly candidates: readonly CadSolidContactCandidate[];
  readonly searchDistanceMm: number;
  /** Digest of this owned preparation's fixed-order payload, excluding this field. */
  readonly preparationSha256: string;
}
 interface CadSolidContactOptions {
  readonly searchDistanceMm: number;
  readonly signal?: AbortSignal;
}
interface CapturedBody {
  readonly documentId: string;
  readonly revision: number;
  readonly bodyFeatureId: string;
  readonly bodyKey: string;
  readonly mesh: TetraMeshResult;
  readonly identity: CadAnalysisBoundaryIdentity;
}

const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function refuse(code: string, reason: string): never { throw new InputIssue(code, 'cad-solid-contact', reason); }
function requireInput(condition: boolean, reason: string): asserts condition {
  if (!condition) refuse('cad-contact-input', reason);
}
function dense(value: readonly unknown[], reason: string): void {
  requireInput(Array.isArray(value), reason);
  for (let index = 0; index < value.length; index++) requireInput(Object.hasOwn(value, index), reason);
}
function deepFreeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
}
function uniqueBodyKey(context: CadTetraContext): string {
  requireInput(context.body.isValid && context.body.bodyKind === 'solid'
    && Number.isFinite(context.body.volume) && context.body.volume > 0, 'A current valid solid body is required');
  requireInput(typeof context.documentId === 'string' && context.documentId.length > 0
    && Number.isSafeInteger(context.revision) && context.revision >= 0
    && typeof context.body.featureId === 'string' && context.body.featureId.length > 0, 'Expected current document, revision and body identities');
  dense(context.steps, 'Current body steps must be dense');
  const steps = context.steps.filter(step => step.featureId === context.body.featureId);
  requireInput(steps.length === 1 && typeof steps[0].key === 'string' && steps[0].key.length > 0,
    'A unique current body key is required');
  return steps[0].key;
}
function checkedList(value: readonly CadSolidContactBody[]): readonly CadSolidContactBody[] {
  dense(value, 'Expected a dense list of CAD bodies');
  requireInput(value.length > 0, 'At least one current body is required');
  const seen = new Set<string>();
  for (const item of value) {
    requireInput(item !== null && typeof item === 'object'
      && Reflect.ownKeys(item).length === 4
      && ['context', 'mesh', 'regions', 'labelFaces'].every(name => Object.hasOwn(item, name)),
    'Supply only current CAD context, mesh, regions and labels; occurrence placement is not supported');
    uniqueBodyKey(item.context);
    const id = item.context.body.featureId;
    requireInput(!seen.has(id), 'Repeated body identities require an occurrence-aware contact binding');
    seen.add(id);
  }
  return [...value].sort((a, b) => compareText(a.context.body.featureId, b.context.body.featureId));
}
/** Observe only analysis-relevant data, never the render mesh. Capture it as a
 * value immediately so later mutations cannot update the original signature. */
function currentSignature(value: readonly CadSolidContactBody[]): string {
  return JSON.stringify(checkedList(value).map(item => ({
    documentId: item.context.documentId, revision: item.context.revision,
    bodyFeatureId: item.context.body.featureId, bodyKey: uniqueBodyKey(item.context),
    volume: item.context.body.volume, faces: item.context.body.faces, origins: item.context.body.origins,
    mesh: { kind: item.mesh.kind, input: item.mesh.input, inputSha256: item.mesh.inputSha256,
      coordinates: item.mesh.coordinates, tetrahedra: item.mesh.tetrahedra,
      boundaryTriangles: item.mesh.boundaryTriangles, boundaryTags: item.mesh.boundaryTags,
      volumeMm3: item.mesh.volumeMm3, minTetVolumeMm3: item.mesh.minTetVolumeMm3 },
    regions: [...item.regions].sort((a, b) => a.tag - b.tag).map(region => ({
      tag: region.tag, reference: region.reference, triangleIndices: [...region.triangleIndices].sort((a, b) => a - b) })),
    labelFaces: item.labelFaces,
  })));
}
function captureBody(item: CadSolidContactBody, documentId: string, revision: number): CapturedBody {
  const { context } = item, bodyKey = uniqueBodyKey(context);
  requireInput(context.documentId === documentId && context.revision === revision,
    'Contact bodies must be current in the same document revision and common coordinate frame');
  const mesh: TetraMeshResult = structuredClone(item.mesh);
  requireInput(isTetraMeshResult(mesh), 'Invalid volume mesh or oriented boundary');
  requireInput(mesh.input.source.documentId === documentId && mesh.input.source.revision === revision
    && mesh.input.source.featureId === context.body.featureId && mesh.input.source.bodyKey === bodyKey,
  'The volume mesh belongs to another CAD source');
  requireInput(Math.abs(mesh.volumeMm3 - context.body.volume) <= context.body.volume * 1e-10,
    'The volume mesh does not match the current solid volume');
  dense(item.regions, 'CAD regions must form a dense partition');
  dense(item.labelFaces, 'Native labels must have a dense CAD face map');
  dense(context.body.faces, 'Current CAD faces must be dense');
  const regions = structuredClone(item.regions).map(region => ({ ...region,
    triangleIndices: [...region.triangleIndices].sort((a, b) => a - b) })).sort((a, b) => a.tag - b.tag);
  const labelFaces = [...item.labelFaces], faceIndices = new Set(context.body.faces.map(face => face.index));
  requireInput(faceIndices.size === context.body.faces.length && regions.length === faceIndices.size && regions.length > 0,
    'CAD regions must cover each current face exactly once');
  requireInput(labelFaces.length === mesh.input.tagCount
    && labelFaces.every(face => Number.isSafeInteger(face) && faceIndices.has(face)), 'Invalid native-label to CAD-face map');
  const covered = new Set<number>(), seenFaces = new Set<number>();
  for (const region of regions) {
    const lookup = resolveCurrentOrigin(context.body, region.reference);
    requireInput(lookup.status === 'matched' && lookup.address.kind === 'face' && lookup.address.index === region.tag
      && faceIndices.has(region.tag) && !seenFaces.has(region.tag), 'A CAD region has stale, repeated or ambiguous face provenance');
    seenFaces.add(region.tag);
    dense(region.triangleIndices, 'Region triangles must be dense');
    requireInput(region.triangleIndices.length > 0, 'Each CAD face needs its boundary triangles');
    for (const triangle of region.triangleIndices) {
      requireInput(Number.isSafeInteger(triangle) && triangle >= 0 && triangle < mesh.boundaryTags.length
        && !covered.has(triangle) && labelFaces[mesh.boundaryTags[triangle]] === region.tag,
      'CAD regions must partition the actual volume-mesh boundary with the current labels');
      covered.add(triangle);
    }
  }
  requireInput(covered.size === mesh.boundaryTags.length, 'The CAD region table omits a boundary triangle');
  // isTetraMeshResult validated the oriented PLC before this existing W05 binder.
  const identity = bindCadBoundaryIdentity(mesh.input, context, regions, undefined,
    (code, reason) => refuse(`cad-contact-${code}`, reason));
  return { documentId, revision, bodyFeatureId: context.body.featureId, bodyKey, mesh, identity };
}
function meshPayload(mesh: TetraMeshResult): object {
  return { coordinates: mesh.coordinates, tetrahedra: mesh.tetrahedra,
    boundaryTriangles: mesh.boundaryTriangles, boundaryTags: mesh.boundaryTags };
}
function appendBody(body: CapturedBody, nodes: Vector3[], tetrahedra: [number, number, number, number][]): CadSolidContactBodyMap {
  const offset = nodes.length, localToGlobalNodes: number[] = [], tetrahedronOffset = tetrahedra.length;
  for (let index = 0; index < body.mesh.coordinates.length; index += 3) {
    localToGlobalNodes.push(nodes.length);
    nodes.push([body.mesh.coordinates[index], body.mesh.coordinates[index + 1], body.mesh.coordinates[index + 2]]);
  }
  for (let index = 0; index < body.mesh.tetrahedra.length; index += 4) {
    tetrahedra.push([offset + body.mesh.tetrahedra[index], offset + body.mesh.tetrahedra[index + 1],
      offset + body.mesh.tetrahedra[index + 2], offset + body.mesh.tetrahedra[index + 3]]);
  }
  return { bodyFeatureId: body.bodyFeatureId, localToGlobalNodes,
    tetrahedronOffset, tetrahedronCount: tetrahedra.length - tetrahedronOffset };
}

/** W23-A preparation only: joins current CAD face provenance and actual volume
 * meshes to the existing W16/W17 contact planner/search. No native solve, contact
 * integration rule, convergence certificate, support reaction or Worker result
 * is created. Coordinate coincidences never weld nodes across distinct bodies. */
export async function prepareCadSolidContact(savedInput: SolidContactSavedInput,
  readCurrent: () => readonly CadSolidContactBody[], options: CadSolidContactOptions): Promise<CadSolidContactPrepared> {
  const signal = options.signal, searchDistanceMm = options.searchDistanceMm;
  const checkCancellation = (): void => {
    if (signal?.aborted) refuse('cad-contact-cancelled', 'Contact preparation was cancelled; no preparation is published');
  };
  checkCancellation();
  requireInput(Number.isFinite(searchDistanceMm) && searchDistanceMm >= 0, 'Search distance must be finite and nonnegative in mm');
  const saved = readSolidContactInput(savedInput), initial = checkedList(readCurrent());
  const signature = currentSignature(initial), documentId = initial[0].context.documentId, revision = initial[0].context.revision;
  requireInput(saved.source.documentId === documentId, 'Saved contacts belong to another document');
  const bodies = initial.map(item => captureBody(item, documentId, revision));
  const current = (): void => {
    checkCancellation();
    let observed: string;
    try { observed = currentSignature(readCurrent()); }
    catch { return refuse('cad-contact-stale', 'Current CAD/mesh data became invalid during contact preparation'); }
    if (observed !== signature) refuse('cad-contact-stale', 'CAD, revision, mesh or face provenance changed during contact preparation');
    checkCancellation();
  };
  const sources: CadSolidContactBodySource[] = [];
  for (const body of bodies) {
    current();
    const inputSha256 = await tetraMeshInputSha256(body.mesh.input);
    current();
    requireInput(inputSha256 === body.mesh.inputSha256, 'The mesh input SHA does not match its actual input bytes');
    const meshSha256 = await sha256Hex(new TextEncoder().encode(JSON.stringify(meshPayload(body.mesh))));
    current();
    sources.push({ bodyFeatureId: body.bodyFeatureId, bodyKey: body.bodyKey, inputSha256, meshSha256 });
  }
  const plan = buildSolidContactPlan({ ...saved, contacts: [...saved.contacts].sort((a, b) => compareText(a.id, b.id)) }, {
    documentId, boundaries: bodies.map(body => ({ boundaryIdentity: body.identity, triangleCount: body.mesh.boundaryTriangles.length / 3 })) });
  const searchMeshes: SolidContactSearchMesh[] = bodies.map(body => ({ boundaryIdentity: body.identity,
    coordinates: body.mesh.coordinates, triangles: body.mesh.boundaryTriangles }));
  const geometry = searchContactFacets(plan, searchMeshes, searchDistanceMm);
  const nodesMm: Vector3[] = [], tetrahedra: [number, number, number, number][] = [];
  const bodyMaps = bodies.map(body => appendBody(body, nodesMm, tetrahedra));
  const maps = new Map(bodyMaps.map(mapping => [mapping.bodyFeatureId, mapping]));
  const globalNodes = (body: string, local: readonly [number, number, number]): [number, number, number] => {
    const map = maps.get(body);
    if (map === undefined) return refuse('cad-contact-input', 'A searched contact body has no volume-node map');
    const ids = local.map(node => map.localToGlobalNodes[node]);
    requireInput(ids.every(id => Number.isSafeInteger(id) && id >= 0), 'A contact facet has an invalid volume-node map');
    return [ids[0], ids[1], ids[2]];
  };
  const candidates = geometry.map(candidate => ({ geometry: candidate,
    masterGlobalNodes: globalNodes(candidate.master.bodyFeatureId, candidate.master.nodeIndices),
    slaveGlobalNodes: globalNodes(candidate.slave.bodyFeatureId, candidate.slave.nodeIndices) }));
  const payload = { kind: 'cad-solid-contact-prepared' as const, source: { documentId, revision, bodies: sources },
    plan, searchMeshes, nodesMm, tetrahedra, bodyMaps, candidates, searchDistanceMm };
  const preparationSha256 = await sha256Hex(new TextEncoder().encode(JSON.stringify(payload)));
  current();
  const prepared: CadSolidContactPrepared = { ...payload, preparationSha256 };
  deepFreeze(prepared);
  return prepared;
}

export type CadSolidContactOutcome =
  | { readonly kind: 'result'; readonly result: SolidContactResult; readonly input: SolidContactInput; readonly prepared: CadSolidContactPrepared }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string; readonly contactDiagnostics?: SolidContactFailureDiagnostics }
  | { readonly kind: 'cancelled'; readonly reason: 'abort' | 'superseded' | 'disposed' };

/** Prepare current CAD/volume data, execute through the existing Worker owner,
 * then re-prepare the current CAD after every result await. A result is never
 * published merely because its original document revision still has the same number. */
export async function analyzeCadSolidContact(client: Pick<FemClient, 'beginSolidContactPreparation'>,
  savedInput: SolidContactSavedInput, readCurrent: () => readonly CadSolidContactBody[],
  requested: SolidContactSolveSettings, searchDistanceMm: number, options: FemOptions = {}): Promise<CadSolidContactOutcome> {
  const owner = client.beginSolidContactPreparation(options);
  const cancellation = (): CadSolidContactOutcome | null => {
    const reason = owner.cancellation();
    return reason === null ? null : { kind: 'cancelled', reason };
  };
  try {
    const early = cancellation();
    if (early !== null) return early;
    const saved = readSolidContactInput(savedInput), settings = structuredClone(requested);
    const initialSignature = currentSignature(readCurrent());
    const current = (): readonly CadSolidContactBody[] => {
      const bodies = readCurrent();
      if (currentSignature(bodies) !== initialSignature) refuse('cad-contact-stale', 'CAD or volume mesh changed during contact analysis');
      return bodies;
    };
    const prepared = await prepareCadSolidContact(saved, current, { searchDistanceMm, signal: owner.signal });
    const afterPreparation = cancellation();
    if (afterPreparation !== null) return afterPreparation;
    const input = await bindSolidContactInput(prepared, current().map(body => ({ bodyFeatureId: body.context.body.featureId, mesh: body.mesh })), settings);
    const afterBinding = cancellation();
    if (afterBinding !== null) return afterBinding;
    current();
    const completion = await owner.analyzeSolidContact(input);
    const afterSolve = cancellation();
    if (afterSolve !== null) return afterSolve;
    current();
    if (completion.kind === 'cancelled') return completion;
    if (completion.kind === 'failed') return { kind: 'failed', ...completion.failure };
    const result = await decodeSolidContactResult(completion.result, input);
    const afterDecoding = cancellation();
    if (afterDecoding !== null) return afterDecoding;
    const currentPreparation = await prepareCadSolidContact(saved, current, { searchDistanceMm, signal: owner.signal });
    const afterValidation = cancellation();
    if (afterValidation !== null) return afterValidation;
    if (currentPreparation.preparationSha256 !== prepared.preparationSha256) refuse('cad-contact-stale', 'Current contact preparation differs from the solved source');
    current();
    return { kind: 'result', result, input, prepared };
  } catch (error) {
    return cancellation() ?? { kind: 'failed', code: 'cad-solid-contact', message: error instanceof Error ? error.message : 'Invalid CAD contact analysis' };
  } finally {
    owner.release();
  }
}
