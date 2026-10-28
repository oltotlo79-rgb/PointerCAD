import { readNativeBoltPreloadWireInput, prepareNativeBoltPreloadJob, nativeBoltPreloadOwnedMatches, type NativeBoltPreloadOwnedResult } from './nativeBoltPreloadBinding.js';
import { FEM_PROTOCOL, isBeamProof, isIdentity, isReply, sameIdentity, type BeamProofResult,
  type FemFailure, type FemIdentity, type FemPhase, type FemRequest, type FemResult } from './protocol.js';
import type { BeamAnalysisResult, BeamModalResult } from './analysisModel.js';
import type { BeamBucklingResult } from './bucklingModel.js';
import { bucklingInputSha256, translateBeamBuckling } from './bucklingTranslation.js';
import { bucklingResultMatches } from './bucklingResults.js';
import type { BeamTransientResult } from './transientModel.js';
import { transientInputSha256, translateBeamTransient } from './transientTranslation.js';
import { transientResultMatches } from './transientResults.js';
import { plasticBarInputSha256, translatePlasticBar } from './plasticBarTranslation.js';
import { plasticBarResultMatches, type PlasticBarResult } from './plasticBarResults.js';
import { contactInputSha256, translateBeamContact } from './contactTranslation.js';
import { contactResultMatches, type BeamContactAnalysisResult } from './contactResults.js';
import { beamBoltContactInputSha256, translateBeamBoltContact, type BeamBoltContactResult } from './beamBoltContact.js';
import { beamBoltContactResultMatches } from './beamBoltContactBinding.js';
import { readFrameBoltContact, frameBoltContactInputSha256 } from './beamBoltContact.js';
import { frameBoltContactResultMatches, type FrameBoltContactResult } from './frameBoltContactBinding.js';
import { beamWeldContactInputSha256, translateBeamWeldContact, type BeamWeldContactResult } from './beamWeldContact.js';
import { beamWeldContactResultMatches } from './beamWeldContactBinding.js';
import { beamJointContactInputSha256, translateBeamJointContact, type BeamJointContactResult } from './beamJointContact.js';
import { beamJointContactResultMatches } from './beamJointContactBinding.js';
import { beamJointInitialStrainInputSha256, translateBeamJointInitialStrain, type BeamJointInitialStrainResult } from './beamJointInitialStrain.js';
import { beamJointInitialStrainResultMatches } from './beamJointInitialStrainBinding.js';
import type { BeamImpactResult } from './beamImpactModel.js';
import { impactInputSha256, translateBeamImpact } from './beamImpactTranslation.js';
import { beamImpactResultMatches } from './beamImpactBinding.js';
import { beamResultMatches } from './analysisResults.js';
import { modalResultMatches } from './modalResults.js';
import { translateBeamModal } from './modalTranslation.js';
import { beamInputSha256, translateBeamAnalysis } from './analysisTranslation.js';
import { diagnoseTetraMeshQuality, readTetraMeshQualityLimits, type TetraMeshQuality, type TetraMeshQualityLimits } from './tetraMeshQuality.js';
import { readTetraMeshInput, tetraMeshInputSha256, tetraMeshResultMatches, type TetraMeshResult } from './tetraMesh.js';
import type { SolidAnalysisResult } from './solidAnalysisModel.js';
import { solidInputSha256, translateSolidAnalysis } from './solidAnalysisTranslation.js';
import { solidResultMatches } from './solidAnalysisResults.js';
import { solidPlasticInputSha256, translateSolidPlastic } from './solidPlasticTranslation.js';
import { solidPlasticResultMatches, type SolidPlasticResult } from './solidPlasticPublicResult.js';
import type { SolidModalResult } from './solidModalModel.js';
import { solidModalInputSha256, translateSolidModal } from './solidModalTranslation.js';
import { solidModalResultMatches } from './solidModalPublicResult.js';
import type { SolidBucklingResult } from './solidBucklingModel.js';
import { solidBucklingInputSha256, translateSolidBuckling } from './solidBucklingTranslation.js';
import { solidBucklingResultMatches } from './solidBucklingPublicResult.js';

import { analyzeFatigue } from './fatigue.js';
import { readFatigueSnCurve, type FatigueResult } from './fatigueModel.js';
import { readSolidFatigueSelection, solidFatigueInput, type SolidFatigueAdaptation } from './fatigueSolid.js';

export interface FemWorkerPort {
  postMessage(message: FemRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
}
export type FemCompletion<R extends FemResult = BeamProofResult> = { readonly kind: 'result'; readonly identity: FemIdentity; readonly result: R }
  | { readonly kind: 'failed'; readonly identity: FemIdentity; readonly failure: FemFailure }
  | { readonly kind: 'cancelled'; readonly identity: FemIdentity; readonly reason: 'abort' | 'superseded' | 'disposed' };
export type TetraMeshQualityCompletion = Exclude<FemCompletion<TetraMeshResult>, { readonly kind: 'result' }>
  | (Extract<FemCompletion<TetraMeshResult>, { readonly kind: 'result' }> & { readonly quality: TetraMeshQuality });
export type SolidFatigueAnalysis = Exclude<SolidFatigueAdaptation, { readonly ok: true }>
  | (Extract<SolidFatigueAdaptation, { readonly ok: true }> & { readonly result: FatigueResult });
/** Native completion is unchanged; only fatigue.ok:true represents a successful fatigue analysis. */
export type SolidFatigueCompletion = Exclude<FemCompletion<SolidAnalysisResult>, { readonly kind: 'result' }>
  | (Extract<FemCompletion<SolidAnalysisResult>, { readonly kind: 'result' }> & { readonly fatigue: SolidFatigueAnalysis });

interface Active {
  readonly identity: FemIdentity;
  readonly worker: FemWorkerPort;
  readonly cancel: (reason: 'superseded' | 'disposed') => void;
}
export interface FemOptions { readonly signal?: AbortSignal; readonly onPhase?: (phase: FemPhase) => void }

/** One interpreter per request. Termination remains effective during native WASM. */
export class FemClient {
  private generation = 0;
  private active: Active | null = null;
  private disposed = false;
  constructor(private readonly createWorker: () => FemWorkerPort) {}

  /** Native small-strain J2 tet4 history. Uses the same one-shot owner as every other mode. */
  analyzeSolidPlastic(value: unknown, options: FemOptions = {}): Promise<FemCompletion<SolidPlasticResult>> {
    let prepared: ReturnType<typeof translateSolidPlastic>;
    try { prepared = translateSolidPlastic(value); }
    catch (error) { this.cancel('superseded'); return Promise.reject(error instanceof Error
      ? error : new Error('Invalid solid-plastic input', { cause: error })); }
    const input = prepared.input;
    const identity = this.nextIdentity(input.source.documentId, input.source.revision);
    const expectedHash = solidPlasticInputSha256(input).catch(() => null);
    return this.execute({ protocol: FEM_PROTOCOL, kind: 'analyze-solid-plastic-tet4', identity, input }, options,
      async result => {
        const hash = await expectedHash;
        return hash !== null && solidPlasticResultMatches(result, input, hash) ? result : null;
      });
  }

  /** Linear-elastic tet4 free vibration (consistent mass). Same one-shot owner, abort, supersession and deadlines;
   * a reply for another revision, mesh, material or digest is refused by re-decoding it against this input. */
  analyzeSolidModal(value: unknown, options: FemOptions = {}): Promise<FemCompletion<SolidModalResult>> {
    let prepared: ReturnType<typeof translateSolidModal>;
    try { prepared = translateSolidModal(value); }
    catch (error) { this.cancel('superseded'); return Promise.reject(error instanceof Error
      ? error : new Error('Invalid solid modal input', { cause: error })); }
    const input = prepared.input;
    const identity = this.nextIdentity(input.source.documentId, input.source.revision);
    const expectedHash = solidModalInputSha256(input).catch(() => null);
    return this.execute({ protocol: FEM_PROTOCOL, kind: 'analyze-solid-modal-tet4', identity, input }, options,
      async result => {
        const hash = await expectedHash;
        return hash !== null && solidModalResultMatches(result, input, hash) ? result : null;
      });
  }

  /** Linear prestress buckling of a tet4 solid about its own static reference state. Same one-shot owner, abort,
   * supersession and deadlines; a reply for another revision, mesh, load set or digest is refused by re-decoding. */
  analyzeSolidBuckling(value: unknown, options: FemOptions = {}): Promise<FemCompletion<SolidBucklingResult>> {
    let prepared: ReturnType<typeof translateSolidBuckling>;
    try { prepared = translateSolidBuckling(value); }
    catch (error) { this.cancel('superseded'); return Promise.reject(error instanceof Error
      ? error : new Error('Invalid solid buckling input', { cause: error })); }
    const input = prepared.input;
    const identity = this.nextIdentity(input.reference.source.documentId, input.reference.source.revision);
    const expectedHash = solidBucklingInputSha256(input).catch(() => null);
    return this.execute({ protocol: FEM_PROTOCOL, kind: 'analyze-solid-buckling-tet4', identity, input }, options,
      async result => {
        const hash = await expectedHash;
        return hash !== null && solidBucklingResultMatches(result, input, hash) ? result : null;
      });
  }

  /** Solve the current native linear solid, then import one exactly bound element into the existing fatigue path.
   * Conversion stays inside execute's accepted-reply lifetime, retaining abort/supersession and one-shot ownership.
   * No new Worker request or result protocol is invented; fatigue is a local derived calculation, not saved data. */
  async analyzeSolidFatigue(value: unknown, selection: unknown, curve: unknown,
    options: FemOptions = {}): Promise<SolidFatigueCompletion> {
    let input: ReturnType<typeof translateSolidAnalysis>['input'];
    let chosen: ReturnType<typeof readSolidFatigueSelection>;
    let ownedCurve: ReturnType<typeof readFatigueSnCurve>;
    try {
      input = translateSolidAnalysis(value).input;
      chosen = readSolidFatigueSelection(selection);
      ownedCurve = readFatigueSnCurve(curve);
      if ('ok' in chosen) throw new RangeError(`${chosen.code}: ${chosen.path}`);
      if ('ok' in ownedCurve) throw new RangeError(`${ownedCurve.code}: ${ownedCurve.path}`);
    } catch (error) { this.cancel('superseded'); throw error; }
    const identity = this.nextIdentity(input.source.documentId, input.source.revision);
    const expectedHash = solidInputSha256(input).catch(() => null);
    let fatigue: SolidFatigueAnalysis | null = null;
    const completion = await this.execute({ protocol: FEM_PROTOCOL, kind: 'analyze-solid-tet4', identity, input }, options,
      async result => {
        const hash = await expectedHash;
        if (hash === null || !solidResultMatches(result, input, hash)) return null;
        const adapted = await solidFatigueInput(input, result, chosen, ownedCurve);
        if (!adapted.ok) fatigue = adapted;
        else {
          const analyzed = analyzeFatigue(adapted.input);
          fatigue = analyzed.ok ? { ...adapted, result: analyzed.result } : analyzed;
        }
        return result;
      });
    if (completion.kind !== 'result') return completion;
    if (this.disposed || options.signal?.aborted || identity.generation !== this.generation) {
      return { kind: 'cancelled', identity, reason: this.disposed ? 'disposed' : options.signal?.aborted ? 'abort' : 'superseded' };
    }
    if (fatigue === null) return { kind: 'failed', identity,
      failure: { code: 'invalid-protocol', message: 'Solid fatigue derivation missing after accepted native reply' } };
    return { ...completion, fatigue };
  }

  /** Actual native tet4 linear elasticity; uses this client's existing one-shot
   * ownership and deadlines. Explicit supports do not imply contact/weld ties. */
  analyzeSolid(value: unknown, options: FemOptions = {}): Promise<FemCompletion<SolidAnalysisResult>> {
    let prepared: ReturnType<typeof translateSolidAnalysis>;
    try { prepared = translateSolidAnalysis(value); }
    catch (error) { this.cancel('superseded'); return Promise.reject(error instanceof Error
      ? error : new Error('Invalid solid input', { cause: error })); }
    const input = prepared.input;
    const identity = this.nextIdentity(input.source.documentId, input.source.revision);
    const expectedHash = solidInputSha256(input).catch(() => null);
    return this.execute({ protocol: FEM_PROTOCOL, kind: 'analyze-solid-tet4', identity, input }, options,
      async result => {
        const hash = await expectedHash;
        return hash !== null && solidResultMatches(result, input, hash) ? result : null;
      });
  }

  /** Reuses the same one-shot ownership, abort, supersession and 60s/180s deadlines as analysis. */
  meshTetrahedra(value: unknown, options: FemOptions = {}): Promise<FemCompletion<TetraMeshResult>> {
    let input: ReturnType<typeof readTetraMeshInput>;
    try { input = readTetraMeshInput(value); }
    catch (error) { this.cancel('superseded'); return Promise.reject(error instanceof Error
      ? error : new Error('Invalid CAD mesh input', { cause: error })); }
    const identity = this.nextIdentity(input.source.documentId, input.source.revision);
    const expectedHash = tetraMeshInputSha256(input).catch(() => null);
    return this.execute({ protocol: FEM_PROTOCOL, kind: 'mesh-cad-convex-tetra', identity, input }, options,
      async result => {
        const hash = await expectedHash;
        if (hash === null || !tetraMeshResultMatches(result, input, hash)) return null;
        if (input.meshing !== undefined && !diagnoseTetraMeshQuality(result, input.meshing.quality).meetsRequestedLimits)
          throw new Error('tetra-mesh: native result does not meet the explicit meshing quality target');
        return result;
      });
  }

  /** Explicit geometric diagnostics; the existing meshing contract and failure/cancel variants are unchanged. */
  async meshTetrahedraWithQuality(value: unknown, requested: TetraMeshQualityLimits,
    options: FemOptions = {}): Promise<TetraMeshQualityCompletion> {
    let limits: TetraMeshQualityLimits;
    try { limits = readTetraMeshQualityLimits(requested); }
    catch (error) { this.cancel('superseded'); throw error; }
    const completion = await this.meshTetrahedra(value, options);
    if (completion.kind !== 'result') return completion;
    return { ...completion, quality: diagnoseTetraMeshQuality(completion.result, limits) };
  }

  async qualify(documentId: string, revision: number, options: FemOptions = {}): Promise<FemCompletion> {
    const identity=this.nextIdentity(documentId,revision);
    return this.execute({protocol:FEM_PROTOCOL,kind:'qualify-oofem-beam',identity},options,
      result=>Promise.resolve(isBeamProof(result)?result:null));
  }
  analyze(value: unknown, options: FemOptions = {}): Promise<FemCompletion<BeamAnalysisResult>> {
    // Translation validates and owns fresh values before the caller can mutate them.
    let prepared: ReturnType<typeof translateBeamAnalysis>;
    try {
      prepared=translateBeamAnalysis(value);
      if (prepared.document.modal !== undefined) throw new Error('Static analysis requires schema 1');
    }
    catch(error) { this.cancel('superseded'); return Promise.reject(error instanceof Error
      ? error : new Error('Invalid static beam input', { cause: error })); }
    const document=prepared.document;
    const identity=this.nextIdentity(document.source.documentId,document.revision);
    // Attach failure handling immediately even if the Worker is cancelled first.
    const expectedHash=beamInputSha256(document).catch(()=>null);
    return this.execute({protocol:FEM_PROTOCOL,kind:'analyze-beam-3d',identity,document},options,
      async result=>{
        const hash=await expectedHash;
        return hash!==null&&beamResultMatches(result,document,hash)?result:null;
      });
  }
  analyzeModal(value: unknown, options: FemOptions = {}): Promise<FemCompletion<BeamModalResult>> {
    let prepared: ReturnType<typeof translateBeamModal>;
    try { prepared = translateBeamModal(value); }
    catch (error) { this.cancel('superseded'); return Promise.reject(error instanceof Error
      ? error : new Error('Invalid modal beam input', { cause: error })); }
    const document = prepared.document;
    const identity = this.nextIdentity(document.source.documentId, document.revision);
    const expectedHash = beamInputSha256(document).catch(() => null);
    return this.execute({ protocol: FEM_PROTOCOL, kind: 'analyze-beam-modal-3d', identity, document }, options,
      async result => {
        const hash = await expectedHash;
        return hash !== null && modalResultMatches(result, document, hash) ? result : null;
      });
  }
  analyzeBuckling(value: unknown, options: FemOptions = {}): Promise<FemCompletion<BeamBucklingResult>> {
    let prepared: ReturnType<typeof translateBeamBuckling>;
    try { prepared = translateBeamBuckling(value); }
    catch (error) { this.cancel('superseded'); return Promise.reject(error instanceof Error
      ? error : new Error('Invalid buckling input', { cause: error })); }
    const input = prepared.input;
    const identity = this.nextIdentity(input.geometry.source.documentId, input.geometry.revision);
    const expectedHash = bucklingInputSha256(input).catch(() => null);
    return this.execute({ protocol: FEM_PROTOCOL, kind: 'analyze-beam-buckling-3d', identity, input }, options,
      async result => {
        const hash = await expectedHash;
        return hash !== null && bucklingResultMatches(result, input, hash) ? result : null;
      });
  }
  /** Undamped linear response from rest. A newer request supersedes this one; its late reply is ignored. */
  analyzeTransient(value: unknown, options: FemOptions = {}): Promise<FemCompletion<BeamTransientResult>> {
    let prepared: ReturnType<typeof translateBeamTransient>;
    try { prepared = translateBeamTransient(value); }
    catch (error) { this.cancel('superseded'); return Promise.reject(error instanceof Error
      ? error : new Error('Invalid transient input', { cause: error })); }
    const input = prepared.input;
    const identity = this.nextIdentity(input.geometry.source.documentId, input.geometry.revision);
    const expectedHash = transientInputSha256(input).catch(() => null);
    return this.execute({ protocol: FEM_PROTOCOL, kind: 'analyze-beam-transient-3d', identity, input }, options,
      async result => {
        const hash = await expectedHash;
        return hash !== null && transientResultMatches(result, input, hash) ? result : null;
      });
  }
  /** Native OOFEM MisesMat member under end-displacement control. Supersedes any earlier request; a result for
   * another plan, digest or document revision is rejected, and abort/dispose terminate the Worker. */
  analyzePlasticBar(value: unknown, options: FemOptions = {}): Promise<FemCompletion<PlasticBarResult>> {
    let prepared: ReturnType<typeof translatePlasticBar>;
    try { prepared = translatePlasticBar(value); }
    catch (error) { this.cancel('superseded'); return Promise.reject(error instanceof Error
      ? error : new Error('Invalid plastic-bar input', { cause: error })); }
    const input = prepared.input;
    const identity = this.nextIdentity(input.source.documentId, input.source.revision);
    const expectedHash = plasticBarInputSha256(input).catch(() => null);
    return this.execute({ protocol: FEM_PROTOCOL, kind: 'analyze-plastic-bar-1d', identity, input }, options,
      async result => {
        const hash = await expectedHash;
        return hash !== null && plasticBarResultMatches(result, input, hash) ? result : null;
      });
  }
  /** Frictionless unilateral node-plane / node-pair contact on the native Beam3d stiffness (explicit NumPy
   * complementarity solve, not an OOFEM contact engine). Supersedes any earlier request; a result for another
   * plan, digest or document revision is rejected, and abort/dispose terminate the Worker. */
  analyzeContact(value: unknown, options: FemOptions = {}): Promise<FemCompletion<BeamContactAnalysisResult>> {
    let prepared: ReturnType<typeof translateBeamContact>;
    try { prepared = translateBeamContact(value); }
    catch (error) { this.cancel('superseded'); return Promise.reject(error instanceof Error
      ? error : new Error('Invalid contact input', { cause: error })); }
    const input = prepared.input;
    const identity = this.nextIdentity(input.geometry.source.documentId, input.geometry.revision);
    const expectedHash = contactInputSha256(input).catch(() => null);
    return this.execute({ protocol: FEM_PROTOCOL, kind: 'analyze-beam-contact-3d', identity, input }, options,
      async result => {
        const hash = await expectedHash;
        return hash !== null && contactResultMatches(result, input, hash) ? result : null;
      });
  }
  /** Same one-shot owner, cancellation, identity and deadlines as the existing contact solve. */
  analyzeBoltContact(value: unknown, options: FemOptions = {}): Promise<FemCompletion<BeamBoltContactResult>> {
    let prepared: ReturnType<typeof translateBeamBoltContact>;
    try { prepared = translateBeamBoltContact(value); }
    catch (error) { this.cancel('superseded'); return Promise.reject(error instanceof Error
      ? error : new Error('Invalid bolt-contact input', { cause: error })); }
    const input = prepared.input;
    const identity = this.nextIdentity(input.contact.geometry.source.documentId, input.contact.geometry.revision);
    const expectedHash = beamBoltContactInputSha256(input).catch(() => null);
    return this.execute({ protocol: FEM_PROTOCOL, kind: 'analyze-beam-bolt-contact', identity, input }, options,
      async result => {
        const hash = await expectedHash;
        return hash !== null && beamBoltContactResultMatches(result, input, hash) ? result : null;
      });
  }
  analyzeWeldContact(value: unknown, options: FemOptions = {}): Promise<FemCompletion<BeamWeldContactResult>> {
    let prepared: ReturnType<typeof translateBeamWeldContact>;
    try { prepared = translateBeamWeldContact(value); }
    catch (error) { this.cancel('superseded'); return Promise.reject(error instanceof Error
      ? error : new Error('Invalid weld-contact input', { cause: error })); }
    const input = prepared.input;
    const identity = this.nextIdentity(input.contact.geometry.source.documentId, input.contact.geometry.revision);
    const expectedHash = beamWeldContactInputSha256(input).catch(() => null);
    return this.execute({ protocol: FEM_PROTOCOL, kind: 'analyze-beam-weld-contact', identity, input }, options,
      async result => {
        const hash = await expectedHash;
        return hash !== null && beamWeldContactResultMatches(result, input, hash) ? result : null;
      });
  }
  /** 専用frame入力を先に所有し、既存executeの取消・期限・4値identity照合を共有する。 */
  analyzeFrameBoltContact(value: unknown, options: FemOptions = {}): Promise<FemCompletion<FrameBoltContactResult>> {
    let prepared: ReturnType<typeof readFrameBoltContact>;
    try { prepared = readFrameBoltContact(value); }
    catch (error) { this.cancel('superseded'); return Promise.reject(error instanceof Error
      ? error : new Error('Invalid frame-bolt input', { cause: error })); }
    const input = prepared.input;
    const identity = this.nextIdentity(input.contact.geometry.source.documentId, input.contact.geometry.revision);
    const expectedHash = frameBoltContactInputSha256(input).catch(() => null);
    return this.execute({ protocol: FEM_PROTOCOL, kind: 'analyze-frame-bolt-contact', identity, input }, options,
      async result => {
        const hash = await expectedHash;
        return hash !== null && frameBoltContactResultMatches(result, input, hash) ? result : null;
      });
  }
  /** Both connector families share this one request, input digest, owner and cancellation lifecycle. */
  analyzeJointContact(value: unknown, options: FemOptions = {}): Promise<FemCompletion<BeamJointContactResult>> {
    let prepared: ReturnType<typeof translateBeamJointContact>;
    try { prepared = translateBeamJointContact(value); }
    catch (error) { this.cancel('superseded'); return Promise.reject(error instanceof Error
      ? error : new Error('Invalid mixed joint-contact input', { cause: error })); }
    const input = prepared.input;
    const identity = this.nextIdentity(input.contact.geometry.source.documentId, input.contact.geometry.revision);
    const expectedHash = beamJointContactInputSha256(input).catch(() => null);
    return this.execute({ protocol: FEM_PROTOCOL, kind: 'analyze-beam-joint-contact', identity, input }, options,
      async result => {
        const hash = await expectedHash;
        return hash !== null && beamJointContactResultMatches(result, input, hash) ? result : null;
      });
  }
  /** Explicit numeric-plan source ownership; no CAD provenance is inferred by this low-level entry. */
  analyzeNativeBoltPreload(value: unknown, options: FemOptions = {}): Promise<FemCompletion<NativeBoltPreloadOwnedResult>> {
    let wire: ReturnType<typeof readNativeBoltPreloadWireInput>;
    try { wire = readNativeBoltPreloadWireInput(value); }
    catch (error) { this.cancel('superseded'); return Promise.reject(error instanceof Error ? error : new Error('Invalid native preload input', { cause: error })); }
    // Reserve this generation before asynchronous hashing, so older preparation cannot supersede a newer request.
    const identity = this.nextIdentity(wire.source.documentId, wire.source.revision);
    return prepareNativeBoltPreloadJob(wire).then<FemCompletion<NativeBoltPreloadOwnedResult>>(job => {
      if (this.disposed || options.signal?.aborted || identity.generation !== this.generation) {
        return { kind: 'cancelled', identity, reason: this.disposed ? 'disposed' : options.signal?.aborted ? 'abort' : 'superseded' };
      }
      // Only plain source/plan data crosses the Worker boundary; no prepared/verified WeakSet token.
      return this.execute({ protocol: FEM_PROTOCOL, kind: 'analyze-native-bolt-preload', identity,
        input: { source: job.source, plan: job.prepared.plan } }, options,
        result => Promise.resolve(nativeBoltPreloadOwnedMatches(result, job)));
    });
  }
  /** Initial strain is part of the same owned request and digest, independent of the external load factor. */
  analyzeJointInitialStrain(value: unknown, options: FemOptions = {}): Promise<FemCompletion<BeamJointInitialStrainResult>> {
    let prepared: ReturnType<typeof translateBeamJointInitialStrain>;
    try { prepared = translateBeamJointInitialStrain(value); }
    catch (error) { this.cancel('superseded'); return Promise.reject(error instanceof Error
      ? error : new Error('Invalid joint initial-strain input', { cause: error })); }
    const input = prepared.input;
    const identity = this.nextIdentity(input.joint.contact.geometry.source.documentId, input.joint.contact.geometry.revision);
    const expectedHash = beamJointInitialStrainInputSha256(input).catch(() => null);
    return this.execute({ protocol: FEM_PROTOCOL, kind: 'analyze-beam-joint-initial-strain', identity, input }, options,
      async result => {
        const hash = await expectedHash;
        return hash !== null && beamJointInitialStrainResultMatches(result, input, hash) ? result : null;
      });
  }
  /** Elastic frictionless normal fixed-plane impact; the reply must re-decode exactly for this input and digest. */
  analyzeBeamImpact(value: unknown, options: FemOptions = {}): Promise<FemCompletion<BeamImpactResult>> {
    let prepared: ReturnType<typeof translateBeamImpact>;
    try { prepared = translateBeamImpact(value); }
    catch (error) { this.cancel('superseded'); return Promise.reject(error instanceof Error
      ? error : new Error('Invalid beam impact input', { cause: error })); }
    const input = prepared.input;
    const identity = this.nextIdentity(input.geometry.source.documentId, input.geometry.revision);
    const expectedHash = impactInputSha256(input).catch(() => null);
    return this.execute({ protocol: FEM_PROTOCOL, kind: 'analyze-beam-impact-3d', identity, input }, options,
      async result => {
        const hash = await expectedHash;
        return hash !== null && beamImpactResultMatches(result, input, hash) ? result : null;
      });
  }
  private nextIdentity(documentId:string,revision:number):FemIdentity {
    this.cancel('superseded');
    const identity = { documentId, revision, generation: ++this.generation, requestId: `fem-${this.generation}` };
    if (!isIdentity(identity)) throw new Error('Invalid FEM document identity');
    return identity;
  }
  private execute<R extends FemResult>(request:FemRequest, options:FemOptions,
    accept:(result:FemResult)=>Promise<R|null>):Promise<FemCompletion<R>> {
    const identity=request.identity;
    if (this.disposed || options.signal?.aborted) return Promise.resolve({ kind: 'cancelled', identity,
      reason: this.disposed ? 'disposed' : 'abort' });
    let worker: FemWorkerPort;
    try { worker = this.createWorker(); }
    catch (error) { return Promise.resolve({ kind: 'failed', identity, failure: { code: 'worker-failed',
      message: error instanceof Error ? error.message.slice(0, 4096) : 'Worker creation failed' } }); }
    return new Promise(resolve => {
      let finished = false;
      let solving = false;
      let solvingTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (completion: FemCompletion<R>): void => {
        if (finished) return;
        finished = true;
        clearTimeout(totalTimer);
        if (solvingTimer !== undefined) clearTimeout(solvingTimer);
        options.signal?.removeEventListener('abort', abort);
        worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
        try { worker.terminate(); }
        finally { if (this.active?.identity === identity) this.active = null; resolve(completion); }
      };
      const fail = (code: FemFailure['code'], message: string): void => finish({ kind: 'failed', identity,
        failure: { code, message: message.slice(0, 4096) || 'FEM runtime failed' } });
      const abort = (): void => finish({ kind: 'cancelled', identity, reason: 'abort' });
      const totalTimer = setTimeout(() => fail('deadline', 'FEM initialization/analysis exceeded 180000 ms'), 180_000);
      this.active = { identity, worker, cancel: reason=>finish({kind:'cancelled',identity,reason}) };
      worker.onmessage = event => {
        if (finished || this.active?.identity !== identity) return;
        if (!isReply(event.data)) { fail('invalid-protocol', 'Invalid FEM response or numerical assertion'); return; }
        if (!sameIdentity(event.data.identity, identity)) {
          fail('invalid-protocol', 'FEM response does not match the current document, revision, generation and request'); return;
        }
        if (event.data.kind === 'phase') {
          if (event.data.phase === 'solving' && !solving) {
            solving = true;
            solvingTimer = setTimeout(() => fail('deadline', 'FEM solve exceeded 60000 ms'), 60_000);
          }
          try { options.onPhase?.(event.data.phase); }
          catch (error) { fail('worker-failed', error instanceof Error ? error.message : 'FEM phase observer failed'); }
        } else if (event.data.kind === 'failure') finish({ kind: 'failed', identity, failure: event.data.failure });
        else void accept(event.data.result).then(result=>{
          if(finished || this.active?.identity!==identity) return;
          if(result===null) fail('invalid-protocol','Analysis kind, input digest, source revision or result association differs');
          else finish({kind:'result',identity,result});
        }).catch((error:unknown)=>fail('invalid-protocol',error instanceof Error?error.message:'Result validation failed'));
      };
      worker.onerror = event => fail('worker-failed', event.message || 'FEM Worker error');
      worker.onmessageerror = () => fail('invalid-protocol', 'FEM Worker response cannot be decoded');
      options.signal?.addEventListener('abort', abort, { once: true });
      // Covers an abort between the first check and installing the listener.
      if (options.signal?.aborted) { abort(); return; }
      try { worker.postMessage(request); }
      catch (error) { fail('worker-failed', error instanceof Error ? error.message : 'FEM request failed'); }
    });
  }
  private cancel(reason: 'superseded' | 'disposed'): void {
    const active = this.active;
    if (active !== null) active.cancel(reason);
  }
  dispose(): void { this.disposed = true; this.cancel('disposed'); }
}
