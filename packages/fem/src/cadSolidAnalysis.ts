import { isSameSubShape, resolveCurrentOrigin, type AnalysisBoundaryOptions, type AnalysisBoundarySource,
  type SubShapeRef } from '@pointercad/model';
import type { FemClient, FemOptions } from './client.js';
import { meshCadBoundary, type CadTetraContext, type CadTetraRegion } from './cadTetraMesh.js';
import { meshCadCurvedBoundary, type CurvedCadTetraOptions } from './cadCurvedTetraMesh.js';
import { isTetraMeshResult, type TetraMeshResult, type TetraMeshingControls } from './tetraMesh.js';
import { translateSolidAnalysis } from './solidAnalysisTranslation.js';
import type { SolidAnalysisInput, SolidAnalysisResult, SolidMaterial, SolidVector3 } from './solidAnalysisModel.js';

/** One current solid. Surface traction is a global vector in N/mm^2, not a resultant force. */
export interface CadSolidSettings {
  readonly material: SolidMaterial;
  readonly fixedFaces: readonly SubShapeRef[];
  readonly loadedFaces: readonly SubShapeRef[];
  readonly tractionMPa: SolidVector3;
  readonly numericBudgetBytes: number;
  readonly meshing?: TetraMeshingControls;
  readonly geometry: { readonly kind: 'planar'; readonly boundary: AnalysisBoundaryOptions }
    | { readonly kind: 'curved'; readonly options: CurvedCadTetraOptions };
}
/** Signed dead pressure in MPa on the undeformed material boundary. Positive is
 * inward (compression); negative is outward. Cavity faces use their actual
 * outward-from-material winding. This is not a follower load or contact law. */
export interface CadSolidPressureSettings extends Omit<CadSolidSettings, 'tractionMPa'> {
  readonly pressureMPa: number;
}
export interface CadSolidPrepared {
  readonly input: SolidAnalysisInput;
  readonly loadedAreaMm2: number;
  readonly totalForceN: SolidVector3;
}
export type CadSolidOutcome =
  | { readonly kind: 'result'; readonly result: SolidAnalysisResult; readonly prepared: CadSolidPrepared;
      readonly mesh: TetraMeshResult }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string }
  | { readonly kind: 'cancelled'; readonly reason: 'abort' | 'superseded' | 'disposed' };

function requireInput(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function sourceKey(context: CadTetraContext): string {
  requireInput(context.body.isValid && context.body.bodyKind === 'solid', 'A current valid solid is required');
  const steps = context.steps.filter(step => step.featureId === context.body.featureId);
  requireInput(steps.length === 1 && steps[0].key.length > 0, 'A unique current body key is required');
  return JSON.stringify({ documentId: context.documentId, revision: context.revision, step: steps[0],
    volume: context.body.volume, faces: context.body.faces, origins: context.body.origins });
}

/** Use the captured CAD region table, never interpret a native label as a persistent face identity. */
export function prepareCadSolidAnalysis(context: CadTetraContext, mesh: TetraMeshResult,
  regions: readonly CadTetraRegion[], labelFaces: readonly number[],
  settings: CadSolidSettings | CadSolidPressureSettings): CadSolidPrepared {
  sourceKey(context);
  const pressure = 'pressureMPa' in settings;
  requireInput('pressureMPa' in settings ? Number.isFinite(settings.pressureMPa) && !('tractionMPa' in settings)
    : 'tractionMPa' in settings, 'Supply either a finite signed pressure or a global traction');
  requireInput(isTetraMeshResult(mesh), 'Invalid tetra mesh');
  const step = context.steps.find(value => value.featureId === context.body.featureId);
  requireInput(mesh.input.source.documentId === context.documentId && mesh.input.source.revision === context.revision
    && mesh.input.source.featureId === context.body.featureId && mesh.input.source.bodyKey === step?.key,
  'Mesh belongs to another CAD revision');
  requireInput(regions.length === context.body.faces.length && regions.length > 0, 'Incomplete CAD region table');
  requireInput(labelFaces.length === mesh.input.tagCount && labelFaces.every(face => Number.isSafeInteger(face)
    && context.body.faces.some(current => current.index === face)), 'Invalid native label to CAD face map');
  const covered = new Set<number>(), faces = new Set<number>();
  for (const region of regions) {
    const lookup = resolveCurrentOrigin(context.body, region.reference);
    requireInput(lookup.status === 'matched' && lookup.address.kind === 'face' && lookup.address.index === region.tag
      && !faces.has(region.tag) && region.triangleIndices.length > 0, 'Ambiguous or stale CAD region');
    faces.add(region.tag);
    for (const index of region.triangleIndices) {
      requireInput(Number.isSafeInteger(index) && index >= 0 && index < mesh.boundaryTags.length
        && !covered.has(index) && labelFaces[mesh.boundaryTags[index]] === region.tag,
      'Invalid boundary triangle membership');
      covered.add(index);
    }
  }
  requireInput(covered.size === mesh.boundaryTags.length, 'Missing boundary triangles');
  const selected = (references: readonly SubShapeRef[]): number[] => {
    requireInput(references.length > 0 && references.length <= regions.length, 'Select current CAD faces');
    const selectedFaces = new Set<number>();
    const indices: number[] = [];
    for (const reference of references) {
      const lookup = resolveCurrentOrigin(context.body, reference);
      const matches = regions.filter(region => isSameSubShape(region.reference, reference));
      requireInput(lookup.status === 'matched' && lookup.address.kind === 'face' && matches.length === 1
        && matches[0].tag === lookup.address.index && !selectedFaces.has(matches[0].tag),
      'Missing, repeated or ambiguous selected face');
      selectedFaces.add(matches[0].tag);
      indices.push(...matches[0].triangleIndices);
    }
    return indices;
  };
  const fixedTriangles = selected(settings.fixedFaces), loadedTriangles = selected(settings.loadedFaces);
  const nodes: SolidVector3[] = [];
  for (let i = 0; i < mesh.coordinates.length; i += 3)
    nodes.push([mesh.coordinates[i], mesh.coordinates[i + 1], mesh.coordinates[i + 2]]);
  const triangle = (index: number): [number, number, number] => [mesh.boundaryTriangles[3 * index],
    mesh.boundaryTriangles[3 * index + 1], mesh.boundaryTriangles[3 * index + 2]];
  const fixed = new Set(fixedTriangles.flatMap(triangle));
  let area = 0;
  const pressureForce: [number, number, number] = [0, 0, 0];
  const surfaceLoads = loadedTriangles.map(index => {
    const ids = triangle(index), [a, b, c] = ids.map(node => nodes[node]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross: SolidVector3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const twiceArea = Math.hypot(...cross), value = twiceArea / 2;
    requireInput(Number.isFinite(value) && value > 0, 'Degenerate loaded boundary triangle');
    area += value;
    // isTetraMeshResult checks every boundary winding against positive tet4
    // incidence. Never infer a physical normal from a display mesh/CAD axis.
    const tractionMPa: SolidVector3 = 'pressureMPa' in settings
      ? [-settings.pressureMPa * (cross[0] / twiceArea), -settings.pressureMPa * (cross[1] / twiceArea),
        -settings.pressureMPa * (cross[2] / twiceArea)] : settings.tractionMPa;
    if (pressure) for (let axis = 0; axis < 3; axis += 1) pressureForce[axis] += value * tractionMPa[axis];
    return { nodes: ids, tractionMPa };
  });
  const elements: SolidAnalysisInput['elements'][number][] = [];
  for (let i = 0; i < mesh.tetrahedra.length; i += 4) elements.push({ materialId: settings.material.id,
    nodes: [mesh.tetrahedra[i], mesh.tetrahedra[i + 1], mesh.tetrahedra[i + 2], mesh.tetrahedra[i + 3]] });
  const totalForceN: SolidVector3 = 'pressureMPa' in settings ? pressureForce
    : [area * settings.tractionMPa[0], area * settings.tractionMPa[1], area * settings.tractionMPa[2]];
  requireInput(Number.isFinite(area) && totalForceN.every(Number.isFinite), 'Surface load overflow');
  const input = translateSolidAnalysis({ schema: 'pointercad-solid-tet4/1', units: 'N-mm-MPa',
    source: { documentId: context.documentId, revision: context.revision, meshKey: mesh.inputSha256 },
    numericBudgetBytes: settings.numericBudgetBytes, nodes, elements, materials: [settings.material],
    constraints: [...fixed].map(node => ({ node, fixed: [true, true, true] })), nodalLoads: [], surfaceLoads }).input;
  return { input, loadedAreaMm2: area, totalForceN };
}

const owners = new WeakMap<object, AbortController>();
/** Actual CAD -> owned Netgen -> strict tet4 input -> actual public OOFEM client. */
export async function analyzeCadSolid(client: Pick<FemClient, 'meshTetrahedra' | 'analyzeSolid'>,
  kernel: AnalysisBoundarySource, readCurrent: () => CadTetraContext,
  requested: CadSolidSettings | CadSolidPressureSettings,
  options: FemOptions = {}): Promise<CadSolidOutcome> {
  owners.get(client)?.abort();
  const owner = new AbortController();
  owners.set(client, owner);
  const abort = (): void => owner.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) owner.abort();
  const cancellation = (): CadSolidOutcome | null => owners.get(client) !== owner
    ? { kind: 'cancelled', reason: 'superseded' } : owner.signal.aborted ? { kind: 'cancelled', reason: 'abort' } : null;
  try {
    const settings = structuredClone(requested), initial = readCurrent(), signature = sourceKey(initial);
    const current = (): CadTetraContext => {
      const value = readCurrent();
      requireInput(sourceKey(value) === signature, 'CAD source changed during analysis');
      return value;
    };
    const early = cancellation();
    if (early) return early;
    const mesh = settings.geometry.kind === 'planar'
      ? await meshCadBoundary(client, kernel, current, settings.geometry.boundary, { ...options, signal: owner.signal }, undefined, settings.meshing)
        .then(outcome => outcome.kind !== 'result' ? outcome : { ...outcome,
          labelFaces: Array.from({ length: outcome.mesh.input.tagCount }, (_, index) => index) })
      : await meshCadCurvedBoundary(client, kernel, current, settings.geometry.options, { ...options, signal: owner.signal }, undefined, settings.meshing);
    const afterMesh = cancellation();
    if (afterMesh) return afterMesh;
    if (mesh.kind !== 'result') return mesh;
    const prepared = prepareCadSolidAnalysis(current(), mesh.mesh, mesh.regions, mesh.labelFaces, settings);
    const completion = await client.analyzeSolid(prepared.input, { ...options, signal: owner.signal });
    const afterSolve = cancellation();
    if (afterSolve) return afterSolve;
    current();
    if (completion.kind === 'cancelled') return completion;
    if (completion.kind === 'failed') return { kind: 'failed', ...completion.failure };
    return { kind: 'result', result: completion.result, prepared, mesh: mesh.mesh };
  } catch (error) {
    return cancellation() ?? { kind: 'failed', code: 'cad-solid', message: error instanceof Error ? error.message : 'Invalid CAD solid analysis' };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    if (owners.get(client) === owner) owners.delete(client);
  }
}
