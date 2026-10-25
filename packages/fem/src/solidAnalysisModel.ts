import type { AnalysisMaterialCapacity } from '@pointercad/model/beam-analysis';

/** Small-strain, static, isotropic linear elasticity. All lengths are mm,
 * forces N, Young's modulus/stress/traction N/mm^2 (MPa). No implicit ties. */
export type SolidVector3 = readonly [number, number, number];
export type SolidVector6 = readonly [number, number, number, number, number, number];
export interface SolidSource {
  readonly documentId: string;
  readonly revision: number;
  readonly meshKey: string;
}
export interface SolidMaterial {
  readonly id: string;
  readonly youngMPa: number;
  readonly poisson: number;
  readonly capacity?: AnalysisMaterialCapacity;
}
export interface SolidTet4 {
  /** Zero-based node indices; positive determinant in the supplied order. */
  readonly nodes: readonly [number, number, number, number];
  readonly materialId: string;
}
export interface SolidAnalysisInput {
  readonly schema: 'pointercad-solid-tet4/1';
  readonly source: SolidSource;
  readonly units: 'N-mm-MPa';
  /** Caller reservation, compatible with AssemblyTetraBudget.numericBytes.
   * Counts retained numeric payload/native arrays, not JS/Python heap or GPU. */
  readonly numericBudgetBytes: number;
  readonly nodes: readonly SolidVector3[];
  readonly elements: readonly SolidTet4[];
  readonly materials: readonly SolidMaterial[];
  readonly constraints: readonly {
    readonly node: number;
    /** Exactly three translations; true prescribes zero displacement. */
    readonly fixed: readonly [boolean, boolean, boolean];
  }[];
  readonly nodalLoads: readonly { readonly node: number; readonly forceN: SolidVector3 }[];
  /** A boundary triangle of exactly one element. The supplied global traction
   * acts on the material, independent of triangle winding; consistent nodal
   * load is traction * area / 3 at each of its three nodes. */
  readonly surfaceLoads: readonly {
    readonly nodes: readonly [number, number, number];
    readonly tractionMPa: SolidVector3;
  }[];
}
export interface SolidAnalysisPlan {
  readonly schema: 'pointercad-solid-tet4-plan/1';
  readonly input: SolidAnalysisInput;
  readonly forcesN: readonly SolidVector3[];
  readonly fixed: readonly (readonly [boolean, boolean, boolean])[];
}
export interface SolidElementResult {
  /** Engineering strains: xx, yy, zz, yz, xz, xy. */
  readonly strain: SolidVector6;
  /** Cauchy stresses in MPa: xx, yy, zz, yz, xz, xy. */
  readonly stressMPa: SolidVector6;
}
export interface SolidAnalysisResult {
  readonly kind: 'oofem-linear-solid-tet4';
  readonly source: SolidSource;
  readonly inputSha256: string;
  readonly method: 'oofem-ltrspace-isole-native-ldlt/1';
  readonly units: 'N-mm-MPa';
  readonly structuralCertification: false;
  readonly displacementMm: readonly SolidVector3[];
  /** Support force on material; internal force minus applied force. Zero on
   * unrestrained DOFs. No beam rotations, reactions or moments are invented. */
  readonly reactionN: readonly SolidVector3[];
  readonly elements: readonly SolidElementResult[];
  readonly strainEnergyNmm: number;
  readonly maximumRelativeEquilibriumResidual: number;
  readonly reservedNumericBytes: number;
  /** Original native K_e u_e, three global force components per element node. */
  readonly nativeElementForcesN: readonly (readonly number[])[];
  /** Smallest D pivot after symmetric diagonal scaling; not a condition number. */
  readonly minimumScaledPivot: number;
}
