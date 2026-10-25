import type { PyodideRuntime } from './runtime.js';
import type { FemPhase } from './protocol.js';
import { beamWeldContactInputSha256, decodeBeamWeldContact, translateBeamWeldContact,
  type BeamWeldContactInput, type BeamWeldContactResult } from './beamWeldContact.js';

/** Explicit program bytes are supplied by the pinned asset loader. No wheel download or fallback solver. */
export async function analyzeBeamWeldContact(runtime: PyodideRuntime, input: BeamWeldContactInput, programs: {
  readonly contactWrapper: Uint8Array; readonly weldWrapper: Uint8Array; readonly wheelLocation: string;
}, onPhase: (phase: FemPhase) => void): Promise<BeamWeldContactResult> {
  const prepared = translateBeamWeldContact(input), hash = await beamWeldContactInputSha256(prepared.input);
  onPhase('loading-packages');
  await runtime.loadPackage(programs.wheelLocation, { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/weld-contact-input.json', JSON.stringify(prepared.plan));
  runtime.FS.writeFile('/pcad_fem/beam_contact.py', programs.contactWrapper);
  runtime.FS.writeFile('/pcad_fem/beam_weld_contact.py', programs.weldWrapper);
  onPhase('solving');
  const encoded = runtime.runPython(`
import sys
sys.path.insert(0, '/pcad_fem')
from beam_weld_contact import run_beam_weld_contact
run_beam_weld_contact()
`);
  if (typeof encoded !== 'string' || encoded.length > 4_000_000) throw new Error('Invalid bounded weld-contact response');
  const raw: unknown = JSON.parse(encoded);
  return decodeBeamWeldContact(raw, prepared.input, hash);
}
