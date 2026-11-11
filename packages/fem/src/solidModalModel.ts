import type { SolidSource, SolidTet4, SolidVector3 } from './solidAnalysisModel.js';

/** Linear-elastic free vibration of the tet4 solid. Input: lengths mm, E MPa and mass density kg/m^3.
 * The native plan and the result use coherent N-mm-MPa-t-s (t = 1000 kg): eigenvalues 1/s^2, frequencies Hz. */
export interface SolidModalMaterial {
  readonly id: string;
  readonly youngMPa: number;
  readonly poisson: number;
  readonly densityKgM3: number;
}
export interface SolidModalInput {
  readonly schema: 'pointercad-solid-tet4-modal/1';
  readonly source: SolidSource;
  readonly units: 'N-mm-MPa';
  /** Caller reservation; must cover solidModalReservedBytes(nodes.length). */
  readonly numericBudgetBytes: number;
  readonly nodes: readonly SolidVector3[];
  readonly elements: readonly SolidTet4[];
  readonly materials: readonly SolidModalMaterial[];
  /** Empty: free-free (one face-connected solid, six rigid modes removed). Otherwise every component restrained. */
  readonly constraints: readonly {
    readonly node: number;
    /** Exactly three translations; true prescribes zero displacement. */
    readonly fixed: readonly [boolean, boolean, boolean];
  }[];
  readonly modeCount: number;
}
export type SolidModalApplicability = 'supported' | 'free-free';
/** Exactly the solidModal.py plan/2 fields; density already t/mm^3. */
export interface SolidModalPlan {
  readonly schema: 'pointercad-solid-tet4-modal-plan/2';
  readonly source: SolidSource;
  readonly units: 'N-mm-MPa-t-s';
  readonly numericBudgetBytes: number;
  readonly nodes: readonly SolidVector3[];
  readonly elements: readonly SolidTet4[];
  readonly materials: readonly {
    readonly id: string;
    readonly youngMPa: number;
    readonly poisson: number;
    readonly densityTPerMm3: number;
  }[];
  readonly fixed: readonly (readonly [boolean, boolean, boolean])[];
  readonly modeCount: number;
}
export interface SolidModalMode {
  readonly number: number;
  readonly eigenvaluePerSecondSquared: number;
  readonly frequencyHz: number;
  /** Native normalized eigen-residual, at most 1e-8. */
  readonly normalizedResidual: number;
  /** phi with phi^T M phi = 1, M in t: units 1/sqrt(t), a shape and not a displacement. A displacement in mm
   * is phi times a modal amplitude in mm sqrt(t), which free vibration does not determine. Restrained
   * components are exactly 0. One row per input node. */
  readonly massNormalizedShapePerSqrtT: readonly SolidVector3[];
}
export interface SolidModalResult {
  readonly kind: 'oofem-solid-tet4-modal';
  readonly method: 'oofem-ltrspace-isole-consistent-mass-numpy-eigh/1';
  readonly source: SolidSource;
  readonly inputSha256: string;
  readonly units: 'N-mm-MPa-t-s';
  readonly structuralCertification: false;
  readonly applicability: SolidModalApplicability;
  /** Input node positions (mm) and translation restraints, for drawing the shapes. */
  readonly nodes: readonly SolidVector3[];
  readonly fixed: readonly (readonly [boolean, boolean, boolean])[];
  readonly rigidBodyModes: 0 | 6;
  readonly freeDofs: number;
  readonly totalMassT: number;
  readonly modes: readonly SolidModalMode[];
  readonly maximumMassOrthogonalityError: number;
  readonly maximumRigidMotionResidual: number;
  /** Measured difference of every native element mass from the closed-form consistent tet4 mass. */
  readonly maximumElementMassError: number;
  readonly reservedNumericBytes: number;
  /** Recomputed in TypeScript from closed-form CST stiffness and consistent mass, independent of native K/M. */
  readonly independentMaximumResidual: number;
  readonly independentMaximumOrthogonalityError: number;
}
