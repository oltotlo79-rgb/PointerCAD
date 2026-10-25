import { analyzeLocalCycle, type LocalCycleResult } from '@pointercad/fem';
import { createFatigueLocalCycleSavedInput, type BeamAnalysisInputs, type FatigueLocalCycleSavedInput,
  type FatigueLocalCycleSavedProblem } from '@pointercad/model/beam-analysis';
import type { MessageKey } from '../i18n/t.js';
import { fatigueStrainNumber } from '../fatigueStrain/fatigueStrainSession.js';

/**
 * Draft of ONE constant-amplitude local cycle with a Morrow or SWT mean-stress correction (a separate document input
 * kind and panel; never mixed with strain histories). Every value is the user's own text: no coefficient, interval,
 * extremum or correction is pre-filled, and no stress is derived from a strain. A result belongs to the draft revision
 * that produced it and is never saved.
 */
export type FatigueLocalCycleCorrection = '' | 'morrow' | 'swt';
export type FatigueLocalCycleDerivation = '' | 'measured' | 'elastic-plastic-analysis';
export const FATIGUE_LOCAL_CYCLE_NUMBER_FIELDS = ['elasticModulusMpa', 'fatigueStrengthCoefficientMpa', 'fatigueStrengthExponent',
  'fatigueDuctilityCoefficient', 'fatigueDuctilityExponent', 'minimumCycles', 'maximumCycles', 'strainMax', 'strainMin',
  'stressMax', 'stressMin'] as const;
export type FatigueLocalCycleNumberField = typeof FATIGUE_LOCAL_CYCLE_NUMBER_FIELDS[number];
export type FatigueLocalCycleTextField = 'materialId' | 'materialReference' | 'materialCondition' | 'cycleReference' | 'cycleCondition';
export interface FatigueLocalCycleDraft extends Readonly<Record<FatigueLocalCycleNumberField | FatigueLocalCycleTextField, string>> {
  readonly correction: FatigueLocalCycleCorrection;
  readonly derivation: FatigueLocalCycleDerivation;
}
export type FatigueLocalCycleEdit =
  | { readonly kind: 'text'; readonly field: FatigueLocalCycleNumberField | FatigueLocalCycleTextField; readonly value: string }
  | { readonly kind: 'correction'; readonly value: FatigueLocalCycleCorrection }
  | { readonly kind: 'derivation'; readonly value: FatigueLocalCycleDerivation };
export interface FatigueLocalCycleRefusal {
  readonly key: MessageKey;
  readonly code: string | null;
  readonly path: string | null;
}
export interface FatigueLocalCycleSession {
  readonly ownerId: string;
  /** Increases on every accepted edit; a result is current only for the revision it was computed from. */
  readonly revision: number;
  readonly draft: FatigueLocalCycleDraft;
  readonly analyzed: { readonly revision: number; readonly problem: FatigueLocalCycleSavedProblem; readonly result: LocalCycleResult } | null;
  readonly refusal: FatigueLocalCycleRefusal | null;
}

export function createFatigueLocalCycleSession(ownerId: string): FatigueLocalCycleSession {
  return { ownerId, revision: 0, analyzed: null, refusal: null, draft: { correction: '', derivation: '', materialId: '',
    elasticModulusMpa: '', fatigueStrengthCoefficientMpa: '', fatigueStrengthExponent: '', fatigueDuctilityCoefficient: '',
    fatigueDuctilityExponent: '', minimumCycles: '', maximumCycles: '', materialReference: '', materialCondition: '',
    strainMax: '', strainMin: '', stressMax: '', stressMin: '', cycleReference: '', cycleCondition: '' } };
}

export function savedFatigueLocalCycleInput(document: { readonly beamAnalysisInputs?: BeamAnalysisInputs }): FatigueLocalCycleSavedInput | null {
  const saved = document.beamAnalysisInputs?.analyses.find(input => input.kind === 'fatigue-local-cycle');
  return saved?.kind === 'fatigue-local-cycle' ? saved.definition : null;
}

/** String(number) is the shortest text that parses back to the same double, so saving a restored draft writes the same values. */
export function restoreFatigueLocalCycleSession(ownerId: string, saved: FatigueLocalCycleSavedInput): FatigueLocalCycleSession {
  const { material, cycle, correction } = saved.input;
  return { ...createFatigueLocalCycleSession(ownerId), draft: { correction, derivation: cycle.derivation, materialId: material.id,
    elasticModulusMpa: String(material.elasticModulusMpa), fatigueStrengthCoefficientMpa: String(material.fatigueStrengthCoefficientMpa),
    fatigueStrengthExponent: String(material.fatigueStrengthExponent), fatigueDuctilityCoefficient: String(material.fatigueDuctilityCoefficient),
    fatigueDuctilityExponent: String(material.fatigueDuctilityExponent), minimumCycles: String(material.calibration.minimumCycles),
    maximumCycles: String(material.calibration.maximumCycles), materialReference: material.source.reference,
    materialCondition: material.source.condition, strainMax: String(cycle.strainMax), strainMin: String(cycle.strainMin),
    stressMax: String(cycle.stressMax), stressMin: String(cycle.stressMin), cycleReference: cycle.source.reference,
    cycleCondition: cycle.source.condition } };
}

function editedDraft(draft: FatigueLocalCycleDraft, edit: FatigueLocalCycleEdit): FatigueLocalCycleDraft {
  switch (edit.kind) {
    case 'text': return { ...draft, [edit.field]: edit.value };
    case 'correction': return { ...draft, correction: edit.value };
    case 'derivation': return { ...draft, derivation: edit.value };
    default: {
      const exhaustiveCheck: never = edit;
      return exhaustiveCheck;
    }
  }
}
/** Every edit starts a new revision and drops the previous result and refusal. */
export function editFatigueLocalCycleSession(session: FatigueLocalCycleSession, edit: FatigueLocalCycleEdit): FatigueLocalCycleSession {
  return { ...session, draft: editedDraft(session.draft, edit), revision: session.revision + 1, analyzed: null, refusal: null };
}

export type FatigueLocalCycleChecked = { readonly ok: true; readonly saved: FatigueLocalCycleSavedInput }
  | { readonly ok: false; readonly refusal: FatigueLocalCycleRefusal };
const refused = (key: MessageKey, path: string | null, code: string | null = null): FatigueLocalCycleChecked =>
  ({ ok: false, refusal: { key, code, path } });

/** The saved input of `documentId` for the draft, validated by the model reader (the same reader as file loading). */
export function fatigueLocalCycleSaved(session: FatigueLocalCycleSession, documentId: string): FatigueLocalCycleChecked {
  const { draft } = session;
  if (draft.correction === '') return refused('fatigueLocalCycle.error.correction', 'correction');
  if (draft.derivation === '') return refused('fatigueLocalCycle.error.derivation', 'cycle.derivation');
  const numbers: Partial<Record<FatigueLocalCycleNumberField, number>> = {};
  for (const field of FATIGUE_LOCAL_CYCLE_NUMBER_FIELDS) {
    const value = fatigueStrainNumber(draft[field]);
    if (value === null) return refused('fatigueLocalCycle.error.number', field);
    numbers[field] = value;
  }
  const problem = { schema: 'pointercad-strain-life-local-cycle/1', correction: draft.correction,
    material: { id: draft.materialId, stressUnit: 'MPa', elasticModulusMpa: numbers.elasticModulusMpa,
      fatigueStrengthCoefficientMpa: numbers.fatigueStrengthCoefficientMpa, fatigueStrengthExponent: numbers.fatigueStrengthExponent,
      fatigueDuctilityCoefficient: numbers.fatigueDuctilityCoefficient, fatigueDuctilityExponent: numbers.fatigueDuctilityExponent,
      calibration: { minimumCycles: numbers.minimumCycles, maximumCycles: numbers.maximumCycles },
      source: { kind: 'user-supplied', reference: draft.materialReference, condition: draft.materialCondition } },
    cycle: { strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', stressUnit: 'MPa', derivation: draft.derivation,
      strainMax: numbers.strainMax, strainMin: numbers.strainMin, stressMax: numbers.stressMax, stressMin: numbers.stressMin,
      source: { kind: 'user-supplied', reference: draft.cycleReference, condition: draft.cycleCondition } } };
  try {
    return { ok: true, saved: createFatigueLocalCycleSavedInput(documentId, problem) };
  } catch (error) {
    // The model reader throws its InputIssue (code and path of the first refused field); anything else is rethrown.
    if (!(error instanceof Error) || !('path' in error) || typeof error.path !== 'string') throw error;
    const code = 'code' in error && typeof error.code === 'string' ? error.code : null;
    return refused('fatigueLocalCycle.error.input', error.path.replace(/^definition\.input\.?/u, ''), code);
  }
}

const ANALYSIS_KEYS: Readonly<Record<string, MessageKey>> = {
  'swt-nonpositive-maximum-stress': 'fatigueLocalCycle.error.swtNonpositive',
  'swt-parameter-underflow': 'fatigueLocalCycle.error.swtUnderflow',
  'strain-life-morrow-domain': 'fatigueLocalCycle.error.morrowDomain',
  'strain-life-shorter-than-calibration': 'fatigueLocalCycle.error.shorter',
  'strain-life-longer-than-calibration': 'fatigueLocalCycle.error.longer',
};
/** Runs the actual local-cycle analysis on the validated input; keeps either this revision's result or the refusal. */
export function runFatigueLocalCycleSession(session: FatigueLocalCycleSession, documentId: string): FatigueLocalCycleSession {
  const checked = fatigueLocalCycleSaved(session, documentId);
  if (!checked.ok) return { ...session, analyzed: null, refusal: checked.refusal };
  const analysis = analyzeLocalCycle(checked.saved.input);
  if (!analysis.ok) {
    return { ...session, analyzed: null, refusal: { key: ANALYSIS_KEYS[analysis.code] ?? 'fatigueLocalCycle.error.analysis',
      code: analysis.code, path: analysis.path } };
  }
  return { ...session, analyzed: { revision: session.revision, problem: checked.saved.input, result: analysis.result }, refusal: null };
}
export function currentFatigueLocalCycleResult(session: FatigueLocalCycleSession): LocalCycleResult | null {
  return session.analyzed !== null && session.analyzed.revision === session.revision ? session.analyzed.result : null;
}
export function fatigueLocalCycleDraftIsSaved(session: FatigueLocalCycleSession, documentId: string,
  saved: FatigueLocalCycleSavedInput | null): boolean {
  const checked = fatigueLocalCycleSaved(session, documentId);
  return checked.ok && saved !== null && JSON.stringify(checked.saved) === JSON.stringify(saved);
}
