import type { PyodideRuntime } from './runtime.js';
import type { FemPhase } from './protocol.js';
import { FEM_ASSETS, BOLT_CONTACT_ASSETS } from './assets.js';
import { WELD_CONTACT_ASSETS } from './beamWeldAssets.js';
import { JOINT_CONTACT_ASSETS } from './beamJointAssets.js';
import { JOINT_INITIAL_STRAIN_ASSETS } from './beamJointInitialStrainAssets.js';
import { prepareNativeBoltPreload, decodeNativeBoltPreload, type NativeBoltPreloadResult } from './nativeBoltPreload.js';

export interface NativeBoltPrograms {
  readonly contactWrapper: Uint8Array; readonly boltWrapper: Uint8Array; readonly weldWrapper: Uint8Array;
  readonly jointWrapper: Uint8Array; readonly initialStrainWrapper: Uint8Array;
  readonly wheelBytes: Uint8Array;
  /** Internal location served by the existing verified offline asset loader, never request data. */
  readonly wheelLocation: string;
}
export interface VerifiedNativeBoltPrograms { readonly wheelLocation: string }
const verifiedPrograms = new WeakMap<VerifiedNativeBoltPrograms, NativeBoltPrograms>();
const files = [
  ['contactWrapper', 'beamContact.py', 'beam_contact.py'], ['boltWrapper', 'beamBoltContact.py', 'beam_bolt_contact.py'],
  ['weldWrapper', 'beamWeldContact.py', 'beam_weld_contact.py'], ['jointWrapper', 'beamJointContact.py', 'beam_joint_contact.py'],
  ['initialStrainWrapper', 'beamJointInitialStrain.py', 'beam_joint_initial_strain.py'],
] as const;
const wheel = 'oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl';
async function verify(bytes: Uint8Array, name: string): Promise<Uint8Array> {
  const pin = [...FEM_ASSETS, ...BOLT_CONTACT_ASSETS, ...WELD_CONTACT_ASSETS, ...JOINT_CONTACT_ASSETS, ...JOINT_INITIAL_STRAIN_ASSETS].find(p => p.file === name);
  if (!(bytes instanceof Uint8Array) || !pin || bytes.byteLength !== pin.bytes) throw new Error('native-preload-asset-size');
  const copy = new Uint8Array(bytes);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', copy)), b => b.toString(16).padStart(2, '0')).join('');
  if (digest !== pin.sha256) throw new Error('native-preload-asset-sha');
  return copy;
}
export async function verifyNativeBoltPrograms(value: NativeBoltPrograms): Promise<VerifiedNativeBoltPrograms> {
  if (typeof value.wheelLocation !== 'string' || value.wheelLocation.length > 2048 || !value.wheelLocation.replaceAll('\\', '/').endsWith('/'+wheel)
    || [...value.wheelLocation].some(c => c.charCodeAt(0) < 32 || c === '?' || c === '#')) throw new Error('native-preload-wheel-location');
  const copies = await Promise.all(files.map(([key, name]) => verify(value[key], name)));
  const programs: NativeBoltPrograms = { contactWrapper: copies[0], boltWrapper: copies[1], weldWrapper: copies[2], jointWrapper: copies[3],
    initialStrainWrapper: copies[4], wheelBytes: await verify(value.wheelBytes, wheel), wheelLocation: value.wheelLocation };
  const token = Object.freeze({ wheelLocation: value.wheelLocation }); verifiedPrograms.set(token, programs); return token;
}
/** Candidate only. The existing owned Worker/offline loader must supply and serve the verified wheel location.
 * Cancellation/revision dispatch remains the existing owner's responsibility; no public FemResult cast. */
export async function analyzeNativeBoltPreload(runtime: PyodideRuntime, value: unknown, token: VerifiedNativeBoltPrograms, onPhase: (phase: FemPhase) => void): Promise<NativeBoltPreloadResult> {
  const prepared = await prepareNativeBoltPreload(value), programs = verifiedPrograms.get(token);
  if (!programs) throw new Error('native-preload-unverified-programs');
  onPhase('loading-packages'); await runtime.loadPackage(programs.wheelLocation, { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  for (const [key, , virtual] of files) runtime.FS.writeFile('/pcad_fem/'+virtual, programs[key]);
  runtime.FS.writeFile('/pcad_fem/bolt-preload-native-input.json', prepared.encoded);
  onPhase('solving');
  const encoded: unknown = runtime.runPython(`
import sys
sys.path.insert(0, '/pcad_fem')
for name in ('beam_joint_initial_strain', 'beam_joint_contact', 'beam_weld_contact', 'beam_bolt_contact', 'beam_contact'):
    sys.modules.pop(name, None)
from beam_joint_initial_strain import run_beam_bolt_preload_stages
run_beam_bolt_preload_stages()
`);
  if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).length > 4_000_000) throw new Error('native-preload-response-bound');
  return decodeNativeBoltPreload(JSON.parse(encoded), prepared);
}
