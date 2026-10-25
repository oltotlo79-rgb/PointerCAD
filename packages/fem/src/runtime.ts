import { FEM_RUNTIME_VERSION, isBeamProof, isRecord, type BeamProofResult, type FemPhase } from './protocol.js';
import type { BeamAnalysisDocument, BeamAnalysisResult, BeamModalResult } from './analysisModel.js';
import { beamInputSha256, translateBeamAnalysis } from './analysisTranslation.js';
import { decodeBeamAnalysis } from './analysisResults.js';
import { decodeBeamModal } from './modalResults.js';
import { translateBeamModal } from './modalTranslation.js';
import type { BeamBucklingInput, BeamBucklingResult } from './bucklingModel.js';
import { bucklingInputSha256, translateBeamBuckling } from './bucklingTranslation.js';
import { decodeBeamBuckling } from './bucklingResults.js';
import type { BeamTransientInput, BeamTransientResult } from './transientModel.js';
import { transientInputSha256, translateBeamTransient } from './transientTranslation.js';
import { decodeBeamTransient } from './transientResults.js';
import { plasticBarInputSha256, translatePlasticBar, type PlasticBarInput } from './plasticBarTranslation.js';
import { decodePlasticBar, type PlasticBarResult } from './plasticBarResults.js';
import type { BeamContactInput } from './contactModel.js';
import { contactInputSha256, translateBeamContact } from './contactTranslation.js';
import { decodeBeamContact, type BeamContactAnalysisResult } from './contactResults.js';
import { readTetraMeshInput, tetraMeshInputSha256, decodeTetraMesh, type TetraMeshInput, type TetraMeshResult } from './tetraMesh.js';
import type { SolidAnalysisInput, SolidAnalysisResult } from './solidAnalysisModel.js';
import { solidInputSha256, translateSolidAnalysis } from './solidAnalysisTranslation.js';
import { decodeSolidAnalysis } from './solidAnalysisResults.js';
import { solidPlasticInputSha256, translateSolidPlastic, type SolidPlasticInput } from './solidPlasticTranslation.js';
import { decodeSolidPlastic, type SolidPlasticResult } from './solidPlasticPublicResult.js';
import type { SolidModalInput, SolidModalResult } from './solidModalModel.js';
import { solidModalInputSha256, translateSolidModal } from './solidModalTranslation.js';
import { decodeSolidModal } from './solidModalResults.js';
import type { SolidBucklingInput, SolidBucklingResult } from './solidBucklingModel.js';
import { solidBucklingInputSha256, translateSolidBuckling } from './solidBucklingTranslation.js';
import { decodeSolidBuckling } from './solidBucklingResults.js';

export interface PyodideRuntime {
  readonly version: string;
  readonly FS: { mkdirTree(path: string): void; writeFile(path: string, value: string | Uint8Array): void };
  runPython(source: string): unknown;
  loadPackage(packages: string | readonly string[], options?: { readonly checkIntegrity: boolean }): Promise<unknown>;
}
export interface PyodideLoader {
  loadPyodide(options: {
    readonly indexURL: string; readonly packageBaseUrl: string; readonly packageCacheDir?: string;
    readonly lockFileContents: string; readonly stdLibURL: string;
    readonly packages: readonly string[]; readonly fullStdLib: false;
    readonly stdout: (text: string) => void; readonly stderr: (text: string) => void;
  }): Promise<unknown>;
}

/** Input is JSON data; only the pinned developer wrapper executes. All native history checks run before return. */
export async function analyzeSolidPlastic(runtime: PyodideRuntime, value: SolidPlasticInput, programs: {
  readonly wrapper: Uint8Array; readonly wheelLocation: string;
}, onPhase: (phase: FemPhase) => void): Promise<SolidPlasticResult> {
  const prepared = translateSolidPlastic(value);
  const hash = await solidPlasticInputSha256(prepared.input);
  onPhase('loading-packages');
  await runtime.loadPackage(programs.wheelLocation, { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/solid-plastic-input.json', JSON.stringify(prepared.plan));
  runtime.FS.writeFile('/pcad_fem/solid_plastic_analysis.py', programs.wrapper);
  onPhase('solving');
  const encoded = runtime.runPython(`
import sys
sys.path.insert(0, '/pcad_fem')
from solid_plastic_analysis import run_solid_plastic
run_solid_plastic()
`);
  // At most 20000 recorded node/element states; each has at most 18 finite doubles plus fixed metadata.
  if (typeof encoded !== 'string' || encoded.length > 16_000_000) throw new Error('Invalid bounded solid-plastic response');
  const raw: unknown = JSON.parse(encoded);
  return decodeSolidPlastic(raw, prepared.input, hash);
}

/** Fixed developer source only. Input JSON is data, never executable Python. */
export async function analyzeSolid(runtime: PyodideRuntime, value: SolidAnalysisInput, programs: {
  readonly wrapper: Uint8Array; readonly wheelLocation: string;
}, onPhase: (phase: FemPhase) => void): Promise<SolidAnalysisResult> {
  const prepared = translateSolidAnalysis(value);
  const hash = await solidInputSha256(prepared.input);
  onPhase('loading-packages');
  await runtime.loadPackage(programs.wheelLocation, { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/solid-input.json', JSON.stringify(prepared.plan));
  runtime.FS.writeFile('/pcad_fem/solid_analysis.py', programs.wrapper);
  onPhase('solving');
  const encoded = runtime.runPython(`
import sys
sys.path.insert(0, '/pcad_fem')
from solid_analysis import run_solid_analysis
run_solid_analysis()
`);
  // 50000 x 12 native actions + 10000 x 3 displacements, <= 25 characters
  // per finite double plus delimiters and fixed metadata, bounded below 24MB.
  if (typeof encoded !== 'string' || encoded.length > 24_000_000) throw new Error('Invalid bounded solid response');
  const raw: unknown = JSON.parse(encoded);
  return decodeSolidAnalysis(raw, prepared.input, hash);
}

/** Fixed hashed r150 solidModal.py only; the plan is JSON data validated again natively. */
export async function analyzeSolidModal(runtime: PyodideRuntime, value: SolidModalInput, programs: {
  readonly wrapper: Uint8Array; readonly wheelLocation: string;
}, onPhase: (phase: FemPhase) => void): Promise<SolidModalResult> {
  const prepared = translateSolidModal(value);
  const hash = await solidModalInputSha256(prepared.input);
  onPhase('loading-packages');
  await runtime.loadPackage(programs.wheelLocation, { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/solid-modal-input.json', JSON.stringify(prepared.plan));
  runtime.FS.writeFile('/pcad_fem/solid_modal.py', programs.wrapper);
  onPhase('solving');
  const encoded = runtime.runPython(`
import sys
sys.path.insert(0, '/pcad_fem')
from solid_modal import run_solid_modal
run_solid_modal()
`);
  // At most 20 modes x 600 nodes x 3 finite doubles (<= 25 characters each) plus fixed metadata: below 2 MB.
  if (typeof encoded !== 'string' || encoded.length > 2_000_000) throw new Error('Invalid bounded solid modal response');
  const raw: unknown = JSON.parse(encoded);
  return decodeSolidModal(raw, prepared.input, hash);
}

/** Fixed hashed task159 native-r1 solidBuckling.py only; the plan is JSON data validated again natively. */
export async function analyzeSolidBuckling(runtime: PyodideRuntime, value: SolidBucklingInput, programs: {
  readonly wrapper: Uint8Array; readonly wheelLocation: string;
}, onPhase: (phase: FemPhase) => void): Promise<SolidBucklingResult> {
  const prepared = translateSolidBuckling(value);
  const hash = await solidBucklingInputSha256(prepared.input);
  onPhase('loading-packages');
  await runtime.loadPackage(programs.wheelLocation, { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/solid-buckling-input.json', JSON.stringify(prepared.plan));
  runtime.FS.writeFile('/pcad_fem/solid_buckling.py', programs.wrapper);
  onPhase('solving');
  const encoded = runtime.runPython(`
import sys
sys.path.insert(0, '/pcad_fem')
from solid_buckling import run_solid_buckling
run_solid_buckling()
`);
  // At most 12 modes x 10000 nodes x 3 finite doubles (<= 25 characters each) plus fixed metadata: below 10 MB.
  if (typeof encoded !== 'string' || encoded.length > 10_000_000) throw new Error('Invalid bounded solid buckling response');
  const raw: unknown = JSON.parse(encoded);
  return decodeSolidBuckling(raw, prepared.input, hash);
}

/** Fixed hashed developer Python plus an admitted local Netgen wheel; input remains JSON data. */
export async function meshTetrahedra(runtime: PyodideRuntime, value: TetraMeshInput, programs: {
  readonly wrapper: Uint8Array; readonly wheelLocation: string;
}, onPhase: (phase: FemPhase) => void): Promise<TetraMeshResult> {
  const input = readTetraMeshInput(value);
  const hash = await tetraMeshInputSha256(input);
  onPhase('loading-packages');
  await runtime.loadPackage(programs.wheelLocation, { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/tetra-input.json', JSON.stringify(input));
  runtime.FS.writeFile('/pcad_fem/netgen_mesher.py', programs.wrapper);
  onPhase('solving');
  const encoded = runtime.runPython(`
import sys
sys.path.insert(0, '/pcad_fem')
from netgen_mesher import run_tetra_mesh
run_tetra_mesh()
`);
  if (typeof encoded !== 'string' || encoded.length > 4_000_000) throw new Error('Invalid bounded Netgen mesh response');
  const raw: unknown = JSON.parse(encoded);
  return decodeTetraMesh(raw, input, hash);
}
export function isLoader(value: unknown): value is PyodideLoader {
  return isRecord(value) && typeof value.loadPyodide === 'function';
}
export function isRuntime(value: unknown): value is PyodideRuntime {
  return isRecord(value) && value.version === FEM_RUNTIME_VERSION && isRecord(value.FS)
    && typeof value.FS.mkdirTree === 'function' && typeof value.FS.writeFile === 'function'
    && typeof value.runPython === 'function' && typeof value.loadPackage === 'function';
}
/** All three Python files/archives here are fixed, hashed developer assets. No
 * request or document text is interpolated into executable Python. */
export async function qualifyBeam(runtime: PyodideRuntime, programs: {
  readonly upstream: Uint8Array; readonly wrapper: Uint8Array; readonly wheelLocation: string;
}, onPhase: (phase: FemPhase) => void): Promise<BeamProofResult> {
  onPhase('loading-packages');
  await runtime.loadPackage(programs.wheelLocation, { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/upstream_test_2.py', programs.upstream);
  runtime.FS.writeFile('/pcad_fem/beam_proof.py', programs.wrapper);
  onPhase('solving');
  const encoded = runtime.runPython(`
import sys
sys.path.insert(0, '/pcad_fem')
from beam_proof import run_beam_proof
run_beam_proof()
`);
  if (typeof encoded !== 'string' || encoded.length > 8192) throw new Error('Invalid FEM numerical response');
  const result: unknown = JSON.parse(encoded);
  if (!isBeamProof(result)) throw new Error('FEM runtime identity or upstream displacement assertion failed');
  return result;
}

/** The translated request is a JSON file. Only this fixed developer module is executed. */
export async function analyzeBeam(runtime:PyodideRuntime, document:BeamAnalysisDocument, programs:{
  readonly wrapper:Uint8Array; readonly wheelLocation:string;
},onPhase:(phase:FemPhase)=>void):Promise<BeamAnalysisResult>{
  const prepared=translateBeamAnalysis(document);
  if (prepared.document.modal !== undefined) throw new Error('Static analysis requires schema 1');
  const inputSha256=await beamInputSha256(prepared.document);
  onPhase('loading-packages');
  await runtime.loadPackage(programs.wheelLocation,{checkIntegrity:true});
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/analysis-input.json',JSON.stringify(prepared.plan));
  runtime.FS.writeFile('/pcad_fem/beam_analysis.py',programs.wrapper);
  onPhase('solving');
  const encoded=runtime.runPython(`
import sys
sys.path.insert(0, '/pcad_fem')
from beam_analysis import run_beam_analysis
run_beam_analysis()
`);
  if(typeof encoded!=='string'||encoded.length>2_000_000) throw new Error('Invalid bounded OOFEM analysis response');
  const decoded:unknown=JSON.parse(encoded);
  return decodeBeamAnalysis(decoded,prepared.document,inputSha256);
}

export async function analyzeBeamModal(runtime: PyodideRuntime, document: BeamAnalysisDocument, programs: {
  readonly wrapper: Uint8Array; readonly wheelLocation: string;
}, onPhase: (phase: FemPhase) => void): Promise<BeamModalResult> {
  const prepared = translateBeamModal(document);
  const inputSha256 = await beamInputSha256(prepared.document);
  onPhase('loading-packages');
  await runtime.loadPackage(programs.wheelLocation, { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/analysis-input.json', JSON.stringify(prepared.plan));
  runtime.FS.writeFile('/pcad_fem/beam_analysis.py', programs.wrapper);
  onPhase('solving');
  const encoded = runtime.runPython(`
import sys
sys.path.insert(0, '/pcad_fem')
from beam_analysis import run_beam_modal
run_beam_modal()
`);
  if (typeof encoded !== 'string' || encoded.length > 2_000_000) throw new Error('Invalid bounded modal response');
  const decoded: unknown = JSON.parse(encoded);
  return decodeBeamModal(decoded, prepared.document, inputSha256);
}


export async function analyzeBeamBuckling(runtime: PyodideRuntime, input: BeamBucklingInput, programs: {
  readonly wrapper: Uint8Array; readonly wheelLocation: string;
}, onPhase: (phase: FemPhase) => void): Promise<BeamBucklingResult> {
  const prepared = translateBeamBuckling(input);
  const hash = await bucklingInputSha256(prepared.input);
  onPhase('loading-packages');
  await runtime.loadPackage(programs.wheelLocation, { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/analysis-input.json', JSON.stringify(prepared.plan));
  runtime.FS.writeFile('/pcad_fem/beam_analysis.py', programs.wrapper);
  onPhase('solving');
  const encoded = runtime.runPython(`
import sys
sys.path.insert(0, '/pcad_fem')
from beam_analysis import run_beam_buckling
run_beam_buckling()
`);
  if (typeof encoded !== 'string' || encoded.length > 2_000_000) throw new Error('Invalid bounded buckling response');
  const raw: unknown = JSON.parse(encoded);
  return decodeBeamBuckling(raw, prepared.input, hash);
}

/** Native beam3d K/M plus the explicit NumPy average-acceleration Newmark integration of
 * run_beam_transient; not an OOFEM transient solver. At most 101 samples x 128 nodes x 18
 * numbers (about 8.4 million characters) stay below the 12,000,000-character bound. */
export async function analyzeBeamTransient(runtime: PyodideRuntime, input: BeamTransientInput, programs: {
  readonly wrapper: Uint8Array; readonly wheelLocation: string;
}, onPhase: (phase: FemPhase) => void): Promise<BeamTransientResult> {
  const prepared = translateBeamTransient(input);
  const hash = await transientInputSha256(prepared.input);
  onPhase('loading-packages');
  await runtime.loadPackage(programs.wheelLocation, { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/analysis-input.json', JSON.stringify(prepared.plan));
  runtime.FS.writeFile('/pcad_fem/beam_analysis.py', programs.wrapper);
  onPhase('solving');
  const encoded = runtime.runPython(`
import sys
sys.path.insert(0, '/pcad_fem')
from beam_analysis import run_beam_transient
run_beam_transient()
`);
  if (typeof encoded !== 'string' || encoded.length > 12_000_000) throw new Error('Invalid bounded transient response');
  const raw: unknown = JSON.parse(encoded);
  return decodeBeamTransient(raw, prepared.input, hash);
}

/** Native truss1d + MisesMat + StaticStructural in the fixed plasticBarAnalysis.py; only the plan is written as JSON.
 * At most 2000 samples, each 7 numbers of at most 25 characters plus about 130 characters of field names (about
 * 0.7 million characters), stay below the 2,000,000-character bound. The decoder rejects any deviation from the independent return-mapping reference. */
export async function analyzePlasticBar(runtime: PyodideRuntime, input: PlasticBarInput, programs: {
  readonly wrapper: Uint8Array; readonly wheelLocation: string;
}, onPhase: (phase: FemPhase) => void): Promise<PlasticBarResult> {
  const prepared = translatePlasticBar(input);
  const hash = await plasticBarInputSha256(prepared.input);
  onPhase('loading-packages');
  await runtime.loadPackage(programs.wheelLocation, { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/analysis-input.json', JSON.stringify(prepared.plan));
  runtime.FS.writeFile('/pcad_fem/plastic_bar_analysis.py', programs.wrapper);
  onPhase('solving');
  const encoded = runtime.runPython(`
import sys
sys.path.insert(0, '/pcad_fem')
from plastic_bar_analysis import run_plastic_bar
run_plastic_bar()
`);
  if (typeof encoded !== 'string' || encoded.length > 2_000_000) throw new Error('Invalid bounded plastic-bar response');
  const raw: unknown = JSON.parse(encoded);
  return decodePlasticBar(raw, prepared.input, hash);
}

/** Native Beam3d K with the explicit NumPy complementarity solve of run_beam_contact (beamContact.py); not an
 * OOFEM contact solver. At most 32 states x 128 nodes x 6 numbers plus 64 contacts x 32 states stay below the
 * 2,000,000-character bound. The decoder recomputes penetration, tension and complementarity. */
export async function analyzeBeamContact(runtime: PyodideRuntime, input: BeamContactInput, programs: {
  readonly wrapper: Uint8Array; readonly wheelLocation: string;
}, onPhase: (phase: FemPhase) => void): Promise<BeamContactAnalysisResult> {
  const prepared = translateBeamContact(input);
  const hash = await contactInputSha256(prepared.input);
  onPhase('loading-packages');
  await runtime.loadPackage(programs.wheelLocation, { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/analysis-input.json', JSON.stringify(prepared.plan));
  runtime.FS.writeFile('/pcad_fem/beam_contact.py', programs.wrapper);
  onPhase('solving');
  const encoded = runtime.runPython(`
import sys
sys.path.insert(0, '/pcad_fem')
from beam_contact import run_beam_contact
run_beam_contact()
`);
  if (typeof encoded !== 'string' || encoded.length > 2_000_000) throw new Error('Invalid bounded contact response');
  const raw: unknown = JSON.parse(encoded);
  return decodeBeamContact(raw, prepared.input, hash);
}
