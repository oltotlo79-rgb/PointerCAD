import { meshCadBoundary, meshCadCurvedBoundary, prepareCadSolidAnalysis, type CadSolidPressureSettings, type CadSolidSettings,
  type CadTetraContext, type FemClient, type FemOptions, type SolidBucklingInput, type SolidBucklingResult } from '@pointercad/fem';
import type { AnalysisBoundarySource } from '@pointercad/model';

/**
 * UI adapter (no FEM runtime of its own) for linear prestress buckling of one CAD solid. The reference state is EXACTLY the
 * static CAD analysis: the same meshing (meshCadBoundary / meshCadCurvedBoundary), face resolution, supports, material and
 * surface load (prepareCadSolidAnalysis). Nothing is re-derived here: the prepared static input becomes
 * SolidBucklingInput.reference unchanged, and the returned load factor multiplies that whole reference load set.
 * It is a linear bifurcation estimate, not a plastic, collapse or code strength check.
 */
export type CadSolidBucklingSettings = (CadSolidSettings | CadSolidPressureSettings) & { readonly modeCount: number };
export type CadSolidBucklingFailureCode = 'cad-solid-buckling' | 'buckling-no-compression' | 'buckling-mechanism'
  | 'buckling-unsupported' | 'buckling-stale';
export type CadSolidBucklingOutcome =
  | { readonly kind: 'result'; readonly input: SolidBucklingInput; readonly result: SolidBucklingResult;
      readonly loadedAreaMm2: number; readonly totalForceN: readonly [number, number, number] }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string }
  | { readonly kind: 'cancelled'; readonly reason: 'abort' | 'superseded' | 'disposed' };
type CadSolidPrepared = ReturnType<typeof prepareCadSolidAnalysis>;

function need(condition: boolean, message: string): asserts condition {  if (!condition) throw new Error(message);
}

/** The buckling request of one prepared static input. Independently re-checks the units and that the reported total force
 * is the sum of traction x area over the actual loaded boundary triangles, so a stale or mismatched preparation is refused. */
export function cadSolidBucklingInput(prepared: CadSolidPrepared, modeCount: number): SolidBucklingInput {
  const { input } = prepared;
  need(input.units === 'N-mm-MPa', 'solid-buckling-units: the static reference must be N-mm-MPa');
  need(input.nodalLoads.length === 0 && input.surfaceLoads.length > 0, 'solid-buckling-load: CAD reference loads are boundary tractions');
  const sum: [number, number, number] = [0, 0, 0];
  let area = 0;
  for (const load of input.surfaceLoads) {
    const [a, b, c] = load.nodes.map(node => input.nodes[node]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const triangle = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
    area += triangle;
    for (let axis = 0; axis < 3; axis += 1) sum[axis] += load.tractionMPa[axis] * triangle;
  }
  const scale = Math.max(Math.hypot(...sum), Math.hypot(...prepared.totalForceN));
  need(Number.isFinite(scale) && scale > 0, 'solid-buckling-load: zero reference load');
  need(Math.abs(area - prepared.loadedAreaMm2) <= 1e-9 * Math.max(area, prepared.loadedAreaMm2)
    && Math.hypot(sum[0] - prepared.totalForceN[0], sum[1] - prepared.totalForceN[1], sum[2] - prepared.totalForceN[2]) <= 1e-9 * scale,
  'solid-buckling-load: prepared total force differs from the loaded boundary');
  return { schema: 'pointercad-solid-tet4-buckling/1', reference: input, modeCount };
}

/** Native refusal text (solidBuckling.py prefixes) to a user-facing category; the message itself is kept verbatim. */
export function cadSolidBucklingFailureCode(message: string): CadSolidBucklingFailureCode {
  if (message.includes('solid-buckling-no-positive-mode')) return 'buckling-no-compression';
  if (message.includes('solid-buckling-mechanism') || message.includes('unrestrained component rigid-body motion')) return 'buckling-mechanism';
  if (message.includes('CAD source changed during analysis') || message.includes('Mesh belongs to another CAD revision')) return 'buckling-stale';
  if (message.includes('solid-buckling-budget') || message.includes('solid-buckling-supports')) return 'buckling-unsupported';
  return 'cad-solid-buckling';
}

function sourceKey(context: CadTetraContext): string {
  need(context.body.isValid && context.body.bodyKind === 'solid', 'A current valid solid is required');
  const steps = context.steps.filter(step => step.featureId === context.body.featureId);
  need(steps.length === 1 && steps[0].key.length > 0, 'A unique current body key is required');
  return JSON.stringify({ documentId: context.documentId, revision: context.revision, step: steps[0],
    volume: context.body.volume, faces: context.body.faces, origins: context.body.origins });
}

const owners = new WeakMap<object, AbortController>();
/** Same ownership, supersede, cancellation and stale-source rules as analyzeCadSolid (the static source key). */
export async function analyzeCadSolidBuckling(client: Pick<FemClient, 'meshTetrahedra' | 'analyzeSolidBuckling'>,
  kernel: AnalysisBoundarySource, readCurrent: () => CadTetraContext, requested: CadSolidBucklingSettings,
  options: FemOptions = {}): Promise<CadSolidBucklingOutcome> {
  owners.get(client)?.abort();
  const owner = new AbortController();
  owners.set(client, owner);
  const abort = (): void => owner.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) owner.abort();
  const cancellation = (): CadSolidBucklingOutcome | null => owners.get(client) !== owner
    ? { kind: 'cancelled', reason: 'superseded' } : owner.signal.aborted ? { kind: 'cancelled', reason: 'abort' } : null;
  try {
    const { modeCount, ...settings } = structuredClone(requested);
    const signature = sourceKey(readCurrent());
    const current = (): CadTetraContext => {
      const value = readCurrent();
      need(sourceKey(value) === signature, 'CAD source changed during analysis');
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
    const input = cadSolidBucklingInput(prepared, modeCount);
    const completion = await client.analyzeSolidBuckling(input, { ...options, signal: owner.signal });
    const afterSolve = cancellation();
    if (afterSolve) return afterSolve;
    current();
    if (completion.kind === 'cancelled') return { kind: 'cancelled', reason: completion.reason };
    if (completion.kind === 'failed') return { kind: 'failed', code: cadSolidBucklingFailureCode(completion.failure.message),
      message: completion.failure.message };
    return { kind: 'result', input, result: completion.result, loadedAreaMm2: prepared.loadedAreaMm2,
      totalForceN: [prepared.totalForceN[0], prepared.totalForceN[1], prepared.totalForceN[2]] };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid CAD buckling analysis';
    return cancellation() ?? { kind: 'failed', code: cadSolidBucklingFailureCode(message), message };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    if (owners.get(client) === owner) owners.delete(client);
  }
}
