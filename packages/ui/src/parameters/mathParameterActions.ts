import { hasDocumentMath, renameDocumentMathParameter } from '@pointercad/model';
import type { MathWorkerClient } from '@pointercad/expression/math/client';
import { createBrowserMathClient } from '../math/createBrowserMathClient.js';
import { useAppStore } from '../store/useAppStore.js';
import { activePartDocument } from '../store/documentKind.js';
import { t } from '../i18n/t.js';
import { commitRenameParameter } from './parameterCommands.js';

export type MathParameterActionResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** Changing one label publishes all references in one Undo entry, or publishes nothing. */
export async function runMathParameterRename(from: string, to: string, options: {
  readonly signal?: AbortSignal; readonly createClient?: () => MathWorkerClient;
} = {}): Promise<MathParameterActionResult> {
  const state = useAppStore.getState(), document = activePartDocument(state);
  const stopped = (): MathParameterActionResult => ({ ok: false, message: t('math.operation.cancelled') });
  if (document === null || options.signal?.aborted) return stopped();
  if (!hasDocumentMath(document) && document.configurations.every(configuration => configuration.mathDefinitions === undefined)) {
    const result = commitRenameParameter(document, from, to);
    if (!result.ok) return result;
    if (result.document !== document) state.applyDocument(result.document);
    return { ok: true };
  }
  const controller = new AbortController(), abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const isCurrent = () => !controller.signal.aborted && useAppStore.getState().documentVersion === state.documentVersion
    && activePartDocument(useAppStore.getState()) === document;
  const unsubscribe = useAppStore.subscribe(() => { if (!isCurrent()) abort(); });
  let client: MathWorkerClient | undefined;
  try {
    client = (options.createClient ?? createBrowserMathClient)();
    const result = await renameDocumentMathParameter(document, from, to, { client,
      identity: { documentId: document.id, documentVersion: state.documentVersion }, signal: controller.signal, isCurrent });
    if (!isCurrent()) return stopped();
    if (!result.ok) return result;
    if (result.document !== document) useAppStore.getState().applyDocument(result.document);
    return { ok: true };
  } catch {
    return { ok: false, message: t('math.rename.failed') };
  } finally {
    unsubscribe();
    options.signal?.removeEventListener('abort', abort);
    abort();
    client?.dispose();
  }
}
