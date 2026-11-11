import type { PyodideRuntime } from './runtime.js';
import type { FemPhase } from './protocol.js';
import { translateShellAnalysis } from './shellTranslation.js';
import { SHELL_NATIVE_KIND, shellNativeResponseBound, shellNativeWireMatches, shellPlanSha256,
  type ShellNativeWireResult } from './shellBinding.js';

/**
 * Native OOFEM TR_SHELL02 + SimpleCrossSection linear static shell in the fixed, hashed shellAnalysis.py (written as
 * shell_analysis.py). The request is validated by translateShellAnalysis (readShellAnalysisInput, limits, offsets,
 * orientation, rigid-body restraint) before any file is written; only the plan JSON is data, no request text is
 * interpolated into Python. The module is dropped from sys.modules first so no other wrapper version is reused.
 * The answer is length-bounded by shellNativeResponseBound (derived from the native output shape), parsed and bound
 * to this plan; it is returned undecoded and is decoded once by the consumer against the same plan.
 */
export async function analyzeShellNative(runtime: PyodideRuntime, value: unknown, programs: {
  readonly wrapper: Uint8Array; readonly wheelLocation: string;
}, onPhase: (phase: FemPhase) => void): Promise<ShellNativeWireResult> {
  const { input, plan } = translateShellAnalysis(value);
  const encodedPlan = JSON.stringify(plan);
  const planSha256 = await shellPlanSha256(plan);
  onPhase('loading-packages');
  await runtime.loadPackage(programs.wheelLocation, { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/shell-input.json', encodedPlan);
  runtime.FS.writeFile('/pcad_fem/shell_analysis.py', programs.wrapper);
  onPhase('solving');
  const encoded = runtime.runPython(`
import importlib
import sys
sys.modules.pop('shell_analysis', None)
importlib.invalidate_caches()
if sys.path[0] != '/pcad_fem':
    sys.path.insert(0, '/pcad_fem')
from shell_analysis import run_shell_analysis
run_shell_analysis()
`);
  if (typeof encoded !== 'string' || encoded.length > shellNativeResponseBound(input)) throw new Error('Invalid bounded shell response');
  const raw: unknown = JSON.parse(encoded);
  const wire = shellNativeWireMatches({ kind: SHELL_NATIVE_KIND, planSha256, raw }, input, planSha256);
  if (wire === null) throw new Error('shell-native: the answer is not the fixed TR_SHELL02 wrapper result for this plan');
  return wire;
}
