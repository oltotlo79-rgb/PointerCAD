import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beamJointContactInputSha256, decodeBeamJointContact, translateBeamJointContact, type BeamJointContactInput } from '@pointercad/fem';
import { TEST_EVIDENCE } from '../../../model/src/analysis/beamInputs.testSupport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { t } from '../i18n/t.js';
import { BeamJointResults } from './BeamJointResults.js';
import { beamDisplayNumber } from './BeamResults.js';
import recorded from './beamJointNative.fixture.json';

// Exact raw proof3cb419f7 from Root's actual20261016-092106 native run.
// This checks the production decoder/view; it does not rerun or substitute the native solver.
function input(): BeamJointContactInput {
  return { schema: 'pointercad-joint-contact/1', contact: {
    schema: 'pointercad-beam-contact/1', geometry: { schema: 'pointercad-beam/2', id: 'native-mixed', revision: 1,
      source: { documentId: 'native-mixed', documentRevision: 1, geometryRevision: 'two-nodes' },
      units: 'N-m', modal: { modeCount: 1, segmentsPerMember: 1 },
      nodes: [{ id: 'a', position: [0, 2, 3] }, { id: 'b', position: [1, 2, 3] }],
      members: [{ id: 'bar', componentId: 'bar', occurrencePath: ['bar'], startNodeId: 'a', endNodeId: 'b',
        materialId: 'material', sectionId: 'section', localYHint: [0, 1, 0] }],
      materials: [{ id: 'material', youngModulus: 1000, shearModulus: 400, densityKgM3: 1, source: TEST_EVIDENCE }],
      sections: [{ id: 'section', area: 1, iy: 1, iz: 1, torsionConstant: 1, shearFactor: 1, source: TEST_EVIDENCE }],
      constraints: [], loads: [] },
    supports: [{ nodeId: 'a', restrained: [true, true, true, true, true, true] },
      { nodeId: 'b', restrained: [false, true, true, false, true, true] }],
    referenceLoads: [{ id: 'force-and-torque', kind: 'nodal', nodeId: 'b', force: [40, 0, 0], moment: [80/3, 0, 0] }],
    contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'b', normal: [-1, 0, 0], gapM: .0005 }],
    loadFactors: [.2, 1, -1, 0, 1] },
    bolts: [{ id: 'shank', nodeIdA: 'a', nodeIdB: 'b', youngPa: 2000, areaM2: 1 }],
    welds: [-1, 1].map((sign, index) => ({ id: 'interval-'+index, nodeIdA: 'a', nodeIdB: 'b',
      centerM: [1, 2+sign*.75, 3], normal: [1, 0, 0], along: [0, 1, 0],
      widthM: 1, lengthM: 4, thicknessM: .2, youngPa: 1000, poisson: .25 })) };
}

beforeEach(() => { resetTestStore(); vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot()); });
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('actual native simultaneous shank and weld result in the production view', () => {
  it('keeps the common open, closed, reversed, zero and repeated states with independent force, moment and energy oracles', async () => {
    const source = input(), { plan } = translateBeamJointContact(source), actual = recorded.nativeCalls[0];
    expect(recorded.nativeCalls).toHaveLength(1);
    expect(actual.error).toBeNull();
    expect(plan.contact).toEqual({ ...actual.plan, members: actual.plan.members.map(member => ({ ...member,
      id: 'bar', componentId: 'bar', occurrencePath: ['bar'] })) });
    expect(actual.jointPlan.contact).toEqual(actual.plan);
    expect(plan.bolts).toEqual(actual.jointPlan.bolts);
    expect(plan.welds).toEqual(actual.jointPlan.welds);
    expect(recorded.coupled).toEqual(actual.response);
    const result = decodeBeamJointContact(actual.response, source, await beamJointContactInputSha256(source));
    // Native beam EA/L=1000, shank k=2000, weld E*A/t=40000. Two disjoint rectangles:
    // A=8; integral y^2=31/6, integral z^2=32/3; weld G/t=2000, native GJ/L=400.
    const torsion = 2000*95/6;
    for (const [index, factor] of [.2, 1, -1, 0, 1].entries()) {
      const state = result.states[index], contact = result.contact.states[index], motion = contact.nodes[1];
      const u = Math.min(40*factor/43000, .0005), theta = factor*(80/3)/(400+torsion), reaction = Math.max(0, 40*factor-21.5);
      expect(state.bolts.map(b => b.id)).toEqual(['shank']);
      expect(state.welds.map(w => w.id)).toEqual(['interval-0', 'interval-1']);
      expect(motion.displacementM[0]).toBeCloseTo(u, 12);
      expect(motion.rotationRad[0]).toBeCloseTo(theta, 12);
      expect(state.bolts[0].axialForceN).toBeCloseTo(2000*u, 10);
      expect(contact.contacts[0].normalReactionN).toBeCloseTo(reaction, 10);
      expect(contact.contacts[0].gapM).toBeCloseTo(.0005-u, 12);
      expect(contact.contacts[0].state).toBe(reaction > 0 ? 'closed' : 'open');
      const weldForce = state.welds.reduce((sum, w) => sum+w.forceOnBN[0], 0);
      const weldMoment = state.welds.reduce((sum, w) => sum+w.momentOnBNm[0], 0);
      expect(1000*u+state.bolts[0].axialForceN-weldForce+reaction).toBeCloseTo(40*factor, 10);
      expect(400*theta-weldMoment).toBeCloseTo(factor*80/3, 10);
      expect(state.welds.reduce((sum, w) => sum+w.elasticEnergyJ, 0)).toBeCloseTo((40000*u*u+torsion*theta*theta)/2, 12);
      const html = renderToStaticMarkup(<BeamJointResults result={result} view={{ state: index }} />);
      const bolt = state.bolts[0], boltRow = html.split('<tr>').find(row => row.startsWith('<th>shank</th>'));
      expect(boltRow).toContain(`data-unit="N" data-value="${bolt.axialForceN}">${beamDisplayNumber(bolt.axialForceN)}<`);
      expect(boltRow).toContain(`data-unit="m" data-value="${bolt.extensionM}">${beamDisplayNumber(bolt.extensionM*1000)}<`);
      for (const [patch, weld] of state.welds.entries()) {
        const sign = patch === 0 ? -1 : 1;
        expect(weld.forceOnBN[0]).toBeCloseTo(-20000*u, 10);
        expect(weld.forceOnBN[2]).toBeCloseTo(-8000*sign*.75*theta, 10);
        expect(weld.momentOnBNm[2]).toBeCloseTo(20000*sign*.75*u, 10);
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
      expect(html).toContain(`data-unit="rad" data-value="${motion.rotationRad[0]}">${beamDisplayNumber(motion.rotationRad[0])}<`);
      expect(html.split(t('beam.contactState'))).toHaveLength(2);
    }
    expect(result.states[4]).toEqual(result.states[1]);
    expect(result.contact.states[4]).toEqual(result.contact.states[1]);
  });
});
