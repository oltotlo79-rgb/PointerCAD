import { activateMathConfiguration, createMathConfiguration, deleteMathConfiguration, hasDocumentMath,
  type ConfigurationChange } from '@pointercad/model';
import type { MathWorkerClient } from '@pointercad/expression/math/client';
import { createBrowserMathClient } from '../math/createBrowserMathClient.js';
import { mathGeometryInputsFor, waitForCurrentMathGeometry } from '../math/mathGeometryResults.js';
import { activePartDocument } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { runConfigurationAction, type ConfigurationAction, type ConfigurationActionResult } from './configurationActions.js';

/** Preserve the synchronous legacy path; new definitions publish only after current-generation Worker validation. */
export async function runMathConfigurationAction(action: ConfigurationAction, options: {
  readonly signal?: AbortSignal; readonly createClient?: () => MathWorkerClient;
} = {}): Promise<ConfigurationActionResult> {
  const state = useAppStore.getState(), document = activePartDocument(state);
  if (document === null) return { ok: false, reason: 'partRequired' };
  if (options.signal?.aborted) return { ok: false, reason: 'invalidExpression' };
  if (action.kind === 'rename' || (!hasDocumentMath(document) && document.configurations.every(entry => entry.mathDefinitions === undefined))) {
    return runConfigurationAction(action);
  }
  const abort = new AbortController();
  const cancel = () => abort.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  const isCurrent = () => !abort.signal.aborted && useAppStore.getState().documentVersion === state.documentVersion
    && activePartDocument(useAppStore.getState()) === document;
  const unsubscribe = useAppStore.subscribe(() => { if (!isCurrent()) abort.abort(); });
  let client: MathWorkerClient | undefined;
  try {
    let geometry = mathGeometryInputsFor(useAppStore.getState(), document);
    if (geometry === null) {
      await waitForCurrentMathGeometry(abort.signal);
      if (!isCurrent()) return { ok: false, reason: 'invalidExpression' };
      geometry = mathGeometryInputsFor(useAppStore.getState(), document);
      if (geometry === null) return { ok: false, reason: 'invalidExpression' };
    }
    client = (options.createClient ?? createBrowserMathClient)();
    const context = { client, geometry, signal: abort.signal, isCurrent,
      identity: { documentId: document.id, documentVersion: state.documentVersion } };
    let result: ConfigurationChange;
    switch (action.kind) {
      case 'create': result = await createMathConfiguration(document, action.name, context); break;
      case 'activate': result = await activateMathConfiguration(document, action.id, context); break;
      case 'delete': result = await deleteMathConfiguration(document, action.id, context); break;
    }
    if (!isCurrent()) return { ok: false, reason: 'invalidExpression' };
    if (mathGeometryInputsFor(useAppStore.getState(), document) !== geometry) return { ok: false, reason: 'invalidExpression' };
    if (!result.ok) return result;
    if (result.document !== document) useAppStore.getState().applyDocument(result.document);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'invalidExpression' };
  } finally {
    unsubscribe();
    options.signal?.removeEventListener('abort', cancel);
    abort.abort();
    client?.dispose();
  }
}
