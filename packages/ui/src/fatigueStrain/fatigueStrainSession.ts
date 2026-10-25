import { analyzeStrainHistory, analyzeStrainStressHistory, type StrainHistoryResult,
  type StrainStressHistoryResult } from '@pointercad/fem';
import { FATIGUE_STRAIN_SAVED_SCHEMA, FATIGUE_STRAIN_STRESS_SAVED_SCHEMA, createFatigueStrainSavedInput,
  createFatigueStrainStressSavedInput, type BeamAnalysisInputs, type FatigueStrainSavedConfiguration, type FatigueStrainSavedInput,
  type FatigueStrainSavedProblem, type FatigueStrainStressSavedProblem, type FatigueStrainStressSavedSample } from '@pointercad/model/beam-analysis';
import type { MessageKey } from '../i18n/t.js';

/**
 * Draft of the strain-life fatigue input (a separate document input kind from the stress-life `fatigue` panel). Every
 * value is the user's own text: no coefficient, interval, history or assumption is pre-filled, and nothing is derived
 * from a material name or from a stress. The draft becomes a saved input only through the model reader, and a result
 * is shown only for the exact draft that produced it; it is never saved.
 *
 * Two kinds of history share the material and the per-history fields: local total strain only, with the user's
 * explicit zero-mean-stress statement, or samples that pair each local strain with the local stress at the same time,
 * whose cycle mean stresses are taken from the paired stresses at the strain reversals (Morrow). A stress is never
 * computed from a strain, and the two kinds are saved under different schemas.
 */
export type FatigueStrainDerivation = '' | 'measured' | 'elastic-plastic-analysis';
export type FatigueStrainSequence = '' | 'once' | 'repeated-periodic';
export type FatigueStrainHistoryKind = 'strain-only' | 'paired-stress';
export interface FatigueStrainHistoryDraft {
  readonly id: string;
  readonly derivation: FatigueStrainDerivation;
  /** Local total strains in chronological order, separated by spaces, commas, semicolons or line breaks. */
  readonly strain: string;
  /** Paired samples, one per line: time [s], local total strain [-], local stress [MPa]. Absent until typed. */
  readonly samples?: string;
  readonly sequence: FatigueStrainSequence;
  readonly repeats: string;
  readonly reference: string;
  readonly condition: string;
}
export const FATIGUE_STRAIN_NUMBER_FIELDS = ['elasticModulusMpa', 'fatigueStrengthCoefficientMpa', 'fatigueStrengthExponent',
  'fatigueDuctilityCoefficient', 'fatigueDuctilityExponent', 'minimumCycles', 'maximumCycles'] as const;
export type FatigueStrainNumberField = typeof FATIGUE_STRAIN_NUMBER_FIELDS[number];
export type FatigueStrainTextField = 'materialId' | 'materialReference' | 'materialCondition';
export type FatigueStrainHistoryTextField = 'id' | 'strain' | 'samples' | 'repeats' | 'reference' | 'condition';
export interface FatigueStrainDraft extends Readonly<Record<FatigueStrainNumberField | FatigueStrainTextField, string>> {
  /** Strain only (zero mean stress, stated by the user) or strain paired with the local stress of every sample. */
  readonly historyKind: FatigueStrainHistoryKind;
  /** The user's explicit statement that every counted cycle has zero mean stress (no Morrow correction). */
  readonly zeroMeanStressConfirmed: boolean;
  readonly histories: readonly FatigueStrainHistoryDraft[];
}
export type FatigueStrainEdit =
  | { readonly kind: 'material'; readonly field: FatigueStrainNumberField | FatigueStrainTextField; readonly value: string }
  | { readonly kind: 'historyKind'; readonly value: FatigueStrainHistoryKind }
  | { readonly kind: 'zeroMeanStress'; readonly confirmed: boolean }
  | { readonly kind: 'history'; readonly index: number; readonly field: FatigueStrainHistoryTextField; readonly value: string }
  | { readonly kind: 'historyDerivation'; readonly index: number; readonly value: FatigueStrainDerivation }
  | { readonly kind: 'historySequence'; readonly index: number; readonly value: FatigueStrainSequence }
  | { readonly kind: 'addHistory' }
  | { readonly kind: 'removeHistory'; readonly index: number };
/** A refusal shown to the user: the message, and the typed code and field path when a reader or the solver gave one. */
export interface FatigueStrainRefusal {
  readonly key: MessageKey;
  readonly code: string | null;
  readonly path: string | null;
}
export type FatigueStrainResult = StrainHistoryResult | StrainStressHistoryResult;
export type FatigueStrainAnalyzed = {
  readonly revision: number;
  /** The exact draft object the result was computed from: every accepted edit and every reopen makes a new draft object,
   * so a result kept or put back from another draft is never current. */
  readonly draft: FatigueStrainDraft;
} & ({ readonly problem: FatigueStrainSavedProblem; readonly result: StrainHistoryResult }
  | { readonly problem: FatigueStrainStressSavedProblem; readonly result: StrainStressHistoryResult });
export interface FatigueStrainSession {
  readonly ownerId: string;
  /** Increases on every accepted edit; a result is current only for the revision it was computed from. */
  readonly revision: number;
  readonly draft: FatigueStrainDraft;
  readonly analyzed: FatigueStrainAnalyzed | null;
  readonly refusal: FatigueStrainRefusal | null;
}

/** Same limit as the saved format and the solver (MAX_FATIGUE_HISTORIES). */
export const FATIGUE_STRAIN_MAX_HISTORIES = 64;

const emptyHistory = (): FatigueStrainHistoryDraft =>
  ({ id: '', derivation: '', strain: '', sequence: '', repeats: '', reference: '', condition: '' });

export function createFatigueStrainSession(ownerId: string): FatigueStrainSession {
  return { ownerId, revision: 0, analyzed: null, refusal: null, draft: { materialId: '', elasticModulusMpa: '',
    fatigueStrengthCoefficientMpa: '', fatigueStrengthExponent: '', fatigueDuctilityCoefficient: '', fatigueDuctilityExponent: '',
    minimumCycles: '', maximumCycles: '', materialReference: '', materialCondition: '', historyKind: 'strain-only',
    zeroMeanStressConfirmed: false, histories: [emptyHistory()] } };
}

/** The saved strain-life configuration of a document for this panel (either kind), or null. */
export function savedFatigueStrainConfiguration(document: { readonly beamAnalysisInputs?: BeamAnalysisInputs }):
  FatigueStrainSavedConfiguration | null {
  const saved = document.beamAnalysisInputs?.analyses.find(input => input.kind === 'fatigue-strain-life');
  return saved?.kind === 'fatigue-strain-life' ? saved.definition : null;
}
/** The saved zero-mean strain-only input of a document, or null (also when the document holds the paired kind). */
export function savedFatigueStrainInput(document: { readonly beamAnalysisInputs?: BeamAnalysisInputs }): FatigueStrainSavedInput | null {
  const saved = savedFatigueStrainConfiguration(document);
  return saved !== null && saved.schema === FATIGUE_STRAIN_SAVED_SCHEMA ? saved : null;
}

/** One paired sample as the text a user types: the shortest decimal of each double (String(number) parses back to the
 * same double), so a restored draft that is saved again writes the same values. */
const sampleLine = (sample: FatigueStrainStressSavedSample): string =>
  `${String(sample.timeSeconds)} ${String(sample.strain)} ${String(sample.stressMpa)}`;

/** A draft that reproduces the saved configuration exactly (String(number) is the shortest text that parses back to the
 * same double). A paired configuration restores the paired kind without a zero-mean statement. */
export function restoreFatigueStrainSession(ownerId: string, saved: FatigueStrainSavedConfiguration): FatigueStrainSession {
  const { material } = saved.input;
  const base = { materialId: material.id,
    elasticModulusMpa: String(material.elasticModulusMpa), fatigueStrengthCoefficientMpa: String(material.fatigueStrengthCoefficientMpa),
    fatigueStrengthExponent: String(material.fatigueStrengthExponent),
    fatigueDuctilityCoefficient: String(material.fatigueDuctilityCoefficient),
    fatigueDuctilityExponent: String(material.fatigueDuctilityExponent),
    minimumCycles: String(material.calibration.minimumCycles), maximumCycles: String(material.calibration.maximumCycles),
    materialReference: material.source.reference, materialCondition: material.source.condition };
  if (saved.schema === FATIGUE_STRAIN_STRESS_SAVED_SCHEMA) {
    return { ...createFatigueStrainSession(ownerId), draft: { ...base, historyKind: 'paired-stress', zeroMeanStressConfirmed: false,
      histories: saved.input.histories.map(history => ({ id: history.id, derivation: history.derivation, strain: '',
        samples: history.samples.map(sampleLine).join('\n'), sequence: history.sequence, repeats: String(history.repeats),
        reference: history.source.reference, condition: history.source.condition })) } };
  }
  return { ...createFatigueStrainSession(ownerId), draft: { ...base, historyKind: 'strain-only',
    zeroMeanStressConfirmed: saved.input.meanStress === 'assumed-zero',
    histories: saved.input.histories.map(history => ({ id: history.id, derivation: history.derivation,
      strain: history.strain.map(String).join(' '), sequence: history.sequence, repeats: String(history.repeats),
      reference: history.source.reference, condition: history.source.condition })) } };
}

function withHistory(draft: FatigueStrainDraft, index: number,
  change: (history: FatigueStrainHistoryDraft) => FatigueStrainHistoryDraft): FatigueStrainDraft | null {
  const history = Number.isSafeInteger(index) ? draft.histories[index] : undefined;
  if (history === undefined) return null;
  return { ...draft, histories: draft.histories.map((item, at) => (at === index ? change(item) : item)) };
}
function editedDraft(draft: FatigueStrainDraft, edit: FatigueStrainEdit): FatigueStrainDraft | null {
  switch (edit.kind) {
    case 'material': return { ...draft, [edit.field]: edit.value };
    // Switching the kind keeps both texts of every history; only the chosen kind is read, saved and analysed.
    case 'historyKind': return edit.value === draft.historyKind ? null : { ...draft, historyKind: edit.value };
    case 'zeroMeanStress': return { ...draft, zeroMeanStressConfirmed: edit.confirmed };
    case 'history': return withHistory(draft, edit.index, history => ({ ...history, [edit.field]: edit.value }));
    case 'historyDerivation': return withHistory(draft, edit.index, history => ({ ...history, derivation: edit.value }));
    case 'historySequence': return withHistory(draft, edit.index, history => ({ ...history, sequence: edit.value }));
    case 'addHistory':
      return draft.histories.length >= FATIGUE_STRAIN_MAX_HISTORIES ? null : { ...draft, histories: [...draft.histories, emptyHistory()] };
    case 'removeHistory':
      return draft.histories.length <= 1 || draft.histories[edit.index] === undefined ? null
        : { ...draft, histories: draft.histories.filter((_, at) => at !== edit.index) };
    default: {
      const exhaustiveCheck: never = edit;
      return exhaustiveCheck;
    }
  }
}
/** An accepted edit starts a new revision (and a new draft object) and drops the result and refusal of the previous one;
 * an edit that cannot apply (unknown history, last history, more than 64, the kind already chosen) returns the same
 * session object. */
export function editFatigueStrainSession(session: FatigueStrainSession, edit: FatigueStrainEdit): FatigueStrainSession {
  const draft = editedDraft(session.draft, edit);
  return draft === null ? session : { ...session, draft, revision: session.revision + 1, analyzed: null, refusal: null };
}

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
/** Plain decimal text only (no expressions, no units, no empty text). */
export function fatigueStrainNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!DECIMAL.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}
export function fatigueStrainList(text: string): number[] | null {
  const parts = text.split(/[\s,;]+/u).filter(part => part !== '');
  const values: number[] = [];
  for (const part of parts) {
    const value = fatigueStrainNumber(part);
    if (value === null) return null;
    values.push(value);
  }
  return values.length === 0 ? null : values;
}
export interface FatigueStrainSampleText {
  readonly timeSeconds: number;
  readonly strain: number;
  readonly stressMpa: number;
}
/**
 * Paired samples typed one per line: time [s], local total strain [-] and local stress [MPa] as plain decimals separated
 * by spaces, tabs, commas or semicolons. Blank lines at the end are ignored; every other line must hold exactly these
 * three numbers, so line k (from 0) is sample k of the saved history. The lines are kept in the typed order (never
 * sorted, merged or interpolated); time order, units and bounds are checked afterwards by the model reader. Returns the
 * samples, or the index of the first line that is not three numbers.
 */
export function fatigueStrainSamples(text: string):
  { readonly ok: true; readonly samples: readonly FatigueStrainSampleText[] } | { readonly ok: false; readonly line: number } {
  const lines = text.split(/\r\n|\n|\r/u);
  while (lines.length > 0 && (lines.at(-1) ?? '').trim() === '') lines.pop();
  if (lines.length === 0) return { ok: false, line: 0 };
  const samples: FatigueStrainSampleText[] = [];
  for (const [line, row] of lines.entries()) {
    const values = row.split(/[\s,;]+/u).filter(part => part !== '').map(fatigueStrainNumber);
    const [timeSeconds, strain, stressMpa] = values;
    if (values.length !== 3 || timeSeconds === null || timeSeconds === undefined || strain === null || strain === undefined
      || stressMpa === null || stressMpa === undefined) return { ok: false, line };
    samples.push({ timeSeconds, strain, stressMpa });
  }
  return { ok: true, samples };
}

export type FatigueStrainChecked = { readonly ok: true; readonly saved: FatigueStrainSavedConfiguration }
  | { readonly ok: false; readonly refusal: FatigueStrainRefusal };
const refused = (key: MessageKey, path: string | null, code: string | null = null): FatigueStrainChecked =>
  ({ ok: false, refusal: { key, code, path } });

/** The saved configuration of `documentId` for the draft, validated by the model reader (the same reader as file
 * loading): the zero-mean kind needs the user's statement, the paired kind needs three numbers on every sample line. */
export function fatigueStrainSaved(session: FatigueStrainSession, documentId: string): FatigueStrainChecked {
  const { draft } = session;
  const paired = draft.historyKind === 'paired-stress';
  if (!paired && !draft.zeroMeanStressConfirmed) return refused('fatigueStrain.error.zeroMean', 'meanStress');
  const numbers: Partial<Record<FatigueStrainNumberField, number>> = {};
  for (const field of FATIGUE_STRAIN_NUMBER_FIELDS) {
    const value = fatigueStrainNumber(draft[field]);
    if (value === null) return refused('fatigueStrain.error.number', field);
    numbers[field] = value;
  }
  const histories: Record<string, unknown>[] = [];
  for (const [index, history] of draft.histories.entries()) {
    let values: Record<string, unknown>;
    if (paired) {
      const samples = fatigueStrainSamples(history.samples ?? '');
      if (!samples.ok) return refused('fatigueStrain.error.sampleLine', `histories[${index}].samples[${samples.line}]`);
      values = { strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', stressMeasure: 'local-stress', stressUnit: 'MPa',
        timeUnit: 'second', samples: samples.samples };
    } else {
      const strain = fatigueStrainList(history.strain);
      if (strain === null) return refused('fatigueStrain.error.strainList', `histories[${index}].strain`);
      values = { strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', strain };
    }
    if (history.derivation === '') return refused('fatigueStrain.error.derivation', `histories[${index}].derivation`);
    if (history.sequence === '') return refused('fatigueStrain.error.sequence', `histories[${index}].sequence`);
    const repeats = fatigueStrainNumber(history.repeats);
    if (repeats === null) return refused('fatigueStrain.error.number', `histories[${index}].repeats`);
    histories.push({ id: history.id, ...values, derivation: history.derivation, sequence: history.sequence, repeats,
      source: { kind: 'user-supplied', reference: history.reference, condition: history.condition } });
  }
  const material = { id: draft.materialId, stressUnit: 'MPa', elasticModulusMpa: numbers.elasticModulusMpa,
    fatigueStrengthCoefficientMpa: numbers.fatigueStrengthCoefficientMpa, fatigueStrengthExponent: numbers.fatigueStrengthExponent,
    fatigueDuctilityCoefficient: numbers.fatigueDuctilityCoefficient, fatigueDuctilityExponent: numbers.fatigueDuctilityExponent,
    calibration: { minimumCycles: numbers.minimumCycles, maximumCycles: numbers.maximumCycles },
    source: { kind: 'user-supplied', reference: draft.materialReference, condition: draft.materialCondition } };
  try {
    return { ok: true, saved: paired
      ? createFatigueStrainStressSavedInput(documentId, { schema: 'pointercad-strain-stress-history/1',
        meanStress: 'morrow-paired-reversal-stress', material, histories })
      : createFatigueStrainSavedInput(documentId, { schema: 'pointercad-strain-history/1', meanStress: 'assumed-zero', material,
        histories }) };
  } catch (error) {
    // The model reader throws its InputIssue (code and path of the first refused field); anything else is rethrown.
    if (!(error instanceof Error) || !('path' in error) || typeof error.path !== 'string') throw error;
    const code = 'code' in error && typeof error.code === 'string' ? error.code : null;
    return refused('fatigueStrain.error.input', error.path.replace(/^definition\.input\.?/u, ''), code);
  }
}

const ANALYSIS_KEYS: Readonly<Record<string, MessageKey>> = {
  'strain-life-shorter-than-calibration': 'fatigueStrain.error.shorter',
  'strain-life-longer-than-calibration': 'fatigueStrain.error.longer',
  'strain-life-morrow-domain': 'fatigueStrain.error.morrowDomain',
  'strain-stress-history-ambiguous-reversal-stress': 'fatigueStrain.error.ambiguousStress',
  'strain-stress-history-periodic-closure': 'fatigueStrain.error.periodicClosure',
  'strain-stress-history-recurrence-closure': 'fatigueStrain.error.recurrenceClosure',
};
const analysisRefusal = (session: FatigueStrainSession, code: string, path: string): FatigueStrainSession =>
  ({ ...session, analyzed: null, refusal: { key: ANALYSIS_KEYS[code] ?? 'fatigueStrain.error.analysis', code, path } });
/** Runs the analysis of the chosen kind on the validated input (the paired kind only with the paired solver); the
 * session keeps either the result of this exact draft or the refusal, never a result of an earlier draft. */
export function runFatigueStrainSession(session: FatigueStrainSession, documentId: string): FatigueStrainSession {
  const checked = fatigueStrainSaved(session, documentId);
  if (!checked.ok) return { ...session, analyzed: null, refusal: checked.refusal };
  const { saved } = checked;
  const at = { revision: session.revision, draft: session.draft };
  if (saved.schema === FATIGUE_STRAIN_STRESS_SAVED_SCHEMA) {
    const analysis = analyzeStrainStressHistory(saved.input);
    if (!analysis.ok) return analysisRefusal(session, analysis.code, analysis.path);
    return { ...session, analyzed: { ...at, problem: saved.input, result: analysis.result }, refusal: null };
  }
  const analysis = analyzeStrainHistory(saved.input);
  if (!analysis.ok) return analysisRefusal(session, analysis.code, analysis.path);
  return { ...session, analyzed: { ...at, problem: saved.input, result: analysis.result }, refusal: null };
}
/** The result for the current draft only: the same revision and the very draft object it was computed from. */
export function currentFatigueStrainResult(session: FatigueStrainSession): FatigueStrainResult | null {
  const { analyzed } = session;
  return analyzed !== null && analyzed.revision === session.revision && analyzed.draft === session.draft ? analyzed.result : null;
}
/** The mean-stress statement a result was computed under, shown with every result. */
export function fatigueStrainApplicability(result: FatigueStrainResult): MessageKey {
  return result.meanStress === 'assumed-zero' ? 'fatigueStrain.applicabilityZeroMean' : 'fatigueStrain.applicabilityPaired';
}
/** True when the document holds exactly the input of this draft (compared through the same reader output). */
export function fatigueStrainDraftIsSaved(session: FatigueStrainSession, documentId: string,
  saved: FatigueStrainSavedConfiguration | null): boolean {
  const checked = fatigueStrainSaved(session, documentId);
  return checked.ok && saved !== null && JSON.stringify(checked.saved) === JSON.stringify(saved);
}
