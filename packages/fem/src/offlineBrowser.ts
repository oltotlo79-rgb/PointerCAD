import { FEM_ASSETS, NETGEN_ASSETS, SOLID_ASSETS, SOLID_PLASTIC_ASSETS, BOLT_CONTACT_ASSETS, SOLID_MODAL_ASSETS, SOLID_BUCKLING_ASSETS } from './assets.js';
import { analyzeBeamBoltContact } from './beamBoltContactRuntime.js';
import type { BeamBoltContactInput, BeamBoltContactResult } from './beamBoltContact.js';
import { WELD_CONTACT_ASSETS } from './beamWeldAssets.js';
import { analyzeBeamWeldContact } from './beamWeldContactRuntime.js';
import type { BeamWeldContactInput, BeamWeldContactResult } from './beamWeldContact.js';
import { JOINT_CONTACT_ASSETS } from './beamJointAssets.js';
import { analyzeBeamJointContact } from './beamJointContactRuntime.js';
import type { BeamJointContactInput, BeamJointContactResult } from './beamJointContact.js';
import { JOINT_INITIAL_STRAIN_ASSETS } from './beamJointInitialStrainAssets.js';
import { analyzeBeamJointInitialStrain } from './beamJointInitialStrainRuntime.js';
import type { BeamJointInitialStrainInput, BeamJointInitialStrainResult } from './beamJointInitialStrain.js';
import { BEAM_IMPACT_ASSETS } from './beamImpactAssets.js';
import { analyzeBeamImpact } from './beamImpactRuntime.js';
import type { BeamImpactInput, BeamImpactResult } from './beamImpactModel.js';
import { analyzeBeam, analyzeBeamModal, analyzeBeamBuckling, analyzeBeamTransient, analyzePlasticBar, analyzeBeamContact,
  isLoader, isRuntime,
  qualifyBeam, meshTetrahedra, analyzeSolid, analyzeSolidPlastic, analyzeSolidModal, analyzeSolidBuckling } from './runtime.js';
import type { BeamProofResult, FemPhase, FemResult } from './protocol.js';
import type { BeamAnalysisDocument, BeamAnalysisResult, BeamModalResult } from './analysisModel.js';

import type { BeamBucklingInput, BeamBucklingResult } from './bucklingModel.js';
import type { BeamTransientInput, BeamTransientResult } from './transientModel.js';
import type { PlasticBarInput } from './plasticBarTranslation.js';
import type { PlasticBarResult } from './plasticBarResults.js';
import type { BeamContactInput } from './contactModel.js';
import type { BeamContactAnalysisResult } from './contactResults.js';
import { NETGEN_WHEEL, type TetraMeshInput, type TetraMeshResult } from './tetraMesh.js';
import type { SolidAnalysisInput, SolidAnalysisResult } from './solidAnalysisModel.js';
import type { SolidPlasticInput } from './solidPlasticTranslation.js';
import type { SolidPlasticResult } from './solidPlasticPublicResult.js';
import type { SolidModalInput, SolidModalResult } from './solidModalModel.js';
import type { SolidBucklingInput, SolidBucklingResult } from './solidBucklingModel.js';

declare const self: DedicatedWorkerGlobalScope;

/** Fixed classic Worker only: Pyodide 0.29.3 loads its glue with importScripts.
 * The app integration must place the frozen assets beside worker.js in assets/.
 * Blob script execution requires a narrowly reviewed CSP allowance before adoption.
 */
export async function qualifyInBrowser(onPhase: (phase: FemPhase) => void): Promise<BeamProofResult> {
  const result=await runInBrowser(onPhase);
  if(result.kind!=='oofem-upstream-test-2') throw new Error('Unexpected qualification result');
  return result;
}
export async function analyzeInBrowser(document:BeamAnalysisDocument,onPhase:(phase:FemPhase)=>void):Promise<BeamAnalysisResult>{
  const result=await runInBrowser(onPhase,document);
  if(result.kind!=='oofem-linear-beam-3d') throw new Error('Unexpected analysis result');
  return result;
}
async function runInBrowser(onPhase:(phase:FemPhase)=>void,document?:BeamAnalysisDocument, buckling?:BeamBucklingInput,
  transient?:BeamTransientInput, plasticBar?:PlasticBarInput, contact?:BeamContactInput, tetra?:TetraMeshInput,
  solid?:SolidAnalysisInput, solidPlastic?:SolidPlasticInput, boltContact?:BeamBoltContactInput, weldContact?:BeamWeldContactInput,
  jointContact?:BeamJointContactInput, initialStrain?:BeamJointInitialStrainInput, impact?:BeamImpactInput, solidModal?:SolidModalInput, solidBuckling?:SolidBucklingInput):Promise<FemResult>{
  const base = new URL('./assets/', self.location.href);
  const localApp = base.protocol === 'app:' && base.host === 'pointercad';
  const web = (base.protocol === 'http:' || base.protocol === 'https:') && base.origin === self.location.origin;
  if ((!localApp && !web) || base.protocol !== self.location.protocol || base.host !== self.location.host) {
    throw new Error('Invalid FEM asset origin');
  }
  const originalFetch = self.fetch.bind(self);
  const originalImportScripts = self.importScripts.bind(self);
  const verified = new Map<string, ArrayBuffer>();
  const urls = new Map<string, string>();
  onPhase('loading-assets');
  // A bounded number of in-flight reads and a fixed developer inventory. Initial
  // requests are same-origin and prohibit redirects, so a remote fallback cannot
  // be reached while establishing integrity either.
  // Mesh-only native assets do not change the beam/bar asset requirements.
  // Impact needs only the pinned runtime, the extracted beamAnalysis.py (FEM_ASSETS) and beamImpact.py.
  const pins = impact !== undefined ? [...FEM_ASSETS, ...BEAM_IMPACT_ASSETS]
    : initialStrain !== undefined ? [...FEM_ASSETS, ...BOLT_CONTACT_ASSETS, ...WELD_CONTACT_ASSETS, ...JOINT_CONTACT_ASSETS, ...JOINT_INITIAL_STRAIN_ASSETS]
    : jointContact !== undefined ? [...FEM_ASSETS, ...BOLT_CONTACT_ASSETS, ...WELD_CONTACT_ASSETS, ...JOINT_CONTACT_ASSETS]
    : weldContact !== undefined ? [...FEM_ASSETS, ...WELD_CONTACT_ASSETS]
    : boltContact !== undefined ? [...FEM_ASSETS, ...BOLT_CONTACT_ASSETS]
    : solidPlastic !== undefined ? [...FEM_ASSETS, ...SOLID_PLASTIC_ASSETS]
    : solidBuckling !== undefined ? [...FEM_ASSETS, ...SOLID_BUCKLING_ASSETS]
    : solidModal !== undefined ? [...FEM_ASSETS, ...SOLID_MODAL_ASSETS]
    : solid !== undefined ? [...FEM_ASSETS, ...SOLID_ASSETS]
    : tetra === undefined ? FEM_ASSETS : [...FEM_ASSETS, ...NETGEN_ASSETS];
  for (let start = 0; start < pins.length; start += 4) {
    await Promise.all(pins.slice(start, start + 4).map(async pin => {
      const url = new URL(pin.file, base).href;
      const response = await originalFetch(url, { redirect: 'error', credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error(`asset-missing: ${pin.file} (HTTP ${response.status})`);
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength !== pin.bytes) throw new Error(`asset-corrupt: ${pin.file} (size)`);
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), byte => byte.toString(16).padStart(2, '0')).join('');
      if (digest !== pin.sha256) throw new Error(`asset-corrupt: ${pin.file} (SHA-256)`);
      verified.set(pin.file, buffer); urls.set(url, pin.file);
    }));
  }
  const asset = (name: string): ArrayBuffer => {
    const buffer = verified.get(name);
    if (buffer === undefined) throw new Error(`asset-missing: ${name}`);
    return buffer;
  };
  let denied = 0;
  self.fetch = (input, init) => new Promise<Response>(resolve => {
    const url = input instanceof Request ? input.url : new URL(String(input), base).href;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const file = urls.get(url);
    if (method !== 'GET' || file === undefined) { denied += 1; throw new Error(`offline-request-denied: ${url}`); }
    resolve(new Response(asset(file).slice(0), { status: 200, headers: {
      'Content-Type': file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.json') ? 'application/json' : 'application/octet-stream',
    } }));
  });
  const moduleBlob = URL.createObjectURL(new Blob([asset('pyodide.mjs')], { type: 'text/javascript' }));
  const glueBlob = URL.createObjectURL(new Blob([asset('pyodide.asm.js')], { type: 'text/javascript' }));
  self.importScripts = (...scripts: string[]): void => {
    if (scripts.length !== 1 || new URL(scripts[0], base).href !== new URL('pyodide.asm.js', base).href) {
      denied += 1; throw new Error('offline-request-denied: unexpected script');
    }
    originalImportScripts(glueBlob);
  };
  try {
    onPhase('loading-runtime');
    // Only verified developer code is imported. No request field becomes a URL.
    const loader: unknown = await import(/* @vite-ignore */ moduleBlob);
    if (!isLoader(loader)) throw new Error('Invalid fixed Pyodide loader');
    const runtime = await loader.loadPyodide({ indexURL: base.href, packageBaseUrl: base.href,
      lockFileContents: new TextDecoder().decode(asset('pyodide-lock.json')),
      // matplotlib is not preloaded: the rebuilt oofem wheel's util.py imports it only inside its plotting helpers,
      // which no FEM mode calls. With the old wheel, importing oofem.util fails, so this line ships only with that wheel.
      stdLibURL: new URL('python_stdlib.zip', base).href, packages: ['numpy'],
      fullStdLib: false, stdout: () => undefined, stderr: () => undefined });
    if (!isRuntime(runtime)) throw new Error('Invalid Pyodide version or API');
    const wheelLocation=new URL('oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl',base).href;
    // plasticBarAnalysis.py must be a pinned FEM_ASSETS entry (generated assets.ts); until then asset() reports
    // asset-missing instead of running unverified code.
    // beamContact.py is a pinned FEM_ASSETS entry; a missing or changed file stops before any code runs.
    const result = impact !== undefined
      ? await analyzeBeamImpact(runtime, impact, { analysisWrapper: new Uint8Array(asset('beamAnalysis.py')),
        impactWrapper: new Uint8Array(asset('beamImpact.py')), wheelLocation }, onPhase)
      : initialStrain !== undefined
      ? await analyzeBeamJointInitialStrain(runtime, initialStrain, { contactWrapper: new Uint8Array(asset('beamContact.py')),
        boltWrapper: new Uint8Array(asset('beamBoltContact.py')), weldWrapper: new Uint8Array(asset('beamWeldContact.py')),
        jointWrapper: new Uint8Array(asset('beamJointContact.py')), initialStrainWrapper: new Uint8Array(asset('beamJointInitialStrain.py')),
        wheelLocation }, onPhase)
      : jointContact !== undefined
      ? await analyzeBeamJointContact(runtime, jointContact, { contactWrapper: new Uint8Array(asset('beamContact.py')),
        boltWrapper: new Uint8Array(asset('beamBoltContact.py')), weldWrapper: new Uint8Array(asset('beamWeldContact.py')),
        jointWrapper: new Uint8Array(asset('beamJointContact.py')), wheelLocation }, onPhase)
      : weldContact !== undefined
      ? await analyzeBeamWeldContact(runtime, weldContact, { contactWrapper: new Uint8Array(asset('beamContact.py')),
        weldWrapper: new Uint8Array(asset('beamWeldContact.py')), wheelLocation }, onPhase)
      : boltContact !== undefined
      ? await analyzeBeamBoltContact(runtime, boltContact, { contactWrapper: new Uint8Array(asset('beamContact.py')),
        boltWrapper: new Uint8Array(asset('beamBoltContact.py')), wheelLocation }, onPhase)
      : solidPlastic !== undefined
      ? await analyzeSolidPlastic(runtime, solidPlastic, { wrapper: new Uint8Array(asset('solidPlasticAnalysis.py')), wheelLocation }, onPhase)
      : solidBuckling !== undefined
      ? await analyzeSolidBuckling(runtime, solidBuckling, { wrapper: new Uint8Array(asset('solidBuckling.py')), wheelLocation }, onPhase)
      : solidModal !== undefined
      ? await analyzeSolidModal(runtime, solidModal, { wrapper: new Uint8Array(asset('solidModal.py')), wheelLocation }, onPhase)
      : solid !== undefined
      ? await analyzeSolid(runtime, solid, { wrapper: new Uint8Array(asset('solidAnalysis.py')), wheelLocation }, onPhase)
      : tetra !== undefined
      ? await meshTetrahedra(runtime, tetra, { wrapper: new Uint8Array(asset('netgenMesher.py')),
        wheelLocation: new URL(NETGEN_WHEEL, base).href }, onPhase)
      : contact !== undefined
      ? await analyzeBeamContact(runtime, contact, { wrapper: new Uint8Array(asset('beamContact.py')), wheelLocation }, onPhase)
      : plasticBar !== undefined
      ? await analyzePlasticBar(runtime, plasticBar, { wrapper: new Uint8Array(asset('plasticBarAnalysis.py')), wheelLocation }, onPhase)
      : transient !== undefined
      ? await analyzeBeamTransient(runtime, transient, { wrapper: new Uint8Array(asset('beamAnalysis.py')), wheelLocation }, onPhase)
      : buckling !== undefined
      ? await analyzeBeamBuckling(runtime, buckling, { wrapper: new Uint8Array(asset('beamAnalysis.py')), wheelLocation }, onPhase)
      : document===undefined ? await qualifyBeam(runtime, { upstream: new Uint8Array(asset('test_2.py')),
      wrapper: new Uint8Array(asset('beamProof.py')),
      wheelLocation }, onPhase) : document.modal === undefined
        ? await analyzeBeam(runtime,document,{wrapper:new Uint8Array(asset('beamAnalysis.py')),wheelLocation},onPhase)
        : await analyzeBeamModal(runtime, document, { wrapper: new Uint8Array(asset('beamAnalysis.py')), wheelLocation }, onPhase);
    if (denied !== 0) throw new Error(`offline-request-denied: ${denied} attempted fallback requests`);
    return result;
  } finally {
    URL.revokeObjectURL(moduleBlob); URL.revokeObjectURL(glueBlob);
    // The one-shot Worker closes immediately. Do not restore an unrestricted
    // fetch or script loader while the interpreter still has references to it.
  }
}

export async function analyzeModalInBrowser(document: BeamAnalysisDocument, onPhase: (phase: FemPhase) => void): Promise<BeamModalResult> {
  const result = await runInBrowser(onPhase, document);
  if (result.kind !== 'oofem-beam-modal-3d') throw new Error('Unexpected modal result');
  return result;
}


export async function analyzeBucklingInBrowser(input: BeamBucklingInput, onPhase: (phase: FemPhase) => void): Promise<BeamBucklingResult> {
  const result = await runInBrowser(onPhase, undefined, input);
  if (result.kind !== 'oofem-beam-buckling-3d') throw new Error('Unexpected buckling result');
  return result;
}

export async function analyzeTransientInBrowser(input: BeamTransientInput, onPhase: (phase: FemPhase) => void): Promise<BeamTransientResult> {
  const result = await runInBrowser(onPhase, undefined, undefined, input);
  if (result.kind !== 'oofem-beam-transient-3d') throw new Error('Unexpected transient result');
  return result;
}

export async function analyzePlasticBarInBrowser(input: PlasticBarInput, onPhase: (phase: FemPhase) => void): Promise<PlasticBarResult> {
  const result = await runInBrowser(onPhase, undefined, undefined, undefined, input);
  if (result.kind !== 'oofem-plastic-bar-1d') throw new Error('Unexpected plastic-bar result');
  return result;
}

export async function analyzeJointContactInBrowser(input: BeamJointContactInput, onPhase: (phase: FemPhase) => void): Promise<BeamJointContactResult> {
  const result = await runInBrowser(onPhase, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, input);
  if (result.kind !== 'oofem-beam-joint-contact') throw new Error('Unexpected mixed joint-contact result');
  return result;
}

export async function analyzeJointInitialStrainInBrowser(input: BeamJointInitialStrainInput, onPhase: (phase: FemPhase) => void): Promise<BeamJointInitialStrainResult> {
  const result = await runInBrowser(onPhase, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, input);
  if (result.kind !== 'oofem-beam-joint-initial-strain') throw new Error('Unexpected joint initial-strain result');
  return result;
}

export async function analyzeImpactInBrowser(input: BeamImpactInput, onPhase: (phase: FemPhase) => void): Promise<BeamImpactResult> {
  const result = await runInBrowser(onPhase, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, input);
  if (result.kind !== 'oofem-beam-impact-3d') throw new Error('Unexpected beam impact result');
  return result;
}

export async function analyzeWeldContactInBrowser(input: BeamWeldContactInput, onPhase: (phase: FemPhase) => void): Promise<BeamWeldContactResult> {
  const result = await runInBrowser(onPhase, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, input);
  if (result.kind !== 'oofem-beam-weld-layer-contact') throw new Error('Unexpected weld-contact result');
  return result;
}

export async function analyzeBoltContactInBrowser(input: BeamBoltContactInput, onPhase: (phase: FemPhase) => void): Promise<BeamBoltContactResult> {
  const result = await runInBrowser(onPhase, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, input);
  if (result.kind !== 'oofem-beam-axial-bolt-contact') throw new Error('Unexpected bolt-contact result');
  return result;
}

export async function analyzeContactInBrowser(input: BeamContactInput, onPhase: (phase: FemPhase) => void): Promise<BeamContactAnalysisResult> {
  const result = await runInBrowser(onPhase, undefined, undefined, undefined, undefined, input);
  if (result.kind !== 'oofem-beam-contact-3d') throw new Error('Unexpected contact result');
  return result;
}

export async function meshTetrahedraInBrowser(input: TetraMeshInput, onPhase: (phase: FemPhase) => void): Promise<TetraMeshResult> {
  const result = await runInBrowser(onPhase, undefined, undefined, undefined, undefined, undefined, input);
  if ((input.schema === 'pointercad-convex-plc/1' && result.kind === 'netgen-convex-tetra-mesh')
    || (input.schema === 'pointercad-plc/2' && result.kind === 'netgen-tetra-mesh')) return result;
  throw new Error('Unexpected native meshing result');
}

export async function analyzeSolidInBrowser(input: SolidAnalysisInput, onPhase: (phase: FemPhase) => void): Promise<SolidAnalysisResult> {
  const result = await runInBrowser(onPhase, undefined, undefined, undefined, undefined, undefined, undefined, input);
  if (result.kind !== 'oofem-linear-solid-tet4') throw new Error('Unexpected solid result');
  return result;
}

export async function analyzeSolidPlasticInBrowser(input: SolidPlasticInput, onPhase: (phase: FemPhase) => void): Promise<SolidPlasticResult> {
  const result = await runInBrowser(onPhase, undefined, undefined, undefined, undefined, undefined, undefined, undefined, input);
  if (result.kind !== 'oofem-plastic-solid-tet4') throw new Error('Unexpected solid-plastic result');
  return result;
}

export async function analyzeSolidModalInBrowser(input: SolidModalInput, onPhase: (phase: FemPhase) => void): Promise<SolidModalResult> {
  const result = await runInBrowser(onPhase, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, input);
  if (result.kind !== 'oofem-solid-tet4-modal') throw new Error('Unexpected solid modal result');
  return result;
}

export async function analyzeSolidBucklingInBrowser(input: SolidBucklingInput, onPhase: (phase: FemPhase) => void): Promise<SolidBucklingResult> {
  const result = await runInBrowser(onPhase, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, input);
  if (result.kind !== 'oofem-solid-tet4-buckling') throw new Error('Unexpected solid buckling result');
  return result;
}
