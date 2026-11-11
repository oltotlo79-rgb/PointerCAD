import type { AnalysisSource, BeamAnalysisDocument, BeamNodalLoad, BeamTransientHistory,
  BeamTransientLoadFactorSample, Vector3 } from './analysisModel.js';
import type { BucklingRestraints } from './bucklingModel.js';

/** History types are the saved CAD input types of the model package (single canonical decoder). */
export type TransientLoadFactorSample = BeamTransientLoadFactorSample;
export type TransientHistory = BeamTransientHistory;
/** Independent core input, not a new saved CAD schema. Geometry, supports and reference
 * loads follow the buckling input exactly (unloaded unrestrained schema-2 snapshot whose
 * modal settings give the mesh refinement; zero prescribed global [u,v,w,rx,ry,rz]).
 * The reference loads are multiplied by the load factor of the history at each time.
 */
export interface BeamTransientInput {
  readonly schema: 'pointercad-beam-transient/1';
  readonly geometry: BeamAnalysisDocument;
  readonly supports: readonly { readonly nodeId: string; readonly restrained: BucklingRestraints }[];
  readonly referenceLoads: readonly BeamNodalLoad[];
  readonly history: TransientHistory;
}
/** Response of one original (CAD) node. Translations in m, m/s, m/s2; rotations in rad, rad/s, rad/s2. */
export interface TransientNodeResponse {
  readonly solverNode: number;
  readonly nodeId: string;
  readonly displacementM: Vector3;
  readonly rotationRad: Vector3;
  readonly velocityMPerS: Vector3;
  readonly angularVelocityRadPerS: Vector3;
  readonly accelerationMPerS2: Vector3;
  readonly angularAccelerationRadPerS2: Vector3;
}
export interface TransientSample {
  readonly timeS: number;
  readonly loadFactor: number;
  readonly nodes: readonly TransientNodeResponse[];
}
interface BeamTransientResultBase {
  readonly kind: 'oofem-beam-transient-3d';
  /** Native OOFEM beam3d K and M; the time integration is an explicit NumPy procedure. */
  readonly nativeTransientSolver: false;
  readonly analysisId: string;
  readonly analysisRevision: number;
  readonly source: AnalysisSource;
  readonly inputSha256: string;
  readonly timeStepS: number;
  readonly stepCount: number;
  readonly normalizationLengthM: number;
  readonly meshNodes: number;
  readonly meshElements: number;
  readonly freeDofs: number;
  /** max over steps of |M a + C v + K u - f| / (|M a| + |C v| + |K u| + |f|). */
  readonly maximumEquilibriumResidual: number;
  /** max over steps of |kinetic + strain energy + viscous loss - external work| / max energy/work/loss magnitude. */
  readonly maximumEnergyBalanceError: number;
  /** Largest |u| of one mesh node at one integration step (sampled or not), with that step time and node.
   * Never the norm of component-wise maxima from different times. Zero response: time 0, solver node 1. */
  readonly peakDisplacementM: number;
  readonly peakDisplacementTimeS: number;
  readonly peakDisplacementSolverNode: number;
  /** Largest |theta| of one mesh node at one integration step, defined like the displacement peak. */
  readonly peakRotationRad: number;
  readonly peakRotationTimeS: number;
  readonly peakRotationSolverNode: number;
  readonly samples: readonly TransientSample[];
  readonly structuralCertification: false;
}

/** Legacy undamped replies remain byte-compatible. A damped reply has a distinct method/schema,
 * exact input coefficients and cumulative discrete viscous dissipation in joules. */
export type BeamTransientResult = BeamTransientResultBase & ({
  readonly method: 'oofem-beam3d-matrices-newmark-average-acceleration/1';
  readonly scope: 'linear-elastic-undamped-small-displacement-nodal-loads';
} | {
  readonly method: 'oofem-beam3d-matrices-newmark-average-acceleration/2';
  readonly scope: 'linear-elastic-rayleigh-small-displacement-nodal-loads';
  readonly damping: Exclude<BeamTransientHistory['damping'], 'none'>;
  readonly dissipatedEnergyJ: number;
});
