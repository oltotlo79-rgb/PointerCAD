import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beamJointInitialStrainInputSha256, decodeBeamJointInitialStrain, translateBeamJointInitialStrain,
  type BeamJointInitialStrainInput } from '@pointercad/fem';
import { TEST_EVIDENCE } from '../../../model/src/analysis/beamInputs.testSupport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { t } from '../i18n/t.js';
import { BeamJointInitialStrainResults } from './BeamJointInitialStrain.js';
import { beamDisplayNumber } from './BeamResults.js';
import recorded from './beamJointInitialStrainNative.fixture.json';

// Exact rawa4dc4da6 from Root's actual20261016-094524 native run.
// The production decoder/view consume the recorded output; the equations below are independent.
function input(): BeamJointInitialStrainInput {
  return { schema: 'pointercad-joint-initial-strain/1', shortenings: [{ boltId: 'shank', shorteningM: .001 }],
    joint: { schema: 'pointercad-joint-contact/1', contact: {
      schema: 'pointercad-beam-contact/1', geometry: { schema: 'pointercad-beam/2', id: 'native-initial-strain', revision: 1,
        source: { documentId: 'native-initial-strain', documentRevision: 1, geometryRevision: 'two-nodes' },
        units: 'N-m', modal: { modeCount: 1, segmentsPerMember: 1 },
        nodes: [{ id: 'a', position: [0, 2, 3] }, { id: 'b', position: [1, 2, 3] }],
        members: [{ id: 'bar', componentId: 'bar', occurrencePath: ['bar'], startNodeId: 'a', endNodeId: 'b',
          materialId: 'material', sectionId: 'section', localYHint: [0, 1, 0] }],
        materials: [{ id: 'material', youngModulus: 1000, shearModulus: 400, densityKgM3: 1, source: TEST_EVIDENCE }],
        sections: [{ id: 'section', area: 1, iy: 1, iz: 1, torsionConstant: 1, shearFactor: 1, source: TEST_EVIDENCE }],
        constraints: [], loads: [] },
      supports: [{ nodeId: 'a', restrained: [true, true, true, true, true, true] },
        { nodeId: 'b', restrained: [false, true, true, false, true, true] }],
      referenceLoads: [{ id: 'external-force', kind: 'nodal', nodeId: 'b', force: [40, 0, 0], moment: [0, 0, 0] }],
      contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'b', normal: [1, 0, 0], gapM: .00002 }],
      loadFactors: [0, .05, 1, -1, 0] },
    bolts: [{ id: 'shank', nodeIdA: 'a', nodeIdB: 'b', youngPa: 2000, areaM2: 1 }],
    welds: [-1, 1].map((sign, index) => ({ id: 'interval-'+index, nodeIdA: 'a', nodeIdB: 'b',
      centerM: [1, 2+sign*.75, 3], normal: [1, 0, 0], along: [0, 1, 0],
      widthM: 1, lengthM: 4, thicknessM: .2, youngPa: 1000, poisson: .25 })) } };
}

beforeEach(() => { resetTestStore(); vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot()); });
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('actual native initial strain in the production joint result view', () => {
  it('displays independent shortening, equilibrium and energy checks for closed, zero-resultant, open, reversed and repeated states', async () => {
    const source = input(), { plan } = translateBeamJointInitialStrain(source), actual = recorded.nativeCalls[0];
    expect(recorded.nativeCalls).toHaveLength(1);
    expect(actual.error).toBeNull();
    expect(plan.joint.contact).toEqual({ ...actual.plan, members: actual.plan.members.map(member => ({ ...member,
      id: 'bar', componentId: 'bar', occurrencePath: ['bar'] })) });
    expect(actual.initialStrainPlan.joint.contact).toEqual(actual.plan);
    expect(plan.joint.bolts).toEqual(actual.initialStrainPlan.joint.bolts);
    expect(plan.joint.welds).toEqual(actual.initialStrainPlan.joint.welds);
    expect(plan.shortenings).toEqual(actual.initialStrainPlan.shortenings);
    expect(recorded.coupled).toEqual(actual.response);
    const result = decodeBeamJointInitialStrain(actual.response, source, await beamJointInitialStrainInputSha256(source));
    // Native EA/L=1000, shank k=2000, weld E*A/t=40000, s=.001; constant initial internal force=2N.
    for (const [index, factor] of [0, .05, 1, -1, 0].entries()) {
      const state = result.states[index], contact = result.contact.states[index], motion = contact.nodes[1];
      const u = Math.max((40*factor-2)/43000, -.00002), reaction = Math.max(0, 2-40*factor-.86);
      const bolt = state.bolts[0];
      expect(state.bolts.map(b => b.id)).toEqual(['shank']);
      expect(state.welds.map(w => w.id)).toEqual(['interval-0', 'interval-1']);
      expect(motion.displacementM[0]).toBeCloseTo(u, 12);
      expect(motion.rotationRad).toEqual([0, 0, 0]);
      expect(bolt.extensionM).toBeCloseTo(u, 12);
      expect(bolt.elasticExtensionM).toBeCloseTo(u+.001, 12);
      expect(bolt.axialForceN).toBeCloseTo(2000*(u+.001), 10);
      expect(bolt.elasticEnergyJ).toBeCloseTo(1000*(u+.001)**2, 12);
      expect(contact.contacts[0].normalReactionN).toBeCloseTo(reaction, 10);
      expect(contact.contacts[0].gapM).toBeCloseTo(.00002+u, 12);
      expect(contact.contacts[0].state).toBe(reaction > 0 ? 'closed' : 'open');
      const weldForce = state.welds.reduce((sum, w) => sum+w.forceOnBN[0], 0);
      expect(weldForce).toBeCloseTo(-40000*u, 10);
      expect(1000*u+bolt.axialForceN-weldForce).toBeCloseTo(40*factor+reaction, 10);
      expect(bolt.elasticEnergyJ+state.welds.reduce((sum, w) => sum+w.elasticEnergyJ, 0)+500*u*u)
        .toBeCloseTo(21500*u*u+2*u+.001, 12);
      const html = renderToStaticMarkup(<BeamJointInitialStrainResults result={result} view={{ state: index }} />);
      const boltRow = html.split('<tr>').find(row => row.startsWith('<th>shank</th>'));
      expect(boltRow).toContain(`data-unit="N" data-value="${bolt.axialForceN}">${beamDisplayNumber(bolt.axialForceN)}<`);
      expect(boltRow).toContain(`data-quantity="extension" data-unit="m" data-value="${bolt.extensionM}">${beamDisplayNumber(bolt.extensionM*1000)}<`);
      expect(boltRow).toContain(`data-quantity="elastic-extension" data-unit="m" data-value="${bolt.elasticExtensionM}">${beamDisplayNumber(bolt.elasticExtensionM*1000)}<`);
      expect(boltRow).toContain(`data-unit="J" data-value="${bolt.elasticEnergyJ}">${beamDisplayNumber(bolt.elasticEnergyJ)}<`);
      for (const [patch, weld] of state.welds.entries()) {
        const sign = patch === 0 ? -1 : 1;
        expect(weld.forceOnBN[0]).toBeCloseTo(-20000*u, 10);
        expect(weld.forceOnBN[2]).toBeCloseTo(0, 10);
        expect(weld.momentOnBNm[2]).toBeCloseTo(20000*sign*.75*u, 10);
        expect(weld.elasticEnergyJ).toBeCloseTo(10000*u*u, 12);
        const rows = html.split('<tr>').filter(row => row.startsWith(`<th>${weld.id}</th>`));
        expect(rows).toHaveLength(4);
        for (const key of ['forceOnAN', 'forceOnBN', 'momentOnANm', 'momentOnBNm'] as const) {
          const row = rows.find(candidate => candidate.includes(`data-quantity="${key}"`));
          for (const value of weld[key]) {
            const unit = key.startsWith('force') ? 'N' : 'N m';
            expect(row).toContain(`data-quantity="${key}" data-unit="${unit}" data-value="${value}">${beamDisplayNumber(value)}<`);
          }
        }
        expect(html).toContain(`data-unit="J" data-value="${weld.elasticEnergyJ}">${weld.id}:`);
      }
      expect(html).toContain(`data-value="${contact.contacts[0].normalReactionN}">${beamDisplayNumber(contact.contacts[0].normalReactionN)}<`);
      expect(html).toContain(`data-unit="m" data-value="${motion.displacementM[0]}">${beamDisplayNumber(motion.displacementM[0]*1000)}<`);
      expect(html.split(t('beam.contactState'))).toHaveLength(2);
    }
    expect(result.states[4]).toEqual(result.states[0]);
    expect(result.contact.states[4]).toEqual(result.contact.states[0]);
  });
});
