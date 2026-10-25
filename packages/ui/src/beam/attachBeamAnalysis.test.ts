import { bucklingInputSha256, bucklingResultMatches, type FemWorkerPort } from '@pointercad/fem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import type { AssemblyMeshOwnership } from '../viewport/assemblyMeshAdmission.js';
import { attachBeamAnalysis, type BeamAttachment } from './attachBeamAnalysis.js';
import { beamUiFixture, requireBeamSession } from './beam.testSupport.js';
import { captureBeamSource } from './beamSource.js';
import { bucklingResultFixture } from './beamBuckling.testSupport.js';

class Port implements FemWorkerPort {
  onmessage: FemWorkerPort['onmessage'] = null;
  onerror: FemWorkerPort['onerror'] = null;
  onmessageerror: FemWorkerPort['onmessageerror'] = null;
  request: Parameters<FemWorkerPort['postMessage']>[0] | null = null;
  terminated = 0;
  postMessage(request: Parameters<FemWorkerPort['postMessage']>[0]): void { this.request = request; }
  terminate(): void { this.terminated += 1; }
  reply(kind: 'failure' | 'phase'): MessageEvent {
    if (this.request === null) throw new Error('Expected request');
    return new MessageEvent('message', { data: { protocol: this.request.protocol, identity: this.request.identity,
      ...(kind === 'phase' ? { kind, phase: 'solving' } : { kind, failure: { code: 'solver-failed', message: 'Deliberate lifecycle fixture failure' } }) } });
  }
}

let attachment: BeamAttachment | null = null;
beforeEach(resetTestStore);
afterEach(() => { attachment?.dispose(); attachment = null; resetTestStore(); });

async function running(analysisType: 'static' | 'modal' | 'buckling' = 'static') {
  const fixture = beamUiFixture(), ports: Port[] = [];
  const session = analysisType === 'static' ? fixture.session : { ...fixture.session, analysisType, modeCount: 2,
    members: fixture.session.members.map(member => ({ ...member,
      startRestraints: [true, true, true, true, true, true] as const,
      values: { ...member.values, endFx: '0', endFz: analysisType === 'buckling' ? '-1' : '0' } })) };
  useAppStore.setState({ ...fixture.state, beamSession: session });
  attachment = attachBeamAnalysis(useAppStore, () => { const port = new Port(); ports.push(port); return port; });
  useAppStore.getState().reviewBeam();
  const reviewed = requireBeamSession();
  expect(reviewed.errorKey).toBeNull();
  expect(reviewed.diagnostic).toBeNull();
  expect(reviewed.reviewed).not.toBeNull();
  useAppStore.getState().runBeam();
  await vi.waitFor(() => {
    expect(ports).toHaveLength(1);
    expect(ports[0].request).not.toBeNull();
  });
  expect(ports).toHaveLength(1);
  expect(ports[0].request?.kind).toBe(analysisType === 'buckling' ? 'analyze-beam-buckling-3d'
    : analysisType === 'modal' ? 'analyze-beam-modal-3d' : 'analyze-beam-3d');
  return { fixture, port: ports[0], ports };
}

describe('owned product FEM lifetime (protocol fixtures, not numerical qualification)', () => {
  it.each(['static', 'modal', 'buckling'] as const)('routes explicit %s through its actual public client and terminates on cancel', async type => {
    const { port } = await running(type);
    const request = port.request;
    if (type === 'buckling') {
      if (request?.kind !== 'analyze-beam-buckling-3d') throw new Error('Missing buckling request');
      expect(request.input.geometry.constraints).toEqual([]);
      expect(request.input.geometry.loads).toEqual([]);
      expect(request.input.supports).toEqual([{ nodeId: 'beam-member-1-start', restrained: [true, true, true, true, true, true] }]);
      expect(request.input.referenceLoads).toEqual([{ id: 'load-0', kind: 'nodal', nodeId: 'beam-member-1-end', force: [0, 0, -1], moment: [0, 0, 0] }]);
    }
    useAppStore.getState().cancelBeam();
    expect(requireBeamSession().status).toBe('cancelled');
    expect(requireBeamSession().result).toBeNull();
    expect(port.terminated).toBe(1);
  });

  it.each(['support', 'settings', 'revision', 'workspace', 'close', 'dispose'] as const)(
    'invalidates buckling on %s and refuses retained phase/failure callbacks', async reason => {
      const { port, fixture } = await running('buckling');
      const callback = port.onmessage;
      const request = port.request;
      if (request?.kind !== 'analyze-beam-buckling-3d') throw new Error('Missing buckling request');
      const result = { ...bucklingResultFixture(request.input), inputSha256: await bucklingInputSha256(request.input) };
      const resultEvent = new MessageEvent('message', { data: { protocol: request.protocol,
        identity: request.identity, kind: 'result', result } });
      if (reason === 'support') useAppStore.getState().editBeam({ kind: 'buckling-support', id: fixture.session.members[0].id,
        end: 'end', axis: 1, restrained: true });
      if (reason === 'settings') useAppStore.getState().editBeam({ kind: 'modal-settings', modeCount: 1, segmentsPerMember: 12 });
      if (reason === 'revision') useAppStore.setState({ documentVersion: fixture.state.documentVersion + 1 });
      if (reason === 'workspace') useAppStore.setState({ activeDocumentId: 'replacement-workspace' });
      if (reason === 'close') useAppStore.getState().closeBeam();
      if (reason === 'dispose') attachment?.dispose();
      const after = useAppStore.getState().beamSession;
      expect(port.terminated).toBe(1);
      callback?.(port.reply('phase'));
      callback?.(port.reply('failure'));
      callback?.(resultEvent);
      await Promise.resolve();
      expect(useAppStore.getState().beamSession).toBe(after);
      expect(after?.result ?? null).toBeNull();
      expect(after?.bucklingEdges ?? []).toEqual([]);
      expect(attachment?.statistics().live).toBe(0);
    },
  );

  it('publishes an associated buckling result with actual refined element topology and clears both after source change', async () => {
    const { port, fixture } = await running('buckling');
    const request = port.request;
    if (request?.kind !== 'analyze-beam-buckling-3d') throw new Error('Missing buckling request');
    const result = { ...bucklingResultFixture(request.input), inputSha256: await bucklingInputSha256(request.input) };
    expect(bucklingResultMatches(result, request.input, result.inputSha256)).toBe(true);
    port.onmessage?.(new MessageEvent('message', { data: { protocol: request.protocol, identity: request.identity, kind: 'result', result } }));
    await vi.waitFor(() => {
      expect(requireBeamSession().diagnostic).toBeNull();
      expect(requireBeamSession().status).toBe('complete');
    });
    expect(requireBeamSession().result).toEqual(result);
    // Independent CAD fixture: centroid (25, 3) mm, 2000 mm along +Z, eight segments.
    // Original IDs sort end before start; the physical member still runs start to end.
    expect(request.input.geometry.nodes).toEqual([
      { id: 'beam-member-1-start', position: [25, 3, 0] },
      { id: 'beam-member-1-end', position: [25, 3, 2000] },
    ]);
    const expectedNodes = [
      { solverNode: 1, nodeId: 'beam-member-1-end', positionM: [0.025, 0.003, 2] },
      { solverNode: 2, nodeId: 'beam-member-1-start', positionM: [0.025, 0.003, 0] },
      { solverNode: 3, nodeId: null, positionM: [0.025, 0.003, 0.25] },
      { solverNode: 4, nodeId: null, positionM: [0.025, 0.003, 0.5] },
      { solverNode: 5, nodeId: null, positionM: [0.025, 0.003, 0.75] },
      { solverNode: 6, nodeId: null, positionM: [0.025, 0.003, 1] },
      { solverNode: 7, nodeId: null, positionM: [0.025, 0.003, 1.25] },
      { solverNode: 8, nodeId: null, positionM: [0.025, 0.003, 1.5] },
      { solverNode: 9, nodeId: null, positionM: [0.025, 0.003, 1.75] },
    ];
    for (const mode of result.modes) {
      expect(mode.nodes.map(({ solverNode, nodeId, positionM }) => ({ solverNode, nodeId, positionM })))
        .toEqual(expectedNodes);
    }
    expect(requireBeamSession().bucklingEdges).toEqual([
      [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 1],
    ]);
    expect(port.terminated).toBe(1);
    useAppStore.setState({ documentVersion: fixture.state.documentVersion + 1 });
    expect(requireBeamSession().result).toBeNull();
    expect(requireBeamSession().bucklingEdges).toEqual([]);
    expect(requireBeamSession().reviewed).toBeNull();
  });

  it('reports the actual public-client rejection of an unnormalized buckling reply and releases its worker', async () => {
    const { port } = await running('buckling');
    const request = port.request;
    if (request?.kind !== 'analyze-beam-buckling-3d') throw new Error('Missing buckling request');
    const valid = { ...bucklingResultFixture(request.input), inputSha256: await bucklingInputSha256(request.input) };
    expect(bucklingResultMatches(valid, request.input, valid.inputSha256)).toBe(true);
    const result = { ...valid, modes: valid.modes.map(mode => ({ ...mode,
      nodes: mode.nodes.map(node => ({ ...node, translation: node.translation.map(value => value * 0.5),
        rotation: node.rotation.map(value => value * 0.5) })) })) };
    port.onmessage?.(new MessageEvent('message', { data: { protocol: request.protocol, identity: request.identity, kind: 'result', result } }));
    await vi.waitFor(() => expect(requireBeamSession().status).toBe('failed'));
    expect(requireBeamSession().diagnostic).toBe('invalid-protocol: Analysis kind, input digest, source revision or result association differs');
    expect(requireBeamSession().result).toBeNull();
    expect(requireBeamSession().bucklingEdges).toEqual([]);
    expect(port.terminated).toBe(1);
    expect(attachment?.statistics()).toEqual({ created: 1, terminated: 1, live: 0 });
  });

  it.each(['edit', 'revision', 'recompute', 'publication', 'document', 'close', 'dispose'] as const)(
    'terminates once on %s and ignores retained old callbacks', async reason => {
      const { fixture, port } = await running();
      const late = port.onmessage;
      if (reason === 'edit') useAppStore.getState().editBeam({ kind: 'value', id: fixture.session.members[0].id, field: 'endFx', source: '11' });
      if (reason === 'revision') useAppStore.setState({ documentVersion: fixture.state.documentVersion + 1 });
      if (reason === 'recompute') useAppStore.setState({ requestedGeneration: 8, isComputing: true });
      if (reason === 'publication') { fixture.current.publication = false; useAppStore.setState({ isComputing: false }); }
      if (reason === 'document') useAppStore.setState({ activeDocumentId: 'other-document' });
      if (reason === 'close') useAppStore.getState().closeBeam();
      if (reason === 'dispose') attachment?.dispose();
      expect(port.terminated).toBe(1);
      expect(port.onmessage).toBeNull();
      const after = useAppStore.getState().beamSession;
      late?.(port.reply('phase'));
      late?.(port.reply('failure'));
      await Promise.resolve();
      expect(useAppStore.getState().beamSession).toBe(after);
      expect(after?.result ?? null).toBeNull();
      expect(attachment?.statistics()).toEqual({ created: 1, terminated: 1, live: 0 });
    },
  );

  it('keeps the active solve through receipt-only ownership refresh and accepts its response', async () => {
    const { fixture, port } = await running();
    const reviewed = requireBeamSession().reviewed;
    const callback = port.onmessage;
    for (const epoch of [1, 2]) {
      const view = useAppStore.getState().assemblyView;
      if (view?.meshOwnership === undefined) throw new Error('Expected current publication');
      const owner = view.meshOwnership;
      if (owner.receipt.status !== 'known' || owner.backingInspection.status !== 'known') {
        throw new Error('Expected issued evidence fixture');
      }
      const fresh: AssemblyMeshOwnership = { ...owner, receipt: { ...owner.receipt, hostEpoch: epoch },
        backingInspection: { ...owner.backingInspection, hostEpoch: epoch },
        uiSnapshot: { ...owner.uiSnapshot, epoch },
        publicationCurrent: () => useAppStore.getState().assemblyView?.meshOwnership === fresh };
      fixture.current.publication = false;
      useAppStore.setState({ assemblyView: { ...view, meshOwnership: fresh } });
      expect(captureBeamSource(useAppStore.getState())?.ownership).toBe(fresh);
      expect(requireBeamSession().status).toBe('running');
      expect(requireBeamSession().reviewed).toBe(reviewed);
      expect(requireBeamSession().errorKey).toBeNull();
      expect(port.terminated).toBe(0);
      expect(port.onmessage).toBe(callback);
      port.onmessage?.(port.reply('phase'));
      expect(requireBeamSession().phase).toBe('solving');
    }
    port.onmessage?.(port.reply('failure'));
    await vi.waitFor(() => expect(requireBeamSession().status).toBe('failed'));
    expect(requireBeamSession().diagnostic).toContain('solver-failed');
    expect(requireBeamSession().result).toBeNull();
    expect(port.terminated).toBe(1);
    expect(attachment?.statistics()).toEqual({ created: 1, terminated: 1, live: 0 });
  });

  it.each(['resolved', 'bodies', 'sources', 'document', 'library', 'version', 'generation', 'cancel'] as const)(
    'rejects a current replacement with changed physical %s and ignores late responses', async reason => {
      const { fixture, port } = await running();
      const late = port.onmessage;
      const state = useAppStore.getState();
      const view = state.assemblyView;
      if (view?.meshOwnership === undefined) throw new Error('Expected current publication');
      const owner = view.meshOwnership;
      const document = reason === 'document' ? { ...owner.document } : owner.document;
      const library = reason === 'library' ? { ...owner.library } : owner.library;
      const documentVersion = owner.documentVersion + (reason === 'version' ? 1 : 0);
      const generation = owner.generation + (reason === 'generation' ? 1 : 0);
      const cancelRequestCount = owner.cancelRequestCount + (reason === 'cancel' ? 1 : 0);
      const bodies = reason === 'bodies' ? new Map(owner.bodies) : owner.bodies;
      let resolved = view.resolved;
      if (reason === 'resolved') {
        const placements = new Map(resolved.placements);
        const placement = placements.get(fixture.component.id);
        if (placement === undefined) throw new Error('Expected resolved member placement');
        placements.set(fixture.component.id, { ...placement, position: [1, 0, 0] });
        resolved = { ...resolved, placements };
      }
      const fresh: AssemblyMeshOwnership = { ...owner, document, library, documentVersion, generation, cancelRequestCount, bodies,
        sources: reason === 'sources' ? new Map(owner.sources) : owner.sources,
        publicationCurrent: () => useAppStore.getState().assemblyView?.meshOwnership === fresh };
      useAppStore.setState({ assembly: document, assemblyLibrary: library, documentVersion,
        requestedGeneration: generation, completedGeneration: generation, cancelRequestCount,
        assemblyView: { ...view, sourceDocument: document, bodies, meshOwnership: fresh, resolved } });
      // Each replacement is internally current. It must still invalidate the older review.
      expect(captureBeamSource(useAppStore.getState())?.ownership).toBe(fresh);
      expect(requireBeamSession().status).toBe('editing');
      expect(requireBeamSession().errorKey).toBe('beam.error.changed');
      expect(requireBeamSession().reviewed).toBeNull();
      expect(port.terminated).toBe(1);
      expect(port.onmessage).toBeNull();
      const after = useAppStore.getState().beamSession;
      late?.(port.reply('phase'));
      late?.(port.reply('failure'));
      await Promise.resolve();
      expect(useAppStore.getState().beamSession).toBe(after);
      expect(attachment?.statistics()).toEqual({ created: 1, terminated: 1, live: 0 });
    },
  );

  it('reports finite runtime failure and closes the Worker before publication', async () => {
    const { port } = await running();
    port.onmessage?.(port.reply('failure'));
    await vi.waitFor(() => expect(requireBeamSession().status).toBe('failed'));
    expect(requireBeamSession().result).toBeNull();
    expect(requireBeamSession().diagnostic).toContain('solver-failed');
    expect(port.terminated).toBe(1);
    expect(attachment?.statistics().live).toBe(0);
  });

  it('cancels from the user action and cannot use an unreviewed edit to start a replacement Worker', async () => {
    const { fixture, port, ports } = await running();
    useAppStore.getState().cancelBeam();
    expect(requireBeamSession().status).toBe('cancelled');
    expect(port.terminated).toBe(1);
    useAppStore.getState().editBeam({ kind: 'value', id: fixture.session.members[0].id, field: 'endFx', source: '20' });
    useAppStore.getState().runBeam();
    await Promise.resolve();
    expect(ports).toHaveLength(1);
    expect(requireBeamSession().errorKey).toBe('beam.error.review');
  });
});
