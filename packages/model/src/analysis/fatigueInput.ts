import { fields, InputIssue, text } from './analysisValidation.js';
import { analysisPropertyEvidenceKeys, fatiguePropertySeries, readOptionalAnalysisPropertyEvidence,
  type AnalysisPropertyEvidence } from './analysisPropertyEvidence.js';

/**
 * Saved fatigue inputs (one per document): a user-supplied single-slope S-N curve and explicit ordered stress
 * histories in MPa, exactly the `pointercad-fatigue/1` input of @pointercad/fem fatigueModel.ts. Only inputs are
 * stored; damage, cycles and life are never stored. Nothing is derived from a material name: every curve value, its
 * stress definition, its mean-stress applicability and its source are the user's own statements.
 */
export const FATIGUE_SAVED_SCHEMA = 'pointercad-fatigue-saved/2';
/** Version 3 explicitly opts into Goodman; versions 1 and 2 retain their uncorrected semantics. */
export const FATIGUE_SAVED_GOODMAN_SCHEMA = 'pointercad-fatigue-saved/3';
/** Version 1 (no imported histories) is still read; it is returned as version 2 with no axial sources, so whatever the
 * reader returns serializes back into an input the reader accepts. */
export const FATIGUE_SAVED_SCHEMA_V1 = 'pointercad-fatigue-saved/1';
/** The only imported stress measure: @pointercad/fem fatigueAxial.ts AXIAL_FATIGUE_MEASURE. */
export const FATIGUE_SAVED_AXIAL_MEASURE = 'member-mean-linear-axial-from-sampled-end-translations/1';
/** The single saved fatigue configuration of a document; distinct from the UUID ids of beam analyses. */
export const FATIGUE_SAVED_ID = 'fatigue';

export interface FatigueSavedSource {
  readonly kind: 'user-supplied';
  readonly reference: string;
  readonly condition: string;
}
export interface FatigueSavedCurve {
  readonly id: string;
  readonly unit: 'MPa';
  readonly stressDefinition: 'range' | 'amplitude';
  readonly meanStressAssumption: 'mean-independent' | 'fully-reversed-only';
  readonly referenceStressMpa: number;
  readonly referenceCycles: number;
  readonly slope: number;
  readonly cutoffStressMpa: number | null;
  readonly source: FatigueSavedSource;
}
export interface FatigueSavedHistory {
  readonly id: string;
  readonly unit: 'MPa';
  readonly stressMpa: readonly number[];
  readonly sequence: 'once' | 'repeated-periodic';
  readonly repeats: number;
  readonly source: FatigueSavedSource;
}
/** Structurally the FatigueInput of @pointercad/fem (the model cannot import the solver package). */
export interface FatigueSavedProblem {
  readonly schema: 'pointercad-fatigue/1';
  readonly curve: FatigueSavedCurve;
  readonly histories: readonly FatigueSavedHistory[];
}
/** Structurally AxialFatigueProvenance of @pointercad/fem fatigueAxial.ts: where an imported history came from. It is
 * the member-mean linear axial stress of one whole member only (no bending, shear, torsion, local, combined or
 * multiaxial stress), one sample time per stress point. */
export interface FatigueSavedAxialProvenance {
  readonly measure: typeof FATIGUE_SAVED_AXIAL_MEASURE;
  readonly stress: 'member-mean-linear-axial';
  readonly excluded: 'bending-shear-torsion-local-combined-multiaxial';
  readonly analysisId: string;
  readonly analysisRevision: number;
  readonly inputSha256: string;
  readonly memberId: string;
  readonly startNodeId: string;
  readonly endNodeId: string;
  readonly lengthM: number;
  readonly youngPa: number;
  readonly sampleTimesS: readonly number[];
  readonly conversion: 'MPa = Pa / 1e6';
}
export interface FatigueSavedAxialSource {
  /** The id of the imported history in `input.histories`. */
  readonly historyId: string;
  readonly provenance: FatigueSavedAxialProvenance;
}
interface FatigueSavedBase {
  readonly id: typeof FATIGUE_SAVED_ID;
  readonly source: { readonly documentId: string };
  readonly input: FatigueSavedProblem;
  /** Saved provenance of this S-N curve, kept outside the unchanged solver input and shared fatigue sources. */
  readonly curveEvidence?: AnalysisPropertyEvidence;
  /** Histories imported from a transient member-mean axial measure; manual histories have no entry. */
  readonly axial: readonly FatigueSavedAxialSource[];
}
export interface FatigueSavedMeanStressCorrection {
  readonly schema: 'pointercad-fatigue-goodman/1';
  readonly method: 'goodman-tension-only/1';
  readonly unit: 'MPa';
  readonly applicability: 'uniaxial-elastic-symmetric-yield';
  readonly ultimateTensileStrengthMpa: number;
  readonly yieldStrengthMpa: number;
  readonly minimumCycles: number;
  readonly source: FatigueSavedSource;
}
export type FatigueSavedInput = FatigueSavedBase & (
  { readonly schema: typeof FATIGUE_SAVED_SCHEMA }
  | { readonly schema: typeof FATIGUE_SAVED_GOODMAN_SCHEMA; readonly correction: FatigueSavedMeanStressCorrection });

/** Same bounds as fatigueModel.ts of @pointercad/fem; fatigueSession.test.ts in the UI package compares the verdicts of
 * both readers on the same cases, so a drift of either copy is reported. */
const LIMITS = { maximumStressMpa: 1e4, maximumPoints: 100_000, maximumHistories: 64, maximumRepeats: 1e9,
  slope: [1, 20], referenceStressMpa: [1, 1e4], referenceCycles: [1, 1e12], maximumCutoffMpa: 2e4 } as const;

function fail(path: string, message: string): never {
  throw new InputIssue('fatigue', path, message);
}
function exact(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  // fields() checks the count and presence; own keys only (an inherited name is not a saved field).
  const row = fields(value, keys, path);
  if (!keys.every(key => Object.hasOwn(row, key))) fail(path, 'Unsupported or missing field');
  return row;
}
function dense(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'Expected a list');
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) fail(`${path}[${index}]`, 'Expected a list without holes');
  }
  return value;
}
function label(value: unknown, path: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    fail(path, `Expected nonempty text of at most ${maximum} characters`);
  }
  return value;
}
function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'Expected a finite number');
  return value;
}
function bounded(value: unknown, path: string, [minimum, maximum]: readonly [number, number]): number {
  const number = finite(value, path);
  if (number < minimum || number > maximum) fail(path, `Expected a value from ${minimum} to ${maximum}`);
  return number;
}
function readSource(value: unknown, path: string): FatigueSavedSource {
  const row = exact(value, ['kind', 'reference', 'condition'], path);
  if (row.kind !== 'user-supplied') fail(`${path}.kind`, 'Fatigue data must be user-supplied');
  return { kind: 'user-supplied', reference: label(row.reference, `${path}.reference`, 512),
    condition: label(row.condition, `${path}.condition`, 512) };
}

function readCurve(value: unknown, path: string): FatigueSavedCurve {
  const row = exact(value, ['id', 'unit', 'stressDefinition', 'meanStressAssumption', 'referenceStressMpa',
    'referenceCycles', 'slope', 'cutoffStressMpa', 'source'], path);
  const id = label(row.id, `${path}.id`, 64);
  if (row.unit !== 'MPa') fail(`${path}.unit`, 'Expected MPa');
  const definition = row.stressDefinition;
  if (definition !== 'range' && definition !== 'amplitude') fail(`${path}.stressDefinition`, 'Expected range or amplitude');
  const mean = row.meanStressAssumption;
  if (mean !== 'mean-independent' && mean !== 'fully-reversed-only') {
    fail(`${path}.meanStressAssumption`, 'Expected an explicit mean-stress assumption');
  }
  const referenceStressMpa = bounded(row.referenceStressMpa, `${path}.referenceStressMpa`, LIMITS.referenceStressMpa);
  const referenceCycles = bounded(row.referenceCycles, `${path}.referenceCycles`, LIMITS.referenceCycles);
  const slope = bounded(row.slope, `${path}.slope`, LIMITS.slope);
  let cutoffStressMpa: number | null = null;
  if (row.cutoffStressMpa !== null) {
    cutoffStressMpa = finite(row.cutoffStressMpa, `${path}.cutoffStressMpa`);
    if (cutoffStressMpa <= 0 || cutoffStressMpa > LIMITS.maximumCutoffMpa) {
      fail(`${path}.cutoffStressMpa`, 'Expected a positive cut-off of at most 2e4 MPa, or no cut-off');
    }
  }
  return { id, unit: 'MPa', stressDefinition: definition, meanStressAssumption: mean, referenceStressMpa,
    referenceCycles, slope, cutoffStressMpa, source: readSource(row.source, `${path}.source`) };
}

function readHistory(value: unknown, path: string): FatigueSavedHistory {
  const row = exact(value, ['id', 'unit', 'stressMpa', 'sequence', 'repeats', 'source'], path);
  const id = label(row.id, `${path}.id`, 64);
  if (row.unit !== 'MPa') fail(`${path}.unit`, 'Expected MPa');
  const points = dense(row.stressMpa, `${path}.stressMpa`);
  if (points.length < 1 || points.length > LIMITS.maximumPoints) fail(`${path}.stressMpa`, 'Expected 1 to 100000 stresses');
  const stressMpa: number[] = [];
  for (const [index, point] of points.entries()) {
    const stress = finite(point, `${path}.stressMpa[${index}]`);
    if (Math.abs(stress) > LIMITS.maximumStressMpa) fail(`${path}.stressMpa[${index}]`, 'Expected |stress| of at most 1e4 MPa');
    stressMpa.push(stress);
  }
  const sequence = row.sequence;
  if (sequence !== 'once' && sequence !== 'repeated-periodic') fail(`${path}.sequence`, 'Expected once or repeated-periodic');
  const repeats = row.repeats;
  if (typeof repeats !== 'number' || !Number.isSafeInteger(repeats) || repeats < 1 || repeats > LIMITS.maximumRepeats
    || (sequence === 'once' && repeats !== 1)) fail(`${path}.repeats`, 'Expected 1 for once, or 1 to 1e9 repeats');
  return { id, unit: 'MPa', stressMpa, sequence, repeats, source: readSource(row.source, `${path}.source`) };
}

/** Strict reader of the saved problem: the same field sets, bounds and refusals as validateFatigueInput. */
export function readFatigueSavedProblem(value: unknown, path: string): FatigueSavedProblem {
  const row = exact(value, ['schema', 'curve', 'histories'], path);
  if (row.schema !== 'pointercad-fatigue/1') fail(`${path}.schema`, 'Expected fatigue input schema 1');
  const curve = readCurve(row.curve, `${path}.curve`);
  const rows = dense(row.histories, `${path}.histories`);
  if (rows.length < 1 || rows.length > LIMITS.maximumHistories) fail(`${path}.histories`, 'Expected 1 to 64 histories');
  const ids = new Set<string>();
  const histories = rows.map((item, index) => {
    const history = readHistory(item, `${path}.histories[${index}]`);
    if (ids.has(history.id)) fail(`${path}.histories[${index}].id`, 'Duplicate history id');
    ids.add(history.id);
    return history;
  });
  return { schema: 'pointercad-fatigue/1', curve, histories };
}

function readProvenance(value: unknown, path: string, points: number): FatigueSavedAxialProvenance {
  const row = exact(value, ['measure', 'stress', 'excluded', 'analysisId', 'analysisRevision', 'inputSha256', 'memberId',
    'startNodeId', 'endNodeId', 'lengthM', 'youngPa', 'sampleTimesS', 'conversion'], path);
  if (row.measure !== FATIGUE_SAVED_AXIAL_MEASURE || row.stress !== 'member-mean-linear-axial'
    || row.excluded !== 'bending-shear-torsion-local-combined-multiaxial' || row.conversion !== 'MPa = Pa / 1e6') {
    fail(path, 'Expected the member-mean linear axial measure in MPa = Pa / 1e6');
  }
  const analysisRevision = row.analysisRevision;
  if (typeof analysisRevision !== 'number' || !Number.isSafeInteger(analysisRevision) || analysisRevision < 0) {
    fail(`${path}.analysisRevision`, 'Expected a nonnegative integer revision');
  }
  const lengthM = finite(row.lengthM, `${path}.lengthM`);
  if (!(lengthM > 0)) fail(`${path}.lengthM`, 'Expected a positive member length');
  const youngPa = finite(row.youngPa, `${path}.youngPa`);
  if (!(youngPa > 0)) fail(`${path}.youngPa`, 'Expected a positive Young modulus');
  const times = dense(row.sampleTimesS, `${path}.sampleTimesS`);
  if (times.length !== points) fail(`${path}.sampleTimesS`, 'Expected one sample time per imported stress');
  const sampleTimesS: number[] = [];
  for (const [index, time] of times.entries()) {
    const timeS = finite(time, `${path}.sampleTimesS[${index}]`);
    const previous = sampleTimesS.at(-1);
    if (previous !== undefined && !(timeS > previous)) fail(`${path}.sampleTimesS[${index}]`, 'Expected increasing times');
    sampleTimesS.push(timeS);
  }
  return { measure: FATIGUE_SAVED_AXIAL_MEASURE, stress: 'member-mean-linear-axial',
    excluded: 'bending-shear-torsion-local-combined-multiaxial', analysisId: label(row.analysisId, `${path}.analysisId`, 256),
    analysisRevision, inputSha256: label(row.inputSha256, `${path}.inputSha256`, 256),
    memberId: label(row.memberId, `${path}.memberId`, 256), startNodeId: label(row.startNodeId, `${path}.startNodeId`, 256),
    endNodeId: label(row.endNodeId, `${path}.endNodeId`, 256), lengthM, youngPa, sampleTimesS, conversion: 'MPa = Pa / 1e6' };
}

function readAxialSources(value: unknown, path: string, problem: FatigueSavedProblem): FatigueSavedAxialSource[] {
  const rows = dense(value, path);
  if (rows.length > LIMITS.maximumHistories) fail(path, 'Expected at most one source per history');
  const seen = new Set<string>();
  return rows.map((item, index) => {
    const row = exact(item, ['historyId', 'provenance'], `${path}[${index}]`);
    const history = problem.histories.find(candidate => candidate.id === row.historyId);
    if (history === undefined || seen.has(history.id)) fail(`${path}[${index}].historyId`, 'Expected one source per existing history');
    seen.add(history.id);
    return { historyId: history.id,
      provenance: readProvenance(row.provenance, `${path}[${index}].provenance`, history.stressMpa.length) };
  });
}

/** Strict reader of the saved configuration. Unknown versions and invalid values are rejected; nothing is coerced. */
export function readFatigueSavedInput(value: unknown, path: string): FatigueSavedInput {
  const version1 = value !== null && typeof value === 'object' && 'schema' in value && value.schema === FATIGUE_SAVED_SCHEMA_V1;
  const version3 = value !== null && typeof value === 'object' && 'schema' in value && value.schema === FATIGUE_SAVED_GOODMAN_SCHEMA;
  const keys = version1 ? ['schema', 'id', 'source', 'input'] : ['schema', 'id', 'source', 'input', 'axial'];
  const row = exact(value, [...(version3 ? [...keys, 'correction'] : keys),
    ...analysisPropertyEvidenceKeys(value, 'curveEvidence')], path);
  if (row.schema !== FATIGUE_SAVED_SCHEMA && !version1 && !version3) {
    throw new InputIssue('unsupported-model', path, 'Expected saved fatigue schema 1, 2 or 3');
  }
  if (row.id !== FATIGUE_SAVED_ID) fail(`${path}.id`, 'Unexpected fatigue input id');
  const source = exact(row.source, ['documentId'], `${path}.source`);
  const documentId = text(source.documentId, `${path}.source.documentId`);
  const input = readFatigueSavedProblem(row.input, `${path}.input`);
  const curveEvidence = readOptionalAnalysisPropertyEvidence(row, 'curveEvidence', fatiguePropertySeries(input.curve), path);
  const base: FatigueSavedBase = { id: FATIGUE_SAVED_ID, source: { documentId }, input,
    axial: version1 ? [] : readAxialSources(row.axial, `${path}.axial`, input),
    ...(curveEvidence === undefined ? {} : { curveEvidence }) };
  if (!version3) return { ...base, schema: FATIGUE_SAVED_SCHEMA };
  if (input.curve.meanStressAssumption !== 'fully-reversed-only') {
    fail(`${path}.input.curve.meanStressAssumption`, 'Goodman requires a fully-reversed reference curve');
  }
  return { ...base, schema: FATIGUE_SAVED_GOODMAN_SCHEMA, correction: readCorrection(row.correction, `${path}.correction`) };
}

function readCorrection(value: unknown, path: string): FatigueSavedMeanStressCorrection {
  const row = exact(value, ['schema', 'method', 'unit', 'applicability', 'ultimateTensileStrengthMpa',
    'yieldStrengthMpa', 'minimumCycles', 'source'], path);
  if (row.schema !== 'pointercad-fatigue-goodman/1' || row.method !== 'goodman-tension-only/1'
    || row.unit !== 'MPa' || row.applicability !== 'uniaxial-elastic-symmetric-yield') {
    fail(path, 'Expected the explicit uniaxial elastic Goodman correction in MPa');
  }
  const ultimateTensileStrengthMpa = finite(row.ultimateTensileStrengthMpa, `${path}.ultimateTensileStrengthMpa`);
  const yieldStrengthMpa = finite(row.yieldStrengthMpa, `${path}.yieldStrengthMpa`);
  const minimumCycles = finite(row.minimumCycles, `${path}.minimumCycles`);
  if (!(yieldStrengthMpa > 0 && yieldStrengthMpa <= ultimateTensileStrengthMpa && ultimateTensileStrengthMpa <= 1e4)) {
    fail(path, 'Expected 0 < yield strength <= tensile strength <= 10000 MPa');
  }
  if (!(minimumCycles > 1000 && minimumCycles <= 1e12)) fail(`${path}.minimumCycles`, 'Expected 1000 < minimum cycles <= 1e12');
  return { schema: 'pointercad-fatigue-goodman/1', method: 'goodman-tension-only/1', unit: 'MPa',
    applicability: 'uniaxial-elastic-symmetric-yield', ultimateTensileStrengthMpa, yieldStrengthMpa, minimumCycles,
    source: readSource(row.source, `${path}.source`) };
}

/** The shared strict readers and bounds, for the saved proportional tensor input (fatigueTensorInput.ts). */
export { dense as denseFatigueList, exact as exactFatigueFields, finite as finiteFatigueNumber, label as fatigueLabel,
  LIMITS as FATIGUE_SAVED_LIMITS, readCurve as readFatigueSavedCurve, readHistory as readFatigueSavedHistory, readSource as readFatigueSavedSource };
