import type { SolidAnalysisInput, SolidAnalysisPlan, SolidSource, SolidVector3 } from './solidAnalysisModel.js';

/** Linear (bifurcation) prestress buckling of an existing tet4 solid, N-mm-MPa.
 * The reference state is exactly the existing static solid input: its supports
 * apply to the static solve and to the eigenproblem, and all of its loads scale
 * together by the returned positive load factor lambda in (K + lambda Kg) phi = 0,
 * where Kg is the initial-stress matrix of the static Cauchy stress. */
export interface SolidBucklingInput {
  readonly schema: 'pointercad-solid-tet4-buckling/1';
  readonly reference: SolidAnalysisInput;
  /** Lowest positive load factors requested (1..12). */
  readonly modeCount: number;
}
export interface SolidBucklingPlan {
  readonly schema: 'pointercad-solid-tet4-buckling-plan/1';
  readonly input: SolidBucklingInput;
  readonly reference: SolidAnalysisPlan;
  readonly freeDofs: number;
}
export interface SolidBucklingMode {
  readonly number: number;
  /** Dimensionless multiplier of the complete reference load set. */
  readonly loadFactor: number;
  /** ||(K + lambda Kg) phi|| / (||K phi|| + |lambda| ||Kg phi||). */
  readonly normalizedResidual: number;
  /** Shape scaled to a maximum nodal translation norm of exactly 1 (dimensionless). */
  readonly shape: readonly SolidVector3[];
}
export interface SolidBucklingResult {
  readonly kind: 'oofem-solid-tet4-buckling';
  readonly method: 'oofem-ltrspace-initial-stress-eigh/1';
  readonly scope: 'linear-elastic-prestress-bifurcation';
  readonly units: 'N-mm-MPa';
  readonly source: SolidSource;
  readonly inputSha256: string;
  readonly freeDofs: number;
  /** Reference static state: relative free-DOF equilibrium residual of the native solve. */
  readonly referenceEquilibriumResidual: number;
  /** Largest relative difference between a native element Kg and the closed-form tet4 Kg. */
  readonly maximumElementInitialStressError: number;
  readonly modes: readonly SolidBucklingMode[];
  readonly structuralCertification: false;
}
