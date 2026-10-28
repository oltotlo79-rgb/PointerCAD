import { invalidateBoltPreloadDraft, reviewedBoltPreloadWire, type BoltPreloadDraft } from './boltPreloadDraft.js';
import { FemClient, createProductFemWorker, impactMemberResponse, transientAxialResponse, translateBeamBuckling,
  type FemOptions, type FemWorkerPort } from '@pointercad/fem';
import type { StoreApi } from 'zustand';
import type { AppState } from '../store/appState.js';
import type { BeamRunner, BoltPreloadRunner } from '../store/beamSlice.js';
import { useAppStore } from '../store/useAppStore.js';
import { beamDefinition, invalidateBeamSession, type BeamSession } from './beamSession.js';
import { beamSourceIsCurrent, type BeamSourceSnapshot } from './beamSource.js';
import { prepareBeamAnalysis } from './prepareBeamAnalysis.js';

export interface BeamWorkerStatistics {
  readonly created: number;
  readonly terminated: number;
  readonly live: number;
}
export interface BeamAttachment {
  dispose(): void;
  statistics(): BeamWorkerStatistics;
}

/** The app attachment owns resources; the only UI state lives in the existing Zustand store. */
export function attachBeamAnalysis(
  store: StoreApi<AppState> = useAppStore,
  createWorker: () => FemWorkerPort = createProductFemWorker,
): BeamAttachment {
  let created = 0, terminated = 0;
  const client = new FemClient(() => {
    const worker = createWorker();
    created += 1;
    let released = false;
    return {
      postMessage: message => worker.postMessage(message),
      terminate: () => {
        if (released) return;
        released = true;
        worker.terminate();
        terminated += 1;
      },
      get onmessage() { return worker.onmessage; }, set onmessage(value) { worker.onmessage = value; },
      get onerror() { return worker.onerror; }, set onerror(value) { worker.onerror = value; },
      get onmessageerror() { return worker.onmessageerror; }, set onmessageerror(value) { worker.onmessageerror = value; },
    };
  });
  let active: { readonly kind: 'standard' | 'preload'; readonly token: object; readonly controller: AbortController } | null = null;
  let disposed = false;
  const cancel = (): void => {
    const previous = active;
    active = null;
    previous?.controller.abort();
    const state = store.getState();
    if (previous?.kind === 'standard' && state.beamSession?.status === 'running') store.setState({ beamSession: { ...state.beamSession, status: 'cancelled', phase: null, result: null } });
    if (previous?.kind === 'preload' && state.boltPreloadStatus === 'running') store.setState({ boltPreloadStatus: 'cancelled', boltPreloadPhase: null });
  };
  const current = (token: object, session: BeamSession, source: BeamSourceSnapshot): boolean => {
    const state = store.getState(), next = state.beamSession;
    return !disposed && active?.kind === 'standard' && active.token === token && state.strengthSession !== null && next !== null
      && next.ownerId === session.ownerId && next.analysisId === session.analysisId
      && next.revision === session.revision && next.reviewed === source && beamSourceIsCurrent(source, state);
  };
  const run = (session: BeamSession, source: BeamSourceSnapshot): void => {
    cancel();
    if (disposed || !beamSourceIsCurrent(source, store.getState())) return;
    const draft = beamDefinition(session, source, source.document.parameters);
    const checked = draft.ok ? prepareBeamAnalysis(source, draft.definition) : null;
    if (checked === null || !checked.ok) {
      store.setState({ beamSession: { ...session, result: null, status: 'failed', errorKey: 'beam.error.model' } });
      return;
    }
    const token = {}, controller = new AbortController();
    active = { kind: 'standard', token, controller };
    store.setState({ beamSession: { ...session, result: null, bucklingEdges: [], transientAxial: null, impactMembers: null, status: 'running', phase: null, errorKey: null, diagnostic: null } });
    const options: FemOptions = {
      signal: controller.signal,
      onPhase: phase => {
        const next = store.getState().beamSession;
        if (current(token, session, source) && next !== null) store.setState({ beamSession: { ...next, phase } });
      },
    };
    const edges = checked.kind === 'buckling' ? translateBeamBuckling(checked.input).plan.members.map(member => member.nodes) : [];
    // FemClient.analyzeTransient accepts a result only when it matches this exact input and its digest.
    const transientInput = checked.kind === 'transient' ? checked.input : null;
    // The member-mean resultants are derived once from the accepted impact result and this exact input, never per render.
    const impactInput = checked.kind === 'impact' ? checked.input : null;
    // FemClient.analyzeContact likewise accepts only a result decoded from this exact input and digest; a reply for an
    // earlier revision, another reviewed source or a cancelled request is still dropped by current() below.
    // FemClient.analyzeBeamImpact also accepts only a result re-decoded for this exact input and digest; the same
    // current() ownership check below drops cancelled, superseded and wrong-revision replies.
    const work = checked.kind === 'impact' ? client.analyzeBeamImpact(checked.input, options)
      : checked.kind === 'joint-initial-strain' ? client.analyzeJointInitialStrain(checked.input, options)
      : checked.kind === 'joint-contact' ? client.analyzeJointContact(checked.input, options)
      : checked.kind === 'weld-contact' ? client.analyzeWeldContact(checked.input, options)
      : checked.kind === 'bolt-contact' ? client.analyzeBoltContact(checked.input, options)
      : checked.kind === 'contact' ? client.analyzeContact(checked.input, options)
      : checked.kind === 'transient' ? client.analyzeTransient(checked.input, options)
      : checked.kind === 'buckling' ? client.analyzeBuckling(checked.input, options)
      : checked.kind === 'modal' ? client.analyzeModal(checked.document, options) : client.analyze(checked.document, options);
    void work.then(completion => {
      if (!current(token, session, source)) return;
      // Derived before ownership is released, so a rejected derivation reaches the failure path below.
      const transientAxial = transientInput !== null && completion.kind === 'result'
        && completion.result.kind === 'oofem-beam-transient-3d' ? transientAxialResponse(completion.result, transientInput) : null;
      const impactMembers = impactInput !== null && completion.kind === 'result'
        && completion.result.kind === 'oofem-beam-impact-3d' ? impactMemberResponse(completion.result, impactInput) : null;
      active = null;
      const next = store.getState().beamSession;
      if (next === null) return;
      if (completion.kind === 'result') {
        store.setState({ beamSession: { ...next, result: completion.result,
          bucklingEdges: completion.result.kind === 'oofem-beam-buckling-3d' ? edges : [], transientAxial, impactMembers,
          status: 'complete', phase: null } });
      } else {
        store.setState({ beamSession: { ...next, result: null, transientAxial: null, impactMembers: null, phase: null,
          status: completion.kind === 'cancelled' ? 'cancelled' : 'failed',
          errorKey: completion.kind === 'failed' ? 'beam.error.runtime' : null,
          diagnostic: completion.kind === 'failed' ? `${completion.failure.code}: ${completion.failure.message}` : null } });
      }
    }).catch((error: unknown) => {
      if (!current(token, session, source)) return;
      active = null;
      const next = store.getState().beamSession;
      if (next !== null) store.setState({ beamSession: { ...next, result: null, transientAxial: null, impactMembers: null, status: 'failed', phase: null,
        errorKey: 'beam.error.runtime', diagnostic: error instanceof Error ? error.message : 'FEM request failed' } });
    });
  };
  const preloadCurrent = (token: object, draft: BoltPreloadDraft, owner: { readonly id: string; readonly revision: number; readonly reviewed: BoltPreloadDraft['reviewed'] }): boolean => {
    const state = store.getState(), next = state.boltPreloadDraft;
    return !disposed && active?.kind === 'preload' && active.token === token && next === draft
      && next.saved.id === owner.id && next.revision === owner.revision && next.reviewed === owner.reviewed
      && state.strengthSession !== null && state.assembly?.id === draft.saved.source.documentId
      && draft.reviewed !== null && beamSourceIsCurrent(draft.reviewed.source, state);
  };
  const runPreload = (draft: BoltPreloadDraft): void => {
    cancel();
    if (disposed || store.getState().boltPreloadDraft !== draft) return;
    let wire;
    try { wire = reviewedBoltPreloadWire(draft, store.getState()); }
    catch (error) { store.setState({ boltPreloadStatus: 'failed', boltPreloadPhase: null, boltPreloadError: error instanceof Error ? error.message : 'Preload review required' }); return; }
    const owner = { id: draft.saved.id, revision: draft.revision, reviewed: draft.reviewed };
    const token = {}, controller = new AbortController(), runningDraft = { ...draft, result: null }; active = { kind: 'preload', token, controller };
    store.setState({ boltPreloadDraft: runningDraft, boltPreloadStatus: 'running', boltPreloadPhase: null, boltPreloadError: null });
    void client.analyzeNativeBoltPreload(wire, { signal: controller.signal, onPhase: phase => {
      if (preloadCurrent(token, runningDraft, owner)) store.setState({ boltPreloadPhase: phase });
    } }).then(completion => {
      if (!preloadCurrent(token, runningDraft, owner)) return;
      active = null;
      if (completion.kind === 'result') store.setState({ boltPreloadDraft: { ...runningDraft, result: completion.result }, boltPreloadStatus: 'complete', boltPreloadPhase: null });
      else store.setState({ boltPreloadStatus: completion.kind === 'cancelled' ? 'cancelled' : 'failed', boltPreloadPhase: null,
        boltPreloadError: completion.kind === 'failed' ? `${completion.failure.code}: ${completion.failure.message}` : null });
    }).catch((error: unknown) => {
      if (!preloadCurrent(token, runningDraft, owner)) return;
      active = null; store.setState({ boltPreloadStatus: 'failed', boltPreloadPhase: null, boltPreloadError: error instanceof Error ? error.message : 'Preload run failed' });
    });
  };
  const preloadRunner: BoltPreloadRunner = { run: runPreload, cancel };
  store.getState().setBoltPreloadRunner(preloadRunner);
  const runner: BeamRunner = { run, cancel };
  store.getState().setBeamRunner(runner);
  const unsubscribe = store.subscribe(state => {
    const draft = state.boltPreloadDraft;
    const invalidOwner = state.strengthSession === null || state.assembly === null || (draft !== null && state.assembly.id !== draft.saved.source.documentId);
    const stale = draft?.reviewed !== null && draft?.reviewed !== undefined && !beamSourceIsCurrent(draft.reviewed.source, state);
    if (draft !== null && (invalidOwner || stale)) {
      if (active?.kind === 'preload') cancel();
      store.setState({ boltPreloadDraft: invalidOwner ? null : invalidateBoltPreloadDraft(draft), boltPreloadStatus: 'editing', boltPreloadPhase: null, boltPreloadError: 'Preload source changed' });
    }
    const session = state.beamSession;
    if (session === null) { if (active?.kind === 'standard') cancel(); return; }
    if (state.strengthSession === null || session.ownerId !== state.activeDocumentId || state.assembly === null) {
      if (active?.kind === 'standard') cancel();
      store.setState({ beamSession: null });
    } else if (session.reviewed !== null && !beamSourceIsCurrent(session.reviewed, state)) {
      if (active?.kind === 'standard') cancel();
      store.setState({ beamSession: invalidateBeamSession(session, 'beam.error.changed') });
    }
  });
  return {
    statistics: () => ({ created, terminated, live: created - terminated }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      cancel();
      client.dispose();
      if (store.getState().boltPreloadRunner === preloadRunner) store.setState({ boltPreloadRunner: null, boltPreloadDraft: null, boltPreloadStatus: 'editing', boltPreloadPhase: null, boltPreloadError: null });
      if (store.getState().beamRunner === runner) store.setState({ beamRunner: null, beamSession: null });
    },
  };
}
