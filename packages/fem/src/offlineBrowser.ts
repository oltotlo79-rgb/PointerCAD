import { SOLID_FINITE_ASSETS } from './solidFiniteAssets.js';
import { analyzeSolidFinite } from './solidFiniteRuntime.js';
import { translateSolidFinite, type SolidFiniteInput } from './solidFiniteTranslation.js';
import { SOLID_FINITE_KIND, type SolidFiniteWireResult } from './solidFiniteBinding.js';
import { sha256Hex } from './sha256.js';
import { SOLID_CONTACT_ASSETS } from './solidContactAssets.js';
import { analyzeSolidContact } from './solidContactRuntime.js';
import { verifySolidContactInput, type SolidContactInput, type SolidContactResult } from './solidContactBinding.js';
import { FRICTION_CONTACT_ASSETS } from './frictionContactAssets.js';
import { analyzeBeamFrictionContact, readFrictionSolveOptions } from './frictionContactRuntime.js';
import { translateBeamFrictionContact, type BeamFrictionContactInput } from './frictionContactTranslation.js';
import type { FrictionContactResult, FrictionSolveOptions } from './frictionContactResults.js';

import { WELD_SPAN_CONTACT_ASSETS } from './beamWeldSpanAssets.js';
import { analyzeBeamWeldSpanContact } from './beamWeldSpanContactRuntime.js';
import { translateBeamWeldSpanContact, type BeamWeldSpanContactInput } from './beamWeldSpanContact.js';
import type { BeamWeldSpanContactResult } from './beamWeldSpanContactBinding.js';
import { analyzeNativeBoltPreload, verifyNativeBoltPrograms } from './nativeBoltPreloadRuntime.js';
import { prepareNativeBoltPreloadJob, NATIVE_BOLT_KIND, type NativeBoltPreloadOwnedResult, type PreparedNativeBoltPreloadJob } from './nativeBoltPreloadBinding.js';
import { FEM_ASSETS, NETGEN_ASSETS, SOLID_ASSETS, SOLID_PLASTIC_ASSETS, BOLT_CONTACT_ASSETS, SOLID_MODAL_ASSETS, SOLID_BUCKLING_ASSETS } from './assets.js';
import { analyzeBeamBoltContact } from './beamBoltContactRuntime.js';
import { analyzeFrameBoltContact } from './frameBoltContactRuntime.js';
import { readFrameBoltContact, type FrameBoltContactInput } from './beamBoltContact.js';
import type { FrameBoltContactResult } from './frameBoltContactBinding.js';
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
import { SHELL_ASSETS } from './shellAssets.js';
import { analyzeShellNative } from './shellRuntime.js';
import { SHELL_NATIVE_KIND, type ShellNativeWireResult } from './shellBinding.js';
import { translateShellAnalysis } from './shellTranslation.js';
import type { ShellAnalysisInput } from './shellAnalysisModel.js';

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
  jointContact?:BeamJointContactInput, initialStrain?:BeamJointInitialStrainInput, impact?:BeamImpactInput, solidModal?:SolidModalInput, solidBuckling?:SolidBucklingInput, nativeBolt?:PreparedNativeBoltPreloadJob, frameBoltContact?:FrameBoltContactInput, spanContact?:BeamWeldSpanContactInput, frictionJob?:{ readonly input:BeamFrictionContactInput; readonly options:FrictionSolveOptions }, solidContact?:SolidContactInput, solidFinite?:SolidFiniteInput, shell?:ShellAnalysisInput):Promise<FemResult | FrictionContactResult>{
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
  // Shell needs only the pinned runtime/OOFEM wheel (FEM_ASSETS) and the fixed shellAnalysis.py.
  const pins = shell !== undefined ? [...FEM_ASSETS, ...SHELL_ASSETS]
    : solidFinite !== undefined ? [...FEM_ASSETS, ...SOLID_FINITE_ASSETS]
    : solidContact !== undefined ? [...FEM_ASSETS, ...SOLID_CONTACT_ASSETS]
    : frictionJob !== undefined ? [...FEM_ASSETS, ...FRICTION_CONTACT_ASSETS]
    : spanContact !== undefined ? [...FEM_ASSETS.filter(pin => pin.file !== 'beamContact.py'), ...WELD_SPAN_CONTACT_ASSETS]
    : nativeBolt !== undefined ? [...FEM_ASSETS, ...BOLT_CONTACT_ASSETS, ...WELD_CONTACT_ASSETS, ...JOINT_CONTACT_ASSETS, ...JOINT_INITIAL_STRAIN_ASSETS]
    : impact !== undefined ? [...FEM_ASSETS, ...BEAM_IMPACT_ASSETS]
    : initialStrain !== undefined ? [...FEM_ASSETS, ...BOLT_CONTACT_ASSETS, ...WELD_CONTACT_ASSETS, ...JOINT_CONTACT_ASSETS, ...JOINT_INITIAL_STRAIN_ASSETS]
    : jointContact !== undefined ? [...FEM_ASSETS, ...BOLT_CONTACT_ASSETS, ...WELD_CONTACT_ASSETS, ...JOINT_CONTACT_ASSETS]
    : weldContact !== undefined ? [...FEM_ASSETS, ...WELD_CONTACT_ASSETS]
    : boltContact !== undefined || frameBoltContact !== undefined ? [...FEM_ASSETS, ...BOLT_CONTACT_ASSETS]
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
      const digest = await sha256Hex(buffer);
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
    const result: FemResult = shell !== undefined
      ? await analyzeShellNative(runtime, shell, { wrapper: new Uint8Array(asset('shellAnalysis.py')), wheelLocation }, onPhase)
      : solidFinite !== undefined
      ? { kind: SOLID_FINITE_KIND, result: await analyzeSolidFinite(runtime, solidFinite, {
        material: new Uint8Array(asset('solidFiniteMaterial.py')),
        equilibrium: new Uint8Array(asset('solidFiniteEquilibrium.py')), wheelLocation }, onPhase) }
      : solidContact !== undefined
      ? await analyzeSolidContact(runtime, solidContact, { normal: new Uint8Array(asset('solidContact.py')),
        friction: new Uint8Array(asset('solidContactFriction.py')), solver: new Uint8Array(asset('solidContactSolver.py')),
        driver: new Uint8Array(asset('solidContactDriver.py')), wheelLocation }, onPhase)
      : frictionJob !== undefined
      ? await analyzeBeamFrictionContact(runtime, frictionJob.input, { contactWrapper: new Uint8Array(asset('beamContact.py')),
        coreWrapper: new Uint8Array(asset('beamFrictionContact.py')), runtimeWrapper: new Uint8Array(asset('beamFrictionRuntime.py')), wheelLocation }, frictionJob.options, onPhase)
      : spanContact !== undefined
      ? await analyzeBeamWeldSpanContact(runtime, spanContact, { contactWrapper: new Uint8Array(asset('beamWeldSpanBase.py')),
        spanWrapper: new Uint8Array(asset('beamWeldSpan.py')), spanContactWrapper: new Uint8Array(asset('beamWeldSpanContact.py')), wheelLocation }, onPhase)
      : nativeBolt !== undefined
      ? { ...await analyzeNativeBoltPreload(runtime, nativeBolt.prepared.plan, await verifyNativeBoltPrograms({
          contactWrapper: new Uint8Array(asset('beamContact.py')), boltWrapper: new Uint8Array(asset('beamBoltContact.py')),
          weldWrapper: new Uint8Array(asset('beamWeldContact.py')), jointWrapper: new Uint8Array(asset('beamJointContact.py')),
          initialStrainWrapper: new Uint8Array(asset('beamJointInitialStrain.py')),
          wheelBytes: new Uint8Array(asset('oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl')), wheelLocation,
        }), onPhase), kind: NATIVE_BOLT_KIND, source: nativeBolt.source }
      : impact !== undefined
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
      : frameBoltContact !== undefined
      ? await analyzeFrameBoltContact(runtime, frameBoltContact, { contactWrapper: new Uint8Array(asset('beamContact.py')),
        boltWrapper: new Uint8Array(asset('beamBoltContact.py')), wheelLocation }, onPhase)
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

/** Validate actual preparation and mesh digests before reading any runtime asset. */
export async function analyzeSolidContactInBrowser(value: unknown,
  onPhase: (phase: FemPhase) => void): Promise<SolidContactResult> {
  const input = await verifySolidContactInput(value);
  const result = await runInBrowser(onPhase, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, input);
  if (result.kind !== 'solid-contact-analysis') throw new Error('Unexpected solid contact result');
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

/** Full untrusted numeric-plan validation and local preparation complete before runInBrowser reads assets. */
export async function analyzeNativeBoltPreloadInBrowser(value: unknown, onPhase: (phase: FemPhase) => void): Promise<NativeBoltPreloadOwnedResult> {
  let job: PreparedNativeBoltPreloadJob;
  try { job = await prepareNativeBoltPreloadJob(value); }
  catch (error) { throw new Error('native-preload-input: '+(error instanceof Error ? error.message : 'invalid plan'), { cause: error }); }
  const result = await runInBrowser(onPhase, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, job);
  if (result.kind !== NATIVE_BOLT_KIND) throw new Error('Unexpected native preload result');
  return result;
}

/** 正規入力の所有を確定するまで、資産取得もinterpreterの作成もしない。 */
export async function analyzeFrameBoltContactInBrowser(value: unknown, onPhase: (phase: FemPhase) => void): Promise<FrameBoltContactResult> {
  const input = readFrameBoltContact(value).input;
  const result = await runInBrowser(onPhase, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, input);
  if (result.kind !== 'frame-bolt-contact') throw new Error('Unexpected frame-bolt-contact result');
  return result;
}

/** Admission and snapshot precede origin/asset/interpreter access. Physical span assets are a separate Root delivery. */
export async function analyzeWeldSpanContactInBrowser(value: unknown, onPhase: (phase: FemPhase) => void): Promise<BeamWeldSpanContactResult> {
  const input = translateBeamWeldSpanContact(value).input;
  const result = await runInBrowser(onPhase, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, input);
  if (result.kind !== 'oofem-beam-weld-span-contact') throw new Error('Unexpected weld-span-contact result');
  return result;
}


/** Own and validate both input and solver options before origin, fetch or interpreter access. */
export async function analyzeFrictionContactInBrowser(value: unknown, options: FrictionSolveOptions,
  onPhase: (phase: FemPhase) => void): Promise<FrictionContactResult> {
  const input = translateBeamFrictionContact(value).input;
  const ownedOptions = readFrictionSolveOptions(options);
  const result = await runInBrowser(onPhase, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { input, options: ownedOptions });
  if (result.kind !== 'pointercad-internal-friction-contact-candidate') throw new Error('Unexpected friction-contact result');
  return result;
}

/** Own a validated plan before any asset read. The one-shot Worker disposes the claimed runtime on every outcome. */
export async function analyzeSolidFiniteInBrowser(value: unknown,
  onPhase: (phase: FemPhase) => void): Promise<SolidFiniteWireResult> {
  const input = translateSolidFinite(value).input;
  const result = await runInBrowser(onPhase, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, input);
  if (result.kind !== SOLID_FINITE_KIND) throw new Error('Unexpected finite-equilibrium result');
  return result;
}

/** Own a validated shell input before any origin, asset or interpreter access. The Worker returns the raw native
 * answer bound to its plan digest; it is decoded once by the consumer (decodeCadShellAnalysis), never here. */
export async function analyzeShellInBrowser(value: unknown, onPhase: (phase: FemPhase) => void): Promise<ShellNativeWireResult> {
  const input = translateShellAnalysis(value).input;
  const result = await runInBrowser(onPhase, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, input);
  if (result.kind !== SHELL_NATIVE_KIND) throw new Error('Unexpected shell result');
  return result;
}
