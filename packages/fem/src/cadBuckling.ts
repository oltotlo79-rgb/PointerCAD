import { standardMembersToBeamAnalysis, type AssemblyDocument, type StandardBeamAdapterContext } from '@pointercad/model';
import { readBeamAnalysisInputs, type AnalysisIssue, type StandardBeamDefinition } from '@pointercad/model/beam-analysis';
import type { BeamBucklingInput } from './bucklingModel.js';
import { translateBeamBuckling } from './bucklingTranslation.js';

export type CadBucklingCheck =
  | { readonly ok: true; readonly input: BeamBucklingInput }
  | { readonly ok: false; readonly issue: AnalysisIssue };

/** Regenerate current straight CAD geometry; neither changes CAD nor starts a solver. */
export function standardMembersToBeamBuckling(
  document: AssemblyDocument,
  definitionValue: unknown,
  context: StandardBeamAdapterContext,
): CadBucklingCheck {
  const checked = readBeamAnalysisInputs({
    schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition: definitionValue }],
  }, document.id);
  if (!checked.ok) return checked;
  const saved = checked.value.analyses[0];
  if (saved?.kind !== 'standard-members' || saved.definition.schema !== 'pointercad-standard-beam/3') {
    return { ok: false, issue: { code: 'unsupported-analysis', path: '$', message: 'Expected saved buckling schema 3' } };
  }
  const definition = saved.definition;
  const geometryDefinition: StandardBeamDefinition = {
    schema: 'pointercad-standard-beam/2', modal: definition.buckling,
    id: definition.id, revision: definition.revision, source: definition.source, units: definition.units,
    members: definition.members, materials: definition.materials, sections: definition.sections,
    constraints: [], loads: [],
  };
  const derived = standardMembersToBeamAnalysis(document, geometryDefinition, context);
  if (!derived.ok) return derived;
  try {
    const prepared = translateBeamBuckling({
      schema: 'pointercad-beam-buckling/1', geometry: derived.document,
      supports: definition.supports, referenceLoads: definition.referenceLoads,
    });
    return { ok: true, input: prepared.input };
  } catch (error) {
    return { ok: false, issue: { code: 'buckling-input', path: '$',
      message: error instanceof Error ? error.message : 'Buckling input could not be prepared' } };
  }
}
