import type { PyodideRuntime } from './runtime.js';
import type { FemPhase } from './protocol.js';
import { readFrameBoltContact, frameBoltContactInputSha256, decodeFrameBoltContact,
  type FrameBoltContactInput } from './beamBoltContact.js';

/** 検証済みの固定Pythonだけを実行する。旧axial入口や代替solverへは流さない。 */
export async function analyzeFrameBoltContact(runtime: PyodideRuntime, input: FrameBoltContactInput, programs: {
  readonly contactWrapper: Uint8Array; readonly boltWrapper: Uint8Array; readonly wheelLocation: string;
}, onPhase: (phase: FemPhase) => void): Promise<ReturnType<typeof decodeFrameBoltContact>> {
  const prepared = readFrameBoltContact(input);
  const inputSha256 = await frameBoltContactInputSha256(prepared.input);
  onPhase('loading-packages');
  await runtime.loadPackage(programs.wheelLocation, { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/frame-bolt-input.json', JSON.stringify({ inputSha256, plan: prepared.plan }));
  runtime.FS.writeFile('/pcad_fem/beam_contact.py', programs.contactWrapper);
  runtime.FS.writeFile('/pcad_fem/beam_bolt_contact.py', programs.boltWrapper);
  onPhase('solving');
  const encoded = runtime.runPython(`
import sys
sys.path.insert(0, '/pcad_fem')
from beam_bolt_contact import run_frame_bolt_contact
run_frame_bolt_contact()
`);
  if (typeof encoded !== 'string' || encoded.length > 4_000_000) throw new Error('Invalid bounded frame-bolt-contact response');
  const raw: unknown = JSON.parse(encoded);
  return decodeFrameBoltContact(raw, prepared.input, inputSha256);
}
