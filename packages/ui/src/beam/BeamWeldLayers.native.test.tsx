import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beamWeldContactInputSha256, decodeBeamWeldContact, translateBeamWeldContact, type BeamWeldContactInput } from '@pointercad/fem';
import { TEST_EVIDENCE } from '../../../model/src/analysis/beamInputs.testSupport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { BeamWeldLayerResults } from './BeamWeldLayers.js';
import { beamDisplayNumber } from './BeamResults.js';
import recorded from './beamWeldNative.fixture.json';

// Verbatim native proof1c0fab52, run20261016-064827-root-weld-layer-native-r1-static.
// Native execution remains separate; this checks the real returned values through the production decoder/view.
const input: BeamWeldContactInput = { schema: 'pointercad-weld-layer/1', contact: {
  schema: 'pointercad-beam-contact/1', geometry: { schema: 'pointercad-beam/2', id: 'native-layer', revision: 1,
    source: { documentId: 'native-layer', documentRevision: 1, geometryRevision: 'two-nodes' },
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
  welds: [{ id: 'effective-patch', nodeIdA: 'a', nodeIdB: 'b', centerM: [1, 2, 3], normal: [1, 0, 0], along: [0, 1, 0],
    widthM: 2, lengthM: 4, thicknessM: .2, youngPa: 1000, poisson: .25 }] };

beforeEach(() => { resetTestStore(); vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot()); });
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('effective layer view with actual native force and moment transfer', () => {
  it('renders both endpoint wrenches, energy and motion at positive, reversed and zero loads', async () => {
    const { plan } = translateBeamWeldContact(input);
    // The public translator retains CAD identity metadata; the native numeric fixture omits it.
    // Bind that metadata to the explicit public input without dropping any physical plan field.
    expect(plan.contact).toEqual({ ...recorded.nativeCalls[0].plan,
      members: recorded.nativeCalls[0].plan.members.map(member => ({ ...member,
        id: 'bar', componentId: 'bar', occurrencePath: ['bar'] })) });
    expect(plan.welds).toEqual([{ id: 'effective-patch', nodeA: 1, nodeB: 2, centerM: [1, 2, 3], normal: [1, 0, 0],
      along: [0, 1, 0], widthM: 2, lengthM: 4, thicknessM: .2, youngPa: 1000, poisson: .25 }]);
    const result = decodeBeamWeldContact(recorded.coupled, input, await beamWeldContactInputSha256(input));
    for (const [index, factor] of [1, -1, 0].entries()) {
      const weld = result.states[index].welds[0], motion = result.contact.states[index].nodes[1];
      // Independent parallel beam/layer stiffness: EA/L=1000, layer40000; GJ/L=400, layer80000/3.
      const u = factor*40/41000, theta = factor*(80/3)/(80000/3+400);
      expect(motion.displacementM[0]).toBeCloseTo(u, 12);
      expect(weld.forceOnBN[0]).toBeCloseTo(-40000*u, 10);
      expect(weld.momentOnBNm[0]).toBeCloseTo(-(80000/3)*theta, 10);
      expect(weld.elasticEnergyJ).toBeCloseTo(.5*(40000*u*u+(80000/3)*theta*theta), 12);
      const html = renderToStaticMarkup(<BeamWeldLayerResults result={result} view={{ state: index }} />);
      for (const key of ['forceOnAN', 'forceOnBN', 'momentOnANm', 'momentOnBNm'] as const) {
        const value = weld[key][0], unit = key.startsWith('force') ? 'N' : 'N m';
        expect(html).toContain(`data-quantity="${key}" data-unit="${unit}" data-value="${value}">${beamDisplayNumber(value)}<`);
      }
      expect(html).toContain(`data-unit="J" data-value="${weld.elasticEnergyJ}"`);
      expect(html).toContain(`data-unit="m" data-value="${motion.displacementM[0]}">${beamDisplayNumber(motion.displacementM[0]*1000)}<`);
    }
  });
});
