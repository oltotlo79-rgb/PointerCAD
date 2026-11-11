import React, { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyPartDocument, createUndoStack, resolveConstrainedAssembly, buildStandardPartFromSource } from '@pointercad/model';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { beamWeldSpanContactInputSha256, beamWeldSpanContactResultMatches, decodeBeamWeldSpanContact,
  type BeamWeldSpanContactInput } from '@pointercad/fem';
import { modalFixture } from '@pointercad/fem/testing/ui-fixtures';
import { cadWeldSpanFixture } from '@pointercad/model/testing/analysis-fixtures';
import { resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { captureMeshBodyLayout } from '../store/recomputeSlice.js';
import type { AssemblySourceMeshOwner } from '../viewport/assemblyMeshAdmission.js';
import { beamUiFixture, requireBeamSession } from './beam.testSupport.js';
import { captureBeamSource } from './beamSource.js';
import { BeamContactResults } from './BeamContactResults.js';
import { beamDefinition } from './beamSession.js';
import { prepareBeamAnalysis } from './prepareBeamAnalysis.js';
import { BeamWeldSpanResults, WeldSpanResultTable, startWeldSpanResultCheck, currentWeldSpanResult } from './BeamWeldSpanResults.js';

/** Independent integral K/C fractions: one-element K=500,C=4000/3; two-element axial 2x2 integrals.
 * This is a pure decoder/view fixture, not an executed native solve or a CAD result. */
async function resultFixture(segments: 1 | 2) {
  const base = modalFixture({ free: true, modes: 1, segments });
  const input: BeamWeldSpanContactInput = { schema: 'pointercad-weld-span/1', contact: {
    schema: 'pointercad-beam-contact/1', geometry: { ...base,
      nodes: [0, 2, 0, 2].map((x, i) => ({ id: `n${i}`, position: [x, 0, 0] })),
      members: ['a', 'b'].map((id, i) => ({ ...base.members[0], id, componentId: id, occurrencePath: [id],
        startNodeId: `n${2*i}`, endNodeId: `n${2*i+1}` })),
      materials: [{ ...base.materials[0], youngModulus: 1000, shearModulus: 400, densityKgM3: 1 }],
      sections: [{ ...base.sections[0], area: 1, iy: .1, iz: .1, torsionConstant: .1, shearFactor: 1 }] },
    supports: [0, 1, 2, 3].map(i => ({ nodeId: `n${i}`, restrained: [i%2 === 0, true, true, true, true, true] })),
    referenceLoads: [{ id: 'load', kind: 'nodal', nodeId: 'n3', force: [1, 0, 0], moment: [0, 0, 0] }],
    contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'n3', normal: [-1, 0, 0], gapM: .01 }], loadFactors: [1, 0, -1] },
    patches: [{ id: 'layer', centerM: [1, 0, 0], normal: [0, 1, 0], along: [1, 0, 0], widthM: 2, lengthM: 1,
      thicknessM: .2, youngPa: 1000, poisson: .25, first: { kind: 'member-span', memberId: 'a' },
      second: { kind: 'member-span', memberId: 'b' } }] };
  const u = segments === 1 ? [0, 8/9500, 0, 11/9500] : [0, 76/97000, 0, 118/97000, 47/97000, 50/97000];
  const first = segments === 1 ? [4/19, 8/19, 0, 0] : [1/97, 29/97, 0, 0, 18/97, 0];
  const second = segments === 1 ? [0, 0, -4/19, -8/19] : [0, 0, -1/97, -29/97, 0, -18/97];
  const states = [1, 0, -1].map(f => ({ loadFactor: f,
    meshNodes: u.map((x, i) => ({ number: i+1, displacementM: [x*f, 0, 0], rotationRad: [0, 0, 0] })),
    welds: [{ id: 'layer', first: first.map(x => [x*f, 0, 0, 0, 0, 0]), second: second.map(x => [x*f, 0, 0, 0, 0, 0]),
      forceOnFirstN: [(segments === 1 ? 12/19 : 48/97)*f, 0, 0], momentAtCenterNm: [0, 0, 0],
      energyJ: (segments === 1 ? 3/45125 : 159/2352250)*f*f, structuralCertification: false }] }));
  const raw = { schema: 'pointercad-weld-span-result/1', contact: {
    schema: 'pointercad-oofem-contact-result/1', method: 'murty-least-index-lcp-on-native-beam3d-stiffness',
    freeDofs: segments === 1 ? 2 : 14, meshNodes: u.length, meshElements: 2*segments,
    momentLengthM: 2/segments, pivotLimit: 20,
    states: states.map(s => ({ loadFactor: s.loadFactor, pivots: 0, forceScaleN: 1, gapScaleM: .01,
      equilibriumResidual: 0, penetration: 0, tension: 0, complementarity: 0, nodes: s.meshNodes.slice(0, 4),
      contacts: [{ id: 'stop', state: 'open', normalReactionN: 0, gapM: .01-u[3]*s.loadFactor }] })) }, states };
  const hash = await beamWeldSpanContactInputSha256(input);
  return { input, hash, result: await decodeBeamWeldSpanContact(raw, input, hash) };
}

/** Real CAD planner/adapter, controlled publication metadata. No native mesh/solver is claimed. */
function savedFixture() {
  const ui = beamUiFixture(), cad = cadWeldSpanFixture();
  const stamp = { documentId: cad.document.id, documentRevision: ui.state.documentVersion,
    geometryRevision: `${cad.document.id}:${ui.state.completedGeneration}` };
  const definition = { ...cad.definition, source: stamp, weldLayers: { ...cad.associations, source: stamp } };
  const document = withBeamAnalysisInputs(cad.document, { schema: 'pointercad-beam-inputs/1', analyses: [
    { kind: 'standard-members', definition }] });
  const sources = new Map<string, AssemblySourceMeshOwner>();
  for (const [key, bodies] of cad.context.bodies) {
    const part = createEmptyPartDocument(), result = { ...resultFor(part), bodies, generation: ui.owner.generation };
    sources.set(key, { document: part, attachments: undefined, result, bodies,
      layouts: bodies.map(captureMeshBodyLayout), displayOwner: null, hiddenOwners: [], current: () => true });
  }
  const owner = { ...ui.owner, document, activeDocumentId: document.id, bodies: cad.context.bodies, sources };
  const resolved = resolveConstrainedAssembly(document, owner.bodies, { standardPart: buildStandardPartFromSource });
  if (!resolved.ok || ui.state.assemblyView === null) throw new Error('Real CAD placement required');
  const state = { ...ui.state, assembly: document, activeDocumentId: document.id, beamSession: null,
    assemblyUndoStack: createUndoStack({ document, library: ui.state.assemblyLibrary }),
    assemblyView: { ...ui.state.assemblyView, sourceDocument: document, bodies: owner.bodies,
      resolved: resolved.resolved, meshOwnership: owner } };
  if (captureBeamSource(state) === null) throw new Error('Controlled current publication required');
  return { state, document, definition };
}

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('span result dedicated view and owned saved /2 admission', () => {
  it('keeps center moment separate from distributed nodal moments in a display-only fixture', async () => {
    const f = await resultFixture(1);
    // This deliberately distinct display fixture does not claim decoded equilibrium or native success.
    const result = { ...f.result, states: f.result.states.map(s => ({ ...s,
      welds: s.welds.map(w => ({ ...w, momentAtCenterNm: [2, 3, 4] as const,
        first: w.first.map((n, i) => i === 0 ? [n[0], n[1], n[2], 7, 8, 9] : n) })) })) };
    const markup = renderToStaticMarkup(<WeldSpanResultTable result={result} view={{ state: 0 }} />);
    expect(markup).toContain('data-unit="N m" data-value="2"');
    expect(markup).toContain('data-component="3" data-unit="N m" data-value="7"');
    expect(markup).toContain('data-quantity="momentAtCenterNm"');
  });

  it('refuses a different current review/owner even before the asynchronous result check', async () => {
    const f = savedFixture(), result = (await resultFixture(1)).result;
    useAppStore.setState(f.state); useAppStore.getState().openBeam();
    const reviewed = captureBeamSource(useAppStore.getState());
    if (reviewed === null) throw new Error('Current review required');
    const session = { ...requireBeamSession(), reviewed, result };
    for (const changed of [{ ...session, reviewed: null }, { ...session, ownerId: 'other-opening' }]) {
      useAppStore.setState({ beamSession: changed });
      const markup = renderToStaticMarkup(<BeamWeldSpanResults session={session} result={result} />);
      expect(markup).toContain('role="alert"');
      expect(markup).not.toContain('beam-weld-span-results');
    }
  });

  it.each([1, 2] as const)('shows independent %i-element forces, nonuniform nodal distribution, SI and mm for positive/zero/negative loads', async segments => {
    const f = await resultFixture(segments);
    expect(await beamWeldSpanContactResultMatches(f.result, f.input, f.hash)).toBe(true);
    for (const [index, factor] of [1, 0, -1].entries()) {
      const markup = renderToStaticMarkup(<WeldSpanResultTable result={f.result} view={{ state: index }} />);
      expect(markup).toContain(`data-load-factor="${factor}"`);
      expect(markup).toContain('data-structural-certification="false"');
      expect(markup).toContain(`data-unit="N" data-value="${(segments === 1 ? 12/19 : 48/97)*factor}"`);
      expect(markup).toContain(`data-unit="J" data-value="${(segments === 1 ? 3/45125 : 159/2352250)*factor*factor}"`);
      expect(markup).toContain('data-quantity="momentAtCenterNm"');
      expect(markup).not.toContain('beam-weld-throat-stress');
      expect(markup.match(/data-side="first"/gu)).toHaveLength(segments === 1 ? 4 : 6);
      expect(markup).toContain(`data-component="0" data-unit="N" data-value="${(segments === 1 ? 4/19 : 1/97)*factor}"`);
      if (segments === 2) {
        expect(markup).toContain(`data-component="0" data-unit="N" data-value="${18/97*factor}"`);
        expect(markup).toContain(`data-unit="m" data-value="${47/97000*factor}"`);
      }
    }
    const markup = renderToStaticMarkup(<WeldSpanResultTable result={f.result} view={{ state: 0 }} />);
    expect(markup).toContain(segments === 1 ? '>0.842105263<' : '>0.783505155<'); // Independent metres-to-mm expectation, 9 significant digits.
  });

  it('uses the actual contact-view callback without editing saved inputs, revision, result or history', async () => {
    const response = await resultFixture(1);
    const f = savedFixture(); useAppStore.setState(f.state); useAppStore.getState().openBeam();
    const session = requireBeamSession(), before = useAppStore.getState();
    let onChange: ((e: { target: { value: string } }) => void) | undefined;
    interface Props { readonly children?: ReactNode; readonly 'data-testid'?: string; readonly onChange?: typeof onChange }
    function Probe(): null {
      function visit(node: ReactNode): void { Children.forEach(node, child => {
        if (!isValidElement<Props>(child)) return;
        if (child.props['data-testid'] === 'beam-contact-state') onChange = child.props.onChange;
        visit(child.props.children);
      }); }
      // Only the selector is used; this existing contact view has the exact same store callback as the nested span view.
      visit(BeamContactResults({ result: response.result.contact, view: session.contactView }));
      return null;
    }
    renderToStaticMarkup(<Probe />);
    if (onChange === undefined) throw new Error('Reached selector required');
    onChange({ target: { value: '1' } });
    expect(requireBeamSession().contactView.state).toBe(1);
    expect(requireBeamSession().revision).toBe(session.revision);
    expect(requireBeamSession().reviewed).toBe(session.reviewed);
    expect(useAppStore.getState().assembly).toBe(before.assembly);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
  });

  it('strictly admits valid saved /2 through open/review/run/apply and preserves one input Undo', () => {
    const f = savedFixture(), runner = { run: vi.fn(), cancel: vi.fn() };
    useAppStore.setState({ ...f.state, beamRunner: runner }); useAppStore.getState().openBeam();
    expect(requireBeamSession().weldSpanLayers).toEqual(f.definition.weldLayers);
    for (const m of requireBeamSession().members) useAppStore.getState().editBeam({ kind: 'confirmed', id: m.id, confirmed: true });
    useAppStore.getState().reviewBeam();
    const s = requireBeamSession();
    expect(s.reviewed).not.toBeNull();
    if (s.reviewed === null) throw new Error('Current saved span review required');
    const d = beamDefinition(s, s.reviewed, []);
    if (!d.ok) throw new Error('Reviewed definition required');
    expect(prepareBeamAnalysis(s.reviewed, d.definition)).toMatchObject({ ok: true, kind: 'weld-span-contact' });
    useAppStore.getState().runBeam(); expect(runner.run).toHaveBeenCalledWith(s, s.reviewed);
    const undo = useAppStore.getState().assemblyUndoStack;
    useAppStore.getState().applyBeamInputs();
    expect(useAppStore.getState().assemblyUndoStack).not.toBe(undo);
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength((undo?.past.length ?? 0) + 1);
    expect(requireBeamSession().reviewed).toBeNull();
  });

  it.each(['source', 'revision', 'bolt', 'strain', 'foreign'] as const)('refuses %s saved /2 without changing document bytes/history', mode => {
    const f = savedFixture(), definition = f.definition;
    const changed = mode === 'source' ? { ...definition, source: { ...definition.source, geometryRevision: 'other' } }
      : mode === 'revision' ? { ...definition, revision: definition.revision + 1 }
      : mode === 'foreign' ? { ...definition, weldLayers: { ...definition.weldLayers,
        welds: definition.weldLayers.welds.map(w => ({ ...w, first: { kind: 'member-span' as const, memberId: 'foreign' } })) } }
      : mode === 'bolt' ? { ...definition, axialBolts: { schema: 'pointercad-cad-axial-bolts/1' as const,
        source: definition.source, analysisId: definition.id, analysisRevision: definition.revision, bolts: [] } }
      : { ...definition, initialStrain: { schema: 'pointercad-cad-joint-initial-strain/1' as const, shortenings: [] } };
    // Deliberately invalid input bypasses no reader; the real store gate must reject it.
    const document = { ...f.document, beamAnalysisInputs: { schema: 'pointercad-beam-inputs/1' as const,
      analyses: [{ kind: 'standard-members' as const, definition: changed }] } };
    if (f.state.assemblyView === null || f.state.assemblyView.meshOwnership === undefined) throw new Error('Publication required');
    useAppStore.setState({ ...f.state, assembly: document, assemblyView: { ...f.state.assemblyView,
      sourceDocument: document, meshOwnership: { ...f.state.assemblyView.meshOwnership, document } } });
    const before = useAppStore.getState(), bytes = JSON.stringify(document);
    useAppStore.getState().openBeam();
    expect(useAppStore.getState().beamSession).toBeNull();
    expect(useAppStore.getState().fileMessage).toMatchObject({ failed: true });
    expect(useAppStore.getState().assembly).toBe(document);
    expect(JSON.stringify(useAppStore.getState().assembly)).toBe(bytes);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
  });

  it('fully rejects changed input hash/material and drops late cleanup/owner/result replies', async () => {
    const f = await resultFixture(2);
    expect(await beamWeldSpanContactResultMatches(f.result, f.input, 'b'.repeat(64))).toBe(false);
    const material = { ...f.input, contact: { ...f.input.contact, geometry: { ...f.input.contact.geometry,
      materials: f.input.contact.geometry.materials.map(m => ({ ...m, youngModulus: 1100 })) } } };
    expect(await beamWeldSpanContactResultMatches(f.result, material, f.hash)).toBe(false);
    const request = { input: f.input, result: f.result, owner: 'opening:analysis:1' };
    const delivered: Parameters<typeof currentWeldSpanResult>[0][] = [];
    const complete = { ...request, matches: true };
    expect(currentWeldSpanResult(complete, request)).toBe(true);
    expect(currentWeldSpanResult(complete, { ...request, owner: 'opening:analysis:2' })).toBe(false);
    expect(currentWeldSpanResult(complete, { ...request, result: structuredClone(f.result) })).toBe(false);
    expect(currentWeldSpanResult(complete, { ...request, input: structuredClone(f.input) })).toBe(false);
    let resolve: ((v: boolean) => void) | undefined;
    const cleanup = startWeldSpanResultCheck(request, v => delivered.push(v), () => new Promise<boolean>(r => { resolve = r; }));
    cleanup(); if (resolve === undefined) throw new Error('Deferred check required'); resolve(true);
    await Promise.resolve(); expect(delivered).toEqual([]);
    startWeldSpanResultCheck(request, v => delivered.push(v));
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(currentWeldSpanResult(delivered[0], request)).toBe(true);
  });
});
