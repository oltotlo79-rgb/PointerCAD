import { axialFatigueHistory, FATIGUE_GOODMAN_SCHEMA, FATIGUE_INPUT_SCHEMA, MAX_FATIGUE_HISTORIES, MAX_FATIGUE_HISTORY_POINTS,
  validateFatigueInput, validateFatigueMeanStressCorrection, type FatigueCorrectedResult, type FatigueCorrectionErrorCode,
  type FatigueMeanStressCorrection,
  type AxialFatigueErrorCode, type AxialFatigueProvenance, type BeamTransientResult, type FatigueErrorCode, type FatigueInput,
  type FatigueMeanStressAssumption, type FatigueResult, type FatigueSequence, type FatigueStressDefinition,
  type TransientAxialResponse, FATIGUE_PROPORTIONAL_TENSOR_METHOD, FATIGUE_PROPORTIONAL_TENSOR_SCHEMA, FATIGUE_TENSOR_COMPONENT_KEYS,
  FATIGUE_TENSOR_COMPONENTS, proportionalTensorFatigueInput, type FatigueReferenceTensor, type FatigueTensorComponent,
  type FatigueTensorConversion, type FatigueTensorErrorCode } from '@pointercad/fem';
import { exactExpressionValueFromNumber } from '@pointercad/expression';
import type { Parameter } from '@pointercad/model';
import { FATIGUE_SAVED_GOODMAN_SCHEMA, FATIGUE_SAVED_ID, FATIGUE_SAVED_SCHEMA, type BeamAnalysisInputs, type FatigueSavedAxialSource,
  type FatigueSavedInput, FATIGUE_SAVED_TENSOR_SCHEMA, type FatigueSavedTensorProblem,
  type FatigueTensorSavedInput } from '@pointercad/model/beam-analysis';
import type { FatiguePiecewiseResult } from '@pointercad/fem';
import type { FatiguePiecewiseSavedInput, FatigueSavedPiecewiseProblem } from '@pointercad/model/beam-analysis';
// Type-only: fatiguePiecewiseDraft.ts imports this module's values, so a value import here would be a load-time cycle.
import type { FatiguePiecewiseDraft } from './fatiguePiecewiseDraft.js';
import type { FatigueSolidSavedInput } from '@pointercad/model/beam-analysis';
import type { FatigueSolidBinding, FatigueSolidAnalyzed } from './fatigueSolidSession.js';
import { t, type MessageKey } from '../i18n/t.js';
import { readFatigueField, type FatigueFieldName } from '../beam/beamFields.js';
import type { BeamSourceSnapshot } from '../beam/beamSource.js';

/** A history imported from the member-mean axial stress of a transient beam result: the exact adapter provenance and
 * the exact imported stresses. While it is set, the stress list and the condition are read-only (they are what the
 * provenance describes); detaching turns the row into an ordinary manual history. */
export interface FatigueImportedHistory {
  readonly provenance: AxialFatigueProvenance;
  readonly stressMpa: readonly number[];
}
/** The accepted transient result of the beam panel with its matched axial measure, kept after the beam panel closes.
 * `reviewed` is the CAD source the beam run used; an import is refused once it is no longer current. */
export interface FatigueAxialSource {
  readonly ownerId: string;
  readonly reviewed: BeamSourceSnapshot;
  readonly result: BeamTransientResult;
  readonly axial: TransientAxialResponse;
}
/** The import form; nothing is preselected. Editing it changes no input (no revision, the result stays). */
export interface FatigueAxialImportDraft {
  readonly memberId: string;
  readonly sequence: FatigueSequence | '';
  readonly repeats: string;
  readonly reference: string;
}

/** Curve values; every one starts empty so that no strength is assumed for any material. */
export type FatigueValueField = Exclude<FatigueFieldName, 'repeats'>;
export interface FatigueSourceDraft { readonly reference: string; readonly condition: string }
export type FatigueCorrectionField = 'ultimateTensileStrengthMpa' | 'yieldStrengthMpa' | 'minimumCycles';
export interface FatigueCorrectionDraft {
  readonly mode: 'none' | 'goodman';
  readonly values: Readonly<Record<FatigueCorrectionField, string>>;
  readonly elasticSymmetricYield: boolean;
  readonly source: FatigueSourceDraft;
}
export interface FatigueHistoryDraft {
  /** Stable row key, saved as the history id. */
  readonly key: string;
  /** Ordered stresses in MPa (tension positive), separated by commas, semicolons, spaces or new lines. */
  readonly stress: string;
  readonly sequence: FatigueSequence | '';
  /** Used only for a repeated history; a history applied once is counted once. */
  readonly repeats: string;
  readonly source: FatigueSourceDraft;
  readonly imported: FatigueImportedHistory | null;
}
/** How the histories give their stresses: the one-direction stress list (the existing input), or one reference stress
 * tensor times signed load factors (proportional loading, converted by the core to the signed von Mises equivalent). */
export type FatigueInputMode = 'stress' | 'proportional-tensor' | 'piecewise' | 'solid-proportional';
/** One history's tensor input as typed: the six reference components (MPa) and the ordered signed load factors. */
export interface FatigueTensorRowDraft {
  readonly components: Readonly<Record<FatigueTensorComponent, string>>;
  readonly loadFactors: string;
}
/** The exact proportional-tensor input handed to the core (curve, ids, sequence, repeats and sources read exactly as for
 * the stress input). */
export interface FatigueTensorProblem {
  readonly schema: typeof FATIGUE_PROPORTIONAL_TENSOR_SCHEMA;
  readonly method: typeof FATIGUE_PROPORTIONAL_TENSOR_METHOD;
  readonly curve: FatigueInput['curve'];
  readonly histories: readonly FatigueTensorProblemHistory[];
}
export interface FatigueTensorProblemHistory {
  readonly id: string;
  readonly reference: FatigueReferenceTensor;
  readonly loadFactors: readonly number[];
  readonly sequence: FatigueSequence;
  readonly repeats: number;
  readonly source: FatigueInput['curve']['source'];
}
/** The tensor input of a tensor-mode result and the core's conversion of each reference (shown with the result). */
export interface FatigueTensorAnalyzed {
  readonly problem: FatigueTensorProblem;
  readonly conversions: readonly FatigueTensorConversion[];
}
export interface FatigueDraft {
  readonly correction: FatigueCorrectionDraft;
  readonly values: Readonly<Record<FatigueValueField, string>>;
  /** No default: an unidentified range/amplitude convention is a factor-of-two error. */
  readonly stressDefinition: FatigueStressDefinition | '';
  readonly meanStressAssumption: FatigueMeanStressAssumption | '';
  /** Whether the user's curve has a cut-off stress; must be chosen explicitly. */
  readonly cutoffMode: 'none' | 'value' | '';
  readonly curveSource: FatigueSourceDraft;
  readonly nextHistory: number;
  readonly histories: readonly FatigueHistoryDraft[];
  readonly axialImport: FatigueAxialImportDraft;
  /** Explicit stress, tensor, piecewise or same-mesh solid-reference mode; only authored inputs are saved. */
  readonly inputMode: FatigueInputMode;
  /** Tensor inputs by history key; a history without an entry has every tensor field empty (nothing is assumed). */
  readonly tensors: Readonly<Record<string, FatigueTensorRowDraft>>;
  /** The user's piecewise S-N calibration of the 'piecewise' mode (stress-list histories, fatiguePiecewiseSession.ts);
   * absent until that mode is first chosen. */
  readonly piecewise?: FatiguePiecewiseDraft;
  readonly solid?: FatigueSolidBinding;
  readonly solidElement?: string;
  readonly solidCurveId?: string;
}
export interface FatigueSession {
  readonly ownerId: string;
  /** Increases on every input edit. */
  readonly revision: number;
  readonly draft: FatigueDraft;
  readonly focusedField: string | null;
  /** The exact input that produced the result. The result is shown only while the current draft and parameters still
   * build this input, so a parameter change through Undo or the parameter table cannot keep an old result current. */
  readonly analyzed: ({ readonly input: FatigueInput; readonly result: FatigueResult; readonly correction?: never;
      readonly tensor?: FatigueTensorAnalyzed }
    | { readonly input: FatigueInput; readonly result: FatigueCorrectedResult; readonly correction: FatigueMeanStressCorrection;
      readonly tensor?: never }) | null;
  readonly errorKey: MessageKey | null;
  readonly diagnostic: string | null;
  /** The piecewise input and the core result it produced (the 'piecewise' mode); cleared by every input edit, never saved. */
  readonly piecewiseAnalyzed?: { readonly problem: FatigueSavedPiecewiseProblem; readonly result: FatiguePiecewiseResult } | null;
  readonly solidAnalyzed?: FatigueSolidAnalyzed | null;
}
export type FatigueEdit =
  | { readonly kind: 'correction-mode'; readonly value: FatigueCorrectionDraft['mode'] }
  | { readonly kind: 'correction-value'; readonly field: FatigueCorrectionField; readonly source: string }
  | { readonly kind: 'correction-applicability'; readonly value: boolean }
  | { readonly kind: 'correction-source'; readonly field: keyof FatigueSourceDraft; readonly source: string }
  /** null when focus leaves a field, so that a later refusal naming the same field is a change ExpressionField acts on. */
  | { readonly kind: 'focus'; readonly field: string | null }
  | { readonly kind: 'value'; readonly field: FatigueValueField; readonly source: string }
  | { readonly kind: 'stress-definition'; readonly value: FatigueStressDefinition | '' }
  | { readonly kind: 'mean-assumption'; readonly value: FatigueMeanStressAssumption | '' }
  | { readonly kind: 'cutoff-mode'; readonly value: 'none' | 'value' | '' }
  | { readonly kind: 'curve-source'; readonly field: keyof FatigueSourceDraft; readonly source: string }
  | { readonly kind: 'history-add' }
  | { readonly kind: 'history-remove'; readonly index: number }
  | { readonly kind: 'history-stress'; readonly index: number; readonly source: string }
  | { readonly kind: 'history-sequence'; readonly index: number; readonly value: FatigueSequence | '' }
  | { readonly kind: 'history-repeats'; readonly index: number; readonly source: string }
  | { readonly kind: 'history-source'; readonly index: number; readonly field: keyof FatigueSourceDraft; readonly source: string }
  | { readonly kind: 'history-detach'; readonly index: number }
  | { readonly kind: 'history-import'; readonly row: FatigueHistoryDraft; readonly nextHistory: number }
  | { readonly kind: 'axial-member'; readonly memberId: string }
  | { readonly kind: 'axial-sequence'; readonly value: FatigueSequence | '' }
  | { readonly kind: 'axial-repeats'; readonly source: string }
  | { readonly kind: 'axial-reference'; readonly source: string }
  | { readonly kind: 'input-mode'; readonly value: FatigueInputMode }
  | { readonly kind: 'tensor-component'; readonly index: number; readonly component: FatigueTensorComponent; readonly source: string }
  | { readonly kind: 'tensor-factors'; readonly index: number; readonly source: string }
  /** The whole edited piecewise draft (built by fatiguePiecewiseSession.ts editFatigueSessionWithPiecewise). */
  | { readonly kind: 'piecewise-draft'; readonly draft: FatiguePiecewiseDraft };
type AxialFormEdit = Extract<FatigueEdit, { readonly kind: 'axial-member' | 'axial-sequence' | 'axial-repeats' | 'axial-reference' }>;

export const FATIGUE_CURVE_ID = 'curve';
const emptySource = (): FatigueSourceDraft => ({ reference: '', condition: '' });
const emptyCorrection = (): FatigueCorrectionDraft => ({ mode: 'none',
  values: { ultimateTensileStrengthMpa: '', yieldStrengthMpa: '', minimumCycles: '' },
  elasticSymmetricYield: false, source: emptySource() });
const emptyHistory = (key: string): FatigueHistoryDraft =>
  ({ key, stress: '', sequence: '', repeats: '', source: emptySource(), imported: null });
const emptyAxialImport = (): FatigueAxialImportDraft => ({ memberId: '', sequence: '', repeats: '', reference: '' });
const emptyTensorRow = (): FatigueTensorRowDraft =>
  ({ components: { xx: '', yy: '', zz: '', yz: '', xz: '', xy: '' }, loadFactors: '' });
/** The tensor input of the history `key` (every field empty when none was typed). */
export function fatigueTensorRow(draft: FatigueDraft, key: string): FatigueTensorRowDraft {
  const row = Object.hasOwn(draft.tensors, key) ? draft.tensors[key] : undefined;
  return row ?? emptyTensorRow();
}
function editTensor(draft: FatigueDraft, index: number, change: (row: FatigueTensorRowDraft) => FatigueTensorRowDraft): FatigueDraft | null {
  const key = Number.isSafeInteger(index) && index >= 0 ? draft.histories[index]?.key : undefined;
  if (key === undefined) return null;
  return { ...draft, tensors: { ...draft.tensors, [key]: change(fatigueTensorRow(draft, key)) } };
}
const blankHistory = (row: FatigueHistoryDraft): boolean => row.imported === null && row.stress.trim() === ''
  && row.sequence === '' && row.repeats === '' && row.source.reference === '' && row.source.condition === '';

export function createFatigueSession(ownerId: string): FatigueSession {
  return { ownerId, revision: 0, focusedField: null, analyzed: null, errorKey: null, diagnostic: null,
    draft: { correction: emptyCorrection(), values: { referenceStress: '', referenceCycles: '', slope: '', cutoff: '' }, stressDefinition: '',
      meanStressAssumption: '', cutoffMode: '', curveSource: emptySource(), nextHistory: 2,
      histories: [emptyHistory('history-1')], axialImport: emptyAxialImport(), inputMode: 'stress', tensors: {} } };
}

/** The next unused history key, as for an added row. */
export function nextHistoryKey(draft: FatigueDraft): { readonly key: string; readonly nextHistory: number } {
  let number = draft.nextHistory;
  while (draft.histories.some(row => row.key === `history-${number}`)) number += 1;
  return { key: `history-${number}`, nextHistory: number + 1 };
}

function editHistory(draft: FatigueDraft, index: number, change: (row: FatigueHistoryDraft) => FatigueHistoryDraft): FatigueDraft | null {
  if (!Number.isSafeInteger(index) || index < 0 || index >= draft.histories.length) return null;
  return { ...draft, histories: draft.histories.map((row, position) => position === index ? change(row) : row) };
}

function isImported(draft: FatigueDraft, index: number): boolean {
  const row = draft.histories.at(index);
  return Number.isSafeInteger(index) && index >= 0 && row !== undefined && row.imported !== null;
}

function nextAxialImport(form: FatigueAxialImportDraft, edit: AxialFormEdit): FatigueAxialImportDraft {
  switch (edit.kind) {
    case 'axial-member': return { ...form, memberId: edit.memberId };
    case 'axial-sequence': return { ...form, sequence: edit.value };
    case 'axial-repeats': return { ...form, repeats: edit.source };
    case 'axial-reference': return { ...form, reference: edit.source };
    default: {
      const exhaustiveCheck: never = edit;
      return exhaustiveCheck;
    }
  }
}

function nextDraft(draft: FatigueDraft, edit: Exclude<FatigueEdit, { readonly kind: 'focus' } | AxialFormEdit>): FatigueDraft | null {
  switch (edit.kind) {
    case 'correction-mode': return { ...draft, correction: { ...draft.correction, mode: edit.value } };
    case 'correction-value': return { ...draft, correction: { ...draft.correction,
      values: { ...draft.correction.values, [edit.field]: edit.source } } };
    case 'correction-applicability': return { ...draft, correction: { ...draft.correction, elasticSymmetricYield: edit.value } };
    case 'correction-source': return { ...draft, correction: { ...draft.correction,
      source: { ...draft.correction.source, [edit.field]: edit.source } } };
    case 'value': return { ...draft, values: { ...draft.values, [edit.field]: edit.source } };
    case 'stress-definition': return { ...draft, stressDefinition: edit.value };
    case 'mean-assumption': return { ...draft, meanStressAssumption: edit.value };
    case 'cutoff-mode': return { ...draft, cutoffMode: edit.value };
    case 'curve-source': return { ...draft, curveSource: { ...draft.curveSource, [edit.field]: edit.source } };
    case 'history-add': {
      if (draft.histories.length >= MAX_FATIGUE_HISTORIES) return null;
      let number = draft.nextHistory;
      while (draft.histories.some(row => row.key === `history-${number}`)) number += 1;
      return { ...draft, nextHistory: number + 1, histories: [...draft.histories, emptyHistory(`history-${number}`)] };
    }
    case 'history-remove':
      if (draft.histories.length <= 1 || !Number.isSafeInteger(edit.index) || edit.index < 0
        || edit.index >= draft.histories.length) return null;
      return { ...draft, histories: draft.histories.filter((_, index) => index !== edit.index) };
    case 'history-stress':
      // An imported series is exactly what its provenance describes; detach it first to type values by hand.
      if (isImported(draft, edit.index)) return null;
      return editHistory(draft, edit.index, row => ({ ...row, stress: edit.source }));
    case 'history-sequence': return editHistory(draft, edit.index, row => ({ ...row, sequence: edit.value }));
    case 'history-repeats': return editHistory(draft, edit.index, row => ({ ...row, repeats: edit.source }));
    case 'history-source':
      if (edit.field === 'condition' && isImported(draft, edit.index)) return null;
      return editHistory(draft, edit.index, row => ({ ...row, source: { ...row.source, [edit.field]: edit.source } }));
    case 'history-detach':
      if (!isImported(draft, edit.index)) return null;
      return editHistory(draft, edit.index, row => ({ ...row, imported: null }));
    case 'history-import': {
      // The single untouched starting row is replaced; otherwise the imported history is added at the end.
      const only = draft.histories[0];
      const replace = draft.histories.length === 1 && only !== undefined && blankHistory(only);
      if ((!replace && draft.histories.length >= MAX_FATIGUE_HISTORIES) || edit.row.imported === null
        || draft.histories.some(row => row.key === edit.row.key)) return null;
      return { ...draft, nextHistory: Math.max(draft.nextHistory, edit.nextHistory),
        histories: replace ? [edit.row] : [...draft.histories, edit.row] };
    }
    case 'input-mode': return edit.value === draft.inputMode ? null : { ...draft, inputMode: edit.value };
    case 'tensor-component': return editTensor(draft, edit.index, row => ({ ...row,
      components: { ...row.components, [edit.component]: edit.source } }));
    case 'tensor-factors': return editTensor(draft, edit.index, row => ({ ...row, loadFactors: edit.source }));
    case 'piecewise-draft': return { ...draft, piecewise: edit.draft };
    default: {
      const exhaustiveCheck: never = edit;
      return exhaustiveCheck;
    }
  }
}

/** Any input edit discards the result and moves to a new revision; focus is view-only; a refused edit changes nothing. */
export function editFatigueSession(session: FatigueSession, edit: FatigueEdit): FatigueSession {
  if (edit.kind === 'focus') return { ...session, focusedField: edit.field };
  if (edit.kind === 'axial-member' || edit.kind === 'axial-sequence' || edit.kind === 'axial-repeats'
    || edit.kind === 'axial-reference') {
    // The import form is not an analysis input: the result stays until something is actually imported.
    return { ...session, draft: { ...session.draft, axialImport: nextAxialImport(session.draft.axialImport, edit) } };
  }
  const draft = nextDraft(session.draft, edit);
  if (draft === null) return session;
  const added = draft.histories.length - 1;
  const focusedField = edit.kind !== 'history-add' ? session.focusedField
    : draft.inputMode === 'proportional-tensor' ? `tensor:${added}:xx` : `history:${added}:stress`;
  return { ...session, draft, focusedField, revision: session.revision + 1, analyzed: null, piecewiseAnalyzed: null, solidAnalyzed: null, errorKey: null,
    diagnostic: null };
}

/** A plain decimal number with an optional exponent (no units, no expressions: the list is a measured or computed record). */
const STRESS_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
export type StressListCheck = { readonly ok: true; readonly values: readonly number[] }
  | { readonly ok: false; readonly point: number | null };
/** Reads the ordered stress list. `point` is the 1-based position of the first unreadable entry, or null for an empty or
 * oversized list. The order of the entries is never changed. */
export function parseStressList(source: string): StressListCheck {
  const tokens = source.split(/[\s,;]+/u).filter(token => token !== '');
  if (tokens.length === 0 || tokens.length > MAX_FATIGUE_HISTORY_POINTS) return { ok: false, point: null };
  const values: number[] = [];
  for (const [index, token] of tokens.entries()) {
    const value = Number(token);
    if (!STRESS_NUMBER.test(token) || !Number.isFinite(value)) return { ok: false, point: index + 1 };
    values.push(value === 0 ? 0 : value);
  }
  return { ok: true, values };
}

export type FatigueDraftCheck = { readonly ok: true; readonly input: FatigueInput }
  | { readonly ok: false; readonly key: MessageKey; readonly field: string | null; readonly diagnostic: string | null };
const refuse = (key: MessageKey, field: string | null, diagnostic: string | null = null): Extract<FatigueDraftCheck, { readonly ok: false }> =>
  ({ ok: false, key, field, diagnostic });

/** Every refusal of the core reader has its own plain message. */
export const FATIGUE_ERROR_KEYS: Readonly<Record<FatigueErrorCode, MessageKey>> = {
  'fatigue-shape': 'fatigue.error.shape', 'fatigue-schema': 'fatigue.error.shape', 'fatigue-id': 'fatigue.error.shape',
  'fatigue-unit': 'fatigue.error.shape', 'fatigue-number': 'fatigue.error.number', 'fatigue-bound': 'fatigue.error.bound',
  'fatigue-history': 'fatigue.error.historyLength', 'fatigue-curve-convention': 'fatigue.error.stressDefinition',
  'fatigue-mean-assumption': 'fatigue.error.meanAssumption', 'fatigue-sequence': 'fatigue.error.sequence',
  'fatigue-repeats': 'fatigue.error.repeats', 'fatigue-source': 'fatigue.error.source', 'fatigue-mean': 'fatigue.error.mean',
  'fatigue-overflow': 'fatigue.error.overflow',
};
const CURVE_FIELDS: Readonly<Record<string, string>> = {
  referenceStressMpa: 'referenceStress', referenceCycles: 'referenceCycles', slope: 'slope', cutoffStressMpa: 'cutoff',
  stressDefinition: 'stressDefinition', meanStressAssumption: 'meanStressAssumption', source: 'curve:reference',
};
const HISTORY_FIELDS: Readonly<Record<string, string>> = {
  stressMpa: 'stress', cycles: 'stress', sequence: 'sequence', repeats: 'repeats', source: 'reference',
};
/** The panel field of a core refusal path, and the stress position when the path names one. */
export function fatigueErrorField(path: string): { readonly field: string | null; readonly point: number | null } {
  const correction = /^correction\.([A-Za-z]+)(?:\.([A-Za-z]+))?/u.exec(path);
  if (correction !== null) return { field: correction[1] === 'source' ? `correction:${correction[2] ?? 'reference'}`
    : `correction:${correction[1]}`, point: null };
  const curve = /^curve\.([A-Za-z]+)/u.exec(path);
  if (curve !== null) return { field: CURVE_FIELDS[curve[1] ?? ''] ?? null, point: null };
  const history = /^histories\[(\d+)\](?:\.([A-Za-z]+)(?:\[(\d+)\])?)?/u.exec(path);
  if (history === null) return { field: null, point: null };
  const name = HISTORY_FIELDS[history[2] ?? 'stressMpa'] ?? 'stress';
  const point = history[2] === 'stressMpa' && history[3] !== undefined ? Number(history[3]) + 1 : null;
  return { field: `history:${history[1]}:${name}`, point };
}
const CORRECTION_ERROR_KEYS: Readonly<Record<FatigueCorrectionErrorCode, MessageKey>> = {
  'fatigue-correction-schema': 'fatigue.error.correction', 'fatigue-correction-method': 'fatigue.error.correction',
  'fatigue-correction-strength': 'fatigue.error.correctionStrength', 'fatigue-correction-curve': 'fatigue.error.correctionCurve',
  'fatigue-correction-domain': 'fatigue.error.correctionDomain',
};
export function fatigueRefusal(code: FatigueErrorCode | FatigueCorrectionErrorCode, path: string): { readonly key: MessageKey; readonly field: string | null;
  readonly diagnostic: string | null } {
  const { field, point } = fatigueErrorField(path);
  const keys: Readonly<Record<FatigueErrorCode | FatigueCorrectionErrorCode, MessageKey>> = { ...FATIGUE_ERROR_KEYS, ...CORRECTION_ERROR_KEYS };
  return { key: keys[code], field, diagnostic: point === null ? null : t('fatigue.error.point').replace('{point}', String(point)) };
}

export type FatigueCorrectionCheck = { readonly ok: true; readonly correction: FatigueMeanStressCorrection | null }
  | Extract<FatigueDraftCheck, { readonly ok: false }>;
/** The legacy path remains uncorrected. Opting in requires every strength, applicability and source statement. */
export function fatigueCorrection(session: FatigueSession, parameters: readonly Parameter[]): FatigueCorrectionCheck {
  const draft = session.draft.correction;
  if (draft.mode === 'none') return { ok: true, correction: null };
  if (!draft.elasticSymmetricYield) return { ok: false, key: 'fatigue.error.correctionApplicability',
    field: 'correction:applicability', diagnostic: null };
  const values: Record<FatigueCorrectionField, number> = { ultimateTensileStrengthMpa: 0, yieldStrengthMpa: 0, minimumCycles: 0 };
  for (const name of ['ultimateTensileStrengthMpa', 'yieldStrengthMpa', 'minimumCycles'] as const) {
    const read = readFatigueField(name === 'minimumCycles' ? 'referenceCycles' : 'referenceStress',
      `correction:${name}`, draft.values[name], parameters);
    if (read.value === null) return { ok: false, key: 'fatigue.error.field', field: `correction:${name}`,
      diagnostic: read.error?.message ?? null };
    values[name] = read.value.value;
  }
  const provenance = source(draft.source, 'correction:');
  if ('ok' in provenance) return provenance;
  const checked = validateFatigueMeanStressCorrection({ schema: FATIGUE_GOODMAN_SCHEMA, method: 'goodman-tension-only/1',
    unit: 'MPa', applicability: 'uniaxial-elastic-symmetric-yield', ...values, source: provenance });
  if (!checked.ok) return { ok: false, ...fatigueRefusal(checked.code, checked.path) };
  if (session.draft.meanStressAssumption !== 'fully-reversed-only') {
    return { ok: false, key: 'fatigue.error.correctionCurve', field: 'meanStressAssumption', diagnostic: null };
  }
  return { ok: true, correction: checked.correction };
}

export function sameFatigueCorrection(left: FatigueMeanStressCorrection | null, right: FatigueMeanStressCorrection | null): boolean {
  if (left === null || right === null) return left === right;
  return left.schema === right.schema && left.method === right.method && left.unit === right.unit
    && left.applicability === right.applicability && left.ultimateTensileStrengthMpa === right.ultimateTensileStrengthMpa
    && left.yieldStrengthMpa === right.yieldStrengthMpa && left.minimumCycles === right.minimumCycles
    && left.source.kind === right.source.kind && left.source.reference === right.source.reference
    && left.source.condition === right.source.condition;
}

function curveNumber(name: FatigueValueField, source: string, parameters: readonly Parameter[]): number | FatigueRefusal {
  const read = readFatigueField(name, name, source, parameters);
  if (read.value === null) return refuse('fatigue.error.field', name, read.error?.message ?? null);
  return read.value.value;
}
function source(draft: FatigueSourceDraft, field: string): { readonly kind: 'user-supplied'; readonly reference: string;
  readonly condition: string } | Extract<FatigueDraftCheck, { readonly ok: false }> {
  const reference = draft.reference.trim(), condition = draft.condition.trim();
  if (reference === '') return refuse('fatigue.error.source', `${field}reference`);
  if (condition === '') return refuse('fatigue.error.source', `${field}condition`);
  return { kind: 'user-supplied', reference, condition };
}

type FatigueRefusal = Extract<FatigueDraftCheck, { readonly ok: false }>;
/** The curve of the draft, each missing choice or value refused at its own field in the panel's order. */
export function fatigueCurve(draft: FatigueDraft, parameters: readonly Parameter[]): FatigueInput['curve'] | FatigueRefusal {
  if (draft.stressDefinition === '') return refuse('fatigue.error.stressDefinition', 'stressDefinition');
  if (draft.meanStressAssumption === '') return refuse('fatigue.error.meanAssumption', 'meanStressAssumption');
  const referenceStressMpa = curveNumber('referenceStress', draft.values.referenceStress, parameters);
  if (typeof referenceStressMpa !== 'number') return referenceStressMpa;
  const referenceCycles = curveNumber('referenceCycles', draft.values.referenceCycles, parameters);
  if (typeof referenceCycles !== 'number') return referenceCycles;
  const slope = curveNumber('slope', draft.values.slope, parameters);
  if (typeof slope !== 'number') return slope;
  if (draft.cutoffMode === '') return refuse('fatigue.error.cutoffMode', 'cutoffMode');
  let cutoffStressMpa: number | null = null;
  if (draft.cutoffMode === 'value') {
    const cutoff = curveNumber('cutoff', draft.values.cutoff, parameters);
    if (typeof cutoff !== 'number') return cutoff;
    cutoffStressMpa = cutoff;
  }
  const curveSource = source(draft.curveSource, 'curve:');
  if ('ok' in curveSource) return curveSource;
  return { id: FATIGUE_CURVE_ID, unit: 'MPa', stressDefinition: draft.stressDefinition,
    meanStressAssumption: draft.meanStressAssumption, referenceStressMpa, referenceCycles, slope, cutoffStressMpa, source: curveSource };
}
/** Sequence, repeats and source of a history row, refused at the row's own fields (read after its stresses). */
export function historyUse(row: FatigueHistoryDraft, index: number, parameters: readonly Parameter[]):
  Pick<FatigueInput['histories'][number], 'sequence' | 'repeats' | 'source'> | FatigueRefusal {
  if (row.sequence === '') return refuse('fatigue.error.sequence', `history:${index}:sequence`);
  let repeats = 1;
  if (row.sequence === 'repeated-periodic') {
    const read = readFatigueField('repeats', `history:${index}:repeats`, row.repeats, parameters);
    if (read.value === null) return refuse('fatigue.error.field', `history:${index}:repeats`, read.error?.message ?? null);
    repeats = read.value.value;
  }
  const historySource = source(row.source, `history:${index}:`);
  if ('ok' in historySource) return historySource;
  return { sequence: row.sequence, repeats, source: historySource };
}

/** The draft's stress histories as core input rows, each refusal at its own row field. Shared by the single-slope and
 * the piecewise modes so that the history reading exists once. */
export function fatigueStressHistories(draft: FatigueDraft, parameters: readonly Parameter[]):
  { readonly ok: true; readonly histories: readonly FatigueInput['histories'][number][] } | FatigueRefusal {
  const histories: FatigueInput['histories'][number][] = [];
  for (const [index, row] of draft.histories.entries()) {
    // An imported history uses the exact imported doubles, not a re-reading of its displayed text.
    const stress: StressListCheck = row.imported === null ? parseStressList(row.stress)
      : { ok: true, values: row.imported.stressMpa };
    if (!stress.ok) {
      return refuse(stress.point === null ? 'fatigue.error.historyLength' : 'fatigue.error.stressEntry', `history:${index}:stress`,
        stress.point === null ? null : t('fatigue.error.point').replace('{point}', String(stress.point)));
    }
    const use = historyUse(row, index, parameters);
    if ('ok' in use) return use;
    histories.push({ id: row.key, unit: 'MPa', stressMpa: stress.values, ...use });
  }
  return { ok: true, histories };
}

/** Builds and strictly validates the core input from the draft (stresses in MPa, no unit conversion). */
export function fatigueInput(session: FatigueSession, parameters: readonly Parameter[]): FatigueDraftCheck {
  const draft = session.draft;
  const curve = fatigueCurve(draft, parameters);
  if ('ok' in curve) return curve;
  const built = fatigueStressHistories(draft, parameters);
  if (!built.ok) return built;
  const histories = built.histories;
  const checked = validateFatigueInput({ schema: FATIGUE_INPUT_SCHEMA, curve, histories });
  if (!checked.ok) return { ok: false, ...fatigueRefusal(checked.code, checked.path) };
  return { ok: true, input: checked.input };
}

/** Every refusal of the tensor conversion has its own plain message (the input form never builds the first five). */
export const TENSOR_ERROR_KEYS: Readonly<Record<FatigueTensorErrorCode, MessageKey>> = {
  'fatigue-tensor-shape': 'fatigue.error.shape', 'fatigue-tensor-schema': 'fatigue.error.shape',
  'fatigue-tensor-method': 'fatigue.error.shape', 'fatigue-tensor-unit': 'fatigue.error.shape',
  'fatigue-tensor-convention': 'fatigue.error.shape', 'fatigue-tensor-number': 'fatigue.error.tensorComponent',
  'fatigue-tensor-bound': 'fatigue.error.tensorBound', 'fatigue-tensor-history': 'fatigue.error.tensorFactorsLength',
  'fatigue-tensor-zero-reference': 'fatigue.error.tensorZero', 'fatigue-tensor-hydrostatic': 'fatigue.error.tensorHydrostatic',
  'fatigue-tensor-underflow': 'fatigue.error.tensorUnderflow',
};
const pointText = (point: number | null): string | null =>
  point === null ? null : t('fatigue.error.point').replace('{point}', String(point));
/** The panel field of a tensor refusal path (a whole-reference refusal is shown at the first component), and the
 * 1-based factor position when the path names one. */
export function fatigueTensorErrorField(path: string): { readonly field: string | null; readonly point: number | null } {
  const match = /^histories\[(\d+)\]\.(reference|loadFactors)(?:\.([a-z]+)|\[(\d+)\])?$/u.exec(path);
  if (match === null) return { field: null, point: null };
  const index = match[1] ?? '', component = match[3], factor = match[4];
  if (match[2] === 'loadFactors') return { field: `tensor:${index}:factors`, point: factor === undefined ? null : Number(factor) + 1 };
  const name = FATIGUE_TENSOR_COMPONENT_KEYS.find(key => key === component) ?? 'xx';
  return { field: `tensor:${index}:${name}`, point: null };
}
const isTensorCode = (code: FatigueTensorErrorCode | FatigueErrorCode): code is FatigueTensorErrorCode =>
  Object.hasOwn(TENSOR_ERROR_KEYS, code);
/** A refusal of the tensor input or analysis: a tensor code at its tensor field, or a scalar code of the converted input,
 * whose stresses are the factors of that history row. */
export function fatigueTensorAnalysisRefusal(code: FatigueTensorErrorCode | FatigueErrorCode, path: string):
  { readonly key: MessageKey; readonly field: string | null; readonly diagnostic: string | null } {
  if (isTensorCode(code)) {
    const { field, point } = fatigueTensorErrorField(path);
    const key: MessageKey = code === 'fatigue-tensor-number' && field?.endsWith(':factors') === true
      ? 'fatigue.error.tensorFactors' : TENSOR_ERROR_KEYS[code];
    return { key, field, diagnostic: pointText(point) };
  }
  const refusal = fatigueRefusal(code, path);
  const stress = /^history:(\d+):stress$/u.exec(refusal.field ?? '');
  return stress === null ? refusal : { ...refusal, field: `tensor:${stress[1] ?? ''}:factors` };
}
function tensorComponent(tensor: FatigueTensorRowDraft, key: FatigueTensorComponent, index: number): number | FatigueRefusal {
  // Exactly one plain number (MPa); an empty component is refused, never read as zero.
  const read = parseStressList(tensor.components[key]);
  const value = read.ok && read.values.length === 1 ? read.values[0] : undefined;
  return value === undefined ? refuse('fatigue.error.tensorComponent', `tensor:${index}:${key}`) : value;
}
function tensorReference(tensor: FatigueTensorRowDraft, index: number): FatigueReferenceTensor | FatigueRefusal {
  const xx = tensorComponent(tensor, 'xx', index);
  if (typeof xx !== 'number') return xx;
  const yy = tensorComponent(tensor, 'yy', index);
  if (typeof yy !== 'number') return yy;
  const zz = tensorComponent(tensor, 'zz', index);
  if (typeof zz !== 'number') return zz;
  const yz = tensorComponent(tensor, 'yz', index);
  if (typeof yz !== 'number') return yz;
  const xz = tensorComponent(tensor, 'xz', index);
  if (typeof xz !== 'number') return xz;
  const xy = tensorComponent(tensor, 'xy', index);
  if (typeof xy !== 'number') return xy;
  return { unit: 'MPa', components: FATIGUE_TENSOR_COMPONENTS, xx, yy, zz, yz, xz, xy };
}
export type FatigueTensorDraftCheck = { readonly ok: true; readonly input: FatigueInput; readonly problem: FatigueTensorProblem;
  readonly conversions: readonly FatigueTensorConversion[] } | FatigueRefusal;
/** Builds the proportional-tensor input from the draft (curve, sequence, repeats and sources read exactly as for the
 * stress input), converts it with the core (exact tensor codes and paths) and validates the converted stress input
 * with the core reader (exact scalar codes and paths). The Goodman correction is uniaxial only and is refused here. */
export function fatigueTensorInput(session: FatigueSession, parameters: readonly Parameter[]): FatigueTensorDraftCheck {
  const draft = session.draft;
  const curve = fatigueCurve(draft, parameters);
  if ('ok' in curve) return curve;
  if (draft.correction.mode !== 'none') return refuse('fatigue.error.tensorCorrection', 'correction:mode');
  const histories: FatigueTensorProblemHistory[] = [];
  for (const [index, row] of draft.histories.entries()) {
    // An imported history is a one-direction member stress, not a reference tensor.
    if (row.imported !== null) return refuse('fatigue.error.tensorImported', `history:${index}:reference`);
    const tensor = fatigueTensorRow(draft, row.key);
    const reference = tensorReference(tensor, index);
    if ('ok' in reference) return reference;
    const factors = parseStressList(tensor.loadFactors);
    if (!factors.ok) {
      return refuse(factors.point === null ? 'fatigue.error.tensorFactorsLength' : 'fatigue.error.tensorFactors',
        `tensor:${index}:factors`, pointText(factors.point));
    }
    const use = historyUse(row, index, parameters);
    if ('ok' in use) return use;
    histories.push({ id: row.key, reference, loadFactors: factors.values, ...use });
  }
  const problem: FatigueTensorProblem = { schema: FATIGUE_PROPORTIONAL_TENSOR_SCHEMA, method: FATIGUE_PROPORTIONAL_TENSOR_METHOD,
    curve, histories };
  const converted = proportionalTensorFatigueInput(problem);
  if (!converted.ok) return { ok: false, ...fatigueTensorAnalysisRefusal(converted.code, converted.path) };
  const checked = validateFatigueInput(converted.input);
  if (!checked.ok) return { ok: false, ...fatigueTensorAnalysisRefusal(checked.code, checked.path) };
  return { ok: true, input: checked.input, problem, conversions: converted.conversions };
}
/** Equal references (all six components) and load factors, compared with === (exact for doubles). */
function sameTensorProblem(left: FatigueTensorProblem, right: FatigueTensorProblem): boolean {
  return left.histories.length === right.histories.length && left.histories.every((history, index) => {
    const other = right.histories[index];
    return other !== undefined && FATIGUE_TENSOR_COMPONENT_KEYS.every(key => history.reference[key] === other.reference[key])
      && history.loadFactors.length === other.loadFactors.length
      && history.loadFactors.every((factor, at) => factor === other.loadFactors[at]);
  });
}

/** Field-by-field equality, independent of object key order. Numbers use === (exact for doubles). */
export function sameFatigueInput(left: FatigueInput, right: FatigueInput): boolean {
  const sameSource = (a: FatigueInput['curve']['source'], b: FatigueInput['curve']['source']): boolean =>
    a.kind === b.kind && a.reference === b.reference && a.condition === b.condition;
  const l = left.curve, r = right.curve;
  return left.schema === right.schema && l.id === r.id && l.unit === r.unit && l.stressDefinition === r.stressDefinition
    && l.meanStressAssumption === r.meanStressAssumption && l.referenceStressMpa === r.referenceStressMpa
    && l.referenceCycles === r.referenceCycles && l.slope === r.slope && l.cutoffStressMpa === r.cutoffStressMpa
    && sameSource(l.source, r.source) && left.histories.length === right.histories.length
    && left.histories.every((history, index) => {
      const other = right.histories[index];
      return other !== undefined && history.id === other.id && history.unit === other.unit
        && history.sequence === other.sequence && history.repeats === other.repeats && sameSource(history.source, other.source)
        && history.stressMpa.length === other.stressMpa.length
        && history.stressMpa.every((stress, at) => stress === other.stressMpa[at]);
    });
}

/** The result is shown only for the exact input that produced it (draft and parameters as they are now). A tensor-mode
 * result is current only in the tensor mode, for the same references and factors and the same converted input. */
export function currentFatigueResult(session: FatigueSession, parameters: readonly Parameter[]): FatigueResult | FatigueCorrectedResult | null {
  if (session.draft.inputMode === 'solid-proportional' || session.analyzed === null) return null;
  if (session.draft.inputMode === 'proportional-tensor') {
    const tensor = session.analyzed.tensor;
    const rebuilt = tensor === undefined ? null : fatigueTensorInput(session, parameters);
    return tensor !== undefined && rebuilt !== null && rebuilt.ok && sameFatigueInput(rebuilt.input, session.analyzed.input)
      && sameTensorProblem(rebuilt.problem, tensor.problem) ? session.analyzed.result : null;
  }
  if (session.analyzed.tensor !== undefined) return null;
  const now = fatigueInput(session, parameters);
  const correction = fatigueCorrection(session, parameters);
  return now.ok && correction.ok && sameFatigueInput(now.input, session.analyzed.input)
    && sameFatigueCorrection(correction.correction, session.analyzed.correction ?? null) ? session.analyzed.result : null;
}

export type FatigueSavedCheck = { readonly ok: true; readonly saved: FatigueSavedInput }
  | { readonly ok: false; readonly key: MessageKey; readonly field: string | null; readonly diagnostic: string | null };
/** The configuration to save in the document `documentId`. Only a complete, valid input is saved (never a result). */
export function fatigueSavedInput(session: FatigueSession, parameters: readonly Parameter[], documentId: string): FatigueSavedCheck {
  // Versions 1 to 3 hold one-direction stress histories only; a tensor draft is saved by fatigueSavedEntry as version 4.
  if (session.draft.inputMode !== 'stress') return { ok: false, key: 'fatigue.error.shape', field: 'inputMode', diagnostic: null };
  const checked = fatigueInput(session, parameters);
  if (!checked.ok) return checked;
  const correction = fatigueCorrection(session, parameters);
  if (!correction.ok) return correction;
  const base = { id: FATIGUE_SAVED_ID, source: { documentId }, input: checked.input, axial: axialSources(session.draft) };
  return correction.correction === null ? { ok: true, saved: { ...base, id: FATIGUE_SAVED_ID, schema: FATIGUE_SAVED_SCHEMA } }
    : { ok: true, saved: { ...base, id: FATIGUE_SAVED_ID, schema: FATIGUE_SAVED_GOODMAN_SCHEMA, correction: correction.correction } };
}

/** The provenance of every imported history of the draft, in history order. */
export function axialSources(draft: FatigueDraft): FatigueSavedAxialSource[] {
  return draft.histories.flatMap(row => row.imported === null ? [] : [{ historyId: row.key, provenance: row.imported.provenance }]);
}
/** Field-by-field equality of provenance lists (sample times compared with ===). */
export function sameAxialSources(left: readonly FatigueSavedAxialSource[], right: readonly FatigueSavedAxialSource[]): boolean {
  return left.length === right.length && left.every((source, index) => {
    const other = right[index], a = source.provenance;
    if (other === undefined) return false;
    const b = other.provenance;
    return source.historyId === other.historyId && a.measure === b.measure && a.stress === b.stress && a.excluded === b.excluded
      && a.analysisId === b.analysisId && a.analysisRevision === b.analysisRevision && a.inputSha256 === b.inputSha256
      && a.memberId === b.memberId && a.startNodeId === b.startNodeId && a.endNodeId === b.endNodeId && a.lengthM === b.lengthM
      && a.youngPa === b.youngPa && a.conversion === b.conversion && a.sampleTimesS.length === b.sampleTimesS.length
      && a.sampleTimesS.every((time, at) => time === b.sampleTimesS[at]);
  });
}

/** Every refusal of the axial adapter has its own plain message. */
export const AXIAL_ERROR_KEYS: Readonly<Record<AxialFatigueErrorCode, MessageKey>> = {
  'fatigue-axial-measure': 'fatigue.error.axialMeasure', 'fatigue-axial-times': 'fatigue.error.axialMeasure',
  'fatigue-axial-series': 'fatigue.error.axialMeasure', 'fatigue-axial-member': 'fatigue.error.axialMember',
  'fatigue-axial-binding': 'fatigue.error.axialStale', 'fatigue-axial-selection': 'fatigue.error.axialSelection',
  'fatigue-axial-bound': 'fatigue.error.axialBound', 'fatigue-axial-label': 'fatigue.error.axialReference',
};
export type FatigueImportCheck = { readonly ok: true; readonly session: FatigueSession }
  | { readonly ok: false; readonly key: MessageKey; readonly field: string | null; readonly diagnostic: string | null };

/** Imports the selected member's member-mean axial stress through the core adapter, with the explicit choices of the
 * import form. The caller has already checked that `source` is the current analysis of this document; the adapter
 * additionally refuses a measure that does not belong to `source.result`. */
export function importAxialHistory(session: FatigueSession, source: Pick<FatigueAxialSource, 'result' | 'axial'>,
  parameters: readonly Parameter[]): FatigueImportCheck {
  const form = session.draft.axialImport;
  if (form.memberId === '') return { ok: false, key: 'fatigue.error.axialMember', field: 'axial:member', diagnostic: null };
  if (form.sequence === '') return { ok: false, key: 'fatigue.error.sequence', field: 'axial:sequence', diagnostic: null };
  let repeats = 1;
  if (form.sequence === 'repeated-periodic') {
    const read = readFatigueField('repeats', 'axial:repeats', form.repeats, parameters);
    if (read.value === null) return { ok: false, key: 'fatigue.error.field', field: 'axial:repeats', diagnostic: read.error?.message ?? null };
    repeats = read.value.value;
  }
  const { key, nextHistory } = nextHistoryKey(session.draft);
  const outcome = axialFatigueHistory(source.axial, source.result,
    { memberId: form.memberId, historyId: key, sequence: form.sequence, repeats, reference: form.reference.trim() });
  if (!outcome.ok) {
    const field = outcome.path.startsWith('selection.repeats') ? 'axial:repeats'
      : outcome.path.startsWith('selection.reference') ? 'axial:reference' : 'axial:member';
    return { ok: false, key: AXIAL_ERROR_KEYS[outcome.code], field, diagnostic: null };
  }
  const row: FatigueHistoryDraft = { key, stress: outcome.history.stressMpa.map(String).join(', '), sequence: outcome.history.sequence,
    repeats: form.sequence === 'repeated-periodic' ? form.repeats : '',
    source: { reference: outcome.history.source.reference, condition: outcome.history.source.condition },
    imported: { provenance: outcome.provenance, stressMpa: outcome.history.stressMpa } };
  const next = editFatigueSession(session, { kind: 'history-import', row, nextHistory });
  if (next === session) return { ok: false, key: 'fatigue.error.historyLength', field: 'axial:member', diagnostic: null };
  return { ok: true, session: { ...next, draft: { ...next.draft, axialImport: emptyAxialImport() } } };
}

/** Restores a saved configuration. Curve values use the exact (non-exponent) number form so that every field evaluates
 * back to the saved double; stresses use the shortest round-trip form. No result is restored. */
export function restoreFatigueSession(ownerId: string, saved: FatigueSavedInput): FatigueSession {
  const exact = (value: number): string => exactExpressionValueFromNumber(value).source;
  const { curve, histories } = saved.input;
  const imported = new Map(saved.axial.map(source => [source.historyId, source.provenance]));
  let next = histories.length + 1;
  while (histories.some(history => history.id === `history-${next}`)) next += 1;
  return { ...createFatigueSession(ownerId), draft: {
    correction: saved.schema === FATIGUE_SAVED_GOODMAN_SCHEMA ? { mode: 'goodman', elasticSymmetricYield: true,
      values: { ultimateTensileStrengthMpa: exact(saved.correction.ultimateTensileStrengthMpa),
        yieldStrengthMpa: exact(saved.correction.yieldStrengthMpa), minimumCycles: exact(saved.correction.minimumCycles) },
      source: { reference: saved.correction.source.reference, condition: saved.correction.source.condition } } : emptyCorrection(),
    values: { referenceStress: exact(curve.referenceStressMpa), referenceCycles: exact(curve.referenceCycles),
      slope: exact(curve.slope), cutoff: curve.cutoffStressMpa === null ? '' : exact(curve.cutoffStressMpa) },
    stressDefinition: curve.stressDefinition, meanStressAssumption: curve.meanStressAssumption,
    cutoffMode: curve.cutoffStressMpa === null ? 'none' : 'value',
    curveSource: { reference: curve.source.reference, condition: curve.source.condition }, nextHistory: next,
    histories: histories.map(history => {
      const provenance = imported.get(history.id);
      return { key: history.id, stress: history.stressMpa.map(String).join(', '),
        sequence: history.sequence, repeats: history.sequence === 'once' ? '' : exact(history.repeats),
        source: { reference: history.source.reference, condition: history.source.condition },
        imported: provenance === undefined ? null : { provenance, stressMpa: history.stressMpa } };
    }), axialImport: emptyAxialImport(), inputMode: 'stress', tensors: {} } };
}

/** The saved configuration of a document, or null. The attachment was already validated by the document loader or by
 * withBeamAnalysisInputs. */
export function savedFatigueInput(document: { readonly beamAnalysisInputs?: BeamAnalysisInputs }): FatigueSavedInput | null {
  const saved = document.beamAnalysisInputs?.analyses.find(input => input.kind === 'fatigue');
  return saved?.kind === 'fatigue' ? saved.definition : null;
}

/** True when the current draft is exactly the saved configuration. */
export function fatigueDraftIsSaved(session: FatigueSession, parameters: readonly Parameter[], saved: FatigueSavedInput | null): boolean {
  if (saved === null || session.draft.inputMode !== 'stress') return false;
  const current = fatigueInput(session, parameters);
  const correction = fatigueCorrection(session, parameters);
  return current.ok && correction.ok && sameFatigueInput(current.input, saved.input)
    && sameFatigueCorrection(correction.correction, saved.schema === FATIGUE_SAVED_GOODMAN_SCHEMA ? saved.correction : null)
    && sameAxialSources(axialSources(session.draft), saved.axial);
}

/** The saved fatigue configuration of a document in either form: stress histories (versions 1 to 3, kind 'fatigue') or the
 * proportional tensor input (version 4, kind 'fatigue-proportional-tensor'); a document holds at most one. */
export type FatigueSavedEntry = { readonly kind: 'fatigue'; readonly definition: FatigueSavedInput }
  | { readonly kind: 'fatigue-proportional-tensor'; readonly definition: FatigueTensorSavedInput }
  | { readonly kind: 'fatigue-piecewise'; readonly definition: FatiguePiecewiseSavedInput }
  | { readonly kind: 'fatigue-solid-proportional'; readonly definition: FatigueSolidSavedInput };
export type FatigueSavedEntryCheck = { readonly ok: true; readonly entry: FatigueSavedEntry }
  | { readonly ok: false; readonly key: MessageKey; readonly field: string | null; readonly diagnostic: string | null };

/** The saved form of the current draft in the document `documentId`: inputs, sources and method only, never a result or a
 * converted stress. The tensor mode gives version 4 (no correction exists for it); otherwise the existing stress form. */
export function fatigueSavedEntry(session: FatigueSession, parameters: readonly Parameter[], documentId: string): FatigueSavedEntryCheck {
  if (session.draft.inputMode !== 'proportional-tensor') {
    const checked = fatigueSavedInput(session, parameters, documentId);
    return checked.ok ? { ok: true, entry: { kind: 'fatigue', definition: checked.saved } } : checked;
  }
  const tensor = fatigueTensorInput(session, parameters);
  if (!tensor.ok) return tensor;
  return { ok: true, entry: { kind: 'fatigue-proportional-tensor',
    definition: { schema: FATIGUE_SAVED_TENSOR_SCHEMA, id: FATIGUE_SAVED_ID, source: { documentId }, input: tensor.problem } } };
}

/** The saved fatigue configuration of a document in either form, or null (already validated by the document loader or by
 * withBeamAnalysisInputs). */
export function savedFatigueEntry(document: { readonly beamAnalysisInputs?: BeamAnalysisInputs }): FatigueSavedEntry | null {
  const saved = document.beamAnalysisInputs?.analyses.find(input => input.kind === 'fatigue' || input.kind === 'fatigue-proportional-tensor'
    || input.kind === 'fatigue-piecewise' || input.kind === 'fatigue-solid-proportional');
  return saved?.kind === 'fatigue' || saved?.kind === 'fatigue-proportional-tensor' || saved?.kind === 'fatigue-piecewise' || saved?.kind === 'fatigue-solid-proportional' ? saved : null;
}

/** Equal saved tensor problems: every curve value and source, record id, sequence, repeats and source, every reference
 * component and every load factor (numbers compared with ===, exact for doubles). */
function sameSavedTensorProblem(left: FatigueSavedTensorProblem, right: FatigueSavedTensorProblem): boolean {
  const sameSource = (a: FatigueSavedTensorProblem['curve']['source'], b: FatigueSavedTensorProblem['curve']['source']): boolean =>
    a.kind === b.kind && a.reference === b.reference && a.condition === b.condition;
  const l = left.curve, r = right.curve;
  return left.schema === right.schema && left.method === right.method && l.id === r.id && l.unit === r.unit
    && l.stressDefinition === r.stressDefinition && l.meanStressAssumption === r.meanStressAssumption
    && l.referenceStressMpa === r.referenceStressMpa && l.referenceCycles === r.referenceCycles && l.slope === r.slope
    && l.cutoffStressMpa === r.cutoffStressMpa && sameSource(l.source, r.source) && left.histories.length === right.histories.length
    && left.histories.every((history, index) => {
      const other = right.histories[index];
      return other !== undefined && history.id === other.id && history.sequence === other.sequence
        && history.repeats === other.repeats && sameSource(history.source, other.source)
        && history.reference.unit === other.reference.unit && history.reference.components === other.reference.components
        && FATIGUE_TENSOR_COMPONENT_KEYS.every(key => history.reference[key] === other.reference[key])
        && history.loadFactors.length === other.loadFactors.length
        && history.loadFactors.every((factor, at) => factor === other.loadFactors[at]);
    });
}

/** True when the current draft is exactly the saved configuration of either form. */
export function fatigueEntryIsSaved(session: FatigueSession, parameters: readonly Parameter[], saved: FatigueSavedEntry | null): boolean {
  if (saved === null) return false;
  if (saved.kind === 'fatigue') return fatigueDraftIsSaved(session, parameters, saved.definition);
  // The piecewise comparison is fatiguePiecewiseSession.ts fatigueEntryIsSavedWithPiecewise (it needs the draft module).
  if (saved.kind === 'fatigue-piecewise' || saved.kind === 'fatigue-solid-proportional') return false;
  if (session.draft.inputMode !== 'proportional-tensor') return false;
  const current = fatigueTensorInput(session, parameters);
  return current.ok && sameSavedTensorProblem(current.problem, saved.definition.input);
}

/** Restores a saved proportional tensor configuration in the tensor mode. Curve values use the exact number form of
 * restoreFatigueSession; components and factors the shortest round-trip form, so every field reads back to the saved
 * double. Record ids become the row keys (own keys whatever their text). No result is restored. */
export function restoreTensorFatigueSession(ownerId: string, saved: FatigueTensorSavedInput): FatigueSession {
  const exact = (value: number): string => exactExpressionValueFromNumber(value).source;
  const { curve, histories } = saved.input;
  let next = histories.length + 1;
  while (histories.some(history => history.id === `history-${next}`)) next += 1;
  const empty = createFatigueSession(ownerId);
  return { ...empty, draft: { ...empty.draft,
    values: { referenceStress: exact(curve.referenceStressMpa), referenceCycles: exact(curve.referenceCycles),
      slope: exact(curve.slope), cutoff: curve.cutoffStressMpa === null ? '' : exact(curve.cutoffStressMpa) },
    stressDefinition: curve.stressDefinition, meanStressAssumption: curve.meanStressAssumption,
    cutoffMode: curve.cutoffStressMpa === null ? 'none' : 'value',
    curveSource: { reference: curve.source.reference, condition: curve.source.condition }, nextHistory: next,
    histories: histories.map(history => ({ key: history.id, stress: '', sequence: history.sequence,
      repeats: history.sequence === 'once' ? '' : exact(history.repeats),
      source: { reference: history.source.reference, condition: history.source.condition }, imported: null })),
    inputMode: 'proportional-tensor',
    tensors: Object.fromEntries(histories.map(history => [history.id, {
      components: { xx: String(history.reference.xx), yy: String(history.reference.yy), zz: String(history.reference.zz),
        yz: String(history.reference.yz), xz: String(history.reference.xz), xy: String(history.reference.xy) },
      loadFactors: history.loadFactors.map(String).join(', ') }] as const)) } };
}
