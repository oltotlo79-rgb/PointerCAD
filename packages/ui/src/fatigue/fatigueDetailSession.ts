import type { FatigueDetailResult } from '@pointercad/fem';
import { exactExpressionValueFromNumber } from '@pointercad/expression';
import type { Parameter } from '@pointercad/model';
import type { FatigueDetailSavedInput } from '@pointercad/model/beam-analysis';
import { createPiecewiseDraft, type FatiguePiecewiseCommon, type FatiguePiecewiseDraft } from './fatiguePiecewiseDraft.js';
import { analyzeDetailDraft, createDetailDraft, detailProblem, detailSavedInput, restoreDetailDraft, type FatigueDetailCheck,
  type FatigueDetailDraft } from './fatigueDetailDraft.js';
import { createFatigueSession, type FatigueSavedEntryCheck, type FatigueSession } from './fatigueSession.js';

/**
 * The joint (weld or bolt) mode of the fatigue panel, connected to the existing session in the same way as the piecewise
 * mode: the calibration is the panel's piecewise calibration and the histories are the panel's histories. Dependency
 * direction: fatiguePiecewiseSession.ts imports this module; this module imports fatigueSession.ts, fatiguePiecewiseDraft.ts
 * and fatigueDetailDraft.ts only. The joint result is derived only: every input edit clears it (editFatigueSession), it
 * is shown only while the current draft builds exactly the analyzed input, and it is never saved or restored.
 */
export function sessionDetailDraft(session: FatigueSession): FatigueDetailDraft {
  return session.draft.detail ?? createDetailDraft();
}
function sessionCalibration(session: FatigueSession): FatiguePiecewiseDraft {
  return session.draft.piecewise ?? createPiecewiseDraft();
}
function detailCommon(session: FatigueSession): FatiguePiecewiseCommon {
  const draft = session.draft;
  return { stressDefinition: draft.stressDefinition, meanStressAssumption: draft.meanStressAssumption, curveSource: draft.curveSource };
}

/** The validated joint input of the current draft. */
export function detailSessionProblem(session: FatigueSession, parameters: readonly Parameter[]): FatigueDetailCheck {
  return detailProblem(sessionDetailDraft(session), sessionCalibration(session), detailCommon(session), session.draft.histories, parameters);
}

/** Runs the actual joint core on the current draft. A refusal clears any result and names its field. */
export function runDetailFatigue(session: FatigueSession, parameters: readonly Parameter[]): FatigueSession {
  const checked = analyzeDetailDraft(sessionDetailDraft(session), sessionCalibration(session), detailCommon(session),
    session.draft.histories, parameters);
  if (!checked.ok) {
    return { ...session, analyzed: null, piecewiseAnalyzed: null, detailAnalyzed: null, errorKey: checked.key,
      diagnostic: checked.diagnostic, focusedField: checked.field ?? session.focusedField };
  }
  return { ...session, analyzed: null, piecewiseAnalyzed: null, detailAnalyzed: { input: checked.input, result: checked.result },
    errorKey: null, diagnostic: null };
}

/** The joint result shown by the panel: only in the joint mode and only while the current draft and parameters build
 * exactly the analyzed input (both are fresh core-built values with the same key order and finite numbers). */
export function currentDetailResult(session: FatigueSession, parameters: readonly Parameter[]): FatigueDetailResult | null {
  const analyzed = session.detailAnalyzed;
  if (session.draft.inputMode !== 'detail' || analyzed === null || analyzed === undefined) return null;
  const now = detailSessionProblem(session, parameters);
  return now.ok && JSON.stringify(now.input) === JSON.stringify(analyzed.input) ? analyzed.result : null;
}

/** The smallest and largest nominal stress (MPa) of each converted history of a joint result, so that the user can check
 * them against force / area. A plain loop over each list (no spread of up to 100000 values into Math.min/Math.max). */
export function detailStressSpans(result: FatigueDetailResult): readonly { readonly historyId: string; readonly minimumMpa: number;
  readonly maximumMpa: number }[] {
  return result.stressHistories.map(history => {
    let minimumMpa = Number.POSITIVE_INFINITY, maximumMpa = Number.NEGATIVE_INFINITY;
    for (const stress of history.stressMpa) {
      if (stress < minimumMpa) minimumMpa = stress;
      if (stress > maximumMpa) maximumMpa = stress;
    }
    return { historyId: history.id, minimumMpa, maximumMpa };
  });
}

/** The saved version 6 form of the current joint draft in the document `documentId` (inputs and sources only). */
export function detailSavedEntry(session: FatigueSession, parameters: readonly Parameter[], documentId: string): FatigueSavedEntryCheck {
  const checked = detailSessionProblem(session, parameters);
  if (!checked.ok) return checked;
  const saved = detailSavedInput(checked.input, documentId);
  if (!saved.ok) return saved;
  return { ok: true, entry: { kind: 'fatigue-detail', definition: saved.saved } };
}

/** True when the current draft is exactly the saved joint configuration of that document. */
export function detailEntryIsSaved(session: FatigueSession, parameters: readonly Parameter[], saved: FatigueDetailSavedInput): boolean {
  if (session.draft.inputMode !== 'detail') return false;
  const current = detailSavedEntry(session, parameters, saved.source.documentId);
  return current.ok && JSON.stringify(current.entry.definition) === JSON.stringify(saved);
}

/** Restores a saved version 6 input in the joint mode: the shared curve fields, the histories (sequence, repeats and
 * source; the MPa lists of a stress quantity, the N lists of a force quantity in the joint draft), the calibration rows
 * and the joint. No result. */
export function restoreDetailFatigueSession(ownerId: string, saved: FatigueDetailSavedInput): FatigueSession {
  const exact = (value: number): string => exactExpressionValueFromNumber(value).source;
  const { loading, curve } = saved.input;
  const calibration = curve.calibration;
  const rows = loading.quantity === 'detail-stress'
    ? loading.histories.map(history => ({ id: history.id, stress: history.stressMpa.map(String).join(', '), sequence: history.sequence,
      repeats: history.repeats, source: history.source }))
    : loading.histories.map(history => ({ id: history.id, stress: '', sequence: history.sequence, repeats: history.repeats,
      source: history.source }));
  let next = rows.length + 1;
  while (rows.some(row => row.id === `history-${next}`)) next += 1;
  const { detail, piecewise } = restoreDetailDraft(saved);
  const empty = createFatigueSession(ownerId);
  return { ...empty, draft: { ...empty.draft, stressDefinition: calibration.stressDefinition,
    meanStressAssumption: calibration.meanStressAssumption,
    curveSource: { reference: calibration.source.reference, condition: calibration.source.condition }, nextHistory: next,
    histories: rows.map(row => ({ key: row.id, stress: row.stress, sequence: row.sequence,
      repeats: row.sequence === 'once' ? '' : exact(row.repeats),
      source: { reference: row.source.reference, condition: row.source.condition }, imported: null })),
    inputMode: 'detail', piecewise, detail } };
}
