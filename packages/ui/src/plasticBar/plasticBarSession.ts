import { PLASTIC_BAR_INPUT_SCHEMA, PLASTIC_BAR_LIMITS, PLASTIC_BAR_PLAN_SCHEMA, translatePlasticBar, type FemPhase,
  type PlasticBarInput, type PlasticBarResult } from '@pointercad/fem';
import { exactExpressionValueFromNumber } from '@pointercad/expression';
import type { Parameter } from '@pointercad/model';
import { PLASTIC_BAR_SAVED_ID, PLASTIC_BAR_SAVED_SCHEMA, plasticBarSiValues, sameAnalysisPropertyEvidence,
  type BeamAnalysisInputs, type PlasticBarSavedInput } from '@pointercad/model/beam-analysis';
import type { MessageKey } from '../i18n/t.js';
import { readPlasticBarField, type PlasticBarFieldName } from '../beam/beamFields.js';

/** Scalar inputs; every material value starts empty so that nothing is assumed for a steel grade. */
export type PlasticBarScalarField = Exclude<PlasticBarFieldName, 'knot'>;
type HardeningEvidence = NonNullable<PlasticBarSavedInput['hardeningEvidence']>;
/** The material values the restored evidence is bound to. plateauPlasticStrain is present only when the saved
 * configuration had a plateau; absence and presence are both part of the binding (no plateau = linear law). */
type RestoredMaterial = Pick<PlasticBarSavedInput,
  'youngModulusMPa' | 'poisson' | 'yieldStressMPa' | 'hardeningModulusMPa' | 'plateauPlasticStrain'> & {
  readonly reference: string;
  readonly evidence: HardeningEvidence;
};
export interface PlasticBarDraft {
  readonly values: Readonly<Record<PlasticBarScalarField, string>>;
  /** End displacements after the fixed first knot 0 (mm), in order. */
  readonly knots: readonly string[];
  /** The user's own statement of where the material values come from (required). */
  readonly reference: string;
  /** Loaded evidence is bound to these exact material values, never inferred from a grade or free-text reference. */
  readonly restoredMaterial?: RestoredMaterial | null;
}
export type PlasticBarStatus = 'editing' | 'running' | 'complete' | 'failed' | 'cancelled';
export interface PlasticBarSession {
  readonly ownerId: string;
  /** Increases on every input edit; a run and its result belong to exactly one revision. */
  readonly revision: number;
  readonly draft: PlasticBarDraft;
  readonly focusedField: string | null;
  readonly status: PlasticBarStatus;
  readonly phase: FemPhase | null;
  readonly result: PlasticBarResult | null;
  readonly errorKey: MessageKey | null;
  readonly diagnostic: string | null;
}
export type PlasticBarEdit =
  | { readonly kind: 'focus'; readonly field: string }
  | { readonly kind: 'value'; readonly field: PlasticBarScalarField; readonly source: string }
  | { readonly kind: 'reference'; readonly source: string }
  | { readonly kind: 'knot'; readonly index: number; readonly source: string }
  | { readonly kind: 'knot-add' }
  | { readonly kind: 'knot-remove'; readonly index: number };

/** The first knot 0 is fixed, so at most maximumKnots - 1 rows are editable. */
export const PLASTIC_BAR_DRAFT_MAXIMUM_KNOTS = PLASTIC_BAR_LIMITS.maximumKnots - 1;
/** The required scalar fields. The optional 'plateau' is read separately: empty means no plateau (the original law). */
export const PLASTIC_BAR_SCALAR_FIELDS: readonly PlasticBarScalarField[] = ['length', 'area', 'young', 'poisson',
  'yieldStress', 'hardening', 'stepsPerSegment'];
const MATERIAL_FIELDS: readonly PlasticBarScalarField[] = ['young', 'poisson', 'yieldStress', 'hardening', 'plateau'];

export function createPlasticBarSession(ownerId: string): PlasticBarSession {
  return { ownerId, revision: 0, focusedField: null, status: 'editing', phase: null, result: null, errorKey: null,
    diagnostic: null, draft: { values: { length: '', area: '', young: '', poisson: '', yieldStress: '', hardening: '',
      plateau: '', stepsPerSegment: '10' }, knots: [''], reference: '' } };
}

/** Any input edit invalidates the result and moves to a new revision; focus is view-only. */
export function editPlasticBarSession(session: PlasticBarSession, edit: PlasticBarEdit): PlasticBarSession {
  if (edit.kind === 'focus') return { ...session, focusedField: edit.field };
  const draft = session.draft;
  let next: PlasticBarDraft;
  if (edit.kind === 'value') next = { ...draft, values: { ...draft.values, [edit.field]: edit.source } };
  else if (edit.kind === 'reference') next = { ...draft, reference: edit.source };
  else if (edit.kind === 'knot') {
    if (!Number.isSafeInteger(edit.index) || edit.index < 0 || edit.index >= draft.knots.length) return session;
    next = { ...draft, knots: draft.knots.map((knot, index) => index === edit.index ? edit.source : knot) };
  } else if (edit.kind === 'knot-add') {
    if (draft.knots.length >= PLASTIC_BAR_DRAFT_MAXIMUM_KNOTS) return session;
    next = { ...draft, knots: [...draft.knots, ''] };
  } else {
    if (draft.knots.length <= 1 || !Number.isSafeInteger(edit.index) || edit.index < 0 || edit.index >= draft.knots.length) {
      return session;
    }
    next = { ...draft, knots: draft.knots.filter((_, index) => index !== edit.index) };
  }
  // Changing material expression text also invalidates evidence: later parameter edits must not revive a citation.
  if ((edit.kind === 'reference' && edit.source !== draft.reference)
    || (edit.kind === 'value' && MATERIAL_FIELDS.includes(edit.field)
      && edit.source !== draft.values[edit.field])) next = { ...next, restoredMaterial: null };
  return { ...session, draft: next, revision: session.revision + 1, status: 'editing', phase: null, result: null,
    errorKey: null, diagnostic: null };
}

export type PlasticBarDraftCheck = { readonly ok: true; readonly input: PlasticBarInput }
  | { readonly ok: false; readonly key: MessageKey; readonly field: string | null; readonly diagnostic: string | null };

type DraftNumbers = Omit<PlasticBarSavedInput, 'schema' | 'id' | 'source' | 'units' | 'materialSource' | 'hardeningEvidence'>;
type DraftNumbersCheck = { readonly ok: true; readonly numbers: DraftNumbers }
  | { readonly ok: false; readonly key: MessageKey; readonly field: string | null; readonly diagnostic: string | null };

/** Evaluates every field in the panel's units (mm, mm², MPa); the first knot 0 is implicit in the draft. */
function draftNumbers(session: PlasticBarSession, parameters: readonly Parameter[]): DraftNumbersCheck {
  const numbers = new Map<string, number>();
  for (const name of PLASTIC_BAR_SCALAR_FIELDS) {
    const read = readPlasticBarField(name, name, session.draft.values[name], parameters);
    if (read.value === null) return { ok: false, key: 'plasticBar.error.field', field: name, diagnostic: read.error?.message ?? null };
    numbers.set(name, read.value.value);
  }
  const knots: number[] = [0];
  for (const [index, source] of session.draft.knots.entries()) {
    const key = `knot:${index}`;
    const read = readPlasticBarField('knot', key, source, parameters);
    if (read.value === null) return { ok: false, key: 'plasticBar.error.field', field: key, diagnostic: read.error?.message ?? null };
    knots.push(read.value.value);
  }
  // Optional plateau (dimensionless plastic strain, % allowed): empty keeps the original law and adds no field.
  let plateau: number | undefined;
  if (session.draft.values.plateau.trim() !== '') {
    const read = readPlasticBarField('plateau', 'plateau', session.draft.values.plateau, parameters);
    if (read.value === null) return { ok: false, key: 'plasticBar.error.field', field: 'plateau', diagnostic: read.error?.message ?? null };
    plateau = read.value.value;
  }
  if (session.draft.reference.trim() === '') return { ok: false, key: 'plasticBar.error.source', field: 'reference', diagnostic: null };
  const value = (name: PlasticBarScalarField): number => numbers.get(name) ?? Number.NaN;
  return { ok: true, numbers: { lengthMm: value('length'), areaMm2: value('area'), youngModulusMPa: value('young'),
    poisson: value('poisson'), yieldStressMPa: value('yieldStress'), hardeningModulusMPa: value('hardening'),
    ...(plateau === undefined ? {} : { plateauPlasticStrain: plateau }),
    endDisplacementMm: knots, stepsPerSegment: value('stepsPerSegment') } };
}

/** Builds the bound FEM input: mm -> m, mm² -> m², MPa -> Pa through plasticBarSiValues (the same conversion the saved
 * configuration reader checks); all plan rules come from readPlasticBarPlan. */
export function plasticBarInput(session: PlasticBarSession, parameters: readonly Parameter[]): PlasticBarDraftCheck {
  const draft = draftNumbers(session, parameters);
  if (!draft.ok) return draft;
  const si = plasticBarSiValues(draft.numbers);
  try {
    const { input } = translatePlasticBar({ schema: PLASTIC_BAR_INPUT_SCHEMA,
      source: { documentId: session.ownerId, revision: session.revision },
      plan: { schema: PLASTIC_BAR_PLAN_SCHEMA, lengthM: si.lengthM, areaM2: si.areaM2,
        material: { youngPa: si.youngPa, poisson: si.poisson, yieldStressPa: si.yieldStressPa,
          hardeningModulusPa: si.hardeningModulusPa,
          ...(si.plateauPlasticStrain === undefined ? {} : { plateauPlasticStrain: si.plateauPlasticStrain }),
          source: { kind: 'user-supplied', reference: session.draft.reference } },
        endDisplacementM: [...si.endDisplacementM], stepsPerSegment: si.stepsPerSegment } });
    return { ok: true, input };
  } catch (error) {
    return { ok: false, key: 'plasticBar.error.plan', field: null,
      diagnostic: error instanceof Error ? error.message : 'Invalid plastic-bar input' };
  }
}

export type PlasticBarSavedCheck = { readonly ok: true; readonly saved: PlasticBarSavedInput }
  | { readonly ok: false; readonly key: MessageKey; readonly field: string | null; readonly diagnostic: string | null };

/** The configuration to save in the document `documentId` (the document's own id, not the session id). Only inputs are
 * saved; the same plan check as a run is required first, so an unrunnable draft is never saved. */
export function plasticBarSavedInput(session: PlasticBarSession, parameters: readonly Parameter[],
  documentId: string): PlasticBarSavedCheck {
  const runnable = plasticBarInput(session, parameters);
  if (!runnable.ok) return runnable;
  const draft = draftNumbers(session, parameters);
  if (!draft.ok) return draft;
  const material = session.draft.restoredMaterial;
  // Evidence is kept only for exactly the restored material values, compared as numbers so that a draft replaced
  // without the edit reducer is checked too. The plateau is part of the series (hardeningPropertySeries: no plateau =
  // linear-isotropic, a plateau = plateau-linear-isotropic with plateauPlasticStrain), so adding, removing or changing
  // it drops the evidence; linear evidence is never moved onto a plateau, and the strict reader refuses that pair.
  const evidence = material != null && material.plateauPlasticStrain === draft.numbers.plateauPlasticStrain
    && material.reference === session.draft.reference
    && material.youngModulusMPa === draft.numbers.youngModulusMPa && material.poisson === draft.numbers.poisson
    && material.yieldStressMPa === draft.numbers.yieldStressMPa
    && material.hardeningModulusMPa === draft.numbers.hardeningModulusMPa ? material.evidence : undefined;
  return { ok: true, saved: { schema: PLASTIC_BAR_SAVED_SCHEMA, id: PLASTIC_BAR_SAVED_ID, source: { documentId },
    units: 'N-mm', ...draft.numbers, materialSource: { kind: 'user-supplied', reference: session.draft.reference },
    ...(evidence === undefined ? {} : { hardeningEvidence: structuredClone(evidence) }) } };
}

/** Restores a saved configuration into the panel. Values are written with the exact (non-exponent) number form, so
 * every field evaluates back to the saved double; the original expression text is not stored. No result is restored. */
export function restorePlasticBarSession(ownerId: string, saved: PlasticBarSavedInput): PlasticBarSession {
  const exact = (value: number): string => exactExpressionValueFromNumber(value).source;
  return { ...createPlasticBarSession(ownerId), draft: {
    values: { length: exact(saved.lengthMm), area: exact(saved.areaMm2), young: exact(saved.youngModulusMPa),
      poisson: exact(saved.poisson), yieldStress: exact(saved.yieldStressMPa), hardening: exact(saved.hardeningModulusMPa),
      // The saved fraction itself (no x100), so it evaluates back to the same double; absent stays empty.
      plateau: saved.plateauPlasticStrain === undefined ? '' : exact(saved.plateauPlasticStrain),
      stepsPerSegment: exact(saved.stepsPerSegment) },
    knots: saved.endDisplacementMm.slice(1).map(exact), reference: saved.materialSource.reference,
    ...(saved.hardeningEvidence === undefined ? {} : { restoredMaterial: {
      youngModulusMPa: saved.youngModulusMPa, poisson: saved.poisson, yieldStressMPa: saved.yieldStressMPa,
      hardeningModulusMPa: saved.hardeningModulusMPa,
      ...(saved.plateauPlasticStrain === undefined ? {} : { plateauPlasticStrain: saved.plateauPlasticStrain }),
      reference: saved.materialSource.reference, evidence: structuredClone(saved.hardeningEvidence),
    } }) } };
}

/** The saved configuration of a document, or null (old documents and documents without one). The attachment was
 * already validated by the document loader or by withBeamAnalysisInputs. */
export function savedPlasticBarInput(document: { readonly beamAnalysisInputs?: BeamAnalysisInputs }): PlasticBarSavedInput | null {
  const saved = document.beamAnalysisInputs?.analyses.find(input => input.kind === 'plastic-bar');
  return saved?.kind === 'plastic-bar' ? saved.definition : null;
}

/**
 * Exact field-by-field equality of two saved configurations, independent of object key insertion order (the p1 version
 * compared JSON.stringify output, and the model reader builds keys in another order than plasticBarSavedInput, so an
 * identical configuration read back through withBeamAnalysisInputs compared as changed). Numbers use ===, which is exact
 * for doubles; the saved reader already normalizes -0 to 0, so -0 and 0 count as equal here as well.
 */
export function samePlasticBarSavedInput(left: PlasticBarSavedInput, right: PlasticBarSavedInput): boolean {
  return left.schema === right.schema && left.id === right.id && left.source.documentId === right.source.documentId
    && left.units === right.units && left.lengthMm === right.lengthMm && left.areaMm2 === right.areaMm2
    && left.youngModulusMPa === right.youngModulusMPa && left.poisson === right.poisson
    && left.yieldStressMPa === right.yieldStressMPa && left.hardeningModulusMPa === right.hardeningModulusMPa
    && left.plateauPlasticStrain === right.plateauPlasticStrain
    && left.materialSource.kind === right.materialSource.kind
    && left.materialSource.reference === right.materialSource.reference
    && sameAnalysisPropertyEvidence(left.hardeningEvidence, right.hardeningEvidence)
    && left.stepsPerSegment === right.stepsPerSegment
    && left.endDisplacementMm.length === right.endDisplacementMm.length
    && left.endDisplacementMm.every((knot, index) => knot === right.endDisplacementMm[index]);
}

/** True when the current draft is exactly the saved configuration (field values compared as saved numbers). */
export function plasticBarDraftIsSaved(session: PlasticBarSession, parameters: readonly Parameter[],
  saved: PlasticBarSavedInput | null): boolean {
  if (saved === null) return false;
  const current = plasticBarSavedInput(session, parameters, saved.source.documentId);
  return current.ok && samePlasticBarSavedInput(current.saved, saved);
}

/** A result is shown only for the exact document and input revision that produced it. */
export function plasticBarResultIsCurrent(session: PlasticBarSession): boolean {
  return session.result !== null && session.result.source.documentId === session.ownerId
    && session.result.source.revision === session.revision;
}
