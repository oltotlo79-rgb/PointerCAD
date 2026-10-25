import type { AssemblyDocument, StandardBeamAdapterContext } from '@pointercad/model';
import { readBeamAnalysisInputs, readCadJointInitialStrain } from '@pointercad/model/beam-analysis';
import { prepareCadBeamJointContact } from './cadBeamJointContact.js';
import { translateBeamJointInitialStrain, type BeamJointInitialStrainInput } from './beamJointInitialStrain.js';

/** Revalidate persisted assumptions and both current CAD families before the SI conversion. */
export function prepareCadBeamJointInitialStrain(document: AssemblyDocument, definition: unknown,
  context: StandardBeamAdapterContext): BeamJointInitialStrainInput {
  const checked = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1',
    analyses: [{ kind: 'standard-members', definition }] }, document.id);
  if (!checked.ok) throw new Error(`${checked.issue.code}: ${checked.issue.message}`);
  const item = checked.value.analyses[0];
  if (item.kind !== 'standard-members' || item.definition.schema !== 'pointercad-standard-beam/5') throw new Error('initial-strain-definition');
  const current = item.definition;
  if (current.axialBolts === undefined || current.weldLayers === undefined || current.initialStrain === undefined) throw new Error('initial-strain-joint');
  const { initialStrain, ...unstrained } = current;
  const joint = prepareCadBeamJointContact(document, unstrained, current.axialBolts, current.weldLayers, context);
  const initial = readCadJointInitialStrain(initialStrain, joint.bolts.map(b => b.id));
  return translateBeamJointInitialStrain({ schema: 'pointercad-joint-initial-strain/1', joint,
    shortenings: initial.shortenings.map(row => ({ boltId: row.boltId, shorteningM: row.shorteningMm/1000 })) }).input;
}
