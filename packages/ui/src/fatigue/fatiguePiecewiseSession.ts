import { fatigueSolidSavedEntry, restoreSolidFatigueSession, solidFatigueEntryIsSaved } from './fatigueSolidSession.js';
import type { FatigueCorrectedResult, FatiguePiecewiseResult, FatigueResult } from '@pointercad/fem';
import { exactExpressionValueFromNumber } from '@pointercad/expression';
import type { Parameter } from '@pointercad/model';
import type { FatiguePiecewiseSavedInput, FatigueSavedPiecewiseProblem } from '@pointercad/model/beam-analysis';
import { analyzePiecewiseDraft, createPiecewiseDraft, editPiecewiseDraft, piecewiseProblem, piecewiseSavedInput,
  restorePiecewiseDraft, type FatiguePiecewiseCheck, type FatiguePiecewiseCommon, type FatiguePiecewiseDraft,
  type FatiguePiecewiseEdit } from './fatiguePiecewiseDraft.js';
import { createFatigueSession, currentFatigueResult, editFatigueSession, fatigueEntryIsSaved, fatigueSavedEntry,
  fatigueStressHistories, restoreFatigueSession, restoreTensorFatigueSession, type FatigueEdit, type FatigueSavedEntry,
  type FatigueSavedEntryCheck, type FatigueSession } from './fatigueSession.js';

/**
 * The piecewise (multi-slope) S-N mode of the fatigue panel, connected to the existing session. Dependency direction:
 * this module imports fatigueSession.ts and fatiguePiecewiseDraft.ts; fatigueSession.ts imports neither at run time
 * (only types), so no module reads an uninitialized constant of the other (fatiguePiecewiseDraft.ts builds its error
 * table from fatigueSession.ts constants when it is loaded).
 *
 * The histories are the panel's stress histories built by the existing builder (fatigueStressHistories), so counting,
 * recurrence and the saved history form are not duplicated. The piecewise result is derived only: every input edit
 * clears it (editFatigueSession), a result is shown only while the current draft builds exactly the analyzed input,
 * and it is never saved or restored.
 */
export type FatigueAnyEdit = FatigueEdit | { readonly kind: 'piecewise'; readonly edit: FatiguePiecewiseEdit };

/** The piecewise draft of the session, or the empty one before the mode is first chosen. */
export function sessionPiecewiseDraft(session: FatigueSession): FatiguePiecewiseDraft {
  return session.draft.piecewise ?? createPiecewiseDraft();
}

function piecewiseCommon(session: FatigueSession): FatiguePiecewiseCommon {
  const draft = session.draft;
  return { stressDefinition: draft.stressDefinition, meanStressAssumption: draft.meanStressAssumption, curveSource: draft.curveSource };
}

/** Every edit of the panel. A piecewise row edit goes through the same input edit (new revision, result cleared); a
 * refused row edit changes nothing. Choosing the piecewise mode the first time starts its empty draft. */
export function editFatigueSessionWithPiecewise(session: FatigueSession, edit: FatigueAnyEdit): FatigueSession {
  if (edit.kind === 'piecewise') {
    const before = sessionPiecewiseDraft(session);
    const after = editPiecewiseDraft(before, edit.edit);
    if (after === before && session.draft.piecewise !== undefined) return session;
    return editFatigueSession(session, { kind: 'piecewise-draft', draft: after });
  }
  if (edit.kind === 'input-mode' && edit.value === 'piecewise' && session.draft.piecewise === undefined) {
    return editFatigueSession(editFatigueSession(session, { kind: 'piecewise-draft', draft: createPiecewiseDraft() }), edit);
  }
  return editFatigueSession(session, edit);
}

/** The validated piecewise input of the current draft (histories first, as built by the existing history builder). */
export function piecewiseSessionProblem(session: FatigueSession, parameters: readonly Parameter[]): FatiguePiecewiseCheck {
  const histories = fatigueStressHistories(session.draft, parameters);
  if (!histories.ok) return histories;
  return piecewiseProblem(sessionPiecewiseDraft(session), piecewiseCommon(session), histories.histories, parameters);
}

/** Runs the actual core on the current draft. A refusal clears any result and names its row or field. */
export function runPiecewiseFatigue(session: FatigueSession, parameters: readonly Parameter[]): FatigueSession {
  const histories = fatigueStressHistories(session.draft, parameters);
  const checked = histories.ok
    ? analyzePiecewiseDraft(sessionPiecewiseDraft(session), piecewiseCommon(session), histories.histories, parameters) : histories;
  if (!checked.ok) {
    return { ...session, analyzed: null, piecewiseAnalyzed: null, errorKey: checked.key, diagnostic: checked.diagnostic,
      focusedField: checked.field ?? session.focusedField };
  }
  return { ...session, analyzed: null, piecewiseAnalyzed: { problem: checked.problem, result: checked.result }, errorKey: null,
    diagnostic: null };
}

/** Equal piecewise inputs: every key and number of the two validated inputs (both are fresh core-built values with the
 * same key order; every number is finite, so the serialized forms are equal exactly when the values are). */
function samePiecewiseProblem(left: FatigueSavedPiecewiseProblem, right: FatigueSavedPiecewiseProblem): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The result shown by the panel in any mode. A piecewise result is current only in the piecewise mode and only while
 * the current draft and parameters build exactly the analyzed input. */
export function currentFatigueResultWithPiecewise(session: FatigueSession, parameters: readonly Parameter[]):
  FatigueResult | FatigueCorrectedResult | FatiguePiecewiseResult | null {
  if (session.draft.inputMode !== 'piecewise') return currentFatigueResult(session, parameters);
  const analyzed = session.piecewiseAnalyzed;
  if (analyzed === null || analyzed === undefined) return null;
  const now = piecewiseSessionProblem(session, parameters);
  return now.ok && samePiecewiseProblem(now.problem, analyzed.problem) ? analyzed.result : null;
}

/** The saved form of the current draft in the document `documentId`: the version 5 input in the piecewise mode,
 * otherwise the existing forms. Inputs and sources only, never a result. */
export function fatigueSavedEntryWithPiecewise(session: FatigueSession, parameters: readonly Parameter[], documentId: string):
  FatigueSavedEntryCheck {
  if (session.draft.inputMode === 'solid-proportional') return fatigueSolidSavedEntry(session, parameters, documentId);
  if (session.draft.inputMode !== 'piecewise') return fatigueSavedEntry(session, parameters, documentId);
  const checked = piecewiseSessionProblem(session, parameters);
  if (!checked.ok) return checked;
  return { ok: true, entry: { kind: 'fatigue-piecewise', definition: piecewiseSavedInput(checked.problem, documentId) } };
}

/** True when the current draft is exactly the saved configuration, including the solid selection form. */
export function fatigueEntryIsSavedWithPiecewise(session: FatigueSession, parameters: readonly Parameter[],
  saved: FatigueSavedEntry | null): boolean {
  if (saved?.kind === 'fatigue-solid-proportional') return solidFatigueEntryIsSaved(session, parameters, saved.definition);
  if (saved?.kind !== 'fatigue-piecewise') return fatigueEntryIsSaved(session, parameters, saved);
  if (session.draft.inputMode !== 'piecewise') return false;
  const current = piecewiseSessionProblem(session, parameters);
  return current.ok && samePiecewiseProblem(current.problem, saved.definition.input);
}

/** Restores a saved version 5 input in the piecewise mode: the shared curve fields, the stress histories (exact number
 * form for repeats, shortest round-trip form for stresses, as restoreFatigueSession) and the calibration rows. No result. */
export function restorePiecewiseFatigueSession(ownerId: string, saved: FatiguePiecewiseSavedInput): FatigueSession {
  const exact = (value: number): string => exactExpressionValueFromNumber(value).source;
  const { curve, histories } = saved.input;
  let next = histories.length + 1;
  while (histories.some(history => history.id === `history-${next}`)) next += 1;
  const empty = createFatigueSession(ownerId);
  return { ...empty, draft: { ...empty.draft, stressDefinition: curve.stressDefinition, meanStressAssumption: curve.meanStressAssumption,
    curveSource: { reference: curve.source.reference, condition: curve.source.condition }, nextHistory: next,
    histories: histories.map(history => ({ key: history.id, stress: history.stressMpa.map(String).join(', '),
      sequence: history.sequence, repeats: history.sequence === 'once' ? '' : exact(history.repeats),
      source: { reference: history.source.reference, condition: history.source.condition }, imported: null })),
    inputMode: 'piecewise', piecewise: restorePiecewiseDraft(saved) } };
}

/** Restores whichever fatigue configuration a document holds (a document holds at most one). */
export function restoreSavedFatigueEntry(ownerId: string, saved: FatigueSavedEntry, documentId = ownerId): FatigueSession {
  switch (saved.kind) {
    case 'fatigue-solid-proportional': return restoreSolidFatigueSession(ownerId, saved.definition, documentId);
    case 'fatigue': return restoreFatigueSession(ownerId, saved.definition);
    case 'fatigue-proportional-tensor': return restoreTensorFatigueSession(ownerId, saved.definition);
    case 'fatigue-piecewise': return restorePiecewiseFatigueSession(ownerId, saved.definition);
  }
}
