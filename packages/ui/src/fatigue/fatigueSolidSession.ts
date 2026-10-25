import type { CadSolidOutcome, FatigueResult, SolidFatigueProvenance, FatigueTensorConversion } from '@pointercad/fem';
import type { Parameter } from '@pointercad/model';
import { FATIGUE_SOLID_SAVED_SCHEMA, readFatigueSolidSavedInput, type FatigueSolidSavedInput } from '@pointercad/model/beam-analysis';
import { fatigueCurve, historyUse, parseStressList, restoreFatigueSession,
  type FatigueSavedEntryCheck, type FatigueSession } from './fatigueSession.js';
import { vonMisesMPa } from '../solidAnalysis/solidFieldView.js';
import type { AppState } from '../store/appState.js';

export type FatigueSolidSource = Extract<CadSolidOutcome, { readonly kind: 'result' }>;
export type FatigueSolidBinding = Pick<FatigueSolidSavedInput, 'source' | 'inputSha256' | 'elementIndex'>;
export type FatigueSolidSnapshot = Pick<AppState, 'document' | 'documentVersion' | 'completedGeneration' | 'fileGateway'
  | 'cancelRequestCount' | 'activeDocumentId'>;
export interface FatigueSolidAnalyzed {
  readonly definition: FatigueSolidSavedInput;
  readonly source: FatigueSolidSource;
  readonly result: FatigueResult;
  readonly provenance: SolidFatigueProvenance;
  readonly conversions: readonly FatigueTensorConversion[];
  readonly snapshot: FatigueSolidSnapshot;
}
export const SOLID_FACTOR_CONDITION = 'Explicit proportional scaling of native linear tet4 Cauchy stress; not a transient/contact/plastic history.';

/** Native source identity is the persistent part ID; the session/tab owner is checked separately.
 * attachSolidAnalysis uses completedGeneration as SolidSource.revision. */
export function solidFatigueSourceIsCurrent(source: FatigueSolidSource, state: Pick<AppState, 'document' | 'activeDocumentId'
  | 'completedGeneration' | 'isComputing' | 'strengthSession' | 'assembly' | 'drawing' | 'solidAnalysisSession'>): boolean {
  return state.strengthSession !== null && state.assembly === null && state.drawing === null && !state.isComputing
    && state.solidAnalysisSession?.ownerId === state.activeDocumentId && source.result.source.documentId === state.document.id
    && source.result.source.revision === state.completedGeneration;
}
export function solidFatigueSnapshotMatches(snapshot: FatigueSolidSnapshot, current: FatigueSolidSnapshot): boolean {
  return snapshot.document === current.document && snapshot.documentVersion === current.documentVersion
    && snapshot.completedGeneration === current.completedGeneration && snapshot.fileGateway === current.fileGateway
    && snapshot.cancelRequestCount === current.cancelRequestCount && snapshot.activeDocumentId === current.activeDocumentId;
}

/** The caller supplies only the currently retained accepted solid outcome; no mesh or stress is reconstructed here. */
export function selectFatigueSolidElement(session: FatigueSession, source: FatigueSolidSource, elementIndex: number, documentId = session.ownerId): FatigueSession {
  if (source.result.source.documentId !== documentId || !Number.isSafeInteger(elementIndex)
    || elementIndex < 0 || elementIndex >= source.prepared.input.elements.length) return session;
  return { ...session, revision: session.revision + 1, analyzed: null, piecewiseAnalyzed: null, solidAnalyzed: null,
    draft: { ...session.draft, inputMode: 'solid-proportional', solidElement: String(elementIndex + 1), solid: {
      source: { ...source.result.source }, inputSha256: source.result.inputSha256, elementIndex } },
    errorKey: null, diagnostic: null };
}

/** Explicit convenience selection only; it never calculates or accepts fatigue. Ties keep the first element. */
export function maximumSolidFatigueElement(source: FatigueSolidSource): number | null {
  let selected: number | null = null, maximum = -1;
  for (const [index, element] of source.result.elements.entries()) {
    const stress = vonMisesMPa(element.stressMPa);
    if (!Number.isFinite(stress)) return null;
    if (stress > maximum) { maximum = stress; selected = index; }
  }
  return selected;
}

export function fatigueSolidSavedEntry(session: FatigueSession, parameters: readonly Parameter[], documentId: string): FatigueSavedEntryCheck {
  const draft = session.draft, binding = draft.solid;
  const refuse = (field: string): FatigueSavedEntryCheck => ({ ok: false, key: 'fatigue.error.solidSelection', field, diagnostic: null });
  if (draft.inputMode !== 'solid-proportional' || binding === undefined
    || binding.source.documentId !== documentId || draft.solidElement !== String(binding.elementIndex + 1)) return refuse('solid:element');
  if (draft.correction.mode !== 'none') return { ok: false, key: 'fatigue.error.tensorCorrection', field: 'correction:mode', diagnostic: null };
  if (draft.histories.length !== 1) return { ok: false, key: 'fatigue.error.solidOneHistory', field: 'history:0:stress', diagnostic: null };
  const row = draft.histories[0];
  if (row === undefined || row.imported !== null) return refuse('history:0:stress');
  const curve = fatigueCurve(draft, parameters);
  if ('ok' in curve) return curve;
  const factors = parseStressList(row.stress);
  if (!factors.ok) return { ok: false, key: 'fatigue.error.tensorFactors', field: 'history:0:stress', diagnostic: null };
  const use = historyUse({ ...row, source: { reference: row.source.reference, condition: SOLID_FACTOR_CONDITION } }, 0, parameters);
  if ('ok' in use) return use;
  try {
    const definition = readFatigueSolidSavedInput({ schema: FATIGUE_SOLID_SAVED_SCHEMA, id: 'fatigue', ...binding,
      historyId: row.key, loadFactors: factors.values, sequence: use.sequence, repeats: use.repeats,
      reference: use.source.reference, curve: { ...curve, id: draft.solidCurveId ?? curve.id } }, 'fatigueSolid');
    return { ok: true, entry: { kind: 'fatigue-solid-proportional', definition } };
  } catch (error) { return { ok: false, key: 'fatigue.error.shape', field: 'history:0:stress',
    diagnostic: error instanceof Error ? error.message : null }; }
}

export function restoreSolidFatigueSession(ownerId: string, saved: FatigueSolidSavedInput, documentId = ownerId): FatigueSession {
  const checked = readFatigueSolidSavedInput(saved, 'fatigueSolid');
  if (checked.source.documentId !== documentId) throw new RangeError('Solid fatigue belongs to another document');
  // Reuse exact curve/repeat restoration. Factors remain authored factors, not derived stresses.
  const session = restoreFatigueSession(ownerId, { schema: 'pointercad-fatigue-saved/2', id: 'fatigue', source: { documentId },
    axial: [], input: { schema: 'pointercad-fatigue/1', curve: checked.curve, histories: [{ id: checked.historyId, unit: 'MPa',
      stressMpa: [], sequence: checked.sequence, repeats: checked.repeats,
      source: { kind: 'user-supplied', reference: checked.reference, condition: SOLID_FACTOR_CONDITION } }] } });
  return { ...session, solidAnalyzed: null, draft: { ...session.draft, inputMode: 'solid-proportional',
    solid: { source: { ...checked.source }, inputSha256: checked.inputSha256, elementIndex: checked.elementIndex },
    solidElement: String(checked.elementIndex + 1),
    solidCurveId: checked.curve.id,
    histories: session.draft.histories.map(row => ({ ...row, stress: checked.loadFactors.map(String).join(', ') })) } };
}

export function solidFatigueEntryIsSaved(session: FatigueSession, parameters: readonly Parameter[], saved: FatigueSolidSavedInput): boolean {
  const checked = fatigueSolidSavedEntry(session, parameters, saved.source.documentId);
  return checked.ok && checked.entry.kind === 'fatigue-solid-proportional'
    && JSON.stringify(checked.entry.definition) === JSON.stringify(readFatigueSolidSavedInput(saved, 'fatigueSolid'));
}

export function currentSolidFatigueResult(session: FatigueSession, parameters: readonly Parameter[], source: FatigueSolidSource | null): FatigueSolidAnalyzed | null {
  const analyzed = session.solidAnalyzed;
  return analyzed !== undefined && analyzed !== null && source === analyzed.source
    && solidFatigueEntryIsSaved(session, parameters, analyzed.definition) ? analyzed : null;
}
