import { InputIssue, text } from './analysisValidation.js';
import { FATIGUE_SAVED_ID, FATIGUE_SAVED_LIMITS, denseFatigueList, exactFatigueFields, fatigueLabel, finiteFatigueNumber,
  readFatigueSavedHistory, readFatigueSavedSource, type FatigueSavedHistory, type FatigueSavedSource } from './fatigueInput.js';

/**
 * Saved piecewise (multi-slope) S-N fatigue input: version 5 of the saved fatigue configuration, stored under its own
 * analysis kind 'fatigue-piecewise' with the single fatigue id, so one document holds exactly one fatigue configuration
 * (versions 1 to 4 are unchanged and still read by their own readers). The input is exactly the
 * `pointercad-fatigue-piecewise/1` input of @pointercad/fem fatiguePiecewise.ts: the user's sourced calibration with
 * ordered segments (each a start stress, start cycles and slope; later starts lie on the previous line), the end of the
 * calibrated cycle range and the stated behaviour below it, the user's applicability statement, and the unchanged stress
 * histories. Only inputs are stored: cycles, damage and life never are. No grade, detail category or FAT value is built in.
 * The model cannot import the solver package, so the core's acceptance rules are mirrored with the same bounds.
 */
export const FATIGUE_SAVED_PIECEWISE_SCHEMA = 'pointercad-fatigue-saved/5';
export const FATIGUE_SAVED_PIECEWISE_INPUT_SCHEMA = 'pointercad-fatigue-piecewise/1';
/** MAX_FATIGUE_PIECEWISE_SEGMENTS and FATIGUE_PIECEWISE_CONTINUITY_TOLERANCE of the core. */
export const FATIGUE_SAVED_PIECEWISE_LIMITS = { maximumSegments: 8, continuityTolerance: 1e-9,
  stressMpa: [1, 1e4], cycles: [1, 1e12], slope: [1, 20] } as const;

export interface FatigueSavedPiecewiseSegment {
  readonly fromStressMpa: number;
  readonly fromCycles: number;
  readonly slope: number;
}
export interface FatigueSavedPiecewiseApplicability {
  readonly material: string;
  readonly detail: string;
  readonly scope: string;
}
export interface FatigueSavedPiecewiseCurve {
  readonly id: string;
  readonly unit: 'MPa';
  readonly stressDefinition: 'range' | 'amplitude';
  readonly meanStressAssumption: 'mean-independent' | 'fully-reversed-only';
  readonly segments: readonly FatigueSavedPiecewiseSegment[];
  readonly endCycles: number;
  readonly end: 'cutoff-at-end' | 'none';
  readonly applicability: FatigueSavedPiecewiseApplicability;
  readonly source: FatigueSavedSource;
}
/** Structurally the FatiguePiecewiseInput of @pointercad/fem (the model cannot import the solver package). */
export interface FatigueSavedPiecewiseProblem {
  readonly schema: typeof FATIGUE_SAVED_PIECEWISE_INPUT_SCHEMA;
  readonly curve: FatigueSavedPiecewiseCurve;
  readonly histories: readonly FatigueSavedHistory[];
}
export interface FatiguePiecewiseSavedInput {
  readonly schema: typeof FATIGUE_SAVED_PIECEWISE_SCHEMA;
  readonly id: typeof FATIGUE_SAVED_ID;
  readonly source: { readonly documentId: string };
  readonly input: FatigueSavedPiecewiseProblem;
}

function fail(path: string, message: string): never {
  throw new InputIssue('fatigue', path, message);
}
function bounded(value: unknown, path: string, [minimum, maximum]: readonly [number, number]): number {
  const number = finiteFatigueNumber(value, path);
  if (number < minimum || number > maximum) fail(path, `Expected a value from ${minimum} to ${maximum}`);
  return number;
}

function readSegments(value: unknown, path: string): FatigueSavedPiecewiseSegment[] {
  const rows = denseFatigueList(value, path);
  if (rows.length < 1 || rows.length > FATIGUE_SAVED_PIECEWISE_LIMITS.maximumSegments) fail(path, 'Expected 1 to 8 segments');
  const segments: FatigueSavedPiecewiseSegment[] = [];
  for (const [index, item] of rows.entries()) {
    const at = `${path}[${index}]`;
    const row = exactFatigueFields(item, ['fromStressMpa', 'fromCycles', 'slope'], at);
    const segment = { fromStressMpa: bounded(row.fromStressMpa, `${at}.fromStressMpa`, FATIGUE_SAVED_PIECEWISE_LIMITS.stressMpa),
      fromCycles: bounded(row.fromCycles, `${at}.fromCycles`, FATIGUE_SAVED_PIECEWISE_LIMITS.cycles),
      slope: bounded(row.slope, `${at}.slope`, FATIGUE_SAVED_PIECEWISE_LIMITS.slope) };
    const previous = segments.at(-1);
    if (previous !== undefined) {
      if (!(segment.fromCycles > previous.fromCycles && segment.fromStressMpa < previous.fromStressMpa)) {
        fail(at, 'Expected more cycles at a lower stress than the previous segment start');
      }
      // The same expression as segmentLife() of the core: N on the previous line at this start stress.
      const expected = previous.fromCycles * (previous.fromStressMpa / segment.fromStressMpa) ** previous.slope;
      if (!(Math.abs(expected - segment.fromCycles) <= FATIGUE_SAVED_PIECEWISE_LIMITS.continuityTolerance * segment.fromCycles)) {
        fail(at, 'Expected the segment start to lie on the previous segment line (continuous at the knee)');
      }
    }
    segments.push(segment);
  }
  return segments;
}

function readApplicability(value: unknown, path: string): FatigueSavedPiecewiseApplicability {
  const row = exactFatigueFields(value, ['material', 'detail', 'scope'], path);
  return { material: fatigueLabel(row.material, `${path}.material`, 512), detail: fatigueLabel(row.detail, `${path}.detail`, 512),
    scope: fatigueLabel(row.scope, `${path}.scope`, 512) };
}

function readCurve(value: unknown, path: string): FatigueSavedPiecewiseCurve {
  const row = exactFatigueFields(value, ['id', 'unit', 'stressDefinition', 'meanStressAssumption', 'segments', 'endCycles', 'end',
    'applicability', 'source'], path);
  const id = fatigueLabel(row.id, `${path}.id`, 64);
  if (row.unit !== 'MPa') fail(`${path}.unit`, 'Expected MPa');
  const definition = row.stressDefinition;
  if (definition !== 'range' && definition !== 'amplitude') fail(`${path}.stressDefinition`, 'Expected range or amplitude');
  const mean = row.meanStressAssumption;
  if (mean !== 'mean-independent' && mean !== 'fully-reversed-only') fail(`${path}.meanStressAssumption`, 'Expected an explicit mean-stress assumption');
  const segments = readSegments(row.segments, `${path}.segments`);
  const endCycles = bounded(row.endCycles, `${path}.endCycles`, FATIGUE_SAVED_PIECEWISE_LIMITS.cycles);
  const last = segments.at(-1);
  if (last === undefined || !(endCycles > last.fromCycles)) fail(`${path}.endCycles`, 'Expected more cycles than the last segment start');
  const end = row.end;
  if (end !== 'cutoff-at-end' && end !== 'none') fail(`${path}.end`, 'Expected cutoff-at-end or none');
  return { id, unit: 'MPa', stressDefinition: definition, meanStressAssumption: mean, segments, endCycles, end,
    applicability: readApplicability(row.applicability, `${path}.applicability`), source: readFatigueSavedSource(row.source, `${path}.source`) };
}

/** Strict reader of the saved piecewise problem: the same fields, bounds and refusals as validateFatiguePiecewiseInput. */
export function readFatiguePiecewiseSavedProblem(value: unknown, path: string): FatigueSavedPiecewiseProblem {
  const row = exactFatigueFields(value, ['schema', 'curve', 'histories'], path);
  if (row.schema !== FATIGUE_SAVED_PIECEWISE_INPUT_SCHEMA) fail(`${path}.schema`, 'Expected piecewise fatigue input schema 1');
  const curve = readCurve(row.curve, `${path}.curve`);
  const rows = denseFatigueList(row.histories, `${path}.histories`);
  if (rows.length < 1 || rows.length > FATIGUE_SAVED_LIMITS.maximumHistories) fail(`${path}.histories`, 'Expected 1 to 64 histories');
  const ids = new Set<string>();
  const histories = rows.map((item, index) => {
    const history = readFatigueSavedHistory(item, `${path}.histories[${index}]`);
    if (ids.has(history.id)) fail(`${path}.histories[${index}].id`, 'Duplicate history id');
    ids.add(history.id);
    return history;
  });
  return { schema: FATIGUE_SAVED_PIECEWISE_INPUT_SCHEMA, curve, histories };
}

/** Strict reader of a saved piecewise configuration. Any other version is refused; nothing is coerced. */
export function readFatiguePiecewiseSavedInput(value: unknown, path: string): FatiguePiecewiseSavedInput {
  const schema = value !== null && typeof value === 'object' && 'schema' in value ? value.schema : undefined;
  if (schema !== FATIGUE_SAVED_PIECEWISE_SCHEMA) {
    throw new InputIssue('unsupported-model', path, 'Expected saved fatigue schema 5 for a piecewise S-N input');
  }
  const row = exactFatigueFields(value, ['schema', 'id', 'source', 'input'], path);
  if (row.id !== FATIGUE_SAVED_ID) fail(`${path}.id`, 'Unexpected fatigue input id');
  const source = exactFatigueFields(row.source, ['documentId'], `${path}.source`);
  const documentId = text(source.documentId, `${path}.source.documentId`);
  return { schema: FATIGUE_SAVED_PIECEWISE_SCHEMA, id: FATIGUE_SAVED_ID, source: { documentId },
    input: readFatiguePiecewiseSavedProblem(row.input, `${path}.input`) };
}
