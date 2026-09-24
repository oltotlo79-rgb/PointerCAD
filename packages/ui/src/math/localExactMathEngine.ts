import mappingsSource from '../../../expression/src/math/exactRuntime/cas_mappings.py?raw';
import limitBoundsSource from '../../../expression/src/math/exactRuntime/cas_limit_bounds.py?raw';
import setsSource from '../../../expression/src/math/exactRuntime/cas_sets.py?raw';
import equationSystemsSource from '../../../expression/src/math/exactRuntime/cas_equation_systems.py?raw';
import odeInputSource from '../../../expression/src/math/exactRuntime/cas_ode_input.py?raw';
import odeSource from '../../../expression/src/math/exactRuntime/cas_ode.py?raw';
import equationsSource from '../../../expression/src/math/exactRuntime/cas_equations.py?raw';
import fourierSeriesSource from '../../../expression/src/math/exactRuntime/cas_fourier_series.py?raw';
import transformsSource from '../../../expression/src/math/exactRuntime/cas_transforms.py?raw';
/** Fixed local program and structured data; user input never becomes Python source. */
import { EXACT_MATH_ENGINE_LIMITS, type ExactMathEnginePhase } from '@pointercad/expression/math/client';
import type { ExactMathEngine } from '@pointercad/expression/math/worker';
import fourierSource from '../../../expression/src/math/exactRuntime/cas_fourier.py?raw';
import gammaSource from '../../../expression/src/math/exactRuntime/cas_gamma_functions.py?raw';
import errorFunctionsSource from '../../../expression/src/math/exactRuntime/cas_error_functions.py?raw';
import besselSource from '../../../expression/src/math/exactRuntime/cas_bessel_functions.py?raw';
import airySource from '../../../expression/src/math/exactRuntime/cas_airy_functions.py?raw';
import ellipticSource from '../../../expression/src/math/exactRuntime/cas_elliptic_functions.py?raw';
import zetaSource from '../../../expression/src/math/exactRuntime/cas_zeta_functions.py?raw';
import lambertSource from '../../../expression/src/math/exactRuntime/cas_lambert_functions.py?raw';
import taylorSource from '../../../expression/src/math/exactRuntime/cas_taylor.py?raw';
import inputSource from '../../../expression/src/math/exactRuntime/cas_input.py?raw';
import resultSource from '../../../expression/src/math/exactRuntime/cas_result.py?raw';
import evaluationSource from '../../../expression/src/math/exactRuntime/cas_evaluate.py?raw';
import linearSource from '../../../expression/src/math/exactRuntime/cas_linear.py?raw';
import decompositionSource from '../../../expression/src/math/exactRuntime/cas_decompositions.py?raw';
import spectralSource from '../../../expression/src/math/exactRuntime/cas_spectral.py?raw';
import discreteSource from '../../../expression/src/math/exactRuntime/cas_discrete.py?raw';
import limitSource from '../../../expression/src/math/exactRuntime/cas_limits.py?raw';
import integralSource from '../../../expression/src/math/exactRuntime/cas_integrals.py?raw';
import derivativeSource from '../../../expression/src/math/exactRuntime/cas_derivatives.py?raw';
import vectorCalculusSource from '../../../expression/src/math/exactRuntime/cas_vector_calculus.py?raw';
import vectorProductsSource from '../../../expression/src/math/exactRuntime/cas_vector_products.py?raw';
import lineIntegralsSource from '../../../expression/src/math/exactRuntime/cas_line_integrals.py?raw';

import boxDomainSource from '../../../expression/src/math/exactRuntime/cas_box_domain.py?raw';
import regionIntegralsSource from '../../../expression/src/math/exactRuntime/cas_region_integrals.py?raw';
import sequencesSource from '../../../expression/src/math/exactRuntime/cas_sequences.py?raw';
import sequenceRangesSource from '../../../expression/src/math/exactRuntime/cas_sequence_ranges.py?raw';
import integerSource from '../../../expression/src/math/exactRuntime/cas_integer.py?raw';
import probabilitySource from '../../../expression/src/math/exactRuntime/cas_probability.py?raw';
import probabilityLawsSource from '../../../expression/src/math/exactRuntime/cas_probability_laws.py?raw';
import probabilityDomainSource from '../../../expression/src/math/exactRuntime/cas_probability_domain.py?raw';
import extendedDispatchSource from '../../../expression/src/math/exactRuntime/cas_extended_dispatch.py?raw';
import cardinalitySource from '../../../expression/src/math/exactRuntime/cas_cardinality.py?raw';
import vectorProjectionSource from '../../../expression/src/math/exactRuntime/cas_vector_projection.py?raw';
import matrixConstructorsSource from '../../../expression/src/math/exactRuntime/cas_matrix_constructors.py?raw';
import setRelationsSource from '../../../expression/src/math/exactRuntime/cas_set_relations.py?raw';
import logicExtendedSource from '../../../expression/src/math/exactRuntime/cas_logic_extended.py?raw';

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
  for (const [name, source] of [['cas_limit_bounds.py', limitBoundsSource], ['cas_sets.py', setsSource], ['cas_equation_systems.py', equationSystemsSource], ['cas_equations.py', equationsSource], ['cas_fourier_series.py', fourierSeriesSource], ['cas_transforms.py', transformsSource], ['cas_fourier.py', fourierSource], ['cas_error_functions.py', errorFunctionsSource], ['cas_zeta_functions.py', zetaSource], ['cas_elliptic_functions.py', ellipticSource], ['cas_airy_functions.py', airySource], ['cas_lambert_functions.py', lambertSource], ['cas_bessel_functions.py', besselSource], ['cas_gamma_functions.py', gammaSource], ['cas_taylor.py', taylorSource], ['cas_input.py', inputSource], ['cas_result.py', resultSource],
    ['cas_mappings.py', mappingsSource], ['cas_ode_input.py', odeInputSource], ['cas_ode.py', odeSource],
    ['cas_evaluate.py', evaluationSource], ['cas_linear.py', linearSource], ['cas_decompositions.py', decompositionSource],
    ['cas_spectral.py', spectralSource], ['cas_discrete.py', discreteSource], ['cas_limits.py', limitSource],
    ['cas_integrals.py', integralSource], ['cas_derivatives.py', derivativeSource], ['cas_vector_calculus.py', vectorCalculusSource],
    ['cas_vector_products.py', vectorProductsSource],
    ['cas_line_integrals.py', lineIntegralsSource], ['cas_box_domain.py', boxDomainSource],
    ['cas_sequences.py', sequencesSource], ['cas_sequence_ranges.py', sequenceRangesSource], ['cas_integer.py', integerSource],
    ['cas_region_integrals.py', regionIntegralsSource], ['cas_probability.py', probabilitySource],
    ['cas_probability_laws.py', probabilityLawsSource], ['cas_probability_domain.py', probabilityDomainSource],
    // Registered operations: the dispatch and each implementing task's module (MC-12/16/18/23/24).
    ['cas_extended_dispatch.py', extendedDispatchSource], ['cas_cardinality.py', cardinalitySource],
    ['cas_vector_projection.py', vectorProjectionSource], ['cas_matrix_constructors.py', matrixConstructorsSource],
    ['cas_set_relations.py', setRelationsSource], ['cas_logic_extended.py', logicExtendedSource]]) {
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
  const evaluateMany: NonNullable<ExactMathEngine['evaluateMany']> = async inputs => {
    if (busy || uses >= EXACT_MATH_ENGINE_LIMITS.requestsPerWorker) throw new Error('Mathematics Worker must be replaced');
    if (inputs.length < 1 || inputs.length > 8) throw new Error('Invalid mathematics batch size');
    uses += 1; busy = true;
    let runtime: Runtime | null = null;
    try {
      const payloads = inputs.map(input => JSON.stringify(input));
      if (payloads.reduce((size, payload) => size + payload.length, 0) > 1_048_576) throw new Error('Structured input exceeds its limit');
      initialization ??= initialize(options.onPhase);
      runtime = await initialization;
      options.onPhase('calculating');
      const results: unknown[] = [];
      let outputSize = 0;
      for (const payload of payloads) {
        runtime.globals.set('_pcad_exact_payload', payload);
        const encoded = runtime.runPython('_pcad_calculate_exact(_pcad_exact_payload)');
        if (typeof encoded !== 'string') throw new Error('Invalid structured response');
        outputSize += encoded.length;
        if (outputSize > 1_048_576) throw new Error('Structured response exceeds its limit');
        results.push(JSON.parse(encoded));
      }
      return results;
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
  };
  return { evaluate: async (expression, angleUnit) => (await evaluateMany([{ expression, angleUnit }]))[0], evaluateMany };
}
