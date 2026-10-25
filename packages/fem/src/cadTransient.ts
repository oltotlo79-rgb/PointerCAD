import { standardMembersToBeamAnalysis, type AssemblyDocument, type StandardBeamAdapterContext } from '@pointercad/model';
import { readBeamAnalysisInputs, type AnalysisIssue, type StandardBeamDefinition } from '@pointercad/model/beam-analysis';
import type { BeamTransientInput } from './transientModel.js';
import { translateBeamTransient } from './transientTranslation.js';

export type CadTransientCheck =
  | { readonly ok: true; readonly input: BeamTransientInput }
  | { readonly ok: false; readonly issue: AnalysisIssue };

/** Regenerate current straight CAD geometry for saved schema 4; neither changes CAD nor starts a solver.
 * Same route as standardMembersToBeamBuckling: unloaded, unrestrained schema-2 geometry whose modal settings
 * carry only the mesh refinement (mode count 1 is a placeholder), then the explicit supports, loads and history. */
export function standardMembersToBeamTransient(
  document: AssemblyDocument,
  definitionValue: unknown,
  context: StandardBeamAdapterContext,
): CadTransientCheck {
  const checked = readBeamAnalysisInputs({
    schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition: definitionValue }],
  }, document.id);
  if (!checked.ok) return checked;
  const saved = checked.value.analyses[0];
  if (saved?.kind !== 'standard-members' || saved.definition.schema !== 'pointercad-standard-beam/4') {
    return { ok: false, issue: { code: 'unsupported-analysis', path: '$', message: 'Expected saved transient schema 4' } };
  }
  const definition = saved.definition;
  const geometryDefinition: StandardBeamDefinition = {
    schema: 'pointercad-standard-beam/2', modal: { modeCount: 1, segmentsPerMember: definition.transient.segmentsPerMember },
    id: definition.id, revision: definition.revision, source: definition.source, units: definition.units,
    members: definition.members, materials: definition.materials, sections: definition.sections,
    constraints: [], loads: [],
  };
  const derived = standardMembersToBeamAnalysis(document, geometryDefinition, context);
  if (!derived.ok) return derived;
  try {
    const prepared = translateBeamTransient({
      schema: 'pointercad-beam-transient/1', geometry: derived.document,
      supports: definition.supports, referenceLoads: definition.referenceLoads, history: definition.transient.history,
    });
    return { ok: true, input: prepared.input };
  } catch (error) {
    return { ok: false, issue: { code: 'transient-input', path: '$',
      message: error instanceof Error ? error.message : 'Transient input could not be prepared' } };
  }
}
