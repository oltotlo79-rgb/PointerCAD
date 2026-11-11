import { readCadWeldSpanInputs } from '@pointercad/model/beam-analysis';
import { beamDefinition, invalidateBeamSession, type BeamSession } from './beamSession.js';
import type { BeamSourceSnapshot } from './beamSource.js';
import { prepareBeamAnalysis } from './prepareBeamAnalysis.js';

/** Explicit review only: construct a proposal without changing the persisted source or input.
 * Existing part/placement/material/group/footprint checks decide whether the proposal can be accepted.
 * Merely opening or editing a saved draft never calls this function. */
export function reassociateBeamWeldSpan(session: BeamSession, source: BeamSourceSnapshot):
  { readonly ok: true; readonly session: BeamSession } | { readonly ok: false; readonly reason: string } {
  try {
    const saved = readCadWeldSpanInputs(session.weldSpanLayers);
    if (session.ownerId !== source.ownership.activeDocumentId || saved.source.documentId !== source.document.id
      || saved.analysisId !== session.analysisId || saved.analysisRevision !== session.revision) {
      return { ok: false, reason: 'weld-span-owner: saved document, opening and analysis must match' };
    }
    const proposal: BeamSession = { ...invalidateBeamSession(session),
      weldSpanLayers: { ...saved, source: { ...source.source } } };
    const draft = beamDefinition(proposal, source, source.document.parameters);
    if (!draft.ok) return { ok: false, reason: draft.diagnostic ?? draft.key };
    const prepared = prepareBeamAnalysis(source, draft.definition);
    if (!prepared.ok) return { ok: false, reason: `${prepared.issue.code}: ${prepared.issue.path}: ${prepared.issue.message}` };
    if (prepared.kind !== 'weld-span-contact') return { ok: false, reason: 'weld-span-route: dedicated preparation required' };
    return { ok: true, session: proposal };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Invalid saved weld span input' };
  }
}
