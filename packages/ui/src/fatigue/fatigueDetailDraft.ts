import { analyzeFatigueDetail, FATIGUE_DETAIL_INPUT_SCHEMA, validateFatigueDetailInput, type FatigueDetailErrorCode,
  type FatigueDetailInput, type FatigueDetailQuantity, type FatigueDetailResult, type FatigueDetailStress } from '@pointercad/fem';
import { exactExpressionValueFromNumber } from '@pointercad/expression';
import type { Parameter } from '@pointercad/model';
import { FATIGUE_SAVED_DETAIL_SCHEMA, FATIGUE_SAVED_ID, FATIGUE_SAVED_PIECEWISE_INPUT_SCHEMA, FATIGUE_SAVED_PIECEWISE_SCHEMA,
  readFatigueDetailSavedInput,
  type FatigueDetailSavedInput } from '@pointercad/model/beam-analysis';
import { t, type MessageKey } from '../i18n/t.js';
import { readFatigueField, readPlasticBarField } from '../beam/beamFields.js';
import { PIECEWISE_ERROR_KEYS, piecewiseErrorField, restorePiecewiseDraft, type FatiguePiecewiseCommon,
  type FatiguePiecewiseDraft } from './fatiguePiecewiseDraft.js';
import { FATIGUE_CURVE_ID, fatigueErrorField, historyUse, parseStressList, type FatigueHistoryDraft } from './fatigueSession.js';

/**
 * The joint (weld or bolt) of the fatigue panel's joint mode, as typed: the joint kind, which area its nominal stress is
 * defined on and the dimensions of that area (mm), what quantity the histories hold and where it was taken, and which
 * stress the user's calibration was derived for. The calibration itself is the panel's piecewise calibration and the
 * histories are the panel's histories (sequence, repeats, source and the MPa stress lists are not duplicated); the force
 * lists (N) are kept here by history key, so a stress list is never re-read as forces or the reverse. Nothing is
 * prefilled: no joint, dimension, curve or stress definition is assumed, and no bolt force is derived from an external
 * force. The input is checked by the actual core (validateFatigueDetailInput of @pointercad/fem).
 */
export type FatigueDetailWeldArea = 'fillet-throat-area' | 'fillet-leg-area';
export type FatigueDetailBoltArea = 'iso-metric-thread-tensile-stress-area' | 'nominal-shank-area';
export type FatigueDetailNumberField = 'weldSize' | 'weldLength' | 'weldLines' | 'boltDiameter' | 'boltPitch';
export interface FatigueDetailDraft {
  /** The joint's id in the input (kept from a saved input; not shown). */
  readonly id: string;
  readonly kind: 'weld' | 'bolt' | '';
  readonly weldArea: FatigueDetailWeldArea | '';
  /** The user's statement that the weld group carries a uniform in-plane shear through its centroid. */
  readonly weldConcentric: boolean;
  readonly boltArea: FatigueDetailBoltArea | '';
  readonly values: Readonly<Record<FatigueDetailNumberField, string>>;
  readonly quantity: FatigueDetailQuantity | '';
  readonly location: string;
  /** The stress definition the histories are stated in (only for the joint stress quantity). */
  readonly loadingStress: FatigueDetailStress | '';
  /** The stress definition the calibration was derived for. */
  readonly curveStress: FatigueDetailStress | '';
  /** Force lists in N by history key (the joint force quantities). */
  readonly forces: Readonly<Record<string, string>>;
}
export type FatigueDetailEdit =
  | { readonly kind: 'kind'; readonly value: FatigueDetailDraft['kind'] }
  | { readonly kind: 'weld-area'; readonly value: FatigueDetailDraft['weldArea'] }
  | { readonly kind: 'weld-concentric'; readonly value: boolean }
  | { readonly kind: 'bolt-area'; readonly value: FatigueDetailDraft['boltArea'] }
  | { readonly kind: 'value'; readonly field: FatigueDetailNumberField; readonly source: string }
  | { readonly kind: 'quantity'; readonly value: FatigueDetailDraft['quantity'] }
  | { readonly kind: 'location'; readonly source: string }
  | { readonly kind: 'loading-stress'; readonly value: FatigueDetailDraft['loadingStress'] }
  | { readonly kind: 'curve-stress'; readonly value: FatigueDetailDraft['curveStress'] }
  | { readonly kind: 'force'; readonly key: string; readonly source: string };
export type FatigueDetailCheck = { readonly ok: true; readonly input: FatigueDetailInput }
  | { readonly ok: false; readonly key: MessageKey; readonly field: string | null; readonly diagnostic: string | null };
type Refusal = Extract<FatigueDetailCheck, { readonly ok: false }>;
 type FatigueDetailAnalysisCheck = { readonly ok: true; readonly input: FatigueDetailInput; readonly result: FatigueDetailResult }
  | Refusal;

/** The joint id of a new input. */
 const FATIGUE_DETAIL_JOINT_ID = 'joint';
 const FATIGUE_DETAIL_FORCE_QUANTITIES: readonly FatigueDetailQuantity[] = ['weld-group-concentric-shear-force',
  'bolt-total-axial-force', 'joint-external-axial-force'];
export const isForceQuantity = (value: FatigueDetailDraft['quantity']): boolean =>
  FATIGUE_DETAIL_FORCE_QUANTITIES.some(item => item === value);

export function createDetailDraft(): FatigueDetailDraft {
  return { id: FATIGUE_DETAIL_JOINT_ID, kind: '', weldArea: '', weldConcentric: false, boltArea: '',
    values: { weldSize: '', weldLength: '', weldLines: '', boltDiameter: '', boltPitch: '' }, quantity: '', location: '',
    loadingStress: '', curveStress: '', forces: {} };
}

/** Pure edit of the joint draft. */
export function editDetailDraft(draft: FatigueDetailDraft, edit: FatigueDetailEdit): FatigueDetailDraft {
  switch (edit.kind) {
    case 'kind': return { ...draft, kind: edit.value };
    case 'weld-area': return { ...draft, weldArea: edit.value };
    case 'weld-concentric': return { ...draft, weldConcentric: edit.value };
    case 'bolt-area': return { ...draft, boltArea: edit.value };
    case 'value': return { ...draft, values: { ...draft.values, [edit.field]: edit.source } };
    case 'quantity': return { ...draft, quantity: edit.value };
    case 'location': return { ...draft, location: edit.source };
    case 'loading-stress': return { ...draft, loadingStress: edit.value };
    case 'curve-stress': return { ...draft, curveStress: edit.value };
    case 'force': return { ...draft, forces: { ...draft.forces, [edit.key]: edit.source } };
  }
}

/** The force list (N) of the history `key` (empty when none was typed). */
export function detailForce(draft: FatigueDetailDraft, key: string): string {
  return Object.hasOwn(draft.forces, key) ? draft.forces[key] ?? '' : '';
}

/** Every refusal of the joint core has its own message; the shared codes keep their existing messages. */
 const DETAIL_ERROR_KEYS: Readonly<Record<FatigueDetailErrorCode, MessageKey>> = { ...PIECEWISE_ERROR_KEYS,
  'fatigue-detail-schema': 'fatigue.error.shape', 'fatigue-detail-binding': 'fatigue.error.shape',
  'fatigue-detail-kind': 'fatigue.error.detailKind', 'fatigue-detail-method': 'fatigue.error.detailKind',
  'fatigue-detail-load-path': 'fatigue.error.detailLoadPath', 'fatigue-detail-geometry': 'fatigue.error.detailGeometry',
  'fatigue-detail-quantity': 'fatigue.error.detailQuantity', 'fatigue-detail-load-distribution': 'fatigue.error.detailLoadDistribution',
  'fatigue-detail-bolt-compression': 'fatigue.error.detailBoltCompression', 'fatigue-detail-stress': 'fatigue.error.detailStress',
  'fatigue-detail-stress-mismatch': 'fatigue.error.detailStressMismatch', 'fatigue-detail-location': 'fatigue.error.detailLocation' };

const GEOMETRY_FIELDS: Readonly<Record<string, FatigueDetailNumberField>> = {
  throatMm: 'weldSize', legMm: 'weldSize', effectiveLengthMm: 'weldLength', lines: 'weldLines',
  nominalDiameterMm: 'boltDiameter', pitchMm: 'boltPitch',
};
/** The panel field of a joint core refusal path, and the 1-based list position when the path names one. */
 function detailErrorField(path: string, kind: FatigueDetailDraft['kind']): { readonly field: string | null; readonly point: number | null } {
  const force = /^loading\.histories\[(\d+)\]\.forceN(?:\[(\d+)\])?/u.exec(path);
  if (force !== null) return { field: `history:${force[1]}:force`, point: force[2] === undefined ? null : Number(force[2]) + 1 };
  if (path.startsWith('loading.histories')) return fatigueErrorField(path.slice('loading.'.length));
  if (path.startsWith('curve.calibration')) return { field: piecewiseErrorField(`curve${path.slice('curve.calibration'.length)}`), point: null };
  if (path === 'curve.detailStress') return { field: 'detail:curveStress', point: null };
  if (path === 'loading.stress') return { field: 'detail:loadingStress', point: null };
  if (path === 'loading.quantity') return { field: 'detail:quantity', point: null };
  if (path === 'loading.location') return { field: 'detail:location', point: null };
  if (path === 'detail.loadPath') return { field: 'detail:weldConcentric', point: null };
  if (path === 'detail.geometry.kind') return { field: kind === 'bolt' ? 'detail:boltArea' : 'detail:weldArea', point: null };
  const geometry = /^detail\.geometry\.([A-Za-z]+)/u.exec(path);
  const named = geometry === null ? undefined : GEOMETRY_FIELDS[geometry[1] ?? ''];
  if (named !== undefined) return { field: `detail:${named}`, point: null };
  // The derived area itself (for example a product of dimensions below the number range): the first dimension.
  if (path === 'detail.geometry') return { field: kind === 'bolt' ? 'detail:boltDiameter' : 'detail:weldSize', point: null };
  return { field: path.startsWith('detail') ? 'detail:kind' : null, point: null };
}

function refusal(code: FatigueDetailErrorCode, path: string, kind: FatigueDetailDraft['kind']): Refusal {
  const { field, point } = detailErrorField(path, kind);
  // A force beyond its bound (1e9 N, or a force over the area above the stress bound) is not described as a stress.
  const key = code === 'fatigue-bound' && field !== null && field.endsWith(':force') ? 'fatigue.error.detailForceBound' : DETAIL_ERROR_KEYS[code];
  return { ok: false, key, field, diagnostic: point === null ? null : t('fatigue.error.point').replace('{point}', String(point)) };
}
const refuse = (key: MessageKey, field: string | null, diagnostic: string | null = null): Refusal => ({ ok: false, key, field, diagnostic });

const SEGMENT_READERS = { fromStress: 'referenceStress', fromCycles: 'referenceCycles', slope: 'slope' } as const;
/** The calibration of the panel's piecewise fields, each missing value refused at its own field (the same readers and
 * bounds as the piecewise mode); its rules are checked by the core's unchanged piecewise reader. */
function calibration(draft: FatiguePiecewiseDraft, common: FatiguePiecewiseCommon, parameters: readonly Parameter[]):
  Record<string, unknown> | Refusal {
  if (common.stressDefinition === '') return refuse('fatigue.error.stressDefinition', 'stressDefinition');
  if (common.meanStressAssumption === '') return refuse('fatigue.error.meanAssumption', 'meanStressAssumption');
  const segments: Record<string, number>[] = [];
  for (const [index, row] of draft.segments.entries()) {
    const values: Record<string, number> = {};
    for (const field of ['fromStress', 'fromCycles', 'slope'] as const) {
      const id = `piecewise:segment:${index}:${field}`;
      const read = readFatigueField(SEGMENT_READERS[field], id, row[field], parameters);
      if (read.value === null) return refuse('fatigue.error.field', id, read.error?.message ?? null);
      values[field === 'fromStress' ? 'fromStressMpa' : field] = read.value.value;
    }
    segments.push(values);
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
  return { id: FATIGUE_CURVE_ID, unit: 'MPa', stressDefinition: common.stressDefinition, meanStressAssumption: common.meanStressAssumption,
    segments, endCycles: end.value.value, end: draft.end, applicability: { material: draft.applicability.material.trim(),
      detail: draft.applicability.detail.trim(), scope: draft.applicability.scope.trim() },
    source: { kind: 'user-supplied', reference, condition } };
}

/** A positive dimension in mm (length units and mm parameters are accepted), or a count. */
function dimension(draft: FatigueDetailDraft, field: FatigueDetailNumberField, parameters: readonly Parameter[]): number | Refusal {
  const key = `detail:${field}`;
  const read = field === 'weldLines' ? readFatigueField('repeats', key, draft.values[field], parameters)
    : readPlasticBarField('length', key, draft.values[field], parameters);
  if (read.value === null) return refuse('fatigue.error.field', key, read.error?.message ?? null);
  return read.value.value;
}

function joint(draft: FatigueDetailDraft, parameters: readonly Parameter[]): Record<string, unknown> | Refusal {
  if (draft.kind === '') return refuse('fatigue.error.detailKind', 'detail:kind');
  if (draft.kind === 'weld') {
    if (draft.weldArea === '') return refuse('fatigue.error.detailArea', 'detail:weldArea');
    if (!draft.weldConcentric) return refuse('fatigue.error.detailLoadPath', 'detail:weldConcentric');
    const size = dimension(draft, 'weldSize', parameters);
    if (typeof size !== 'number') return size;
    const effectiveLengthMm = dimension(draft, 'weldLength', parameters);
    if (typeof effectiveLengthMm !== 'number') return effectiveLengthMm;
    const lines = dimension(draft, 'weldLines', parameters);
    if (typeof lines !== 'number') return lines;
    const geometry = draft.weldArea === 'fillet-throat-area' ? { kind: draft.weldArea, throatMm: size, effectiveLengthMm, lines }
      : { kind: draft.weldArea, legMm: size, effectiveLengthMm, lines };
    return { id: draft.id, kind: 'weld', method: 'fillet-weld-nominal-shear/1', loadPath: 'concentric-in-plane-shear', geometry };
  }
  if (draft.boltArea === '') return refuse('fatigue.error.detailArea', 'detail:boltArea');
  const nominalDiameterMm = dimension(draft, 'boltDiameter', parameters);
  if (typeof nominalDiameterMm !== 'number') return nominalDiameterMm;
  if (draft.boltArea === 'nominal-shank-area') {
    return { id: draft.id, kind: 'bolt', method: 'bolt-axial-nominal/1', geometry: { kind: draft.boltArea, nominalDiameterMm } };
  }
  const pitchMm = dimension(draft, 'boltPitch', parameters);
  if (typeof pitchMm !== 'number') return pitchMm;
  return { id: draft.id, kind: 'bolt', method: 'bolt-axial-nominal/1', geometry: { kind: draft.boltArea, nominalDiameterMm, pitchMm } };
}

/** The histories of the joint mode: the force lists (N) of a force quantity, or the panel's stress lists (MPa). */
function histories(draft: FatigueDetailDraft, rows: readonly FatigueHistoryDraft[], parameters: readonly Parameter[]):
  Record<string, unknown>[] | Refusal {
  const force = isForceQuantity(draft.quantity);
  const read: Record<string, unknown>[] = [];
  for (const [index, row] of rows.entries()) {
    // An imported member-mean axial stress is not a joint stress or force.
    if (row.imported !== null) return refuse('fatigue.error.detailImported', `history:${index}:stress`);
    const field = force ? `history:${index}:force` : `history:${index}:stress`;
    const list = parseStressList(force ? detailForce(draft, row.key) : row.stress);
    if (!list.ok) {
      const point = list.point === null ? null : t('fatigue.error.point').replace('{point}', String(list.point));
      if (force) return refuse(list.point === null ? 'fatigue.error.detailForceLength' : 'fatigue.error.detailForceEntry', field, point);
      return refuse(list.point === null ? 'fatigue.error.historyLength' : 'fatigue.error.stressEntry', field, point);
    }
    const use = historyUse(row, index, parameters);
    if ('ok' in use) return use;
    read.push(force ? { id: row.key, unit: 'N', forceN: list.values, ...use } : { id: row.key, unit: 'MPa', stressMpa: list.values, ...use });
  }
  return read;
}

const isRefusal = (value: object): value is Refusal => 'ok' in value;

/** Builds the joint input from the draft in the panel's order and validates it with the actual core. */
export function detailProblem(draft: FatigueDetailDraft, piecewise: FatiguePiecewiseDraft, common: FatiguePiecewiseCommon,
  rows: readonly FatigueHistoryDraft[], parameters: readonly Parameter[]): FatigueDetailCheck {
  const detail = joint(draft, parameters);
  if (isRefusal(detail)) return detail;
  if (draft.quantity === '') return refuse('fatigue.error.detailQuantity', 'detail:quantity');
  if (draft.location.trim() === '') return refuse('fatigue.error.detailLocation', 'detail:location');
  const stressQuantity = draft.quantity === 'detail-stress';
  if (stressQuantity && draft.loadingStress === '') return refuse('fatigue.error.detailStress', 'detail:loadingStress');
  if (draft.curveStress === '') return refuse('fatigue.error.detailStress', 'detail:curveStress');
  const curve = calibration(piecewise, common, parameters);
  if (isRefusal(curve)) return curve;
  const read = histories(draft, rows, parameters);
  if (!Array.isArray(read)) return read;
  const base = { detailId: draft.id, location: draft.location.trim(), quantity: draft.quantity };
  const candidate = { schema: FATIGUE_DETAIL_INPUT_SCHEMA, detail,
    loading: stressQuantity ? { ...base, stress: draft.loadingStress, histories: read } : { ...base, histories: read },
    curve: { detailStress: draft.curveStress, calibration: curve } };
  const checked = validateFatigueDetailInput(candidate);
  if (!checked.ok) return refusal(checked.code, checked.path, draft.kind);
  return { ok: true, input: checked.input };
}

/** Validates and runs the actual joint core. The result is derived only: it is never saved. */
export function analyzeDetailDraft(draft: FatigueDetailDraft, piecewise: FatiguePiecewiseDraft, common: FatiguePiecewiseCommon,
  rows: readonly FatigueHistoryDraft[], parameters: readonly Parameter[]): FatigueDetailAnalysisCheck {
  const checked = detailProblem(draft, piecewise, common, rows, parameters);
  if (!checked.ok) return checked;
  const analysis = analyzeFatigueDetail(checked.input);
  if (!analysis.ok) return refusal(analysis.code, analysis.path, draft.kind);
  return { ok: true, input: checked.input, result: analysis.result };
}

/** The saved version 6 form of a valid input in the document `documentId`, read back by the document's own reader:
 * inputs and sources only (no area, stress, damage or life). */
export function detailSavedInput(input: FatigueDetailInput, documentId: string):
  { readonly ok: true; readonly saved: FatigueDetailSavedInput } | Refusal {
  try {
    return { ok: true, saved: readFatigueDetailSavedInput({ schema: FATIGUE_SAVED_DETAIL_SCHEMA, id: FATIGUE_SAVED_ID,
      source: { documentId }, input }, 'fatigueDetail') };
  } catch (error) {
    return refuse('fatigue.error.shape', 'detail:kind', error instanceof Error ? error.message : null);
  }
}

/** Restores the joint and calibration drafts of a saved version 6 input with the exact number form (every dimension
 * reads back to the saved double). */
export function restoreDetailDraft(saved: FatigueDetailSavedInput): { readonly detail: FatigueDetailDraft; readonly piecewise: FatiguePiecewiseDraft } {
  const exact = (value: number): string => exactExpressionValueFromNumber(value).source;
  const { detail, loading, curve } = saved.input;
  const values = { ...createDetailDraft().values };
  if (detail.kind === 'weld') {
    const geometry = detail.geometry;
    values.weldSize = exact(geometry.kind === 'fillet-throat-area' ? geometry.throatMm : geometry.legMm);
    values.weldLength = exact(geometry.effectiveLengthMm);
    values.weldLines = exact(geometry.lines);
  } else {
    values.boltDiameter = exact(detail.geometry.nominalDiameterMm);
    if (detail.geometry.kind === 'iso-metric-thread-tensile-stress-area') values.boltPitch = exact(detail.geometry.pitchMm);
  }
  const forces = loading.quantity === 'detail-stress' ? {}
    : Object.fromEntries(loading.histories.map(history => [history.id, history.forceN.map(String).join(', ')] as const));
  const piecewise = restorePiecewiseDraft({ schema: FATIGUE_SAVED_PIECEWISE_SCHEMA, id: FATIGUE_SAVED_ID, source: saved.source,
    input: { schema: FATIGUE_SAVED_PIECEWISE_INPUT_SCHEMA, curve: curve.calibration, histories: [] } });
  return { piecewise, detail: { id: detail.id, kind: detail.kind,
    weldArea: detail.kind === 'weld' ? detail.geometry.kind : '', weldConcentric: detail.kind === 'weld',
    boltArea: detail.kind === 'bolt' ? detail.geometry.kind : '', values, quantity: loading.quantity, location: loading.location,
    loadingStress: loading.quantity === 'detail-stress' ? loading.stress : '', curveStress: curve.detailStress, forces } };
}
