import { standardMembersToBeamAnalysis, type AssemblyDocument, type StandardBeamAdapterContext } from '@pointercad/model';
import { readBeamAnalysisInputs, type StandardBeamDefinition } from '@pointercad/model/beam-analysis';
import { translateBeamFrictionContact, type BeamFrictionContactInput } from './frictionContactTranslation.js';

/** Saved schema 7 and current CAD ownership -> the dedicated friction input. No solver or joint coercion. */
export function prepareCadBeamFrictionContact(document: AssemblyDocument, definitionValue: unknown,
  context: StandardBeamAdapterContext): BeamFrictionContactInput {
  const checked = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1',
    analyses: [{ kind: 'standard-members', definition: definitionValue }] }, document.id);
  if (!checked.ok) throw new Error(`friction-cad: ${checked.issue.code} at ${checked.issue.path}: ${checked.issue.message}`);
  const item = checked.value.analyses[0];
  if (item?.kind !== 'standard-members' || item.definition.schema !== 'pointercad-standard-beam/7') {
    throw new Error('friction-cad: explicit standard-beam schema 7 required');
  }
  const definition = item.definition;
  // Reuse only the existing unloaded schema-2 geometry/mesh route. Friction supports and every load stage are explicit below.
  const geometryDefinition: StandardBeamDefinition = {
    schema: 'pointercad-standard-beam/2', id: definition.id, revision: definition.revision,
    source: definition.source, units: definition.units, members: definition.members,
    materials: definition.materials, sections: definition.sections, constraints: [], loads: [],
    modal: { modeCount: 1, segmentsPerMember: definition.contact.segmentsPerMember },
  };
  const derived = standardMembersToBeamAnalysis(document, geometryDefinition, context);
  if (!derived.ok) throw new Error(`friction-cad: ${derived.issue.code} at ${derived.issue.path}: ${derived.issue.message}`);
  return translateBeamFrictionContact({ schema: 'pointercad-beam-friction-contact/1', geometry: derived.document,
    supports: definition.supports, friction: definition.friction, stepLoads: definition.stepLoads,
    contacts: definition.contact.contacts.map(contact => contact.kind === 'node-plane'
      ? { kind: 'node-plane', id: contact.id, nodeId: contact.nodeId, normal: contact.normal, gapM: contact.gapMm / 1000 }
      : { kind: 'node-pair', id: contact.id, nodeIdA: contact.nodeIdA, nodeIdB: contact.nodeIdB,
        normal: contact.normal, gapM: contact.gapMm / 1000 }),
  }).input;
}
