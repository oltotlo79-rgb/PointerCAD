/** Fixed local program and structured data; user input never becomes Python source. */
import { EXACT_MATH_ENGINE_LIMITS, type ExactMathEnginePhase } from '@pointercad/expression/math/client';
import type { ExactMathEngine } from '@pointercad/expression/math/worker';
import inputSource from '../../../expression/src/math/exactRuntime/cas_input.py?raw';
import resultSource from '../../../expression/src/math/exactRuntime/cas_result.py?raw';
import evaluationSource from '../../../expression/src/math/exactRuntime/cas_evaluate.py?raw';
import linearSource from '../../../expression/src/math/exactRuntime/cas_linear.py?raw';

interface Runtime {
  readonly FS: {
    readonly mkdirTree: (path: string) => void;
    readonly writeFile: (path: string, source: string) => void;
  };
  readonly globals: {
    readonly set: (name: string, value: string) => void;
    readonly delete: (name: string) => void;
  };
  readonly runPython: (source: string) => unknown;
}
interface Loader {
  readonly loadPyodide: (options: {
    readonly indexURL: string; readonly packageBaseUrl: string;
    readonly lockFileURL: string; readonly packages: readonly string[];
  }) => Promise<unknown>;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isLoader(value: unknown): value is Loader {
  return object(value) && typeof value.loadPyodide === 'function';
}
function isRuntime(value: unknown): value is Runtime {
  return object(value) && object(value.FS) && object(value.globals)
    && typeof value.FS.mkdirTree === 'function' && typeof value.FS.writeFile === 'function'
    && typeof value.globals.set === 'function' && typeof value.globals.delete === 'function'
    && typeof value.runPython === 'function';
}
async function initialize(notify: (phase: ExactMathEnginePhase) => void): Promise<Runtime> {
  notify('runtime-loading');
  // Production Workers are emitted in assets/ in both distributions. Development
  // serves the identical verified runtime at the configured application's base.
  const folder = import.meta.env.DEV
    ? `${new URL(import.meta.env.BASE_URL, self.location.origin + '/').pathname}exact-math/runtime/`
    : '../exact-math/runtime/';
  const base = new URL(folder, import.meta.url);
  const moduleUrl = new URL('pyodide.mjs', base).href;
  const loader: unknown = await import(/* @vite-ignore */ moduleUrl);
  if (!isLoader(loader)) throw new Error('The fixed mathematics loader is missing');
  const runtime = await loader.loadPyodide({ indexURL: base.href, packageBaseUrl: base.href,
    lockFileURL: new URL('pyodide-lock.json', base).href, packages: ['sympy'] });
  if (!isRuntime(runtime)) throw new Error('Invalid mathematics runtime');
  runtime.FS.mkdirTree('/pcad_exact');
  for (const [name, source] of [['cas_input.py', inputSource], ['cas_result.py', resultSource],
    ['cas_evaluate.py', evaluationSource], ['cas_linear.py', linearSource]]) {
    if (source.length > 32_768) throw new Error('The fixed mathematics module exceeds its limit');
    runtime.FS.writeFile('/pcad_exact/' + name, source);
  }
  notify('symbolic-import');
  runtime.runPython(`
import sys
import importlib.metadata as _pcad_metadata
assert _pcad_metadata.version('sympy') == '1.14.0'
assert _pcad_metadata.version('mpmath') == '1.3.0'
sys.path.insert(0, '/pcad_exact')
from cas_evaluate import calculate_exact_json as _pcad_calculate_exact
`);
  return runtime;
}

/** Runs in the existing math Worker. The window owns its deadline and can terminate
 * the whole interpreter directly, even while Python blocks this Worker's event loop. */
export function createLocalExactMathEngine(options: {
  readonly onPhase: (phase: ExactMathEnginePhase) => void;
  readonly retire: () => void;
}): ExactMathEngine {
  let initialization: Promise<Runtime> | null = null;
  let busy = false, uses = 0;
  return { async evaluate(expression, angleUnit) {
    if (busy || uses >= EXACT_MATH_ENGINE_LIMITS.requestsPerWorker) throw new Error('Mathematics Worker must be replaced');
    uses += 1; busy = true;
    let runtime: Runtime | null = null;
    try {
      const payload = JSON.stringify({ expression, angleUnit });
      if (payload.length > 1_048_576) throw new Error('Structured input exceeds its limit');
      initialization ??= initialize(options.onPhase);
      runtime = await initialization;
      options.onPhase('calculating');
      runtime.globals.set('_pcad_exact_payload', payload);
      const encoded = runtime.runPython('_pcad_calculate_exact(_pcad_exact_payload)');
      if (typeof encoded !== 'string' || encoded.length > 1_048_576) throw new Error('Invalid structured response');
      const result: unknown = JSON.parse(encoded);
      return result;
    } catch (error) {
      options.retire();
      throw error;
    } finally {
      try { runtime?.globals.delete('_pcad_exact_payload'); }
      // A validated result remains usable, but a runtime retaining this payload
      // must never receive another input. The host terminates it after the reply.
      catch { options.retire(); }
      busy = false;
      if (uses >= EXACT_MATH_ENGINE_LIMITS.requestsPerWorker) options.retire();
    }
  } };
}
