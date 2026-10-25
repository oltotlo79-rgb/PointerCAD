import { meshCadBoundary, meshCadCurvedBoundary, prepareCadSolidAnalysis, type CadSolidSettings, type CadTetraContext,
  type FemClient, type FemOptions, type SolidModalInput, type SolidModalResult } from '@pointercad/fem';
import type { AnalysisBoundarySource, SubShapeRef } from '@pointercad/model';

/**
 * UI adapter (no FEM runtime of its own): the static CAD path's own meshing (meshCadBoundary / meshCadCurvedBoundary)
 * and face resolution (prepareCadSolidAnalysis) produce the nodes, elements and fixed nodes; this file only maps them
 * to the modal request and calls FemClient.analyzeSolidModal. The static preparation requires a selected face set
 * and a load, so it is given the restrained faces (or, for free-free, one face of the same body) with a zero traction:
 * a load does not enter a free-vibration problem and its triangles are not used. Free-free drops every constraint.
 */
export interface CadSolidModalSettings {
  readonly material: { readonly id: string; readonly youngMPa: number; readonly poisson: number; readonly densityKgM3: number };
  /** Empty: free-free (one connected solid, six rigid modes removed by the solver). */
  readonly fixedFaces: readonly SubShapeRef[];
  /** Any face of the analysed body; used only to satisfy the static preparation when fixedFaces is empty. */
  readonly anchorFace: SubShapeRef;
  readonly modeCount: number;
  readonly numericBudgetBytes: number;
  readonly meshing?: CadSolidSettings['meshing'];
  readonly geometry: CadSolidSettings['geometry'];
}
export type CadSolidModalOutcome =
  | { readonly kind: 'result'; readonly input: SolidModalInput; readonly result: SolidModalResult }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string }
  | { readonly kind: 'cancelled'; readonly reason: 'abort' | 'superseded' | 'disposed' };

/** The modal request of one prepared static input: same source, nodes and elements; the static constraints or none. */
export function cadSolidModalInput(prepared: CadSolidPrepared,
  request: Pick<CadSolidModalSettings, 'material' | 'modeCount' | 'numericBudgetBytes'> & { readonly freeFree: boolean }): SolidModalInput {
  const { input } = prepared;
  return {
    schema: 'pointercad-solid-tet4-modal/1', source: input.source, units: 'N-mm-MPa',
    numericBudgetBytes: request.numericBudgetBytes, nodes: input.nodes,
    elements: input.elements.map(element => ({ nodes: element.nodes, materialId: request.material.id })),
    materials: [request.material],
    constraints: request.freeFree ? [] : input.constraints.map(row => ({ node: row.node, fixed: row.fixed })),
    modeCount: request.modeCount,
  };
}
type CadSolidPrepared = ReturnType<typeof prepareCadSolidAnalysis>;

const owners = new WeakMap<object, AbortController>();
/** Same ownership, supersede, cancellation and stale-source rules as analyzeCadSolid. */
export async function analyzeCadSolidModal(client: Pick<FemClient, 'meshTetrahedra' | 'analyzeSolidModal'>,
  kernel: AnalysisBoundarySource, readCurrent: () => CadTetraContext, requested: CadSolidModalSettings,
  options: FemOptions = {}): Promise<CadSolidModalOutcome> {
  owners.get(client)?.abort();
  const owner = new AbortController();
  owners.set(client, owner);
  const abort = (): void => owner.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) owner.abort();
  const cancellation = (): CadSolidModalOutcome | null => owners.get(client) !== owner
    ? { kind: 'cancelled', reason: 'superseded' } : owner.signal.aborted ? { kind: 'cancelled', reason: 'abort' } : null;
  try {
    const settings = structuredClone(requested), initial = readCurrent();
    const signature = JSON.stringify({ documentId: initial.documentId, revision: initial.revision, featureId: initial.body.featureId });
    const current = (): CadTetraContext => {
      const value = readCurrent();
      if (JSON.stringify({ documentId: value.documentId, revision: value.revision, featureId: value.body.featureId }) !== signature)
        throw new Error('CAD source changed during analysis');
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
    const faces = settings.fixedFaces.length === 0 ? [settings.anchorFace] : settings.fixedFaces;
    const prepared = prepareCadSolidAnalysis(current(), mesh.mesh, mesh.regions, mesh.labelFaces, {
      material: { id: settings.material.id, youngMPa: settings.material.youngMPa, poisson: settings.material.poisson },
      fixedFaces: faces, loadedFaces: faces, tractionMPa: [0, 0, 0], numericBudgetBytes: settings.numericBudgetBytes,
      geometry: settings.geometry, ...(settings.meshing === undefined ? {} : { meshing: settings.meshing }) });
    const input = cadSolidModalInput(prepared, { material: settings.material, modeCount: settings.modeCount,
      numericBudgetBytes: settings.numericBudgetBytes, freeFree: settings.fixedFaces.length === 0 });
    const completion = await client.analyzeSolidModal(input, { ...options, signal: owner.signal });
    const afterSolve = cancellation();
    if (afterSolve) return afterSolve;
    current();
    if (completion.kind === 'cancelled') return { kind: 'cancelled', reason: completion.reason };
    if (completion.kind === 'failed') return { kind: 'failed', ...completion.failure };
    return { kind: 'result', input, result: completion.result };
  } catch (error) {
    return cancellation() ?? { kind: 'failed', code: 'cad-solid-modal', message: error instanceof Error ? error.message : 'Invalid CAD modal analysis' };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    if (owners.get(client) === owner) owners.delete(client);
  }
}
