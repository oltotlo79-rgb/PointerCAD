import { Children, isValidElement, type ReactNode } from 'react';
import { createBeamSession } from './beamSession.js';
import { useAppStore } from '../store/useAppStore.js';
import { beamJointContactInputSha256, decodeBeamJointContact, beamJointInitialStrainInputSha256, decodeBeamJointInitialStrain,
  recoverJointWeldThroatStress, recoverInitialStrainWeldThroatStress } from '@pointercad/fem';
import { initialStrainTestInput, initialStrainTestRaw } from '../../../fem/src/beamJointInitialStrain.testSupport.js';
import { prepareWeldStressRequest } from './BeamWeldThroatStressResults.js';
import { BeamJointInitialStrainResults } from './BeamJointInitialStrain.js';
import { BeamJointResults } from './BeamJointResults.js';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beamWeldContactInputSha256, decodeBeamWeldContact, translateBeamWeldContact, type BeamWeldContactInput } from '@pointercad/fem';
import { TEST_EVIDENCE } from '../../../model/src/analysis/beamInputs.testSupport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { BeamWeldLayerResults } from './BeamWeldLayers.js';
import { recoverWeldThroatStress } from '@pointercad/fem';
import { WeldStressTable, currentWeldStress, startWeldStressRecovery, type WeldStressCompletion } from './BeamWeldThroatStressResults.js';
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

describe('input-bound rectangular throat stress with recorded native states', () => {
  async function recordedResult() { return decodeBeamWeldContact(recorded.coupled, input, await beamWeldContactInputSha256(input)); }
  it('uses independent axial/torsional stiffness at all three selected states and converts Pa to MPa', async () => {
    const result = await recordedResult(), before = structuredClone({ input, result });
    const recovered = await recoverWeldThroatStress(input, result);
    for (const [index, factor] of [1, -1, 0].entries()) {
      const u = factor*40/41000, theta = factor*(80/3)/(80000/3+400);
      const html = renderToStaticMarkup(<WeldStressTable states={recovered} state={index} />);
      expect(html.match(/data-weld-stress-patch=/gu)).toHaveLength(4);
      expect(html).toContain(`data-load-factor="${factor}"`);
      for (const corner of recovered[index].welds[0].corners) {
        // E/t=5000, G/t=2000; rotation about n gives (-q*theta,s*theta).
        expect(corner.normalPa).toBeCloseTo(5000*u, 10);
        expect(corner.shearAlongPa).toBeCloseTo(-2000*corner.acrossM*theta, 10);
        expect(corner.shearAcrossPa).toBeCloseTo(2000*corner.alongM*theta, 10);
        expect(html).toContain(`data-stress="normalPa" data-unit="MPa" data-value="${corner.normalPa/1e6}"`);
        expect(html).toContain(`data-stress="shearAlongPa" data-unit="MPa" data-value="${corner.shearAlongPa/1e6}"`);
      }
      const existing = renderToStaticMarkup(<BeamWeldLayerResults result={result} view={{ state: index }} />);
      expect(existing).toContain(`data-unit="J" data-value="${result.states[index].welds[0].elasticEnergyJ}"`);
    }
    expect({ input, result }).toEqual(before);
  });
  it('rejects changed thickness through the real digest check and reports unavailable instead of stress', async () => {
    const result = await recordedResult();
    const changed = { ...input, welds: [{ ...input.welds[0], thicknessM: .4 }] };
    const published = vi.fn<(value: WeldStressCompletion) => void>();
    const cleanup = startWeldStressRecovery({ input: changed, result, owner: 'owner-a' }, published);
    await vi.waitFor(() => expect(published).toHaveBeenCalledOnce());
    expect(published.mock.calls[0][0].states).toBeNull();
    cleanup();
  });
  it.each(['owner', 'input', 'result'] as const)('hides old completion immediately on a changed %s', async reason => {
    const result = await recordedResult(), states = await recoverWeldThroatStress(input, result);
    const request = { input, result, owner: 'owner-a' };
    const complete = { ...request, states };
    expect(currentWeldStress(complete, request)).toBe(complete);
    const next = reason === 'owner' ? { ...request, owner: 'other-document-or-analysis' }
      : reason === 'input' ? { ...request, input: structuredClone(input) } : { ...request, result: structuredClone(result) };
    expect(currentWeldStress(complete, next)).toBeNull();
  });
  it('drops an async success after cleanup and does not publish for a missing prepared input', async () => {
    const result = await recordedResult(), states = await recoverWeldThroatStress(input, result);
    let release: (value: typeof states) => void = () => { throw new Error('Deferred promise not initialized'); };
    const pending = new Promise<typeof states>(resolve => { release = resolve; });
    const recover = vi.fn<typeof recoverWeldThroatStress>().mockReturnValue(pending);
    const publish = vi.fn<(value: WeldStressCompletion) => void>();
    const stop = startWeldStressRecovery({ input, result, owner: 'old' }, publish, recover);
    stop(); release(states); await pending;
    expect(publish).not.toHaveBeenCalled();
    startWeldStressRecovery({ input: null, result, owner: 'new' }, publish, recover)();
    expect(recover).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });
  it('drops a rejected async completion after unmount', async () => {
    const result = await recordedResult();
    let reject: (reason: Error) => void = () => { throw new Error('Deferred promise not initialized'); };
    const pending = new Promise<Awaited<ReturnType<typeof recoverWeldThroatStress>>>((_resolve, fail) => { reject = fail; });
    const publish = vi.fn<(value: WeldStressCompletion) => void>();
    const stop = startWeldStressRecovery({ input, result, owner: 'old' }, publish, () => pending);
    stop(); reject(new Error('stale input')); await pending.catch(() => undefined);
    expect(publish).not.toHaveBeenCalled();
  });
});

// Analytic three-branch fixtures, not new native execution. The recorded-native tests above remain unchanged.
describe('combined throat view and owned asynchronous admission', () => {
  async function requests() {
    const initial = initialStrainTestInput(), raw = initialStrainTestRaw();
    const result = decodeBeamJointInitialStrain(raw, initial, await beamJointInitialStrainInputSha256(initial));
    const zero = initialStrainTestInput(0), zr = initialStrainTestRaw(0);
    const joint = decodeBeamJointContact({ ...zr, schema: 'pointercad-joint-contact-result/1', states: zr.states.map(s => ({ ...s,
      bolts: s.bolts.map(b => ({ id: b.id, extensionM: b.extensionM, axialForceN: b.axialForceN, forceOnAN: b.forceOnAN, forceOnBN: b.forceOnBN })) })) },
    zero.joint, await beamJointContactInputSha256(zero.joint));
    return [prepareWeldStressRequest({ kind: 'joint-contact', input: zero.joint }, joint, 'document/analysis/revision'),
      prepareWeldStressRequest({ kind: 'joint-initial-strain', input: initial }, result, 'document/analysis/revision')];
  }
  it('uses each real kind/digest for all three states, mm/MPa and leaves existing bolt/contact/energy views present', async () => {
    for (const request of await requests()) {
      const publish = vi.fn<(v: WeldStressCompletion) => void>();
      const cleanup = startWeldStressRecovery(request, publish);
      await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
      const current = currentWeldStress(publish.mock.calls[0][0], request);
      if (current?.states === null || current === null) throw new Error('Missing matching combined stresses');
      for (const [index, factor] of [1, 0, -1].entries()) {
        const s = request.kind === 'joint-initial-strain' ? 1e-6 : 0;
        const u = (1000*factor-210e6*s)/(3*210e6), stress = 210e9*u;
        const html = renderToStaticMarkup(<WeldStressTable states={current.states} state={index} />);
        expect(html).toContain(`data-load-factor="${factor}"`);
        expect(html.match(/data-weld-stress-patch=/gu)).toHaveLength(4);
        for (const corner of current.states[index].welds[0].corners) expect(corner.normalPa/1e6).toBeCloseTo(stress/1e6, 10);
        expect(html).toContain('data-unit="MPa"'); expect(html).toContain('data-unit="mm"');
        const oldView = request.result.kind === 'oofem-beam-joint-initial-strain'
          ? renderToStaticMarkup(<BeamJointInitialStrainResults result={request.result} view={{ state: index }} />)
          : request.result.kind === 'oofem-beam-joint-contact'
            ? renderToStaticMarkup(<BeamJointResults result={request.result} view={{ state: index }} />) : '';
        expect(oldView).toContain('data-unit="J"'); expect(oldView).toContain('data-unit="N"');
      }
      cleanup();
    }
  });
  it('hides changed input/result/owner immediately, refuses crossed prepared variants and null input', async () => {
    for (const request of await requests()) {
      const complete: WeldStressCompletion = { ...request, states: [] };
      expect(currentWeldStress(complete, request)).toBe(complete);
      expect(currentWeldStress(complete, { ...request, owner: 'other-document/analysis/revision' })).toBeNull();
      expect(currentWeldStress(complete, structuredClone(request))).toBeNull();
      const incompatible = prepareWeldStressRequest({ kind: 'weld-contact', input }, request.result, request.owner);
      expect(incompatible.input).toBeNull();
      const publish = vi.fn<(v: WeldStressCompletion) => void>();
      startWeldStressRecovery(incompatible, publish)(); expect(publish).not.toHaveBeenCalled();
    }
  });
  it.each(['success', 'failure'] as const)('drops combined late %s after cleanup for both genuine request kinds', async outcome => {
    for (const request of await requests()) {
      type States = Awaited<ReturnType<typeof recoverWeldThroatStress>>;
      let resolve: (states: States) => void = () => { throw new Error('Deferred not initialized'); };
      let reject: (error: Error) => void = () => { throw new Error('Deferred not initialized'); };
      const pending = new Promise<States>((yes, no) => { resolve = yes; reject = no; });
      const publish = vi.fn<(v: WeldStressCompletion) => void>();
      const stop = startWeldStressRecovery(request, publish, recoverWeldThroatStress,
        { joint: vi.fn<typeof recoverJointWeldThroatStress>().mockReturnValue(pending),
          initialStrain: vi.fn<typeof recoverInitialStrainWeldThroatStress>().mockReturnValue(pending) });
      stop(); if (outcome === 'success') resolve([]); else reject(new Error('old input'));
      await pending.catch(() => undefined); expect(publish).not.toHaveBeenCalled();
    }
  });

  it('selects value indices 0/1/2 through the real result handler/store and updates both result and stress views', async () => {
    for (const original of await requests()) {
      const owner = createBeamSession('view-document', 'view-analysis');
      const session = { ...owner, revision: 7, status: 'complete' as const, result: original.result };
      const request = { ...original, owner: JSON.stringify([session.ownerId, session.analysisId, session.revision]) };
      const cancel = vi.fn();
      useAppStore.setState({ beamSession: session, beamRunner: { run: vi.fn(), cancel } });
      const publish = vi.fn<(v: WeldStressCompletion) => void>();
      const cleanup = startWeldStressRecovery(request, publish);
      await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
      const completion = currentWeldStress(publish.mock.calls[0][0], request);
      if (completion?.states === null || completion === null) throw new Error('Missing current recovery');
      interface SelectProps { readonly children?: ReactNode; readonly value?: string | number;
        readonly onChange?: (event: { readonly target: { readonly value: string } }) => void }
      const selects: SelectProps[] = [], options: { value: string | number | undefined; label: ReactNode }[] = [];
      function walk(node: ReactNode): void {
        Children.forEach(node, child => {
          if (!isValidElement<SelectProps>(child)) return;
          if (child.type === 'select') selects.push(child.props);
          if (child.type === 'option') options.push({ value: child.props.value, label: child.props.children });
          walk(child.props.children);
        });
      }
      for (const [index, factor] of [1, 0, -1].entries()) {
        selects.length = 0; options.length = 0;
        const current = useAppStore.getState().beamSession;
        if (current === null) throw new Error('View session disappeared');
        const view = current.contactView;
        function Probe(): null { walk(BeamWeldLayerResults({ result: original.result, view })); return null; }
        renderToStaticMarkup(<Probe />);
        expect(selects).toHaveLength(1);
        // A string option "1" also matches the first label. The automation must select {value:"1"}.
        expect(options).toEqual([{ value: 0, label: '1' }, { value: 1, label: '0' }, { value: 2, label: '-1' }]);
        const select = selects[0];
        if (select.onChange === undefined) throw new Error('Missing actual select handler');
        select.onChange({ target: { value: String(index) } });
        const changed = useAppStore.getState().beamSession;
        if (changed === null) throw new Error('View change lost session');
        expect(changed.contactView.state).toBe(index);
        expect(changed.result).toBe(original.result);
        expect([changed.ownerId, changed.analysisId, changed.revision, changed.reviewed])
          .toEqual([session.ownerId, session.analysisId, session.revision, session.reviewed]);
        expect(cancel).not.toHaveBeenCalled();
        const stress = renderToStaticMarkup(<WeldStressTable states={completion.states} state={changed.contactView.state} />);
        expect(stress.match(new RegExp(`data-load-factor="${factor}"`, 'gu'))).toHaveLength(4);
        const u = (1000*factor-210e6*(request.kind === 'joint-initial-strain' ? 1e-6 : 0))/(3*210e6);
        for (const corner of completion.states[index].welds[0].corners) expect(corner.normalPa).toBeCloseTo(210e9*u, 6);
        const resultView = request.result.kind === 'oofem-beam-joint-initial-strain'
          ? renderToStaticMarkup(<BeamJointInitialStrainResults result={request.result} view={changed.contactView} />)
          : request.result.kind === 'oofem-beam-joint-contact'
            ? renderToStaticMarkup(<BeamJointResults result={request.result} view={changed.contactView} />) : '';
        const boltForce = 210e6*(u+(request.kind === 'joint-initial-strain' ? 1e-6 : 0));
        expect(resultView).toContain(`data-unit="N" data-value="${boltForce}"`);
        expect(resultView).toContain(`data-unit="J" data-value="${request.result.states[index].welds[0].elasticEnergyJ}"`);
      }
      cleanup();
    }
  });
});
