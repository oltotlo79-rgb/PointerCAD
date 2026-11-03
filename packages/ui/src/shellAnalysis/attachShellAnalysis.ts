import { analyzeCadShell, createProductFemWorker, FemClient, femShellNativeRunner, resolveSavedCadShellSettings,
  type CadShellSettings, type CadTetraContext, type FemWorkerPort } from '@pointercad/fem';
import { affectsShape, createSubShapeReference, type AnalysisBoundarySource, type PartDocument, type ResolvedPart,
  type SolidBody } from '@pointercad/model';
import { solidCadFaceKey, type ShellCadAnalysisInput } from '@pointercad/model/beam-analysis';
import type { StoreApi } from 'zustand';
import type { AppState } from '../store/appState.js';
import type { ShellAnalysisRunner } from '../store/shellAnalysisSlice.js';
import { useAppStore } from '../store/useAppStore.js';
import { hasCurrentConnectionGeometry } from '../sketch/connectionSelection.js';
import { parseSubShapeId } from '../solid/subShapeSelection.js';
import { t } from '../i18n/t.js';
import { emptyShellFixed, emptyShellLoadValues, shellFailureMessage, shellOriginKey, shellSavedInput } from './shellAnalysisSession.js';

/** Same part, same geometry: saving the input (beamAnalysisInputs only) neither invalidates a result nor cancels a run. */
function sameGeometryDocument(left: PartDocument, right: PartDocument): boolean {
  return left === right || (left.id === right.id && !affectsShape(left, right));
}

/**
 * The thin-sheet analysis of the panel through the real path: saved definition -> CadShellSettings (current references
 * resolved from the saved semantic origins) -> analyzeCadShell -> femShellNativeRunner -> FemClient.analyzeShell (one
 * one-shot FEM Worker per run) -> decoded, CAD-bound result. The resolved CAD step is captured from the real recompute.
 */
export function attachShellAnalysis(kernel: AnalysisBoundarySource, store: StoreApi<AppState> = useAppStore,
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
  const nativeRunner = femShellNativeRunner(client);
  let resolved: { document: PartDocument; generation: number; steps: CadTetraContext['steps']; valid: boolean;
    owner: string; gateway: AppState['fileGateway'] } | null = null;
  let active: AbortController | null = null;
  let selection: { ids: readonly string[]; document: PartDocument; generation: number; version: number;
    owner: string; gateway: AppState['fileGateway']; bodies: readonly SolidBody[] } | null = null;
  const cancel = (): void => { const old = active; active = null; old?.abort(); };

  /** The current valid CAD sheet (shell) body; a solid is refused here with the same reason the FEM path gives. */
  const context = (bodyFeatureId: string): CadTetraContext => {
    const state = store.getState();
    if (disposed || !hasCurrentConnectionGeometry(state) || state.assembly !== null || state.drawing !== null
      || resolved === null || !resolved.valid || resolved.generation !== state.completedGeneration
      || resolved.document.id !== state.document.id
      || resolved.owner !== state.activeDocumentId || resolved.gateway !== state.fileGateway
      || affectsShape(resolved.document, state.document)) throw new Error(t('shellAnalysis.changed'));
    const matches = state.bodies.filter(body => body.featureId === bodyFeatureId && body.isValid);
    if (matches.length !== 1) throw new Error(t('shellAnalysis.selectBody'));
    if (matches[0].bodyKind !== 'shell') throw new Error(t('shellAnalysis.notSheet'));
    return { documentId: state.document.id, revision: state.completedGeneration, body: matches[0], steps: resolved.steps };
  };
  /** Saved semantic origins -> current references through the single fem adapter (unique origin or a coded refusal;
   * never an index). A refusal is shown with its Japanese reason and stops the run before any Worker exists. */
  const settings = (saved: ShellCadAnalysisInput): CadShellSettings => {
    const current = context(saved.geometry.bodyFeatureId);
    try { return resolveSavedCadShellSettings(current, saved); }
    catch (error) {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'invalid-settings';
      throw new Error(shellFailureMessage(code, error instanceof Error ? error.message : ''), { cause: error });
    }
  };
  const failure = (error: unknown): void => {
    const session = store.getState().shellAnalysisSession;
    if (session) store.setState({ shellAnalysisSession: { ...session, status: 'failed', result: null,
      error: error instanceof Error ? error.message : t('shellAnalysis.failed') } });
  };
  const validate = (): void => {
    const state = store.getState(), session = state.shellAnalysisSession;
    if (!session || session.ownerId !== state.activeDocumentId) throw new Error(t('shellAnalysis.changed'));
    settings(shellSavedInput(session, state.document.id, state.document.parameters));
  };
  const capture = (role: 'midsurface' | 'support' | 'load'): void => {
    try {
      const state = store.getState(), session = state.shellAnalysisSession, selected = selection;
      if (!session || !selected || selected.ids !== state.selection || !sameGeometryDocument(selected.document, state.document)
        || selected.generation !== state.completedGeneration || selected.version !== state.documentVersion
        || selected.owner !== state.activeDocumentId || selected.gateway !== state.fileGateway
        || selected.bodies !== state.bodies || selected.ids.length === 0) throw new Error(t('shellAnalysis.reselect'));
      const ids = selected.ids.map(parseSubShapeId), first = ids[0];
      const allowed = role === 'midsurface' ? ['face'] : role === 'support' ? ['edge', 'vertex'] : ['edge'];
      if (!first || ids.some(id => !id || !allowed.includes(id.kind) || id.bodyFeatureId !== first.bodyFeatureId))
        throw new Error(t(role === 'midsurface' ? 'shellAnalysis.selectFaces' : role === 'support' ? 'shellAnalysis.selectSupport'
          : 'shellAnalysis.selectLoadEdges'));
      if (role !== 'midsurface' && session.bodyFeatureId === null) throw new Error(t('shellAnalysis.needMidsurface'));
      if (session.bodyFeatureId !== null && session.bodyFeatureId !== first.bodyFeatureId) throw new Error(t('shellAnalysis.otherBody'));
      const body = context(first.bodyFeatureId).body;
      const references = ids.map(id => {
        const reference = id ? createSubShapeReference(body, id.kind, id.index) : null;
        if (!reference?.origin) throw new Error(t('shellAnalysis.untracked'));
        return reference;
      });
      let change: Partial<NonNullable<AppState['shellAnalysisSession']>>;
      if (role === 'midsurface') {
        const keys = references.map(solidCadFaceKey);
        if (new Set(keys).size !== keys.length) throw new Error(t('shellAnalysis.reselect'));
        change = { bodyFeatureId: first.bodyFeatureId, midsurfaceFaces: keys };
      } else {
        const rows = references.map(reference => {
          const origin = reference.origin;
          if (origin === undefined || origin.shapeKind === 'face') throw new Error(t('shellAnalysis.untracked'));
          return { key: shellOriginKey(origin), origin };
        });
        const taken = new Set((role === 'support' ? session.supports : session.edgeLoads).map(row => row.key));
        if (new Set(rows.map(row => row.key)).size !== rows.length || rows.some(row => taken.has(row.key)))
          throw new Error(t('shellAnalysis.duplicate'));
        change = role === 'support'
          ? { supports: [...session.supports, ...rows.map(row => ({ key: row.key, kind: row.origin.shapeKind, origin: row.origin,
            fixed: emptyShellFixed() }))] }
          : { edgeLoads: [...session.edgeLoads, ...rows.flatMap(row => row.origin.shapeKind === 'edge'
            ? [{ key: row.key, origin: row.origin, values: emptyShellLoadValues() }] : [])] };
      }
      cancel();
      store.setState({ shellAnalysisSession: { ...session, ...change, revision: session.revision + 1, result: null, error: null,
        status: 'editing' } });
    } catch (error) { failure(error); }
  };
  const run = (): void => {
    cancel();
    const state = store.getState(), session = state.shellAnalysisSession;
    if (!session) return;
    try {
      if (session.ownerId !== state.activeDocumentId) throw new Error(t('shellAnalysis.changed'));
      const saved = shellSavedInput(session, state.document.id, state.document.parameters), input = settings(saved);
      const controller = new AbortController(), document = state.document, generation = state.completedGeneration;
      active = controller;
      store.setState({ shellAnalysisSession: { ...session, status: 'running', result: null, error: null } });
      const current = (): boolean => {
        const next = store.getState();
        return !disposed && active === controller && !controller.signal.aborted && next.strengthSession !== null
          && next.shellAnalysisSession?.ownerId === session.ownerId && next.shellAnalysisSession.revision === session.revision
          && sameGeometryDocument(document, next.document) && next.fileGateway === state.fileGateway
          && next.activeDocumentId === state.activeDocumentId && next.completedGeneration === generation && hasCurrentConnectionGeometry(next);
      };
      void analyzeCadShell(kernel, () => {
        if (!current()) throw new Error(t('shellAnalysis.changed'));
        return context(saved.geometry.bodyFeatureId);
      }, input, nativeRunner, controller.signal).then(outcome => {
        if (!current()) return;
        active = null;
        const next = store.getState().shellAnalysisSession;
        if (!next) return;
        store.setState({ shellAnalysisSession: outcome.kind === 'result'
          ? { ...next, status: 'complete', result: outcome.result, error: null }
          : outcome.kind === 'cancelled' ? { ...next, status: 'cancelled', result: null, error: null }
            : { ...next, status: 'failed', result: null, error: shellFailureMessage(outcome.code, outcome.message) } });
      }).catch((error: unknown) => { if (current()) { active = null; failure(error); } });
    } catch (error) { failure(error); }
  };
  const runner: ShellAnalysisRunner = { run, cancel, capture, validate };
  store.setState({ shellAnalysisRunner: runner });
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.selection !== previous.selection) selection = state.shellAnalysisSession && hasCurrentConnectionGeometry(state)
      ? { ids: state.selection, document: state.document, generation: state.completedGeneration,
        version: state.documentVersion, owner: state.activeDocumentId, gateway: state.fileGateway, bodies: state.bodies } : null;
    const session = state.shellAnalysisSession;
    if (!session) { cancel(); return; }
    if (state.strengthSession === null || state.activeDocumentId !== session.ownerId || state.assembly !== null || state.drawing !== null) {
      cancel(); selection = null;
      store.setState({ shellAnalysisSession: null }); return;
    }
    const geometryKept = sameGeometryDocument(previous.document, state.document) && state.fileGateway === previous.fileGateway
      && state.completedGeneration === previous.completedGeneration && state.cancelRequestCount === previous.cancelRequestCount
      && state.isComputing === previous.isComputing && state.bodies === previous.bodies
      // A newly requested recompute makes the captured CAD step stale even before it completes.
      && state.requestedGeneration === previous.requestedGeneration;
    if (!geometryKept || state.documentVersion !== previous.documentVersion) {
      cancel(); selection = null;
      if (state.documentVersion !== previous.documentVersion) {
        // A history step (undo/redo) restores the input saved in that document; openShellAnalysis changes neither the
        // document nor documentVersion, so this subscription does not recurse here.
        state.openShellAnalysis();
        const restored = store.getState().shellAnalysisSession;
        if (restored) store.setState({ shellAnalysisSession: { ...restored, revision: session.revision + 1,
          error: geometryKept ? restored.error : t('shellAnalysis.changed') } });
        return;
      }
      if (session.result !== null || session.status === 'running') {
        store.setState({ shellAnalysisSession: { ...session, revision: session.revision + 1, status: 'editing', result: null,
          error: t('shellAnalysis.changed') } });
      }
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
      if (store.getState().shellAnalysisRunner === runner) store.setState({ shellAnalysisRunner: null, shellAnalysisSession: null });
    },
  };
}
