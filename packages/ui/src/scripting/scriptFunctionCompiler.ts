import { t } from '../i18n/t.js';
import type { MathWorkerClient } from '@pointercad/expression/math/client';
import type { ScriptFunctionCompiler } from '@pointercad/model/scripting';
import { evaluateFunctionPlotDraft } from '../functionPlot/functionPlotDraft.js';
import { createBrowserMathClient } from '../math/createBrowserMathClient.js';
import { scriptFunctionDraft } from './scriptFunctionDraft.js';
export function createScriptFunctionCompiler(createClient: () => Pick<MathWorkerClient, 'evaluate' | 'dispose'>): ScriptFunctionCompiler {
  return async (document, input, shouldCancel) => {
    if (shouldCancel())
      throw new Error(t('script.phase.cancelled'));
    const client = createClient(), abort = new AbortController();
    const cancelWatch = setInterval(() => {
      if (shouldCancel())
        abort.abort();
    }, 16);
    try {
      const result = await evaluateFunctionPlotDraft(document, 0, scriptFunctionDraft(input), client, abort.signal, () => !shouldCancel());
      if (!result.ok) {
        if (result.cancelled)
          throw new Error(t('script.phase.cancelled'));
        throw new Error([...result.fields].map(([field, message]) => `${field}: ${message}`).join('\n'));
      }
      return { document: result.prepared, definition: result.definition };
    }
    finally {
      clearInterval(cancelWatch);
      abort.abort();
      client.dispose();
    }
  };
}
export const compileScriptFunction = createScriptFunctionCompiler(createBrowserMathClient);
