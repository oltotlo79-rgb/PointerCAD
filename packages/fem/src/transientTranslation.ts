import { readBeamTransientHistory } from '@pointercad/model/beam-analysis';
import { translateBeamBuckling, type OofemBucklingPlan } from './bucklingTranslation.js';
import type { BeamTransientInput, TransientHistory, TransientLoadFactorSample } from './transientModel.js';

export interface OofemTransientPlan extends Omit<OofemBucklingPlan, 'schema'> {
  readonly schema: 'pointercad-oofem-transient-plan/1';
  readonly history: TransientHistory;
}
// The single TS history decoder and its bounds live with the saved CAD inputs in the model package.
export { TRANSIENT_MAXIMUM_STEPS, TRANSIENT_MAXIMUM_OUTPUT_SAMPLES, TRANSIENT_MAXIMUM_LOAD_SAMPLES } from '@pointercad/model/beam-analysis';
/** Provisional step count x free DOFs^2 bound, identical to TRANSIENT_WORK_LIMIT in beamAnalysis.py. Not a
 * measured performance claim: Root's bounded benchmark (transientBenchmark.testSupport.ts) confirms or replaces it
 * against the 60 s solve deadline without changing accuracy. */
export const TRANSIENT_WORK_LIMIT = 400_000_000;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: unknown, names: readonly string[], path: string): Record<string, unknown> {
  if (!record(value) || Object.keys(value).length !== names.length || names.some(name => !(name in value))) {
    throw new Error(`transient-shape: ${path}`);
  }
  return value;
}

/** Output steps: time 0, every n-th step and the last step. Shared by the decoder. */
export function transientOutputSteps(history: TransientHistory): number[] {
  const steps = [0];
  for (let index = 1; index <= history.stepCount; index += 1) {
    if (index % history.outputEvery === 0 || index === history.stepCount) steps.push(index);
  }
  return steps;
}

/** Same arithmetic order as _transient_load_factor in beamAnalysis.py. */
export function transientLoadFactor(samples: readonly TransientLoadFactorSample[], time: number): number {
  for (let index = 0; index + 1 < samples.length; index += 1) {
    const left = samples[index];
    const right = samples[index + 1];
    if (left.timeS <= time && time <= right.timeS) {
      return left.factor + (time - left.timeS) / (right.timeS - left.timeS) * (right.factor - left.factor);
    }
  }
  const last = samples[samples.length - 1];
  if (Math.abs(time - last.timeS) <= Math.abs(last.timeS) * 1e-12) return last.factor;
  throw new Error('transient-history: time outside the load-factor samples');
}

/** Geometry, supports and reference loads use the buckling validation unchanged:
 * unrestrained schema-2 geometry, explicit six-DOF zero supports and a nonzero
 * reference load. The zero-load response is requested with all-zero factors. */
export function translateBeamTransient(value: unknown): {
  readonly input: BeamTransientInput; readonly plan: OofemTransientPlan;
} {
  const row = fields(value, ['schema', 'geometry', 'supports', 'referenceLoads', 'history'], '$');
  if (row.schema !== 'pointercad-beam-transient/1') throw new Error('transient-schema: unsupported input');
  let prepared: ReturnType<typeof translateBeamBuckling>;
  try {
    prepared = translateBeamBuckling({ schema: 'pointercad-beam-buckling/1', geometry: row.geometry,
      supports: row.supports, referenceLoads: row.referenceLoads });
  } catch (error) {
    throw new Error(`transient-input: ${error instanceof Error ? error.message : 'invalid beam input'}`,
      { cause: error });
  }
  const history = readBeamTransientHistory(row.history, 'history');
  const freeDofs = prepared.plan.nodes.reduce((sum, node) => sum + node.restrained.filter(value => !value).length, 0);
  if (history.stepCount * freeDofs * freeDofs > TRANSIENT_WORK_LIMIT) {
    throw new Error('transient-budget: step count x free DOFs^2 exceeds 4e8; use fewer steps or a coarser mesh');
  }
  const { geometry, supports, referenceLoads } = prepared.input;
  const input: BeamTransientInput = { schema: 'pointercad-beam-transient/1', geometry, supports, referenceLoads, history };
  // Evidence remains part of the authored input/hash, but the unchanged Python reader accepts only these three fields.
  const solverHistory: TransientHistory = history.damping === 'none' ? history : { ...history,
    damping: { kind: 'rayleigh', massCoefficientPerS: history.damping.massCoefficientPerS,
      stiffnessCoefficientS: history.damping.stiffnessCoefficientS } };
  return { input, plan: { ...prepared.plan, schema: 'pointercad-oofem-transient-plan/1', history: solverHistory } };
}

export async function transientInputSha256(value: unknown): Promise<string> {
  const input = translateBeamTransient(value).input;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
