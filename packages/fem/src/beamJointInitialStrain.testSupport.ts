import type { BeamJointInitialStrainInput } from './beamJointInitialStrain.js';
import { jointTestInput, jointTestRaw } from './beamJointContact.testSupport.js';

export function initialStrainTestInput(shorteningM = 1e-6): BeamJointInitialStrainInput {
  const joint = jointTestInput();
  return { schema: 'pointercad-joint-initial-strain/1', joint: { ...joint,
    contact: { ...joint.contact, loadFactors: [1, 0, -1] } }, shortenings: [{ boltId: 'bolt', shorteningM }] };
}
export function initialStrainTestRaw(shorteningM = 1e-6) {
  // Three parallel branches each k=210e6. Equilibrium: 3*k*u+k*s=F.
  // The right-hand stop is open in all three independently constructed states.
  const base = jointTestRaw(), k = 210e6;
  const states = [1, 0, -1].map(factor => {
    const u = (factor*1000-k*shorteningM)/(3*k), elastic = u+shorteningM;
    const boltForce = k*elastic, weldForce = k*u;
    return { factor, u, bolt: { id: 'bolt', extensionM: u, elasticExtensionM: elastic,
      axialForceN: boltForce, forceOnAN: [boltForce, 0, 0], forceOnBN: [-boltForce, 0, 0],
      elasticEnergyJ: k*elastic*elastic/2 }, weld: { id: 'weld', forceOnAN: [weldForce, 0, 0],
      forceOnBN: [-weldForce, 0, 0], momentOnANm: [0, 0, 0], momentOnBNm: [0, 0, 0], elasticEnergyJ: k*u*u/2 } };
  });
  return { schema: 'pointercad-joint-initial-strain-result/1', contact: { ...base.contact,
    states: states.map(({ factor, u }) => ({ ...base.contact.states[0], loadFactor: factor,
      nodes: [{ number: 1, displacementM: [0, 0, 0], rotationRad: [0, 0, 0] },
        { number: 2, displacementM: [u, 0, 0], rotationRad: [0, 0, 0] }],
      contacts: [{ id: 'stop', state: 'open', normalReactionN: 0, gapM: .001-u }] })) },
    states: states.map(({ factor, bolt, weld }) => ({ loadFactor: factor, bolts: [bolt], welds: [weld] })) };
}
