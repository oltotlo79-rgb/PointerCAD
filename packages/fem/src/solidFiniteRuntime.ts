import type { FemPhase } from './protocol.js';
import type { PyodideRuntime } from './runtime.js';
import { decodeSolidFinite, type SolidFiniteResult } from './solidFiniteResults.js';
import { solidFiniteInputSha256, translateSolidFinite, type SolidFiniteInput } from './solidFiniteTranslation.js';

/**
 * Runtime entry of the internal finite-strain J2 equilibrium (EX-09 W33 law + W34 entry) over an existing
 * PyodideRuntime. Dispatched by the one-shot Worker; no CAD/UI integration. Only the two fixed developer files (the W33
 * solidFiniteMaterial.py and W34 solidFiniteEquilibrium.py bytes, under the module names that the entry imports) and the
 * fixed call below execute; the plan is written as a JSON data file and no caller content is placed in Python source.
 *
 * Ownership: the entry keeps every native analysis in solidFiniteMaterial._NATIVE_LIFETIME until the interpreter ends
 * (the binding exposes no native destruction; this code never clears that list or forces a collection). One runtime
 * therefore hosts at most ONE call of this function: the first call that passes input validation claims the runtime,
 * whether it then succeeds or fails, and every later call on the same runtime is refused before touching it. The
 * Worker owns the interpreter lifetime and must dispose the runtime (terminate the Worker) after the call. A result must
 * report exactly one retained native analysis, i.e. no earlier native analysis lived in this interpreter.
 * Errors of the runtime, the Python entry and the phase callback propagate as the original objects.
 * The numerical oracle is the native W34 suite (solidFiniteEquilibriumNative.test.ts); this layer adds I/O and contracts.
 */
const PLAN_FILE = '/pcad_fem/finite-equilibrium-plan.json';
const MATERIAL_FILE = '/pcad_fem/solidFiniteMaterial.py';
const ENTRY_FILE = '/pcad_fem/solidFiniteEquilibrium.py';
const CALL = `
import json
import sys
sys.path.insert(0, '/pcad_fem')
import oofem
from solidFiniteEquilibrium import run_finite_equilibrium
with open('${PLAN_FILE}', encoding='utf-8') as stream:
    plan = json.load(stream)
run_finite_equilibrium(oofem, plan)
`;
/**
 * Response bound before JSON.parse. Python json.dumps writes ', ' and ': ' separators and repr doubles of at most 24
 * characters. An element state holds 46 numbers (J, tau 9, P 9, sigma 9, alpha, dissipation, q, F9 9, S6 6) plus about
 * 200 characters of names and punctuation, below 1400 characters; a node state holds 9 numbers, below 300. The plan
 * allows at most 20000 node and element states and 200 steps (each below 300 characters of step metadata), so a
 * complete reply stays below 20000 x 1400 + 200 x 300 + fixed metadata < 28,500,000 characters.
 */
const SOLID_FINITE_RESPONSE_LIMIT = 28_500_000;

 interface SolidFinitePrograms {
  /** Fixed W33 solidFiniteMaterial.py bytes. */
  readonly material: Uint8Array;
  /** Fixed W34 solidFiniteEquilibrium.py bytes. */
  readonly equilibrium: Uint8Array;
  /** Fixed pinned OOFEM wheel location. */
  readonly wheelLocation: string;
}

const claimed = new WeakSet<PyodideRuntime>();

/** True once this runtime has hosted (or started) a finite equilibrium call; it must then be disposed, not reused. */
export function solidFiniteRuntimeClaimed(runtime: PyodideRuntime): boolean {
  return claimed.has(runtime);
}

export async function analyzeSolidFinite(runtime: PyodideRuntime, value: SolidFiniteInput, programs: SolidFinitePrograms,
  onPhase: (phase: FemPhase) => void): Promise<SolidFiniteResult> {
  if (claimed.has(runtime)) {
    throw new Error('finite-equilibrium-runtime: this runtime already hosted a finite analysis; dispose it and start a new runtime');
  }
  const prepared = translateSolidFinite(value);
  const hash = await solidFiniteInputSha256(prepared.input);
  if (claimed.has(runtime)) {
    throw new Error('finite-equilibrium-runtime: this runtime already hosted a finite analysis; dispose it and start a new runtime');
  }
  claimed.add(runtime);
  onPhase('loading-packages');
  await runtime.loadPackage(programs.wheelLocation, { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile(PLAN_FILE, JSON.stringify(prepared.plan));
  runtime.FS.writeFile(MATERIAL_FILE, programs.material);
  runtime.FS.writeFile(ENTRY_FILE, programs.equilibrium);
  onPhase('solving');
  const encoded = runtime.runPython(CALL);
  if (typeof encoded !== 'string' || encoded.length > SOLID_FINITE_RESPONSE_LIMIT) {
    throw new Error('finite-equilibrium-runtime: invalid bounded finite equilibrium response');
  }
  const raw: unknown = JSON.parse(encoded);
  const result = await decodeSolidFinite(raw, prepared.input, hash);
  if (result.retainedNativeAnalyses !== 1) {
    throw new Error(`finite-equilibrium-runtime: the runtime retains ${String(result.retainedNativeAnalyses)} native analyses; `
      + 'a finite analysis needs a fresh runtime');
  }
  return result;
}
