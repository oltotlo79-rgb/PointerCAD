import { prepareCadWeldLayers, type AssemblyDocument, type StandardBeamAdapterContext } from '@pointercad/model';
import { translateBeamWeldContact, type BeamWeldContactInput } from './beamWeldContact.js';

/** Current CAD associations -> the existing coupled native input. No new solver or guessed material constants. */
export function prepareCadBeamWeldContact(document: AssemblyDocument, contactDefinition: unknown,
  weldAssociations: unknown, context: StandardBeamAdapterContext): BeamWeldContactInput {
  if (contactDefinition !== null && typeof contactDefinition === 'object' && Object.hasOwn(contactDefinition, 'initialStrain')) {
    throw new Error('initial-strain: explicit initial-strain execution route required');
  }
  const prepared = prepareCadWeldLayers(document, contactDefinition, weldAssociations, context);
  const definition = prepared.contact;
  return translateBeamWeldContact({ schema: 'pointercad-weld-layer/1', welds: prepared.welds,
    contact: { schema: 'pointercad-beam-contact/1', geometry: prepared.geometry,
      supports: definition.supports, referenceLoads: definition.referenceLoads,
      contacts: definition.contact.contacts.map(contact => contact.kind === 'node-plane'
        ? { kind: 'node-plane', id: contact.id, nodeId: contact.nodeId, normal: contact.normal, gapM: contact.gapMm / 1000 }
        : { kind: 'node-pair', id: contact.id, nodeIdA: contact.nodeIdA, nodeIdB: contact.nodeIdB,
          normal: contact.normal, gapM: contact.gapMm / 1000 }), loadFactors: definition.contact.loadFactors } }).input;
}
