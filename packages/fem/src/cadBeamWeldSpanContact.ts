import { prepareCadWeldSpanLayers, type AssemblyDocument, type StandardBeamAdapterContext } from '@pointercad/model';
import { translateBeamWeldSpanContact, type BeamWeldSpanContactInput } from './beamWeldSpanContact.js';

/** Current saved /2 CAD ownership -> dedicated full-mesh span input; no bolt/initial-strain coercion. */
export function prepareCadBeamWeldSpanContact(document: AssemblyDocument, contactDefinition: unknown,
  weldAssociations: unknown, context: StandardBeamAdapterContext): BeamWeldSpanContactInput {
  const prepared = prepareCadWeldSpanLayers(document, contactDefinition, weldAssociations, context);
  const definition = prepared.contact;
  return translateBeamWeldSpanContact({ schema: 'pointercad-weld-span/1', patches: prepared.welds,
    contact: { schema: 'pointercad-beam-contact/1', geometry: prepared.geometry,
      supports: definition.supports, referenceLoads: definition.referenceLoads,
      contacts: definition.contact.contacts.map(contact => contact.kind === 'node-plane'
        ? { kind: 'node-plane', id: contact.id, nodeId: contact.nodeId, normal: contact.normal, gapM: contact.gapMm/1000 }
        : { kind: 'node-pair', id: contact.id, nodeIdA: contact.nodeIdA, nodeIdB: contact.nodeIdB,
          normal: contact.normal, gapM: contact.gapMm/1000 }), loadFactors: definition.contact.loadFactors } }).input;
}
