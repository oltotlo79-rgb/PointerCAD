import type { PyodideRuntime } from './runtime.js';
import type { FemPhase } from './protocol.js';
import type { BeamImpactInput, BeamImpactResult } from './beamImpactModel.js';
import { decodeBeamImpact } from './beamImpactResults.js';
import { impactInputSha256, translateBeamImpact } from './beamImpactTranslation.js';

/**
 * Native beam3d K and M from beam_analysis.py's extracted helpers and the midpoint/discrete-gradient contact
 * integration of beam_impact.py. Elastic frictionless normal fixed-plane contact only. Explicit verified program
 * bytes come from offlineBrowser's pinned asset loader; no wheel download or fallback solver. Both modules are
 * dropped from sys.modules before the import, so a module object from another wrapper version is never reused.
 * At most 101 samples x 128 nodes x 12 numbers plus 64 contacts (about 4 million characters) stay below the
 * 6,000,000-character bound.
 */
export async function analyzeBeamImpact(runtime: PyodideRuntime, input: BeamImpactInput, programs: {
  readonly analysisWrapper: Uint8Array; readonly impactWrapper: Uint8Array; readonly wheelLocation: string;
}, onPhase: (phase: FemPhase) => void): Promise<BeamImpactResult> {
  const prepared = translateBeamImpact(input);
  const hash = await impactInputSha256(prepared.input);
  onPhase('loading-packages');
  await runtime.loadPackage(programs.wheelLocation, { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/analysis-input.json', JSON.stringify(prepared.plan));
  runtime.FS.writeFile('/pcad_fem/beam_analysis.py', programs.analysisWrapper);
  runtime.FS.writeFile('/pcad_fem/beam_impact.py', programs.impactWrapper);
  onPhase('solving');
  const encoded = runtime.runPython(`
import importlib
import sys
for name in ('beam_impact', 'beam_analysis'):
    sys.modules.pop(name, None)
importlib.invalidate_caches()
if sys.path[0] != '/pcad_fem':
    sys.path.insert(0, '/pcad_fem')
from beam_impact import run_beam_impact
run_beam_impact()
`);
  if (typeof encoded !== 'string' || encoded.length > 6_000_000) throw new Error('Invalid bounded impact response');
  const raw: unknown = JSON.parse(encoded);
  return decodeBeamImpact(raw, prepared.input, hash);
}
