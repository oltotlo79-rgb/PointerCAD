import type { AnalysisSource, BeamAnalysisDocument, Vector3 } from './analysisModel.js';
import type { BeamImpactInterior } from './beamImpactInterior.js';
import type { BucklingRestraints } from './bucklingModel.js';

/**
 * Bounded beam impact (task130). Scope, stated in every contract that uses it: linear elastic small-displacement
 * native beam3d K and M (+ rotary inertia), frictionless compliant normal contact of original CAD nodes against fixed
 * planes (phi = k min(g, 0)^2 / 2), undamped, no restitution coefficient, zero external load, zero initial
 * displacement, explicit midpoint/discrete-gradient integration in NumPy. Not plastic impact, not free-body motion
 * (supports must remove every rigid mode), not general or body-to-body contact, not friction.
 */
export const BEAM_IMPACT_SCOPE = 'elastic-frictionless-normal-fixed-plane' as const;
export const IMPACT_MAXIMUM_STEPS = 4000;
export const IMPACT_MAXIMUM_OUTPUT_SAMPLES = 101;
export const IMPACT_MAXIMUM_CONTACTS = 64;

/** Translations of an original CAD node in m/s on the global axes; rotations start at rest. */
export interface BeamImpactInitialVelocity {
  readonly nodeId: string;
  readonly velocityMPerS: Vector3;
}

/** A fixed plane facing an original CAD node: gap g = gapM - directionUnit . u(node), contact while g < 0. */
export interface BeamImpactContact {
  readonly nodeId: string;
  readonly directionUnit: Vector3;
  readonly gapM: number;
}

export interface BeamImpactHistory {
  readonly timeStepS: number;
  readonly stepCount: number;
  readonly outputEvery: number;
}

export interface BeamImpactSupport {
  readonly nodeId: string;
  readonly restrained: BucklingRestraints;
}

export interface BeamImpactInput {
  readonly schema: 'pointercad-beam-impact/1';
  readonly geometry: BeamAnalysisDocument;
  readonly supports: readonly BeamImpactSupport[];
  readonly initialVelocities: readonly BeamImpactInitialVelocity[];
  readonly contacts: readonly BeamImpactContact[];
  readonly contactStiffnessNPerM: number;
  readonly history: BeamImpactHistory;
}

export interface BeamImpactNodeSample {
  readonly solverNode: number;
  readonly nodeId: string;
  readonly displacementM: Vector3;
  readonly rotationRad: Vector3;
  readonly velocityMPerS: Vector3;
  readonly angularVelocityRadPerS: Vector3;
}

export interface BeamImpactContactSample {
  readonly nodeId: string;
  readonly gapM: number;
  /** Secant force over the interval ending at this sample (N, compressive positive); null at time 0. */
  readonly intervalForceN: number | null;
  readonly impulseNs: number | null;
}

export interface BeamImpactSample {
  readonly step: number;
  readonly timeS: number;
  readonly energyJ: number;
  readonly nodes: readonly BeamImpactNodeSample[];
  readonly contacts: readonly BeamImpactContactSample[];
}

export interface BeamImpactContactPeak {
  readonly nodeId: string;
  readonly intervalForceN: number;
  readonly timeS: number;
  readonly totalImpulseNs: number;
}

/** Same identity and certification conventions as BeamTransientResult (transientModel.ts). */
export interface BeamImpactResult {
  readonly kind: 'oofem-beam-impact-3d';
  readonly method: 'oofem-beam3d-matrices-midpoint-discrete-gradient-contact/1';
  readonly scope: typeof BEAM_IMPACT_SCOPE;
  readonly nativeImpactSolver: false;
  readonly analysisId: string;
  readonly analysisRevision: number;
  readonly source: AnalysisSource;
  readonly inputSha256: string;
  readonly timeStepS: number;
  readonly stepCount: number;
  readonly normalizationLengthM: number;
  readonly samples: readonly BeamImpactSample[];
  readonly contactPeaks: readonly BeamImpactContactPeak[];
  readonly initialEnergyJ: number;
  readonly maximumEnergyBalanceError: number;
  readonly maximumMomentumResidual: number;
  readonly factorizationsUsed: number;
  readonly freeDofs: number;
  readonly meshNodes: number;
  readonly meshElements: number;
  /** Present only when the reply carried the solver mesh fields (beamImpact.py with element blocks); every mesh node at
   * every emitted sample and every element's native global block, decoded by decodeImpactInterior. */
  readonly interior?: BeamImpactInterior;
  readonly structuralCertification: false;
}
