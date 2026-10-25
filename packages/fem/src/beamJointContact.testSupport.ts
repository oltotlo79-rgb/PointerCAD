import type { BeamJointContactInput } from './beamJointContact.js';
import { axialOscillator, transientHistory } from './transient.testSupport.js';

export function jointTestInput(millimetres = false): BeamJointContactInput {
  const { geometry, supports, referenceLoads } = axialOscillator(transientHistory(1e-4, 10, [[0, 1], [10, 1]]), { millimetres });
  return { schema: 'pointercad-joint-contact/1', contact: { schema: 'pointercad-beam-contact/1', geometry, supports, referenceLoads,
    contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'node-1', normal: [-1, 0, 0], gapM: .001 }], loadFactors: [1] },
  bolts: [{ id: 'bolt', nodeIdA: 'node-0', nodeIdB: 'node-1', youngPa: 210e9, areaM2: .001 }],
  welds: [{ id: 'weld', nodeIdA: 'node-0', nodeIdB: 'node-1', youngPa: 210e9, poisson: .3,
    centerM: [1, 0, 0], normal: [1, 0, 0], along: [0, 1, 0], widthM: .1, lengthM: .01, thicknessM: 1 }] };
}
export function jointTestRaw() {
  // Three independent parallel branches: beam=bolt=weld=210e6 N/m, F=1000N.
  const u = 1000/(3*210e6), force = 1000/3;
  return { schema: 'pointercad-joint-contact-result/1', contact: {
    schema: 'pointercad-oofem-contact-result/1', method: 'murty-least-index-lcp-on-native-beam3d-stiffness',
    freeDofs: 1, meshNodes: 2, meshElements: 1, momentLengthM: 1, pivotLimit: 20,
    states: [{ loadFactor: 1, pivots: 0, forceScaleN: 1000, gapScaleM: .001, equilibriumResidual: 0,
      penetration: 0, tension: 0, complementarity: 0,
      nodes: [{ number: 1, displacementM: [0, 0, 0], rotationRad: [0, 0, 0] },
        { number: 2, displacementM: [u, 0, 0], rotationRad: [0, 0, 0] }],
      contacts: [{ id: 'stop', state: 'open', normalReactionN: 0, gapM: .001-u }] }] },
    states: [{ loadFactor: 1, bolts: [{ id: 'bolt', extensionM: u, axialForceN: force,
      forceOnAN: [force, 0, 0], forceOnBN: [-force, 0, 0] }],
    welds: [{ id: 'weld', forceOnAN: [force, 0, 0], forceOnBN: [-force, 0, 0], momentOnANm: [0, 0, 0],
      momentOnBNm: [0, 0, 0], elasticEnergyJ: force*u/2 }] }] };
}

