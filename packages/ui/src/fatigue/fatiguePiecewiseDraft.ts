import { analyzeFatiguePiecewise, FATIGUE_PIECEWISE_INPUT_SCHEMA, validateFatiguePiecewiseInput, type FatigueInput,
  type FatigueMeanStressAssumption, type FatiguePiecewiseErrorCode, type FatiguePiecewiseResult,
  type FatigueStressDefinition } from '@pointercad/fem';
import { exactExpressionValueFromNumber } from '@pointercad/expression';
import type { Parameter } from '@pointercad/model';
import { FATIGUE_SAVED_ID, FATIGUE_SAVED_PIECEWISE_SCHEMA, type FatiguePiecewiseSavedInput,
  type FatigueSavedPiecewiseProblem } from '@pointercad/model/beam-analysis';
import { t, type MessageKey } from '../i18n/t.js';
import { readFatigueField } from '../beam/beamFields.js';
import { FATIGUE_CURVE_ID, FATIGUE_ERROR_KEYS, fatigueErrorField, type FatigueSourceDraft } from './fatigueSession.js';

/**
 * The piecewise (multi-slope) S-N calibration as typed in the fatigue panel: ordered segment rows (start stress, start
 * cycles, slope), the end of the calibrated cycle range and what applies below it, and the user's applicability
 * statement. The curve's stress definition, mean-stress assumption and source are the panel's existing fields, and the
 * histories are the panel's existing stress histories, so neither the counting nor the saved history form is duplicated.
 * Nothing is prefilled: no grade, detail category or FAT value is assumed. Numbers use the existing expression reader
 * with the same bounds as the core (stress like the reference stress, cycles like the reference cycles, slope like slope).
 */
export type FatiguePiecewiseSegmentField = 'fromStress' | 'fromCycles' | 'slope';
export interface FatiguePiecewiseSegmentDraft {
  /** Stable row key; not saved (the saved segments are an ordered list). */
  readonly key: string;
  readonly fromStress: string;
  readonly fromCycles: string;
  readonly slope: string;
}
export type FatiguePiecewiseApplicabilityField = 'material' | 'detail' | 'scope';
export interface FatiguePiecewiseDraft {
  readonly segments: readonly FatiguePiecewiseSegmentDraft[];
  readonly nextSegment: number;
  readonly endCycles: string;
  /** No default: whether stresses below the end are cut off or refused is the user's statement. */
  readonly end: 'cutoff-at-end' | 'none' | '';
  readonly applicability: Readonly<Record<FatiguePiecewiseApplicabilityField, string>>;
}
export type FatiguePiecewiseEdit =
  | { readonly kind: 'segment-add' }
  | { readonly kind: 'segment-remove'; readonly index: number }
  | { readonly kind: 'segment-value'; readonly index: number; readonly field: FatiguePiecewiseSegmentField; readonly source: string }
  | { readonly kind: 'end-cycles'; readonly source: string }
  | { readonly kind: 'end'; readonly value: FatiguePiecewiseDraft['end'] }
  | { readonly kind: 'applicability'; readonly field: FatiguePiecewiseApplicabilityField; readonly source: string };
/** The curve settings shared with the existing single-slope form. */
export interface FatiguePiecewiseCommon {
  readonly stressDefinition: FatigueStressDefinition | '';
  readonly meanStressAssumption: FatigueMeanStressAssumption | '';
  readonly curveSource: FatigueSourceDraft;
}
export type FatiguePiecewiseCheck = { readonly ok: true; readonly problem: FatigueSavedPiecewiseProblem }
  | { readonly ok: false; readonly key: MessageKey; readonly field: string | null; readonly diagnostic: string | null };
export type FatiguePiecewiseAnalysisCheck = { readonly ok: true; readonly problem: FatigueSavedPiecewiseProblem;
  readonly result: FatiguePiecewiseResult } | Extract<FatiguePiecewiseCheck, { readonly ok: false }>;

const emptySegment = (key: string): FatiguePiecewiseSegmentDraft => ({ key, fromStress: '', fromCycles: '', slope: '' });
export function createPiecewiseDraft(): FatiguePiecewiseDraft {
  return { segments: [emptySegment('segment-1')], nextSegment: 2, endCycles: '', end: '',
    applicability: { material: '', detail: '', scope: '' } };
}

/** Pure edit of the draft; a removed or unknown row index changes nothing. The last row cannot be removed. */
export function editPiecewiseDraft(draft: FatiguePiecewiseDraft, edit: FatiguePiecewiseEdit): FatiguePiecewiseDraft {
  switch (edit.kind) {
    case 'segment-add':
      return { ...draft, segments: [...draft.segments, emptySegment(`segment-${draft.nextSegment}`)], nextSegment: draft.nextSegment + 1 };
    case 'segment-remove':
      if (draft.segments.length <= 1 || draft.segments[edit.index] === undefined) return draft;
      return { ...draft, segments: draft.segments.filter((_, index) => index !== edit.index) };
    case 'segment-value':
      if (draft.segments[edit.index] === undefined) return draft;
      return { ...draft, segments: draft.segments.map((row, index) => index === edit.index ? { ...row, [edit.field]: edit.source } : row) };
    case 'end-cycles':
      return { ...draft, endCycles: edit.source };
    case 'end':
      return { ...draft, end: edit.value };
    case 'applicability':
      return { ...draft, applicability: { ...draft.applicability, [edit.field]: edit.source } };
  }
}

const refuse = (key: MessageKey, field: string | null, diagnostic: string | null = null): Extract<FatiguePiecewiseCheck, { readonly ok: false }> =>
  ({ ok: false, key, field, diagnostic });
const READERS = { fromStress: 'referenceStress', fromCycles: 'referenceCycles', slope: 'slope' } as const;
/** Every new refusal of the piecewise core has its own message; the shared codes keep their existing messages. */
export const PIECEWISE_ERROR_KEYS: Readonly<Record<FatiguePiecewiseErrorCode, MessageKey>> = { ...FATIGUE_ERROR_KEYS,
  'fatigue-piecewise-order': 'fatigue.error.piecewiseOrder', 'fatigue-piecewise-continuity': 'fatigue.error.piecewiseContinuity',
  'fatigue-piecewise-domain': 'fatigue.error.piecewiseDomain', 'fatigue-applicability': 'fatigue.error.piecewiseApplicability' };
/** The panel field of a piecewise core refusal path: a segment row (and its field), the end, applicability, or the
 * existing curve and history fields. */
export function piecewiseErrorField(path: string): string | null {
  const segment = /^curve\.segments\[(\d+)\](?:\.(fromStressMpa|fromCycles|slope))?/u.exec(path);
  if (segment !== null) {
    const field = segment[2] === undefined ? null : segment[2] === 'fromStressMpa' ? 'fromStress' : segment[2];
    return field === null ? `piecewise:segment:${segment[1]}` : `piecewise:segment:${segment[1]}:${field}`;
  }
  if (path === 'curve.endCycles') return 'piecewise:endCycles';
  if (path === 'curve.end') return 'piecewise:end';
  const applicability = /^curve\.applicability\.(material|detail|scope)/u.exec(path);
  if (applicability !== null) return `piecewise:${applicability[1]}`;
  return fatigueErrorField(path).field;
}

/** Builds and strictly validates the piecewise input from the draft and the panel's already-built histories. */
export function piecewiseProblem(draft: FatiguePiecewiseDraft, common: FatiguePiecewiseCommon,
  histories: readonly FatigueInput['histories'][number][], parameters: readonly Parameter[]): FatiguePiecewiseCheck {
  if (common.stressDefinition === '') return refuse('fatigue.error.stressDefinition', 'stressDefinition');
  if (common.meanStressAssumption === '') return refuse('fatigue.error.meanAssumption', 'meanStressAssumption');
  const segments: { fromStressMpa: number; fromCycles: number; slope: number }[] = [];
  for (const [index, row] of draft.segments.entries()) {
    const values: Partial<Record<FatiguePiecewiseSegmentField, number>> = {};
    for (const field of ['fromStress', 'fromCycles', 'slope'] as const) {
      const id = `piecewise:segment:${index}:${field}`;
      const read = readFatigueField(READERS[field], id, row[field], parameters);
      if (read.value === null) return refuse('fatigue.error.field', id, read.error?.message ?? null);
      values[field] = read.value.value;
    }
    segments.push({ fromStressMpa: values.fromStress ?? Number.NaN, fromCycles: values.fromCycles ?? Number.NaN, slope: values.slope ?? Number.NaN });
  }
  const end = readFatigueField('referenceCycles', 'piecewise:endCycles', draft.endCycles, parameters);
  if (end.value === null) return refuse('fatigue.error.field', 'piecewise:endCycles', end.error?.message ?? null);
  if (draft.end === '') return refuse('fatigue.error.piecewiseEnd', 'piecewise:end');
  for (const field of ['material', 'detail', 'scope'] as const) {
    if (draft.applicability[field].trim() === '') return refuse('fatigue.error.piecewiseApplicability', `piecewise:${field}`);
  }
  const reference = common.curveSource.reference.trim(), condition = common.curveSource.condition.trim();
  if (reference === '') return refuse('fatigue.error.source', 'curve:reference');
  if (condition === '') return refuse('fatigue.error.source', 'curve:condition');
  const candidate = { schema: FATIGUE_PIECEWISE_INPUT_SCHEMA, histories,
    curve: { id: FATIGUE_CURVE_ID, unit: 'MPa', stressDefinition: common.stressDefinition,
      meanStressAssumption: common.meanStressAssumption, segments, endCycles: end.value.value, end: draft.end,
      applicability: { material: draft.applicability.material.trim(), detail: draft.applicability.detail.trim(),
        scope: draft.applicability.scope.trim() }, source: { kind: 'user-supplied', reference, condition } } };
  const checked = validateFatiguePiecewiseInput(candidate);
  if (!checked.ok) return refuse(PIECEWISE_ERROR_KEYS[checked.code], piecewiseErrorField(checked.path));
  return { ok: true, problem: checked.input };
}

/** Validates and runs the core on the draft. The result is derived only: it is never saved. */
export function analyzePiecewiseDraft(draft: FatiguePiecewiseDraft, common: FatiguePiecewiseCommon,
  histories: readonly FatigueInput['histories'][number][], parameters: readonly Parameter[]): FatiguePiecewiseAnalysisCheck {
  const checked = piecewiseProblem(draft, common, histories, parameters);
  if (!checked.ok) return checked;
  const analysis = analyzeFatiguePiecewise(checked.problem);
  if (!analysis.ok) {
    const point = fatigueErrorField(analysis.path).point;
    return refuse(PIECEWISE_ERROR_KEYS[analysis.code], piecewiseErrorField(analysis.path),
      point === null ? null : t('fatigue.error.point').replace('{point}', String(point)));
  }
  return { ok: true, problem: checked.problem, result: analysis.result };
}

/** The saved version 5 form of a valid problem in the document `documentId`: inputs and sources only. */
export function piecewiseSavedInput(problem: FatigueSavedPiecewiseProblem, documentId: string): FatiguePiecewiseSavedInput {
  return { schema: FATIGUE_SAVED_PIECEWISE_SCHEMA, id: FATIGUE_SAVED_ID, source: { documentId }, input: problem };
}

/** Restores the draft of a saved version 5 input with the exact number form (every field reads back to the saved double). */
export function restorePiecewiseDraft(saved: FatiguePiecewiseSavedInput): FatiguePiecewiseDraft {
  const exact = (value: number): string => exactExpressionValueFromNumber(value).source;
  const { curve } = saved.input;
  return { segments: curve.segments.map((segment, index) => ({ key: `segment-${index + 1}`, fromStress: exact(segment.fromStressMpa),
    fromCycles: exact(segment.fromCycles), slope: exact(segment.slope) })), nextSegment: curve.segments.length + 1,
  endCycles: exact(curve.endCycles), end: curve.end, applicability: { ...curve.applicability } };
}
