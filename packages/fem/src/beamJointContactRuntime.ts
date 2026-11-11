import type { PyodideRuntime } from './runtime.js';
import type { FemPhase } from './protocol.js';
import { beamJointContactInputSha256, decodeBeamJointContact, translateBeamJointContact,
  type BeamJointContactInput, type BeamJointContactResult } from './beamJointContact.js';

/** Pinned local program bytes only; the combined wrapper invokes exactly one native contact solve. */
export async function analyzeBeamJointContact(runtime: PyodideRuntime, input: BeamJointContactInput, programs: {
  readonly contactWrapper: Uint8Array; readonly boltWrapper: Uint8Array;
  readonly weldWrapper: Uint8Array; readonly jointWrapper: Uint8Array; readonly wheelLocation: string;
}, onPhase: (phase: FemPhase) => void): Promise<BeamJointContactResult> {
  const prepared = translateBeamJointContact(input), hash = await beamJointContactInputSha256(prepared.input);
  onPhase('loading-packages');
  await runtime.loadPackage(programs.wheelLocation, { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/joint-contact-input.json', JSON.stringify(prepared.plan));
  runtime.FS.writeFile('/pcad_fem/beam_contact.py', programs.contactWrapper);
  runtime.FS.writeFile('/pcad_fem/beam_bolt_contact.py', programs.boltWrapper);
  runtime.FS.writeFile('/pcad_fem/beam_weld_contact.py', programs.weldWrapper);
  runtime.FS.writeFile('/pcad_fem/beam_joint_contact.py', programs.jointWrapper);
  onPhase('solving');
  const encoded = runtime.runPython(`
import sys
sys.path.insert(0, '/pcad_fem')
from beam_joint_contact import run_beam_joint_contact
run_beam_joint_contact()
`);
  if (typeof encoded !== 'string' || encoded.length > 4_000_000) throw new Error('Invalid bounded mixed joint response');
  const raw: unknown = JSON.parse(encoded);
  return decodeBeamJointContact(raw, prepared.input, hash);
}
