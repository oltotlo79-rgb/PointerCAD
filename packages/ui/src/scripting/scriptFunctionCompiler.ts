import { MathInputProblem } from '@pointercad/expression/math/contracts';
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
    const internalFailures: unknown[] = [];
    const evaluate: MathWorkerClient['evaluate'] = async (...args) => {
      try {
        const reply = await client.evaluate(...args);
        if (reply.status === 'worker-error' || reply.status === 'disposed' || reply.status === 'queue-full') {
          internalFailures.push(new Error(`Script math evaluation failed: ${reply.status}`));
        }
        return reply;
      } catch (error) {
        if (error instanceof MathInputProblem || shouldCancel()) throw error;
        internalFailures.push(error);
        return { status: 'worker-error', identity: args[0].identity };
      }
    };
    const cancelWatch = setInterval(() => {
      if (shouldCancel())
        abort.abort();
    }, 16);
    try {
      const result = await evaluateFunctionPlotDraft(document, 0, scriptFunctionDraft(input), { evaluate }, abort.signal, () => !shouldCancel());
      if (!shouldCancel() && internalFailures.length > 0) {
        throw internalFailures.length === 1 ? internalFailures[0] : new AggregateError(internalFailures, 'Script math evaluation failed');
      }
      if (!result.ok) {
        if (result.cancelled)
          throw new Error(t('script.phase.cancelled'));
        throw new DOMException([...result.fields].map(([field, message]) => `${field}: ${message}`).join('\n'), 'DataError');
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
