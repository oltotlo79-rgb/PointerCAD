import type { AssemblyDocument, StandardBeamAdapterContext } from '@pointercad/model';
import { prepareCadBeamBoltContact } from './cadBeamBoltContact.js';
import { prepareCadBeamWeldContact } from './cadBeamWeldContact.js';
import { translateBeamJointContact, type BeamJointContactInput } from './beamJointContact.js';

/** Both current CAD ownership adapters must succeed on the same source, geometry and explicit contact setup. */
export function prepareCadBeamJointContact(document: AssemblyDocument, contactDefinition: unknown,
  boltAssociations: unknown, weldAssociations: unknown, context: StandardBeamAdapterContext): BeamJointContactInput {
  if (contactDefinition !== null && typeof contactDefinition === 'object' && Object.hasOwn(contactDefinition, 'initialStrain')) {
    throw new Error('initial-strain: explicit initial-strain execution route required');
  }
  const bolt = prepareCadBeamBoltContact(document, contactDefinition, boltAssociations, context);
  const weld = prepareCadBeamWeldContact(document, contactDefinition, weldAssociations, context);
  if (JSON.stringify(bolt.contact) !== JSON.stringify(weld.contact)) throw new Error('joint-contact: CAD owners or physical inputs differ');
  return translateBeamJointContact({ schema: 'pointercad-joint-contact/1', contact: bolt.contact,
    bolts: bolt.bolts, welds: weld.welds }).input;
}
