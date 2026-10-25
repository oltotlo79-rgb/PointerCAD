import { FemClient, createProductFemWorker, type FemOptions, type FemWorkerPort, type PlasticBarInput,
  type PlasticBarPlan } from '@pointercad/fem';
import type { Parameter } from '@pointercad/model';
import type { StoreApi } from 'zustand';
import type { AppState } from '../store/appState.js';
import type { PlasticBarRunner } from '../store/plasticBarSlice.js';
import { useAppStore } from '../store/useAppStore.js';
import type { BeamAttachment } from '../beam/attachBeamAnalysis.js';
import { plasticBarInput, type PlasticBarSession } from './plasticBarSession.js';

/** The parameters the panel evaluates its expressions with (the same choice as runPlasticBar and the panel). */
function ownerParameters(state: AppState): readonly Parameter[] {
  return state.assembly?.parameters ?? state.document.parameters;
}
/** Exact equality of the bounded solver plan (at most 64 knots); no document-wide serialization. */
function samePlan(left: PlasticBarPlan, right: PlasticBarPlan): boolean {
  return left.lengthM === right.lengthM && left.areaM2 === right.areaM2 && left.stepsPerSegment === right.stepsPerSegment
    && left.material.youngPa === right.material.youngPa && left.material.poisson === right.material.poisson
    && left.material.yieldStressPa === right.material.yieldStressPa
    && left.material.hardeningModulusPa === right.material.hardeningModulusPa
    && left.material.source.reference === right.material.source.reference
    && left.endDisplacementM.length === right.endDisplacementM.length
    && left.endDisplacementM.every((knot, index) => knot === right.endDisplacementM[index]);
}

/** Same ownership as attachBeamAnalysis: this attachment owns its FemClient and every Worker it creates; the only
 * UI state is the store's plasticBarSession. A late completion is applied only to the same document and revision. */
export function attachPlasticBar(
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
  let active: { readonly token: object; readonly controller: AbortController } | null = null;
  let disposed = false;
  /** What the running or completed result was computed from. Field expressions may name document or assembly
   * parameters, so the session revision alone does not bind the result (ui1 defect: a parameter edit through
   * applyDocument/applyAssembly kept an old result current and let a late completion through). */
  let bound: { readonly ownerId: string; readonly revision: number; readonly parameters: readonly Parameter[];
    readonly plan: PlasticBarPlan } | null = null;
  const cancel = (): void => {
    const previous = active;
    active = null;
    previous?.controller.abort();
  };
  const current = (token: object, session: PlasticBarSession): boolean => {
    const state = store.getState(), next = state.plasticBarSession;
    return !disposed && active?.token === token && state.strengthSession !== null && next !== null
      && next.ownerId === session.ownerId && next.revision === session.revision
      && state.activeDocumentId === session.ownerId;
  };
  const run = (session: PlasticBarSession, input: PlasticBarInput): void => {
    cancel();
    if (disposed || input.source.documentId !== session.ownerId || input.source.revision !== session.revision) return;
    const token = {}, controller = new AbortController();
    active = { token, controller };
    // Bound before the state change below so that the subscription sees the same parameters and keeps the run.
    bound = { ownerId: session.ownerId, revision: session.revision, parameters: ownerParameters(store.getState()),
      plan: input.plan };
    store.setState({ plasticBarSession: { ...session, result: null, status: 'running', phase: null, errorKey: null, diagnostic: null } });
    const options: FemOptions = {
      signal: controller.signal,
      onPhase: phase => {
        const next = store.getState().plasticBarSession;
        if (current(token, session) && next !== null) store.setState({ plasticBarSession: { ...next, phase } });
      },
    };
    // FemClient.analyzePlasticBar accepts a result only when it matches this exact input and its digest.
    void client.analyzePlasticBar(input, options).then(completion => {
      if (!current(token, session)) return;
      active = null;
      const next = store.getState().plasticBarSession;
      if (next === null) return;
      if (completion.kind === 'result') {
        store.setState({ plasticBarSession: { ...next, result: completion.result, status: 'complete', phase: null } });
      } else {
        store.setState({ plasticBarSession: { ...next, result: null, phase: null,
          status: completion.kind === 'cancelled' ? 'cancelled' : 'failed',
          errorKey: completion.kind === 'failed' ? 'plasticBar.error.runtime' : null,
          diagnostic: completion.kind === 'failed' ? `${completion.failure.code}: ${completion.failure.message}` : null } });
      }
    }).catch((error: unknown) => {
      if (!current(token, session)) return;
      active = null;
      const next = store.getState().plasticBarSession;
      if (next !== null) store.setState({ plasticBarSession: { ...next, result: null, status: 'failed', phase: null,
        errorKey: 'plasticBar.error.runtime', diagnostic: error instanceof Error ? error.message : 'FEM request failed' } });
    });
  };
  const runner: PlasticBarRunner = { run, cancel };
  store.getState().setPlasticBarRunner(runner);
  const unsubscribe = store.subscribe(state => {
    const session = state.plasticBarSession;
    if (session === null) { cancel(); return; }
    if (state.strengthSession === null || session.ownerId !== state.activeDocumentId) {
      cancel();
      store.setState({ plasticBarSession: null });
      return;
    }
    const parameters = ownerParameters(state);
    if (bound === null || bound.ownerId !== session.ownerId || bound.revision !== session.revision
      || bound.parameters === parameters || (session.status !== 'running' && session.result === null)) return;
    // Parameters were replaced (edit, configuration, CSV, Undo): re-evaluate the unchanged draft. An unrelated
    // parameter leaves the plan equal and keeps the run or result; any change of the plan cancels and invalidates.
    const checked = plasticBarInput(session, parameters);
    if (checked.ok && samePlan(checked.input.plan, bound.plan)) {
      bound = { ...bound, parameters };
      return;
    }
    bound = null;
    cancel();
    store.setState({ plasticBarSession: { ...session, result: null, status: 'editing', phase: null,
      errorKey: 'beam.error.changed', diagnostic: null } });
  });
  return {
    statistics: () => ({ created, terminated, live: created - terminated }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      cancel();
      client.dispose();
      if (store.getState().plasticBarRunner === runner) store.setState({ plasticBarRunner: null, plasticBarSession: null });
    },
  };
}
