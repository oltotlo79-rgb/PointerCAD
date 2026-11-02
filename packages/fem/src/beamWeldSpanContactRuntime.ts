import type { PyodideRuntime } from './runtime.js';
import type { FemPhase } from './protocol.js';
import { beamWeldSpanContactInputSha256, decodeBeamWeldSpanContact, translateBeamWeldSpanContact,
  type BeamWeldSpanContactInput } from './beamWeldSpanContact.js';
import type { BeamWeldSpanContactResult } from './beamWeldSpanContactBinding.js';

/** Only explicit, integrity-admitted program bytes; no fallback or public Worker registration. */
export async function analyzeBeamWeldSpanContact(runtime: PyodideRuntime, input: BeamWeldSpanContactInput, programs: {
  readonly contactWrapper: Uint8Array; readonly spanWrapper: Uint8Array; readonly spanContactWrapper: Uint8Array;
  readonly wheelLocation: string;
}, onPhase: (phase: FemPhase) => void): Promise<BeamWeldSpanContactResult> {
  const prepared = translateBeamWeldSpanContact(input);
  const contactWrapper = new Uint8Array(programs.contactWrapper), spanWrapper = new Uint8Array(programs.spanWrapper);
  const spanContactWrapper = new Uint8Array(programs.spanContactWrapper), wheelLocation = programs.wheelLocation;
  const hash = await beamWeldSpanContactInputSha256(prepared.input);
  onPhase('loading-packages');
  await runtime.loadPackage(wheelLocation, { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/weld-span-contact-input.json', JSON.stringify(prepared.plan));
  runtime.FS.writeFile('/pcad_fem/beamContact.py', contactWrapper);
  runtime.FS.writeFile('/pcad_fem/beamWeldSpan.py', spanWrapper);
  runtime.FS.writeFile('/pcad_fem/beamWeldSpanContact.py', spanContactWrapper);
  onPhase('solving');
  const encoded = runtime.runPython(`
import sys
sys.path.insert(0, '/pcad_fem')
from beamWeldSpanContact import run_beam_weld_span_contact
run_beam_weld_span_contact()
`);
  if (typeof encoded !== 'string' || encoded.length > 4_000_000
    || new TextEncoder().encode(encoded).byteLength > 4_000_000) throw new Error('Invalid bounded weld-span-contact response');
  const raw: unknown = JSON.parse(encoded);
  return decodeBeamWeldSpanContact(raw, prepared.input, hash);
}
