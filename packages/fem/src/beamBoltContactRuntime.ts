import type { PyodideRuntime } from './runtime.js';
import type { FemPhase } from './protocol.js';
import { beamBoltContactInputSha256, decodeBeamBoltContact, translateBeamBoltContact,
  type BeamBoltContactInput, type BeamBoltContactResult } from './beamBoltContact.js';

/** Explicit program bytes are supplied by the pinned asset loader. No wheel download or fallback solver. */
export async function analyzeBeamBoltContact(runtime: PyodideRuntime, input: BeamBoltContactInput, programs: {
  readonly contactWrapper: Uint8Array; readonly boltWrapper: Uint8Array; readonly wheelLocation: string;
}, onPhase: (phase: FemPhase) => void): Promise<BeamBoltContactResult> {
  const prepared = translateBeamBoltContact(input), hash = await beamBoltContactInputSha256(prepared.input);
  onPhase('loading-packages');
  await runtime.loadPackage(programs.wheelLocation, { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/bolt-contact-input.json', JSON.stringify(prepared.plan));
  runtime.FS.writeFile('/pcad_fem/beam_contact.py', programs.contactWrapper);
  runtime.FS.writeFile('/pcad_fem/beam_bolt_contact.py', programs.boltWrapper);
  onPhase('solving');
  const encoded = runtime.runPython(`
import sys
sys.path.insert(0, '/pcad_fem')
from beam_bolt_contact import run_beam_bolt_contact
run_beam_bolt_contact()
`);
  if (typeof encoded !== 'string' || encoded.length > 4_000_000) throw new Error('Invalid bounded bolt-contact response');
  const raw: unknown = JSON.parse(encoded);
  return decodeBeamBoltContact(raw, prepared.input, hash);
}
