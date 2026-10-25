import { InputIssue } from './analysisValidation.js';
import { analysisPropertyEvidenceKeys, rayleighPropertySeries, readOptionalAnalysisPropertyEvidence,
  type AnalysisPropertyEvidence } from './analysisPropertyEvidence.js';

/** One sample of the piecewise-linear multiplier applied to every reference load. */
export interface BeamTransientLoadFactorSample {
  readonly timeS: number;
  readonly factor: number;
}
/** Linear viscous damping C = alpha M + beta K; coefficients are explicit user inputs. */
export interface BeamRayleighDamping {
  readonly kind: 'rayleigh';
  /** alpha, inverse seconds. */
  readonly massCoefficientPerS: number;
  /** beta, seconds; uses the constant linear-elastic stiffness. */
  readonly stiffnessCoefficientS: number;
  /** Saved provenance only. The FEM translation removes it from the numerical plan after validation. */
  readonly evidence?: AnalysisPropertyEvidence;
}
/** Explicit linear time history from rest; no initial state or damping coefficient is inferred. */
export interface BeamTransientHistory {
  readonly timeStepS: number;
  readonly stepCount: number;
  /** Every n-th integration step is returned plus time 0 and the last step once; at most 101 samples. */
  readonly outputEvery: number;
  readonly loadFactor: readonly BeamTransientLoadFactorSample[];
  readonly damping: 'none' | BeamRayleighDamping;
  readonly initialConditions: 'zero-at-rest';
}
export const TRANSIENT_MAXIMUM_STEPS = 4000;
export const TRANSIENT_MAXIMUM_OUTPUT_SAMPLES = 101;
export const TRANSIENT_MAXIMUM_LOAD_SAMPLES = 256;

function fail(code: string, path: string, detail: string): never {
  throw new InputIssue(code, path, `${code}: ${detail}`);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: unknown, names: readonly string[], path: string): Record<string, unknown> {
  if (!record(value) || Object.keys(value).length !== names.length || names.some(name => !(name in value))) {
    fail('transient-shape', path, path);
  }
  return value;
}
function dense(value: readonly unknown[]): boolean {
  if (Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}
function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('transient-number', path, path);
  return value === 0 ? 0 : value;
}

/** The single TS history decoder, shared by saved CAD inputs and the FEM request boundary. The same acceptance,
 * order and message prefixes are mirrored by _validate_transient_history in packages/fem/src/beamAnalysis.py. */
export function readBeamTransientHistory(value: unknown, path: string): BeamTransientHistory {
  const row = fields(value, ['timeStepS', 'stepCount', 'outputEvery', 'loadFactor', 'damping', 'initialConditions'], path);
  let damping: BeamTransientHistory['damping'] = 'none';
  if (row.damping !== 'none') {
    const value = row.damping;
    if (!record(value) || Reflect.ownKeys(value).length !== 3 + analysisPropertyEvidenceKeys(value, 'evidence').length || value.kind !== 'rayleigh'
      || !Object.hasOwn(value, 'massCoefficientPerS') || !Object.hasOwn(value, 'stiffnessCoefficientS')
      || !Object.hasOwn(value, 'kind')
      || typeof value.massCoefficientPerS !== 'number' || !Number.isFinite(value.massCoefficientPerS)
      || value.massCoefficientPerS < 0
      || typeof value.stiffnessCoefficientS !== 'number' || !Number.isFinite(value.stiffnessCoefficientS)
      || value.stiffnessCoefficientS < 0) {
      fail('transient-damping', path, 'expected none or explicit nonnegative finite Rayleigh coefficients');
    }
    const evidence = readOptionalAnalysisPropertyEvidence(value, 'evidence', rayleighPropertySeries({
      massCoefficientPerS: value.massCoefficientPerS, stiffnessCoefficientS: value.stiffnessCoefficientS }), `${path}.damping`);
    damping = { kind: 'rayleigh', massCoefficientPerS: value.massCoefficientPerS === 0 ? 0 : value.massCoefficientPerS,
      stiffnessCoefficientS: value.stiffnessCoefficientS === 0 ? 0 : value.stiffnessCoefficientS,
      ...(evidence === undefined ? {} : { evidence }) };
  }
  if (row.initialConditions !== 'zero-at-rest') {
    fail('transient-initial', path, 'only zero displacement and velocity are supported');
  }
  const timeStepS = finite(row.timeStepS, `${path}.timeStepS`);
  if (timeStepS <= 0) fail('transient-step', path, 'time step must be positive');
  const stepCount = row.stepCount;
  if (typeof stepCount !== 'number' || !Number.isSafeInteger(stepCount) || stepCount < 1
    || stepCount > TRANSIENT_MAXIMUM_STEPS) {
    fail('transient-steps', path, `step count must be an integer from 1 to ${TRANSIENT_MAXIMUM_STEPS}`);
  }
  // Returned samples: time 0, every n-th step and the last step once = 1 + ceil(stepCount / outputEvery).
  const outputEvery = row.outputEvery;
  if (typeof outputEvery !== 'number' || !Number.isSafeInteger(outputEvery) || outputEvery < 1 || outputEvery > stepCount
    || Math.ceil(stepCount / outputEvery) > TRANSIENT_MAXIMUM_OUTPUT_SAMPLES - 1) {
    fail('transient-output', path, `at most ${TRANSIENT_MAXIMUM_OUTPUT_SAMPLES} output samples are returned`);
  }
  const duration = timeStepS * stepCount;
  if (!Number.isFinite(duration) || duration <= 0) fail('transient-step', path, 'total duration must be finite and positive');
  // Newmark coefficients 4/dt^2, 4/dt and dt/2 must be finite and nonzero.
  if (![4 / (timeStepS * timeStepS), 4 / timeStepS, timeStepS / 2].every(item => Number.isFinite(item) && item > 0)) {
    fail('transient-step', path, 'Newmark coefficients overflow or underflow');
  }
  if (!Array.isArray(row.loadFactor) || row.loadFactor.length < 2
    || row.loadFactor.length > TRANSIENT_MAXIMUM_LOAD_SAMPLES) {
    fail('transient-history', `${path}.loadFactor`,
      `two to ${TRANSIENT_MAXIMUM_LOAD_SAMPLES} load-factor samples are required`);
  }
  // Array.map skips holes: an in-memory sparse array must not reach the per-sample checks. (JSON, and therefore the
  // Python mirror, cannot express holes.)
  if (!dense(row.loadFactor)) fail('transient-shape', `${path}.loadFactor`, `${path}.loadFactor`);
  const loadFactor = row.loadFactor.map((item: unknown, index: number): BeamTransientLoadFactorSample => {
    const samplePath = `${path}.loadFactor[${index}]`;
    const sample = fields(item, ['timeS', 'factor'], samplePath);
    const factor = finite(sample.factor, `${samplePath}.factor`);
    if (Math.abs(factor) > 1e6) fail('transient-history', samplePath, 'load factor magnitude exceeds 1e6');
    return { timeS: finite(sample.timeS, `${samplePath}.timeS`), factor };
  });
  if (loadFactor.some((sample, index) => index > 0 && sample.timeS <= loadFactor[index - 1].timeS)) {
    fail('transient-history', `${path}.loadFactor`, 'sample times must be strictly increasing');
  }
  if (loadFactor[0].timeS !== 0) fail('transient-history', `${path}.loadFactor`, 'the first sample must be at time 0');
  const last = loadFactor[loadFactor.length - 1].timeS;
  if (last < duration * (1 - 1e-12) || last > duration * (1 + 1e-12)) {
    fail('transient-history', `${path}.loadFactor`, 'the last sample must be at the analysis duration');
  }
  return { timeStepS, stepCount, outputEvery, loadFactor, damping, initialConditions: 'zero-at-rest' };
}
