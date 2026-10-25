import { analyzeCadSolid, FemClient, createProductFemWorker, type CadSolidPressureSettings, type CadSolidSettings,
  type CadTetraContext, type FemWorkerPort } from '@pointercad/fem';
import { affectsShape, createSubShapeReference, type AnalysisBoundarySource, type PartDocument, type ResolvedPart,
  type SolidBody, type SubShapeRef } from '@pointercad/model';
import { solidCadFaceKey, type SolidCadSavedInput } from '@pointercad/model/beam-analysis';
import type { StoreApi } from 'zustand';
import type { AppState } from '../store/appState.js';
import type { SolidAnalysisRunner } from '../store/solidAnalysisSlice.js';
import { useAppStore } from '../store/useAppStore.js';
import { hasCurrentConnectionGeometry } from '../sketch/connectionSelection.js';
import { parseSubShapeId } from '../solid/subShapeSelection.js';
import { t } from '../i18n/t.js';
import { solidSavedInput } from './solidAnalysisSession.js';
import { analyzeCadSolidModal, type CadSolidModalSettings } from './cadSolidModal.js';
import { invalidateSolidModal, solidModalRequestValues } from './solidModalState.js';
import { solidModalEffectiveShared } from './solidModalShared.js';
import { analyzeCadSolidBuckling, cadSolidBucklingFailureCode } from './cadSolidBuckling.js';
import { invalidateSolidBuckling, solidBucklingModeCount } from './solidBucklingState.js';
import { solidBucklingEffectiveReference } from './solidBucklingSaved.js';

/** The same part with the same geometry. Saving the analysis inputs (or any other non-shape field such as appearance)
 * replaces the document object without touching a shape field (`affectsShape`), so it must neither invalidate a result
 * nor cancel a run. A different part or any shape change (solids, sketches, parameters, ...) still does. */
function sameGeometryDocument(left: PartDocument, right: PartDocument): boolean {
  return left === right || (left.id === right.id && !affectsShape(left, right));
}

/** A resolved step is captured from the real recompute callback, never recomputed with different caches. */
export function attachSolidAnalysis(kernel: AnalysisBoundarySource, store: StoreApi<AppState> = useAppStore,
  createWorker: () => FemWorkerPort = createProductFemWorker): {
    captureResolved(document: PartDocument, generation: number,
      resolved: Pick<ResolvedPart, 'errors'> & { readonly steps: CadTetraContext['steps'] }): void;
    statistics(): { created: number; terminated: number; live: number };
    dispose(): void;
  } {
  let created = 0, terminated = 0, disposed = false;
  const client = new FemClient(() => {
    const port = createWorker(); created++;
    let released = false;
    return { postMessage: message => port.postMessage(message),
      terminate: () => { if (!released) { released = true; terminated++; port.terminate(); } },
      get onmessage() { return port.onmessage; }, set onmessage(value) { port.onmessage = value; },
      get onerror() { return port.onerror; }, set onerror(value) { port.onerror = value; },
      get onmessageerror() { return port.onmessageerror; }, set onmessageerror(value) { port.onmessageerror = value; } };
  });
  let resolved: { document: PartDocument; generation: number; steps: CadTetraContext['steps']; valid: boolean;
    owner: string; gateway: AppState['fileGateway'] } | null = null;
  let active: AbortController | null = null;
  let selection: { ids: readonly string[]; document: PartDocument; generation: number; version: number;
    owner: string; gateway: AppState['fileGateway']; bodies: readonly SolidBody[] } | null = null;
  const cancel = (): void => { const old = active; active = null; old?.abort(); };
  let modalActive: AbortController | null = null;
  const cancelModal = (): void => { const old = modalActive; modalActive = null; old?.abort(); };
  let bucklingActive: AbortController | null = null;
  const cancelBuckling = (): void => { const old = bucklingActive; bucklingActive = null; old?.abort(); };
  const context = (bodyFeatureId: string): CadTetraContext => {
    const state = store.getState();
    if (disposed || !hasCurrentConnectionGeometry(state) || state.assembly !== null || state.drawing !== null
      || resolved === null || !resolved.valid || resolved.generation !== state.completedGeneration
      || resolved.document.id !== state.document.id
      || resolved.owner !== state.activeDocumentId || resolved.gateway !== state.fileGateway
      || affectsShape(resolved.document, state.document)) throw new Error(t('solidAnalysis.changed'));
    const matches = state.bodies.filter(body => body.featureId === bodyFeatureId && body.isValid && body.bodyKind === 'solid');
    if (matches.length !== 1) throw new Error(t('solidAnalysis.selectBody'));
    return { documentId: state.document.id, revision: state.completedGeneration, body: matches[0], steps: resolved.steps };
  };
  const references = (body: SolidBody, keys: readonly string[]): SubShapeRef[] => {
    const faces = body.faces.flatMap(face => {
      const reference = createSubShapeReference(body, 'face', face.index);
      return reference?.origin ? [reference] : [];
    });
    return keys.map(key => {
      const matches = faces.filter(reference => solidCadFaceKey(reference) === key);
      if (matches.length !== 1) throw new Error(t('solidAnalysis.changed'));
      return matches[0];
    });
  };
  const settings = (saved: SolidCadSavedInput): CadSolidSettings | CadSolidPressureSettings => {
    const current = context(saved.bodyFeatureId);
    const boundary = { boundary: 'closed' as const, linearDeflection: saved.linearDeflectionMm,
      angularDeflection: saved.angularDeflectionRad };
    const common = { material: { id: 'material', youngMPa: saved.youngMPa, poisson: saved.poisson },
      fixedFaces: references(current.body, saved.fixedFaces), loadedFaces: references(current.body, saved.loadedFaces),
      numericBudgetBytes: 256 * 1024 * 1024,
      geometry: current.body.faces.every(face => face.surfaceKind === 'plane') ? { kind: 'planar' as const, boundary }
        : { kind: 'curved' as const, options: { boundary, nodeToleranceMm: 1e-7,
          maximumChordDeviationMm: saved.maximumChordDeviationMm, maximumVolumeDeviationMm3: saved.maximumVolumeDeviationMm3 } } };
    // The FEM accepts exactly one load: a pressure request must not carry a tractionMPa key at all.
    return saved.schema === 'pointercad-solid-cad-input/2' ? { ...common, pressureMPa: saved.pressureMPa }
      : { ...common, tractionMPa: saved.tractionMPa };
  };
  const failure = (error: unknown): void => {
    const session = store.getState().solidAnalysisSession;
    if (session) store.setState({ solidAnalysisSession: { ...session, status: 'failed', result: null,
      error: error instanceof Error ? error.message : t('solidAnalysis.failed') } });
  };
  const validate = (): void => {
    const state = store.getState(), session = state.solidAnalysisSession;
    if (!session || session.ownerId !== state.activeDocumentId) throw new Error(t('solidAnalysis.changed'));
    settings(solidSavedInput(session, state.document.id, state.document.parameters));
  };
  const captureFaces = (role: 'fixed' | 'loaded'): void => {
    try {
      const state = store.getState(), session = state.solidAnalysisSession, selected = selection;
      if (!session || !selected || selected.ids !== state.selection || !sameGeometryDocument(selected.document, state.document)
        || selected.generation !== state.completedGeneration || selected.version !== state.documentVersion
        || selected.owner !== state.activeDocumentId || selected.gateway !== state.fileGateway
        || selected.bodies !== state.bodies || selected.ids.length === 0)
        throw new Error(t('solidAnalysis.reselect'));
      const ids = selected.ids.map(parseSubShapeId), first = ids[0];
      if (!first || first.kind !== 'face' || ids.some(id => !id || id.kind !== 'face' || id.bodyFeatureId !== first.bodyFeatureId)
        || (session.bodyFeatureId !== null && session.bodyFeatureId !== first.bodyFeatureId)) throw new Error(t('solidAnalysis.selectBody'));
      const body = context(first.bodyFeatureId).body;
      const keys = ids.map(id => {
        const reference = id ? createSubShapeReference(body, 'face', id.index) : null;
        if (!reference?.origin) throw new Error(t('solidAnalysis.changed'));
        return solidCadFaceKey(reference);
      });
      if (new Set(keys).size !== keys.length) throw new Error(t('solidAnalysis.reselect'));
      cancel(); cancelModal(); cancelBuckling();
      store.setState({ solidAnalysisSession: { ...session, bodyFeatureId: first.bodyFeatureId,
        ...(role === 'fixed' ? { fixedFaces: keys } : { loadedFaces: keys }), revision: session.revision + 1,
        result: null, error: null, status: 'editing' }, solidModal: invalidateSolidModal(store.getState().solidModal),
        solidBuckling: invalidateSolidBuckling(store.getState().solidBuckling) });
    } catch (error) { failure(error); }
  };
  const run = (): void => {
    cancel();
    const state = store.getState(), session = state.solidAnalysisSession;
    if (!session) return;
    try {
      validate();
      const saved = solidSavedInput(session, state.document.id, state.document.parameters), input = settings(saved);
      const controller = new AbortController(), document = state.document, generation = state.completedGeneration;
      active = controller;
      store.setState({ solidAnalysisSession: { ...session, status: 'running', result: null, error: null } });
      const current = (): boolean => {
        const next = store.getState();
        return !disposed && active === controller && !controller.signal.aborted && next.strengthSession !== null
          && next.solidAnalysisSession?.ownerId === session.ownerId && next.solidAnalysisSession.revision === session.revision
          && sameGeometryDocument(document, next.document) && next.fileGateway === state.fileGateway
          && next.activeDocumentId === state.activeDocumentId && next.completedGeneration === generation && hasCurrentConnectionGeometry(next);
      };
      void analyzeCadSolid(client, kernel, () => {
        if (!current()) throw new Error(t('solidAnalysis.changed'));
        return context(saved.bodyFeatureId);
      }, input, { signal: controller.signal }).then(outcome => {
        if (!current()) return;
        active = null;
        const next = store.getState().solidAnalysisSession;
        if (next) store.setState({ solidAnalysisSession: { ...next, status: outcome.kind === 'result' ? 'complete'
          : outcome.kind === 'cancelled' ? 'cancelled' : 'failed', result: outcome.kind === 'result' ? outcome : null,
        error: outcome.kind === 'failed' ? outcome.message : null } });
      }).catch((error: unknown) => { if (current()) { active = null; failure(error); } });
    } catch (error) { failure(error); }
  };
  /** Modal run of the same session: same body, restrained faces, material and meshing tolerances; no load. */
  const runModal = (): void => {
    cancel(); cancelModal();
    const state = store.getState(), session = state.solidAnalysisSession;
    if (!session) return;
    const id = state.startSolidModal();
    const fail = (error: unknown): void => {
      store.getState().receiveSolidModal(id, { kind: 'failed', message: error instanceof Error ? error.message : null });
    };
    try {
      if (session.ownerId !== state.activeDocumentId) throw new Error(t('solidAnalysis.changed'));
      const values = solidModalRequestValues(state.solidModal);
      if (values === null) throw new Error(t('solidAnalysis.modalInputInvalid'));
      // An independently saved modal input keeps its own shared values; otherwise the panel's current ones.
      const shared = solidModalEffectiveShared(session, state.solidModalShared, state.document.parameters, state.bodies);
      const bodyFeatureId = shared.bodyFeatureId;
      const body = context(bodyFeatureId).body;
      const anchorFace = body.faces.map(face => createSubShapeReference(body, 'face', face.index)).find(reference => reference?.origin);
      if (!anchorFace) throw new Error(t('solidAnalysis.changed'));
      const boundary = { boundary: 'closed' as const, linearDeflection: shared.linearDeflectionMm, angularDeflection: shared.angularDeflectionRad };
      const settings: CadSolidModalSettings = {
        material: { id: 'material', youngMPa: shared.youngMPa, poisson: shared.poisson, densityKgM3: values.densityKgM3 },
        fixedFaces: references(body, shared.fixedFaces), anchorFace, modeCount: values.modeCount, numericBudgetBytes: 256 * 1024 * 1024,
        geometry: body.faces.every(face => face.surfaceKind === 'plane') ? { kind: 'planar', boundary }
          : { kind: 'curved', options: { boundary, nodeToleranceMm: 1e-7,
            maximumChordDeviationMm: shared.maximumChordDeviationMm, maximumVolumeDeviationMm3: shared.maximumVolumeDeviationMm3 } } };
      const controller = new AbortController(), document = state.document, generation = state.completedGeneration;
      modalActive = controller;
      const live = (): boolean => {
        const next = store.getState();
        return !disposed && modalActive === controller && !controller.signal.aborted && next.solidModal.requestId === id
          && next.strengthSession !== null && next.solidAnalysisSession?.ownerId === session.ownerId
          && sameGeometryDocument(document, next.document) && next.fileGateway === state.fileGateway
          && next.activeDocumentId === state.activeDocumentId && next.completedGeneration === generation && hasCurrentConnectionGeometry(next);
      };
      void analyzeCadSolidModal(client, kernel, () => {
        if (!live()) throw new Error(t('solidAnalysis.changed'));
        return context(bodyFeatureId);
      }, settings, { signal: controller.signal }).then(outcome => {
        if (!live()) return;
        modalActive = null;
        if (outcome.kind === 'result') store.getState().receiveSolidModal(id, { kind: 'result', input: outcome.input, result: outcome.result });
        else if (outcome.kind === 'failed') store.getState().receiveSolidModal(id, { kind: 'failed', message: outcome.message });
        else store.getState().cancelSolidModal();
      }).catch((error: unknown) => { if (live()) { modalActive = null; fail(error); } });
    } catch (error) { fail(error); }
  };
  /** Linear prestress buckling of the same session. The reference load state is a static input (the panel's current one,
   * or an independently saved reference) mapped by the SAME settings() as the static run: body, restrained and loaded
   * faces, the one surface load, material and meshing. Only the number of requested load factors is added. */
  const runBuckling = (): void => {
    cancel(); cancelModal(); cancelBuckling();
    const state = store.getState(), session = state.solidAnalysisSession;
    if (!session) return;
    const id = state.startSolidBuckling();
    const fail = (error: unknown): void => {
      const message = error instanceof Error ? error.message : null;
      store.getState().receiveSolidBuckling(id, { kind: 'failed', code: message === null ? null : cadSolidBucklingFailureCode(message), message });
    };
    try {
      if (session.ownerId !== state.activeDocumentId) throw new Error(t('solidAnalysis.changed'));
      const modeCount = solidBucklingModeCount(state.solidBuckling);
      if (modeCount === null) throw new Error(t('solidAnalysis.bucklingInputInvalid'));
      const reference = solidBucklingEffectiveReference(session, state.solidBucklingReference, state.document.id, state.document.parameters);
      const requested = { ...settings(reference), modeCount };
      const controller = new AbortController(), document = state.document, generation = state.completedGeneration;
      bucklingActive = controller;
      const live = (): boolean => {
        const next = store.getState();
        return !disposed && bucklingActive === controller && !controller.signal.aborted && next.solidBuckling.requestId === id
          && next.strengthSession !== null && next.solidAnalysisSession?.ownerId === session.ownerId
          && sameGeometryDocument(document, next.document) && next.fileGateway === state.fileGateway
          && next.activeDocumentId === state.activeDocumentId && next.completedGeneration === generation && hasCurrentConnectionGeometry(next);
      };
      void analyzeCadSolidBuckling(client, kernel, () => {
        if (!live()) throw new Error(t('solidAnalysis.changed'));
        return context(reference.bodyFeatureId);
      }, requested, { signal: controller.signal }).then(outcome => {
        if (!live()) return;
        bucklingActive = null;
        if (outcome.kind === 'result') store.getState().receiveSolidBuckling(id, { kind: 'result', input: outcome.input,
          result: outcome.result, loadedAreaMm2: outcome.loadedAreaMm2, totalForceN: outcome.totalForceN });
        else if (outcome.kind === 'failed') store.getState().receiveSolidBuckling(id, { kind: 'failed',
          code: cadSolidBucklingFailureCode(outcome.message), message: outcome.message });
        else store.getState().cancelSolidBuckling();
      }).catch((error: unknown) => { if (live()) { bucklingActive = null; fail(error); } });
    } catch (error) { fail(error); }
  };
  const runner: SolidAnalysisRunner = { run, cancel, captureFaces, validate, runModal, cancelModal, runBuckling, cancelBuckling };
  store.setState({ solidAnalysisRunner: runner });
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.selection !== previous.selection) selection = state.solidAnalysisSession && hasCurrentConnectionGeometry(state)
      ? { ids: state.selection, document: state.document, generation: state.completedGeneration,
        version: state.documentVersion, owner: state.activeDocumentId, gateway: state.fileGateway, bodies: state.bodies } : null;
    const session = state.solidAnalysisSession;
    if (!session) { cancel(); cancelModal(); cancelBuckling(); return; }
    if (state.strengthSession === null || state.activeDocumentId !== session.ownerId || state.assembly !== null || state.drawing !== null) {
      cancel(); cancelModal(); cancelBuckling(); selection = null;
      store.setState({ solidAnalysisSession: null, solidModal: invalidateSolidModal(state.solidModal),
        solidBuckling: invalidateSolidBuckling(state.solidBuckling) }); return;
    }
    // Its own input save (saveSolidAnalysis -> applyDocument) changes only beamAnalysisInputs: not a geometry change.
    const geometryKept = sameGeometryDocument(previous.document, state.document) && state.fileGateway === previous.fileGateway
      && state.completedGeneration === previous.completedGeneration && state.cancelRequestCount === previous.cancelRequestCount
      && state.isComputing === previous.isComputing && state.bodies === previous.bodies;
    if (!geometryKept || state.documentVersion !== previous.documentVersion) {
      cancel(); cancelModal(); cancelBuckling(); selection = null;
      // Undo/Redo always advance documentVersion (documentSlice: drafts are discarded across a history step), so the run,
      // result and pending selection are still dropped. Only when nothing above changed (a non-shape step such as the
      // input save itself) is it not reported as a shape or input change.
      store.setState({ solidAnalysisSession: { ...session, status: 'editing', result: null,
        error: geometryKept ? session.error : t('solidAnalysis.changed') }, solidModal: invalidateSolidModal(state.solidModal),
        solidBuckling: invalidateSolidBuckling(state.solidBuckling) });
    }
  });
  return {
    captureResolved: (document, generation, value) => {
      const state = store.getState();
      resolved = { document, generation, valid: value.errors.length === 0, owner: state.activeDocumentId, gateway: state.fileGateway,
        steps: value.steps.map(step => ({ featureId: step.featureId, key: step.key })) };
    },
    statistics: () => ({ created, terminated, live: created - terminated }),
    dispose: () => {
      if (disposed) return;
      disposed = true; unsubscribe(); cancel(); cancelModal(); cancelBuckling(); client.dispose();
      if (store.getState().solidAnalysisRunner === runner) store.setState({ solidAnalysisRunner: null, solidAnalysisSession: null });
    },
  };
}
