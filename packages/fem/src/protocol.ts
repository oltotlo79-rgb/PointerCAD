import type { BeamAnalysisDocument, BeamAnalysisResult, BeamModalResult } from './analysisModel.js';
import { isBeamAnalysisResult } from './analysisResults.js';
import { isBeamModalResult } from './modalResults.js';
import type { BeamBucklingInput, BeamBucklingResult } from './bucklingModel.js';
import { isBeamBucklingResult } from './bucklingResults.js';
import { translateBeamBuckling } from './bucklingTranslation.js';
import type { BeamTransientInput, BeamTransientResult } from './transientModel.js';
import { isBeamTransientResult } from './transientResults.js';
import { translateBeamTransient } from './transientTranslation.js';
import { translatePlasticBar, type PlasticBarInput } from './plasticBarTranslation.js';
import { isPlasticBarResult, type PlasticBarResult } from './plasticBarResults.js';
import type { BeamContactInput } from './contactModel.js';
import { isBeamContactResult, type BeamContactAnalysisResult } from './contactResults.js';
import { translateBeamContact } from './contactTranslation.js';
import { translateBeamBoltContact, type BeamBoltContactInput, type BeamBoltContactResult } from './beamBoltContact.js';
import { isBeamBoltContactResult } from './beamBoltContactBinding.js';
import { translateBeamWeldContact, type BeamWeldContactInput, type BeamWeldContactResult } from './beamWeldContact.js';
import { isBeamWeldContactResult } from './beamWeldContactBinding.js';
import { translateBeamJointContact, type BeamJointContactInput, type BeamJointContactResult } from './beamJointContact.js';
import { isBeamJointContactResult } from './beamJointContactBinding.js';
import { translateBeamJointInitialStrain, type BeamJointInitialStrainInput, type BeamJointInitialStrainResult } from './beamJointInitialStrain.js';
import { isBeamJointInitialStrainResult } from './beamJointInitialStrainBinding.js';
import type { BeamImpactInput, BeamImpactResult } from './beamImpactModel.js';
import { translateBeamImpact } from './beamImpactTranslation.js';
import { isBeamImpactResult } from './beamImpactBinding.js';
import { readBeamAnalysis } from './analysisValidation.js';
import { readTetraMeshInput, isTetraMeshResult, type TetraMeshInput, type TetraMeshResult } from './tetraMesh.js';
import type { SolidAnalysisInput, SolidAnalysisResult } from './solidAnalysisModel.js';
import { translateSolidAnalysis } from './solidAnalysisTranslation.js';
import { isSolidAnalysisResult } from './solidAnalysisResults.js';
import { translateSolidPlastic, type SolidPlasticInput } from './solidPlasticTranslation.js';
import { isSolidPlasticResult, type SolidPlasticResult } from './solidPlasticPublicResult.js';
import type { SolidModalInput, SolidModalResult } from './solidModalModel.js';
import { translateSolidModal } from './solidModalTranslation.js';
import { isSolidModalResult } from './solidModalPublicResult.js';
import type { SolidBucklingInput, SolidBucklingResult } from './solidBucklingModel.js';
import { translateSolidBuckling } from './solidBucklingTranslation.js';
import { isSolidBucklingResult } from './solidBucklingPublicResult.js';
/** Isolated runtime and linear analysis; neither certifies a CAD structure. */
export const FEM_PROTOCOL = 'pointercad-fem/1';
export const FEM_RUNTIME_VERSION = '0.29.3';
export const OOFEM_DISTRIBUTION_VERSION = '3.1.dev5+g214b161ed';
export type FemPhase = 'loading-assets' | 'loading-runtime' | 'loading-packages' | 'solving';
export interface FemIdentity {
  readonly documentId: string;
  readonly revision: number;
  readonly generation: number;
  readonly requestId: string;
}
export interface QualificationRequest {
  readonly protocol: typeof FEM_PROTOCOL;
  readonly kind: 'qualify-oofem-beam';
  readonly identity: FemIdentity;
}
export type FemRequest = QualificationRequest | {
  readonly protocol: typeof FEM_PROTOCOL;
  readonly kind: 'analyze-beam-impact-3d';
  readonly identity: FemIdentity;
  readonly input: BeamImpactInput;
} | {
  readonly protocol: typeof FEM_PROTOCOL;
  readonly kind: 'analyze-beam-joint-initial-strain';
  readonly identity: FemIdentity;
  readonly input: BeamJointInitialStrainInput;
} | {
  readonly protocol: typeof FEM_PROTOCOL;
  readonly kind: 'analyze-beam-joint-contact';
  readonly identity: FemIdentity;
  readonly input: BeamJointContactInput;
} | {
  readonly protocol: typeof FEM_PROTOCOL;
  readonly kind: 'analyze-beam-weld-contact';
  readonly identity: FemIdentity;
  readonly input: BeamWeldContactInput;
} | {
  readonly protocol: typeof FEM_PROTOCOL;
  readonly kind: 'analyze-beam-bolt-contact';
  readonly identity: FemIdentity;
  readonly input: BeamBoltContactInput;
} | {
  readonly protocol: typeof FEM_PROTOCOL;
  readonly kind: 'analyze-solid-plastic-tet4';
  readonly identity: FemIdentity;
  readonly input: SolidPlasticInput;
} | {
  readonly protocol: typeof FEM_PROTOCOL;
  readonly kind: 'analyze-solid-modal-tet4';
  readonly identity: FemIdentity;
  readonly input: SolidModalInput;
} | {
  readonly protocol: typeof FEM_PROTOCOL;
  readonly kind: 'analyze-solid-buckling-tet4';
  readonly identity: FemIdentity;
  readonly input: SolidBucklingInput;
} | {
  readonly protocol: typeof FEM_PROTOCOL;
  readonly kind: 'analyze-solid-tet4';
  readonly identity: FemIdentity;
  readonly input: SolidAnalysisInput;
} | {
  readonly protocol: typeof FEM_PROTOCOL;
  readonly kind: 'mesh-cad-convex-tetra';
  readonly identity: FemIdentity;
  readonly input: TetraMeshInput;
} | {
  readonly protocol: typeof FEM_PROTOCOL;
  readonly kind: 'analyze-beam-buckling-3d';
  readonly identity: FemIdentity;
  readonly input: BeamBucklingInput;
} | {
  readonly protocol: typeof FEM_PROTOCOL;
  readonly kind: 'analyze-beam-transient-3d';
  readonly identity: FemIdentity;
  readonly input: BeamTransientInput;
} | {
  readonly protocol: typeof FEM_PROTOCOL;
  readonly kind: 'analyze-plastic-bar-1d';
  readonly identity: FemIdentity;
  readonly input: PlasticBarInput;
} | {
  readonly protocol: typeof FEM_PROTOCOL;
  readonly kind: 'analyze-beam-contact-3d';
  readonly identity: FemIdentity;
  readonly input: BeamContactInput;
} | {
  readonly protocol: typeof FEM_PROTOCOL;
  readonly kind: 'analyze-beam-3d' | 'analyze-beam-modal-3d';
  readonly identity: FemIdentity;
  readonly document: BeamAnalysisDocument;
};
export interface BeamProofResult {
  readonly kind: 'oofem-upstream-test-2';
  readonly purpose: 'runtime-qualification-only';
  readonly pyodideVersion: string;
  readonly pythonVersion: string;
  readonly oofemVersion: string;
  readonly pythonAbi: string;
  readonly u1: number;
  readonly u4: number;
  readonly upstreamAssertionsPassed: true;
  readonly maximumAbsoluteError: number;
}
export type FemFailureCode = 'asset-missing' | 'asset-corrupt' | 'offline-request-denied'
  | 'runtime-initialization' | 'solver-failed' | 'invalid-protocol' | 'worker-failed' | 'deadline';
export interface FemFailure {
  readonly code: FemFailureCode;
  readonly message: string;
}
export type FemResult = BeamProofResult | BeamAnalysisResult | BeamModalResult | BeamBucklingResult
  | BeamTransientResult | PlasticBarResult | BeamContactAnalysisResult | BeamBoltContactResult | BeamWeldContactResult | BeamJointContactResult | BeamJointInitialStrainResult | BeamImpactResult | TetraMeshResult | SolidAnalysisResult | SolidPlasticResult | SolidModalResult | SolidBucklingResult;
export type FemReply =
  | { readonly protocol: typeof FEM_PROTOCOL; readonly kind: 'phase'; readonly identity: FemIdentity; readonly phase: FemPhase }
  | { readonly protocol: typeof FEM_PROTOCOL; readonly kind: 'result'; readonly identity: FemIdentity; readonly result: FemResult }
  | { readonly protocol: typeof FEM_PROTOCOL; readonly kind: 'failure'; readonly identity: FemIdentity; readonly failure: FemFailure };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}
export function isIdentity(value: unknown): value is FemIdentity {
  return isRecord(value) && boundedText(value.documentId, 256) && safeInteger(value.revision)
    && safeInteger(value.generation) && boundedText(value.requestId, 128);
}
export function sameIdentity(left: FemIdentity, right: FemIdentity): boolean {
  return left.documentId === right.documentId && left.revision === right.revision
    && left.generation === right.generation && left.requestId === right.requestId;
}
export function isRequest(value: unknown): value is FemRequest {
  if (!isRecord(value) || value.protocol !== FEM_PROTOCOL || !isIdentity(value.identity)) return false;
  if (value.kind === 'qualify-oofem-beam') return Object.keys(value).length === 3;
  if (value.kind === 'analyze-solid-plastic-tet4') {
    if (Object.keys(value).length !== 4) return false;
    try {
      const input = translateSolidPlastic(value.input).input;
      return input.source.documentId === value.identity.documentId && input.source.revision === value.identity.revision;
    } catch { return false; }
  }
  if (value.kind === 'analyze-solid-modal-tet4') {
    if (Object.keys(value).length !== 4) return false;
    try {
      const input = translateSolidModal(value.input).input;
      return input.source.documentId === value.identity.documentId && input.source.revision === value.identity.revision;
    } catch { return false; }
  }
  if (value.kind === 'analyze-solid-buckling-tet4') {
    if (Object.keys(value).length !== 4) return false;
    try {
      const input = translateSolidBuckling(value.input).input.reference;
      return input.source.documentId === value.identity.documentId && input.source.revision === value.identity.revision;
    } catch { return false; }
  }
  if (value.kind === 'analyze-solid-tet4') {
    if (Object.keys(value).length !== 4) return false;
    try {
      const input = translateSolidAnalysis(value.input).input;
      return input.source.documentId === value.identity.documentId && input.source.revision === value.identity.revision;
    } catch { return false; }
  }
  if (value.kind === 'mesh-cad-convex-tetra') {
    if (Object.keys(value).length !== 4) return false;
    try {
      const input = readTetraMeshInput(value.input);
      return input.source.documentId === value.identity.documentId && input.source.revision === value.identity.revision;
    } catch { return false; }
  }
  if (value.kind === 'analyze-beam-buckling-3d') {
    if (Object.keys(value).length !== 4) return false;
    try {
      const input = translateBeamBuckling(value.input).input;
      return input.geometry.source.documentId === value.identity.documentId
        && input.geometry.revision === value.identity.revision;
    } catch { return false; }
  }
  if (value.kind === 'analyze-beam-transient-3d') {
    if (Object.keys(value).length !== 4) return false;
    try {
      const input = translateBeamTransient(value.input).input;
      return input.geometry.source.documentId === value.identity.documentId
        && input.geometry.revision === value.identity.revision;
    } catch { return false; }
  }
  if (value.kind === 'analyze-plastic-bar-1d') {
    if (Object.keys(value).length !== 4) return false;
    try {
      const input = translatePlasticBar(value.input).input;
      return input.source.documentId === value.identity.documentId
        && input.source.revision === value.identity.revision;
    } catch { return false; }
  }
  if (value.kind === 'analyze-beam-impact-3d') {
    if (Object.keys(value).length !== 4) return false;
    try {
      const input = translateBeamImpact(value.input).input;
      return input.geometry.source.documentId === value.identity.documentId
        && input.geometry.revision === value.identity.revision;
    } catch { return false; }
  }
  if (value.kind === 'analyze-beam-joint-initial-strain') {
    if (Object.keys(value).length !== 4) return false;
    try {
      const input = translateBeamJointInitialStrain(value.input).input;
      return input.joint.contact.geometry.source.documentId === value.identity.documentId
        && input.joint.contact.geometry.revision === value.identity.revision;
    } catch { return false; }
  }
  if (value.kind === 'analyze-beam-joint-contact') {
    if (Object.keys(value).length !== 4) return false;
    try {
      const input = translateBeamJointContact(value.input).input;
      return input.contact.geometry.source.documentId === value.identity.documentId
        && input.contact.geometry.revision === value.identity.revision;
    } catch { return false; }
  }
  if (value.kind === 'analyze-beam-weld-contact') {
    if (Object.keys(value).length !== 4) return false;
    try {
      const input = translateBeamWeldContact(value.input).input;
      return input.contact.geometry.source.documentId === value.identity.documentId
        && input.contact.geometry.revision === value.identity.revision;
    } catch { return false; }
  }
  if (value.kind === 'analyze-beam-bolt-contact') {
    if (Object.keys(value).length !== 4) return false;
    try {
      const input = translateBeamBoltContact(value.input).input;
      return input.contact.geometry.source.documentId === value.identity.documentId
        && input.contact.geometry.revision === value.identity.revision;
    } catch { return false; }
  }
  if (value.kind === 'analyze-beam-contact-3d') {
    if (Object.keys(value).length !== 4) return false;
    try {
      const input = translateBeamContact(value.input).input;
      return input.geometry.source.documentId === value.identity.documentId
        && input.geometry.revision === value.identity.revision;
    } catch { return false; }
  }
  if ((value.kind !== 'analyze-beam-3d' && value.kind !== 'analyze-beam-modal-3d') || Object.keys(value).length !== 4) return false;
  const checked = readBeamAnalysis(value.document);
  return checked.ok && checked.document.source.documentId === value.identity.documentId
    && checked.document.revision === value.identity.revision
    && (value.kind === 'analyze-beam-modal-3d') === (checked.document.modal !== undefined);
}
export function isBeamProof(value: unknown): value is BeamProofResult {
  if (!isRecord(value) || value.kind !== 'oofem-upstream-test-2'
    || value.purpose !== 'runtime-qualification-only' || value.pyodideVersion !== FEM_RUNTIME_VERSION
    || value.oofemVersion !== OOFEM_DISTRIBUTION_VERSION || !boundedText(value.pythonVersion, 128)
    || !value.pythonVersion.startsWith('3.13.') || !boundedText(value.pythonAbi, 128)
    || !value.pythonAbi.includes('313') || value.upstreamAssertionsPassed !== true
    || typeof value.u1 !== 'number' || !Number.isFinite(value.u1)
    || typeof value.u4 !== 'number' || !Number.isFinite(value.u4)
    || typeof value.maximumAbsoluteError !== 'number' || !Number.isFinite(value.maximumAbsoluteError)) return false;
  const error = Math.max(Math.abs(value.u1 + 8.64000000e-4), Math.abs(value.u4 - 9.47333333e-4));
  // The original uses round(error, 8) == 0; strictly less than half a last place
  // is at least as strict and avoids a JS/Python tie-breaking discrepancy.
  return error < 5e-9 && value.maximumAbsoluteError === error;
}
const phases: readonly string[] = ['loading-assets', 'loading-runtime', 'loading-packages', 'solving'];
const failures: readonly string[] = ['asset-missing', 'asset-corrupt', 'offline-request-denied',
  'runtime-initialization', 'solver-failed', 'invalid-protocol', 'worker-failed', 'deadline'];
export function isReply(value: unknown): value is FemReply {
  if (!isRecord(value) || value.protocol !== FEM_PROTOCOL || !isIdentity(value.identity)) return false;
  if (value.kind === 'phase') return typeof value.phase === 'string' && phases.includes(value.phase);
  if (value.kind === 'result') return isBeamProof(value.result) || isBeamAnalysisResult(value.result) || isBeamModalResult(value.result) || isBeamBucklingResult(value.result)
    || isBeamTransientResult(value.result) || isPlasticBarResult(value.result) || isBeamContactResult(value.result)
    || isBeamBoltContactResult(value.result)
    || isBeamWeldContactResult(value.result)
    || isBeamJointContactResult(value.result)
    || isBeamJointInitialStrainResult(value.result)
    || isBeamImpactResult(value.result)
    || isTetraMeshResult(value.result) || isSolidAnalysisResult(value.result) || isSolidPlasticResult(value.result) || isSolidModalResult(value.result) || isSolidBucklingResult(value.result);
  return value.kind === 'failure' && isRecord(value.failure) && typeof value.failure.code === 'string'
    && failures.includes(value.failure.code) && boundedText(value.failure.message, 4096);
}
