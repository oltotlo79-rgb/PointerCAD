import type { AnalysisBoundarySource } from '@pointercad/model';
import type { FemClient, FemOptions } from './client.js';
import { prepareCadSolidAnalysis, type CadSolidPrepared, type CadSolidSettings } from './cadSolidAnalysis.js';
import { meshCadBoundary, type CadTetraContext } from './cadTetraMesh.js';
import { meshCadCurvedBoundary } from './cadCurvedTetraMesh.js';
import { translateSolidAnalysis } from './solidAnalysisTranslation.js';
import { SOLID_PLASTIC_PLAN_SCHEMA, type SolidPlasticPlan } from './solidPlastic.js';
import { SOLID_PLASTIC_INPUT_SCHEMA, translateSolidPlastic, type SolidPlasticInput } from './solidPlasticTranslation.js';
import type { SolidPlasticResult } from './solidPlasticPublicResult.js';
import type { TetraMeshResult } from './tetraMesh.js';

/**
 * CAD continuum plasticity bridge (PROVISIONAL, unexecuted). Reuses the adopted linear CAD path unchanged:
 * the same meshing (meshCadBoundary / meshCadCurvedBoundary), the same face resolution and consistent surface-load
 * integration (prepareCadSolidAnalysis), and the same nodal force assembly (translateSolidAnalysis). The resulting
 * fixed nodes become zero prescribed displacements and the reference nodal forces become forcesN; the user's
 * load-factor history scales them. No algebra or solver of its own; solved by FemClient.analyzeSolidPlastic.
 */
export interface CadSolidPlasticSettings extends CadSolidSettings {
  readonly yieldStressMPa: number;
  readonly hardeningModulusMPa: number;
  readonly materialReference: string;
  readonly loadFactor: readonly number[];
  readonly stepsPerSegment: number;
}
export type CadSolidPlasticOutcome =
  | { readonly kind: 'result'; readonly result: SolidPlasticResult; readonly input: SolidPlasticInput;
      readonly prepared: CadSolidPrepared; readonly mesh: TetraMeshResult }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string }
  | { readonly kind: 'cancelled'; readonly reason: 'abort' | 'superseded' | 'disposed' };

/** Maps the adopted linear tet4 input of the same CAD selection to a validated plasticity input. */
export function cadSolidPlasticInput(prepared: CadSolidPrepared, settings: CadSolidPlasticSettings): SolidPlasticInput {
  const plan = translateSolidAnalysis(prepared.input).plan;
  const prescribedMm: { node: number; dof: 'x' | 'y' | 'z'; valueMm: number }[] = [];
  const forcesN: { node: number; dof: 'x' | 'y' | 'z'; forceN: number }[] = [];
  const axes = ['x', 'y', 'z'] as const;
  plan.fixed.forEach((fixed, node) => fixed.forEach((isFixed, axis) => {
    if (isFixed) prescribedMm.push({ node, dof: axes[axis], valueMm: 0 });
    else if (plan.forcesN[node][axis] !== 0) forcesN.push({ node, dof: axes[axis], forceN: plan.forcesN[node][axis] });
  }));
  const material = prepared.input.materials[0];
  const value: SolidPlasticPlan = { schema: SOLID_PLASTIC_PLAN_SCHEMA, units: 'N-mm-MPa',
    nodes: prepared.input.nodes, elements: prepared.input.elements.map(element => element.nodes),
    material: { youngMPa: material.youngMPa, poisson: material.poisson, yieldStressMPa: settings.yieldStressMPa,
      hardeningModulusMPa: settings.hardeningModulusMPa,
      source: { kind: 'user-supplied', reference: settings.materialReference } },
    prescribedMm, forcesN, loadFactor: settings.loadFactor, stepsPerSegment: settings.stepsPerSegment };
  // translateSolidPlastic applies every plan bound (limits, overflow, reference contract) before anything is sent.
  return translateSolidPlastic({ schema: SOLID_PLASTIC_INPUT_SCHEMA,
    source: { documentId: prepared.input.source.documentId, revision: prepared.input.source.revision }, plan: value }).input;
}

const owners = new WeakMap<object, AbortController>();
/** Same ownership, cancellation and stale-source rules as analyzeCadSolid. */
export async function analyzeCadSolidPlastic(
  client: Pick<FemClient, 'meshTetrahedra' | 'analyzeSolidPlastic'>, kernel: AnalysisBoundarySource,
  readCurrent: () => CadTetraContext, requested: CadSolidPlasticSettings, options: FemOptions = {}): Promise<CadSolidPlasticOutcome> {
  owners.get(client)?.abort();
  const owner = new AbortController();
  owners.set(client, owner);
  const abort = (): void => owner.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) owner.abort();
  const cancellation = (): CadSolidPlasticOutcome | null => owners.get(client) !== owner
    ? { kind: 'cancelled', reason: 'superseded' } : owner.signal.aborted ? { kind: 'cancelled', reason: 'abort' } : null;
  try {
    const settings = structuredClone(requested), initial = readCurrent();
    const signature = JSON.stringify({ documentId: initial.documentId, revision: initial.revision });
    const current = (): CadTetraContext => {
      const value = readCurrent();
      if (JSON.stringify({ documentId: value.documentId, revision: value.revision }) !== signature)
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
    const prepared = prepareCadSolidAnalysis(current(), mesh.mesh, mesh.regions, mesh.labelFaces, settings);
    const input = cadSolidPlasticInput(prepared, settings);
    const completion = await client.analyzeSolidPlastic(input, { ...options, signal: owner.signal });
    const afterSolve = cancellation();
    if (afterSolve) return afterSolve;
    current();
    if (completion.kind === 'cancelled') return completion;
    if (completion.kind === 'failed') return { kind: 'failed', ...completion.failure };
    return { kind: 'result', result: completion.result, input, prepared, mesh: mesh.mesh };
  } catch (error) {
    return cancellation() ?? { kind: 'failed', code: 'cad-solid-plastic',
      message: error instanceof Error ? error.message : 'Invalid CAD solid plasticity analysis' };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    if (owners.get(client) === owner) owners.delete(client);
  }
}
