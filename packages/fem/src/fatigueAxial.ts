import { MAX_FATIGUE_HISTORY_POINTS, MAX_FATIGUE_REPEATS, MAX_FATIGUE_STRESS_MPA, type FatigueSequence,
  type FatigueStressHistory } from './fatigueModel.js';
import { transientAxialMatches, type TransientAxialResponse } from './transientAxial.js';
import type { BeamTransientResult } from './transientModel.js';

/**
 * Adapter from the existing transient member-mean axial measure (transientAxial.ts) to ONE fatigue stress history.
 * Only that measure is mapped: sigma = E * ((u_end - u_start) . x) / L, the mean axial stress of a whole CAD member
 * from its sampled end translations. It is not bending, shear, torsion, local (notch/weld), combined or multiaxial
 * stress, not a stress between the emitted samples and not a stress inside a subdivided member, so a fatigue result
 * from it is a member-mean axial estimate only. Values are never interpolated, extrapolated, reordered or clipped.
 */
export const AXIAL_FATIGUE_MEASURE = 'member-mean-linear-axial-from-sampled-end-translations/1';
/** Pa -> MPa (N/m2 -> N/mm2): MPa = Pa / 1e6, one exact division per sample. */
export const PASCALS_PER_MEGAPASCAL = 1e6;

/** Explicit user choice; there is no default member, sequence, repeat count or label. */
export interface AxialFatigueSelection {
  readonly memberId: string;
  readonly historyId: string;
  /** 'once': the analysed time window is one event. 'repeated-periodic': the user states the window is one period. */
  readonly sequence: FatigueSequence;
  readonly repeats: number;
  /** The user's own label for the fatigue history (e.g. the load case it represents); provenance is added separately. */
  readonly reference: string;
}
export interface AxialFatigueProvenance {
  readonly measure: typeof AXIAL_FATIGUE_MEASURE;
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
  /** The emitted sample times, one per history point, strictly increasing. */
  readonly sampleTimesS: readonly number[];
  readonly conversion: 'MPa = Pa / 1e6';
}
export type AxialFatigueErrorCode = 'fatigue-axial-measure' | 'fatigue-axial-times' | 'fatigue-axial-member'
  | 'fatigue-axial-series' | 'fatigue-axial-binding' | 'fatigue-axial-selection' | 'fatigue-axial-bound' | 'fatigue-axial-label';
export interface AxialFatigueError { readonly ok: false; readonly code: AxialFatigueErrorCode; readonly path: string }
export type AxialFatigueHistory =
  | { readonly ok: true; readonly history: FatigueStressHistory; readonly provenance: AxialFatigueProvenance }
  | AxialFatigueError;

const fail = (code: AxialFatigueErrorCode, path: string): AxialFatigueError => ({ ok: false, code, path });
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
/** Holes are refused (every/map skip them), as in every other runtime reader of this package. */
const dense = (value: unknown): value is unknown[] => {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index)) return false;
  return true;
};

function readSelection(value: unknown): AxialFatigueSelection | AxialFatigueError {
  const keys = ['memberId', 'historyId', 'sequence', 'repeats', 'reference'];
  if (!record(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) {
    return fail('fatigue-axial-selection', 'selection');
  }
  if (!text(value.memberId, 256)) return fail('fatigue-axial-selection', 'selection.memberId');
  if (!text(value.historyId, 64)) return fail('fatigue-axial-selection', 'selection.historyId');
  const sequence = value.sequence;
  if (sequence !== 'once' && sequence !== 'repeated-periodic') return fail('fatigue-axial-selection', 'selection.sequence');
  const repeats = value.repeats;
  if (typeof repeats !== 'number' || !Number.isSafeInteger(repeats) || repeats < 1 || repeats > MAX_FATIGUE_REPEATS
    || (sequence === 'once' && repeats !== 1)) return fail('fatigue-axial-selection', 'selection.repeats');
  if (!text(value.reference, 512)) return fail('fatigue-axial-label', 'selection.reference');
  return { memberId: value.memberId, historyId: value.historyId, sequence, repeats, reference: value.reference };
}

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const numbers = (value: unknown): value is number[] => dense(value) && value.every(finiteNumber);
const extreme = (value: unknown): boolean => record(value) && ['sample', 'timeS', 'strain', 'stressPa'].every(key => finiteNumber(value[key]));
/** Structural guard of a stored or transferred measure (no cast): every field transientAxialMatches reads. */
function isAxialResponse(value: Record<string, unknown>): value is Record<string, unknown> & TransientAxialResponse {
  return value.measure === AXIAL_FATIGUE_MEASURE && typeof value.analysisId === 'string' && finiteNumber(value.analysisRevision)
    && typeof value.inputSha256 === 'string' && numbers(value.sampleTimesS) && dense(value.members)
    && value.members.every(member => record(member) && ['memberId', 'startNodeId', 'endNodeId'].every(key => typeof member[key] === 'string')
      && ['startSolverNode', 'endSolverNode', 'lengthM', 'youngPa'].every(key => finiteNumber(member[key]))
      && numbers(member.axis) && member.axis.length === 3 && numbers(member.strain) && dense(member.stressPa)
      && extreme(member.maximum) && extreme(member.minimum));
}

/**
 * One fatigue stress history (MPa) of the selected member, bound to the displayed transient result.
 * Refuses (typed, never thrown): another measure, a sample grid that is not finite and strictly increasing, a member
 * that is absent or listed twice, a series of the wrong length or with a non-finite value, a measure that does not
 * belong to `result` (transientAxialMatches: digest, id, revision, grid and every stored value), an invalid selection
 * and any converted value outside the fatigue input bound. The returned history passes validateFatigueInput's
 * history rules by construction (same bounds); combine it with a user-supplied curve for analyzeFatigue.
 */
export function axialFatigueHistory(axial: unknown, result: BeamTransientResult, selection: unknown): AxialFatigueHistory {
  if (!record(axial) || axial.measure !== AXIAL_FATIGUE_MEASURE) return fail('fatigue-axial-measure', 'axial.measure');
  const times = axial.sampleTimesS;
  if (!dense(times) || times.length < 1 || times.length > MAX_FATIGUE_HISTORY_POINTS) return fail('fatigue-axial-times', 'axial.sampleTimesS');
  let before: number | null = null;
  for (const [index, time] of times.entries()) {
    if (!finiteNumber(time) || (before !== null && !(time > before))) return fail('fatigue-axial-times', `axial.sampleTimesS[${index}]`);
    before = time;
  }
  const chosen = readSelection(selection);
  if ('ok' in chosen) return chosen;
  if (!dense(axial.members)) return fail('fatigue-axial-member', 'axial.members');
  const matching = axial.members.filter(member => record(member) && member.memberId === chosen.memberId);
  const found = matching[0];
  if (matching.length !== 1 || !record(found)) return fail('fatigue-axial-member', 'selection.memberId');
  const series = found.stressPa;
  if (!dense(series) || series.length !== times.length) return fail('fatigue-axial-series', 'member.stressPa');
  for (const [index, value] of series.entries()) {
    if (!finiteNumber(value)) return fail('fatigue-axial-series', `member.stressPa[${index}]`);
  }
  // The measure must be the one derived from this very result (no stale, foreign or edited series).
  if (!isAxialResponse(axial) || !transientAxialMatches(axial, result)) return fail('fatigue-axial-binding', 'axial');
  const member = axial.members.find(row => row.memberId === chosen.memberId);
  if (member === undefined) return fail('fatigue-axial-member', 'selection.memberId');
  const stressMpa: number[] = [];
  for (const [index, value] of member.stressPa.entries()) {
    const converted = value / PASCALS_PER_MEGAPASCAL;
    if (!Number.isFinite(converted) || Math.abs(converted) > MAX_FATIGUE_STRESS_MPA) {
      return fail('fatigue-axial-bound', `member.stressPa[${index}]`);
    }
    stressMpa.push(converted);
  }
  const condition = `member-mean linear axial stress E*chord strain of member ${member.memberId} from transient analysis `
    + `${axial.analysisId} revision ${axial.analysisRevision} input ${axial.inputSha256}; bending, shear, torsion, local, `
    + 'combined and multiaxial stress are not included';
  if (condition.length > 512) return fail('fatigue-axial-label', 'provenance');
  const history: FatigueStressHistory = { id: chosen.historyId, unit: 'MPa', stressMpa, sequence: chosen.sequence,
    repeats: chosen.repeats, source: { kind: 'user-supplied', reference: chosen.reference, condition } };
  return { ok: true, history, provenance: { measure: AXIAL_FATIGUE_MEASURE, stress: 'member-mean-linear-axial',
    excluded: 'bending-shear-torsion-local-combined-multiaxial', analysisId: axial.analysisId,
    analysisRevision: axial.analysisRevision, inputSha256: axial.inputSha256, memberId: member.memberId,
    startNodeId: member.startNodeId, endNodeId: member.endNodeId, lengthM: member.lengthM, youngPa: member.youngPa,
    sampleTimesS: [...axial.sampleTimesS], conversion: 'MPa = Pa / 1e6' } };
}
