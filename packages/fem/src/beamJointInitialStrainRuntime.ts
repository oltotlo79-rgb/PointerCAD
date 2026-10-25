import type { PyodideRuntime } from './runtime.js';
import type { FemPhase } from './protocol.js';
import { beamJointInitialStrainInputSha256, decodeBeamJointInitialStrain, translateBeamJointInitialStrain,
  type BeamJointInitialStrainInput, type BeamJointInitialStrainResult } from './beamJointInitialStrain.js';

/** The caller verifies all five local programs against their pinned bytes before invoking this route. */
export async function analyzeBeamJointInitialStrain(runtime: PyodideRuntime, input: BeamJointInitialStrainInput, programs: {
  readonly contactWrapper: Uint8Array; readonly boltWrapper: Uint8Array; readonly weldWrapper: Uint8Array;
  readonly jointWrapper: Uint8Array; readonly initialStrainWrapper: Uint8Array; readonly wheelLocation: string;
}, onPhase: (phase: FemPhase) => void): Promise<BeamJointInitialStrainResult> {
  const prepared = translateBeamJointInitialStrain(input), hash = await beamJointInitialStrainInputSha256(prepared.input);
  onPhase('loading-packages');
  await runtime.loadPackage(programs.wheelLocation, { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/joint-initial-strain-input.json', JSON.stringify(prepared.plan));
  runtime.FS.writeFile('/pcad_fem/beam_contact.py', programs.contactWrapper);
  runtime.FS.writeFile('/pcad_fem/beam_bolt_contact.py', programs.boltWrapper);
  runtime.FS.writeFile('/pcad_fem/beam_weld_contact.py', programs.weldWrapper);
  runtime.FS.writeFile('/pcad_fem/beam_joint_contact.py', programs.jointWrapper);
  runtime.FS.writeFile('/pcad_fem/beam_joint_initial_strain.py', programs.initialStrainWrapper);
  onPhase('solving');
  const encoded = runtime.runPython(`
import sys
sys.path.insert(0, '/pcad_fem')
from beam_joint_initial_strain import run_beam_joint_initial_strain
run_beam_joint_initial_strain()
`);
  if (typeof encoded !== 'string' || encoded.length > 4_000_000) throw new Error('Invalid bounded initial-strain response');
  const raw: unknown = JSON.parse(encoded);
  return decodeBeamJointInitialStrain(raw, prepared.input, hash);
}
