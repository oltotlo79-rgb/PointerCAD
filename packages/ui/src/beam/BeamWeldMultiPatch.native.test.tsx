import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beamWeldContactInputSha256, decodeBeamWeldContact, translateBeamWeldContact, type BeamWeldContactInput } from '@pointercad/fem';
import { TEST_EVIDENCE } from '../../../model/src/analysis/beamInputs.testSupport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { BeamWeldLayerResults } from './BeamWeldLayers.js';
import { beamDisplayNumber } from './BeamResults.js';
import recorded from './beamWeldMultiPatchNative.fixture.json';

// Exact raw proof1bdb6cf7, actual run20261016-082641-root-weld-multipatch-native-r1-static.
// This is a decoder/view check of actual native output, not another native execution.
function input(distance: number): BeamWeldContactInput {
  return { schema: 'pointercad-weld-layer/1', contact: {
    schema: 'pointercad-beam-contact/1', geometry: { schema: 'pointercad-beam/2', id: 'native-multipatch', revision: 1,
      source: { documentId: 'native-multipatch', documentRevision: 1, geometryRevision: 'two-nodes' },
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
    contacts: [{ id: 'distant-stop', kind: 'node-plane', nodeId: 'b', normal: [1, 0, 0], gapM: 1 }], loadFactors: [1, -1, 0] },
    welds: [-1, 1].map((sign, index) => ({ id: 'interval-'+index, nodeIdA: 'a', nodeIdB: 'b',
      centerM: [1, 2+sign*distance, 3], normal: [1, 0, 0], along: [0, 1, 0],
      widthM: 1, lengthM: 4, thicknessM: .2, youngPa: 1000, poisson: .25 })) };
}

beforeEach(() => { resetTestStore(); vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot()); });
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('actual native intermittent weld results through the production decoder and view', () => {
  it.each([.75, 1.5])('preserves every patch wrench/energy and the independent inertia response at half-spacing %s', async distance => {
    const caseIndex = distance === .75 ? 0 : 1, source = input(distance), { plan } = translateBeamWeldContact(source);
    const actual = recorded.nativeCalls[caseIndex];
    expect(actual.error).toBeNull();
    expect(plan.contact).toEqual({ ...actual.plan, members: actual.plan.members.map(member => ({ ...member,
      id: 'bar', componentId: 'bar', occurrencePath: ['bar'] })) });
    expect(actual.weldPlan.contact).toEqual(actual.plan);
    expect(plan.welds).toEqual(actual.weldPlan.welds);
    expect(recorded.coupled[caseIndex]).toEqual(actual.response);
    const result = decodeBeamWeldContact(actual.response, source, await beamWeldContactInputSha256(source));
    // A=8, int(y^2)=2/3+8*d^2, int(z^2)=32/3. Native beam EA/L=1000, GJ/L=400.
    const torsion = 2000*(2/3+8*distance*distance+32/3);
    for (const [index, factor] of [1, -1, 0].entries()) {
      const state = result.states[index], motion = result.contact.states[index].nodes[1];
      const u = factor*40/41000, theta = factor*(80/3)/(400+torsion);
      expect(state.welds.map(weld => weld.id)).toEqual(['interval-0', 'interval-1']);
      expect(motion.displacementM[0]).toBeCloseTo(u, 12);
      expect(motion.rotationRad[0]).toBeCloseTo(theta, 12);
      expect(state.welds.reduce((sum, weld) => sum+weld.forceOnBN[0], 0)).toBeCloseTo(-40000*u, 10);
      expect(state.welds.reduce((sum, weld) => sum+weld.momentOnBNm[0], 0)).toBeCloseTo(-torsion*theta, 10);
      expect(state.welds.reduce((sum, weld) => sum+weld.elasticEnergyJ, 0)).toBeCloseTo((40000*u*u+torsion*theta*theta)/2, 12);
      const html = renderToStaticMarkup(<BeamWeldLayerResults result={result} view={{ state: index }} />);
      for (const [patch, weld] of state.welds.entries()) {
        // Each half contributes half the axial force, and opposite centroidal transverse force/moment.
        const sign = patch === 0 ? -1 : 1;
        expect(weld.forceOnBN[0]).toBeCloseTo(-20000*u, 10);
        expect(weld.forceOnBN[2]).toBeCloseTo(-8000*sign*distance*theta, 10);
        expect(weld.momentOnBNm[2]).toBeCloseTo(20000*sign*distance*u, 10);
        const rows = html.split('<tr>').filter(row => row.startsWith(`<th>${weld.id}</th>`));
        expect(rows).toHaveLength(4);
        for (const key of ['forceOnAN', 'forceOnBN', 'momentOnANm', 'momentOnBNm'] as const) {
          const row = rows.find(candidate => candidate.includes(`data-quantity="${key}"`));
          expect(row).toBeDefined();
          for (const value of weld[key]) {
            const unit = key.startsWith('force') ? 'N' : 'N m';
            expect(row).toContain(`data-quantity="${key}" data-unit="${unit}" data-value="${value}">${beamDisplayNumber(value)}<`);
          }
        }
        expect(html).toContain(`data-unit="J" data-value="${weld.elasticEnergyJ}">${weld.id}:`);
      }
      expect(html).toContain(`data-unit="m" data-value="${motion.displacementM[0]}">${beamDisplayNumber(motion.displacementM[0]*1000)}<`);
      expect(html).toContain(`data-unit="rad" data-value="${motion.rotationRad[0]}">${beamDisplayNumber(motion.rotationRad[0])}<`);
    }
  });
});
