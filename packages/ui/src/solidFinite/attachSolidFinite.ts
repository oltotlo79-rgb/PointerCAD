import { analyzeCadSolidFinite, FemClient, createProductFemWorker, type CadSolidFiniteSettings, type CadTetraContext,
  type FemWorkerPort } from '@pointercad/fem';
import { affectsShape, createSubShapeReference, type AnalysisBoundarySource, type PartDocument, type ResolvedPart,
  type SolidBody, type SubShapeRef } from '@pointercad/model';
import { solidCadFaceKey, type SolidFiniteCadSavedInput } from '@pointercad/model/beam-analysis';
import type { StoreApi } from 'zustand';
import type { AppState } from '../store/appState.js';
import type { SolidFiniteRunner } from '../store/solidFiniteSlice.js';
import { useAppStore } from '../store/useAppStore.js';
import { hasCurrentConnectionGeometry } from '../sketch/connectionSelection.js';
import { parseSubShapeId } from '../solid/subShapeSelection.js';
import { t } from '../i18n/t.js';
import { createSolidFiniteSession, solidFiniteSavedInput } from './solidFiniteSession.js';
import { createSolidSupport } from '../solidAnalysis/solidBoundaryDraft.js';

/**
 * Mirrors attachSolidAnalysis (same captured recompute, face-key resolution, ownership and invalidation rules) and
 * runs the CAD finite-strain bridge through the product FEM worker. Any document, selection-owner, recompute or cancel
 * change cancels the run and clears the result; a late reply of an older revision is ignored.
 */
export function attachSolidFinite(kernel: AnalysisBoundarySource, store: StoreApi<AppState> = useAppStore,
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
  const context = (bodyFeatureId: string): CadTetraContext => {
    const state = store.getState();
    if (disposed || !hasCurrentConnectionGeometry(state) || state.assembly !== null || state.drawing !== null
      || resolved === null || !resolved.valid || resolved.generation !== state.completedGeneration
      || resolved.document.id !== state.document.id
      || resolved.owner !== state.activeDocumentId || resolved.gateway !== state.fileGateway
      || affectsShape(resolved.document, state.document)) throw new Error(t('solidFinite.changed'));
    const matches = state.bodies.filter(body => body.featureId === bodyFeatureId && body.isValid && body.bodyKind === 'solid');
    if (matches.length !== 1) throw new Error(t('solidFinite.selectBody'));
    return { documentId: state.document.id, revision: state.completedGeneration, body: matches[0], steps: resolved.steps };
  };
  const references = (body: SolidBody, keys: readonly string[]): SubShapeRef[] => {
    const faces = body.faces.flatMap(face => {
      const reference = createSubShapeReference(body, 'face', face.index);
      return reference?.origin ? [reference] : [];
    });
    return keys.map(key => {
      const matches = faces.filter(reference => solidCadFaceKey(reference) === key);
      if (matches.length !== 1) throw new Error(t('solidFinite.changed'));
      return matches[0];
    });
  };
  const settings = (saved: SolidFiniteCadSavedInput): CadSolidFiniteSettings => {
    const current = context(saved.bodyFeatureId);
    const supportReferences = saved.supports === undefined ? [] : references(current.body, saved.supports.map(row => row.face));
    const boundary = { boundary: 'closed' as const, linearDeflection: saved.linearDeflectionMm,
      angularDeflection: saved.angularDeflectionRad };
    return { material: { id: 'material', youngMPa: saved.youngMPa, poisson: saved.poisson },
      fixedFaces: references(current.body, saved.fixedFaces), loadedFaces: references(current.body, saved.loadedFaces),
      tractionMPa: saved.tractionMPa, numericBudgetBytes: 256 * 1024 * 1024,
      geometry: current.body.faces.every(face => face.surfaceKind === 'plane') ? { kind: 'planar', boundary }
        : { kind: 'curved', options: { boundary, nodeToleranceMm: 1e-7,
          maximumChordDeviationMm: saved.maximumChordDeviationMm, maximumVolumeDeviationMm3: saved.maximumVolumeDeviationMm3 } },
      yieldStressMPa: saved.yieldStressMPa, hardeningModulusMPa: saved.hardeningModulusMPa,
      materialReference: saved.materialReference, forceFactors: saved.forceFactors,
      prescribedDisplacementFactors: saved.prescribedDisplacementFactors,
      ...(saved.referenceForceN === undefined ? {} : { referenceForceN: saved.referenceForceN }),
      ...(saved.gravity === undefined ? {} : { gravity: saved.gravity }),
      ...(saved.supports === undefined ? {} : { supports: saved.supports.map((row, index) => ({ ...row,
        face: supportReferences[index] })) }) };
  };
  const failure = (error: unknown): void => {
    const session = store.getState().solidFiniteSession;
    if (session) store.setState({ solidFiniteSession: { ...session, status: 'failed', result: null,
      error: error instanceof Error ? error.message : t('solidFinite.failed') } });
  };
  const validate = (): void => {
    const state = store.getState(), session = state.solidFiniteSession;
    if (!session || session.ownerId !== state.activeDocumentId) throw new Error(t('solidFinite.changed'));
    settings(solidFiniteSavedInput(session, state.document.id, state.document.parameters));
  };
  const captureFaces = (role: 'fixed' | 'loaded' | 'support'): void => {
    cancel();
    try {
      const state = store.getState(), session = state.solidFiniteSession, selected = selection;
      if (!session || !selected || selected.ids !== state.selection || selected.document !== state.document
        || selected.generation !== state.completedGeneration || selected.version !== state.documentVersion
        || selected.owner !== state.activeDocumentId || selected.gateway !== state.fileGateway
        || selected.bodies !== state.bodies || selected.ids.length === 0)
        throw new Error(t('solidFinite.reselect'));
      const ids = selected.ids.map(parseSubShapeId), first = ids[0];
      if (!first || first.kind !== 'face' || ids.some(id => !id || id.kind !== 'face' || id.bodyFeatureId !== first.bodyFeatureId)
        || (session.bodyFeatureId !== null && session.bodyFeatureId !== first.bodyFeatureId)) throw new Error(t('solidFinite.selectBody'));
      const body = context(first.bodyFeatureId).body;
      const keys = ids.map(id => {
        const reference = id ? createSubShapeReference(body, 'face', id.index) : null;
        if (!reference?.origin) throw new Error(t('solidFinite.changed'));
        return solidCadFaceKey(reference);
      });
      if (new Set(keys).size !== keys.length) throw new Error(t('solidFinite.reselect'));
      const supports = session.supports ?? [];
      if ((role === 'support' && keys.some(key => session.fixedFaces.includes(key) || supports.some(row => row.face === key)))
        || (role === 'fixed' && keys.some(key => supports.some(row => row.face === key))))
        throw new Error(t('solidAnalysis.supportDuplicate'));
      store.setState({ solidFiniteSession: { ...session, bodyFeatureId: first.bodyFeatureId,
        ...(role === 'fixed' ? { fixedFaces: keys } : role === 'loaded' ? { loadedFaces: keys }
          : { supports: [...supports, ...keys.map(createSolidSupport)] }), revision: session.revision + 1,
        result: null, error: null, status: 'editing' } });
    } catch (error) { failure(error); }
  };
  const run = (): void => {
    cancel();
    const state = store.getState(), session = state.solidFiniteSession;
    if (!session) return;
    try {
      validate();
      const saved = solidFiniteSavedInput(session, state.document.id, state.document.parameters), input = settings(saved);
      const controller = new AbortController(), document = state.document, generation = state.completedGeneration;
      active = controller;
      store.setState({ solidFiniteSession: { ...session, status: 'running', result: null, error: null } });
      const current = (): boolean => {
        const next = store.getState();
        return !disposed && active === controller && !controller.signal.aborted && next.strengthSession !== null
          && next.solidFiniteSession?.ownerId === session.ownerId && next.solidFiniteSession.revision === session.revision
          && next.document === document && next.fileGateway === state.fileGateway
          && next.activeDocumentId === state.activeDocumentId && next.completedGeneration === generation && hasCurrentConnectionGeometry(next);
      };
      void analyzeCadSolidFinite(client, kernel, () => {
        if (!current()) throw new Error(t('solidFinite.changed'));
        return context(saved.bodyFeatureId);
      }, input, { signal: controller.signal }).then(outcome => {
        if (!current()) return;
        active = null;
        const next = store.getState().solidFiniteSession;
        if (next) store.setState({ solidFiniteSession: { ...next, status: outcome.kind === 'result' ? 'complete'
          : outcome.kind === 'cancelled' ? 'cancelled' : 'failed', result: outcome.kind === 'result' ? outcome : null,
        error: outcome.kind === 'failed' ? outcome.message : null } });
      }).catch((error: unknown) => { if (current()) { active = null; failure(error); } });
    } catch (error) { failure(error); }
  };
  const runner: SolidFiniteRunner = { run, cancel, captureFaces, validate };
  store.setState({ solidFiniteRunner: runner });
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.selection !== previous.selection) selection = state.solidFiniteSession && hasCurrentConnectionGeometry(state)
      ? { ids: state.selection, document: state.document, generation: state.completedGeneration,
        version: state.documentVersion, owner: state.activeDocumentId, gateway: state.fileGateway, bodies: state.bodies } : null;
    const session = state.solidFiniteSession;
    if (!session) { cancel(); return; }
    if (state.strengthSession === null || state.activeDocumentId !== session.ownerId || state.assembly !== null || state.drawing !== null) {
      cancel(); selection = null; store.setState({ solidFiniteSession: null }); return;
    }
    const oldSaved = previous.document.beamAnalysisInputs?.analyses.find(item => item.kind === 'solid-finite-cad');
    const saved = state.document.beamAnalysisInputs?.analyses.find(item => item.kind === 'solid-finite-cad');
    if (state.document !== previous.document && state.activeDocumentId === previous.activeDocumentId
      && state.fileGateway === previous.fileGateway && JSON.stringify(oldSaved) !== JSON.stringify(saved)) {
      cancel(); selection = null;
      const draft = createSolidFiniteSession(state.activeDocumentId, saved?.kind === 'solid-finite-cad' ? saved.definition : undefined);
      store.setState({ solidFiniteSession: { ...draft, revision: session.revision + 1 } });
      return;
    }
    if (state.document !== previous.document || state.fileGateway !== previous.fileGateway
      || state.completedGeneration !== previous.completedGeneration
      || state.documentVersion !== previous.documentVersion || state.cancelRequestCount !== previous.cancelRequestCount
      || state.isComputing !== previous.isComputing || state.bodies !== previous.bodies) {
      cancel(); selection = null;
      // Saving input metadata changes document identity, but not the current geometry.
      // Still cancel/clear results; do not invent a stale-geometry error for that save.
      const metadataOnly = state.document !== previous.document && state.document.id === previous.document.id
        && !affectsShape(previous.document, state.document) && hasCurrentConnectionGeometry(state)
        && state.activeDocumentId === previous.activeDocumentId && state.fileGateway === previous.fileGateway
        && state.documentVersion === previous.documentVersion && state.completedGeneration === previous.completedGeneration
        && state.cancelRequestCount === previous.cancelRequestCount && state.isComputing === previous.isComputing
        && state.bodies === previous.bodies;
      store.setState({ solidFiniteSession: { ...session, status: 'editing', result: null,
        error: metadataOnly ? session.error : t('solidFinite.changed') } });
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
      disposed = true; unsubscribe(); cancel(); client.dispose();
      if (store.getState().solidFiniteRunner === runner) store.setState({ solidFiniteRunner: null, solidFiniteSession: null });
    },
  };
}
