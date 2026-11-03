import type { AnalysisBoundarySource } from '@pointercad/model';
import type { FemClient, FemOptions } from './client.js';
import { prepareCadSolidAnalysis, type CadSolidPrepared, type CadSolidSettings } from './cadSolidAnalysis.js';
import { meshCadBoundary, type CadTetraContext } from './cadTetraMesh.js';
import { meshCadCurvedBoundary } from './cadCurvedTetraMesh.js';
import { translateSolidAnalysis } from './solidAnalysisTranslation.js';
import { SOLID_FINITE_LIMITS, SOLID_FINITE_PLAN_SCHEMA, type SolidFinitePrescribed, type SolidFiniteLoad } from './solidFinitePlan.js';
import { SOLID_FINITE_INPUT_SCHEMA, translateSolidFinite, type SolidFiniteInput } from './solidFiniteTranslation.js';
import type { SolidFiniteResult } from './solidFiniteResults.js';
import type { TetraMeshResult } from './tetraMesh.js';

/** Explicit values at native steps 1..n; t=0 remains undeformed/unloaded. No interpolation or implicit ramp.
 * Nodal forces are reference-geometry dead loads in CAD part axes, including the existing gravity assembly.
 * Prescribed displacement factors scale the existing CAD supports' reference prescribedMm; fixedFaces remain zero. */
export interface CadSolidFiniteSettings extends CadSolidSettings {
  readonly yieldStressMPa: number;
  readonly hardeningModulusMPa: number;
  readonly materialReference: string;
  readonly forceFactors: readonly number[];
  readonly prescribedDisplacementFactors: readonly number[];
  readonly referenceForceN?: number;
}
export type CadSolidFiniteOutcome =
  | { readonly kind: 'result'; readonly result: SolidFiniteResult; readonly input: SolidFiniteInput;
      readonly prepared: CadSolidPrepared; readonly mesh: TetraMeshResult; readonly materialReference: string }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string }
  | { readonly kind: 'cancelled'; readonly reason: 'abort' | 'superseded' | 'disposed' };

function readHistorySettings(value: CadSolidFiniteSettings): void {
  if (typeof value.materialReference !== 'string' || value.materialReference.trim().length === 0 || value.materialReference.length > 500)
    throw new Error('CAD finite materialReference must state the source of the material values (1..500 characters)');
  const forces = value.forceFactors, displacements = value.prescribedDisplacementFactors;
  if (!Array.isArray(forces) || forces.length < 1 || forces.length > SOLID_FINITE_LIMITS.steps
    || !Array.isArray(displacements) || displacements.length !== forces.length
    || Array.from(forces).some(v => !Number.isFinite(v)) || Array.from(displacements).some(v => !Number.isFinite(v)))
    throw new Error('CAD finite histories must have the same 1..200 finite step values');
  if (Object.hasOwn(value, 'referenceForceN') && (typeof value.referenceForceN !== 'number'
    || !Number.isFinite(value.referenceForceN) || value.referenceForceN <= 0))
    throw new Error('CAD finite referenceForceN must be explicitly positive');
  if (forces.every(v => v === 0) && value.referenceForceN === undefined)
    throw new Error('CAD finite zero-force history requires referenceForceN');
}

/** Existing CAD -> linear nodal assembly supplies every coordinate, restraint and force; only explicit histories differ.
 * The strict W34 reader is the final authority, including material, size, orientation and free/prescribed DOF bounds. */
export function cadSolidFiniteInput(prepared: CadSolidPrepared, settings: CadSolidFiniteSettings): SolidFiniteInput {
  readHistorySettings(settings);
  const { input: linear, plan } = translateSolidAnalysis(prepared.input);
  if (linear.materials.length !== 1) throw new Error('CAD finite analysis requires one explicit homogeneous material');
  const material = linear.materials[0];
  if (material.id !== settings.material.id || material.youngMPa !== settings.material.youngMPa || material.poisson !== settings.material.poisson)
    throw new Error('CAD finite material differs from the prepared CAD input');
  const axes = ['x', 'y', 'z'] as const, prescribedMm: SolidFinitePrescribed[] = [], forcesN: SolidFiniteLoad[] = [];
  plan.fixed.forEach((fixed, node) => fixed.forEach((isFixed, axis) => {
    if (isFixed) prescribedMm.push({ node, dof: axes[axis],
      valuesMm: settings.prescribedDisplacementFactors.map(factor => factor * (plan.prescribedMm?.[node][axis] ?? 0)) });
    if (plan.forcesN[node][axis] !== 0) forcesN.push({ node, dof: axes[axis],
      valuesN: settings.forceFactors.map(factor => factor * plan.forcesN[node][axis]) });
  }));
  return translateSolidFinite({ schema: SOLID_FINITE_INPUT_SCHEMA,
    source: { documentId: linear.source.documentId, revision: linear.source.revision }, plan: {
      schema: SOLID_FINITE_PLAN_SCHEMA, units: 'N-mm-MPa', nodes: linear.nodes, elements: linear.elements.map(element => element.nodes),
      material: { youngMPa: material.youngMPa, poisson: material.poisson,
        yieldStressMPa: settings.yieldStressMPa, hardeningModulusMPa: settings.hardeningModulusMPa },
      steps: settings.forceFactors.length, prescribedMm, forcesN,
      ...(settings.referenceForceN === undefined ? {} : { referenceForceN: settings.referenceForceN }),
    } }).input;
}

function sourceSignature(value: CadTetraContext): string {
  return JSON.stringify({ documentId: value.documentId, revision: value.revision, steps: value.steps,
    featureId: value.body.featureId, valid: value.body.isValid, kind: value.body.bodyKind,
    volume: value.body.volume, faces: value.body.faces, origins: value.body.origins });
}

/** Reserve before kernel awaits; each mesh/solve gets a separate Worker within the same client-owned generation.
 * Re-prepare after completion so a same-revision CAD/provenance mutation is not published as a current result. */
export async function analyzeCadSolidFinite(client: Pick<FemClient, 'beginSolidFinitePreparation'>,
  kernel: AnalysisBoundarySource, readCurrent: () => CadTetraContext, requested: CadSolidFiniteSettings,
  options: FemOptions = {}): Promise<CadSolidFiniteOutcome> {
  const owner = client.beginSolidFinitePreparation(options);
  const cancellation = (): CadSolidFiniteOutcome | null => {
    const reason = owner.cancellation();
    return reason === null ? null : { kind: 'cancelled', reason };
  };
  try {
    const early = cancellation();
    if (early !== null) return early;
    const settings = structuredClone(requested);
    readHistorySettings(settings);
    const signature = sourceSignature(readCurrent());
    const current = (): CadTetraContext => {
      const value = readCurrent();
      if (sourceSignature(value) !== signature) throw new Error('CAD source changed during finite analysis');
      return value;
    };
    const mesh = settings.geometry.kind === 'planar'
      ? await meshCadBoundary(owner, kernel, current, settings.geometry.boundary, { ...options, signal: owner.signal }, undefined, settings.meshing)
        .then(outcome => outcome.kind !== 'result' ? outcome : { ...outcome,
          labelFaces: Array.from({ length: outcome.mesh.input.tagCount }, (_, index) => index) })
      : await meshCadCurvedBoundary(owner, kernel, current, settings.geometry.options, { ...options, signal: owner.signal }, undefined, settings.meshing);
    const afterMesh = cancellation();
    if (afterMesh !== null) return afterMesh;
    if (mesh.kind !== 'result') return mesh;
    const prepared = prepareCadSolidAnalysis(current(), mesh.mesh, mesh.regions, mesh.labelFaces, settings);
    const input = cadSolidFiniteInput(prepared, settings);
    const completion = await owner.analyzeSolidFinite(input);
    const afterSolve = cancellation();
    if (afterSolve !== null) return afterSolve;
    current();
    if (completion.kind === 'cancelled') return completion;
    if (completion.kind === 'failed') return { kind: 'failed', ...completion.failure };
    const rebound = prepareCadSolidAnalysis(current(), mesh.mesh, mesh.regions, mesh.labelFaces, settings);
    if (JSON.stringify(cadSolidFiniteInput(rebound, settings)) !== JSON.stringify(input))
      throw new Error('Current CAD finite preparation differs from the solved input');
    const afterValidation = cancellation();
    if (afterValidation !== null) return afterValidation;
    current();
    const beforePublication = cancellation();
    if (beforePublication !== null) return beforePublication;
    return { kind: 'result', result: completion.result.result, input, prepared, mesh: mesh.mesh, materialReference: settings.materialReference };
  } catch (error) {
    return cancellation() ?? { kind: 'failed', code: 'cad-solid-finite',
      message: error instanceof Error ? error.message : 'Invalid CAD finite analysis' };
  } finally { owner.release(); }
}
