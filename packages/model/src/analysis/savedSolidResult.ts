/** Stored value contracts. The solver supplies these values structurally. */
type SolidVector3 = readonly [number, number, number];

type SolidVector6 = readonly [number, number, number, number, number, number];

interface SolidSource {
  readonly documentId: string;
  readonly revision: number;
  readonly meshKey: string;
}

interface SolidElementResult {
  /** Engineering strains: xx, yy, zz, yz, xz, xy. */
  readonly strain: SolidVector6;
  /** Cauchy stresses in MPa: xx, yy, zz, yz, xz, xy. */
  readonly stressMPa: SolidVector6;
}

interface SolidAnalysisResult {
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
  /** Optional native support forces, independently checked against reactionN.
   * Sum with all applied forces (including gravity) to obtain zero. */
  readonly reactionsN?: readonly SolidVector3[];
  readonly elements: readonly SolidElementResult[];
  readonly strainEnergyNmm: number;
  readonly maximumRelativeEquilibriumResidual: number;
  readonly reservedNumericBytes: number;
  /** Original native K_e u_e, three global force components per element node. */
  readonly nativeElementForcesN: readonly (readonly number[])[];
  /** Smallest D pivot after symmetric diagonal scaling; not a condition number. */
  readonly minimumScaledPivot: number;
}

interface PlcShell {
  readonly role: 'outer' | 'cavity';
  readonly triangles: readonly number[];
}

interface TetraMeshSource {
  readonly documentId: string;
  readonly revision: number;
  readonly featureId: string;
  readonly bodyKey: string;
}

interface TetraMeshingControls {
  /** Native maxh sizing parameter in mm; fixed boundary edges are not subdivided. */
  readonly targetSizeMm: number;
  /** Positive local sizing-field grading, at most one. */
  readonly grading: number;
  /** Zero to three actual move/swap optimization passes, only while the target is unmet. */
  readonly maximumOptimizationPasses: number;
  /** One to boundaryNodes owned local restrictions, in mm; absent keeps the native default field. */
  readonly localSizeConstraints?: readonly {
    readonly positionMm: readonly [number, number, number];
    readonly targetSizeMm: number;
  }[];
  readonly quality: {
    readonly minimumMeanRatio: number;
    readonly maximumEdgeRatio: number;
  };
}

interface TetraMeshInputFields {
  readonly source: TetraMeshSource;
  readonly units: 'mm';
  readonly coordinates: readonly number[];
  readonly triangles: readonly number[];
  /** Zero-based CAD face labels; a label never becomes a persistent identity. */
  readonly tags: readonly number[];
  readonly tagCount: number;
  /** Absent preserves the native default generation path exactly. */
  readonly meshing?: TetraMeshingControls;
}

interface LegacyConvexTetraMeshInput extends TetraMeshInputFields {
  readonly schema: 'pointercad-convex-plc/1';
}

interface PlanarTetraMeshInput extends TetraMeshInputFields {
  readonly schema: 'pointercad-plc/2';
  readonly shells: readonly PlcShell[];
}

type TetraMeshInput = LegacyConvexTetraMeshInput | PlanarTetraMeshInput;

interface TetraMeshResult {
  readonly kind: 'netgen-convex-tetra-mesh' | 'netgen-tetra-mesh';
  readonly input: TetraMeshInput;
  readonly inputSha256: string;
  readonly coordinates: readonly number[];
  /** Zero-based, positively oriented four-node tetrahedra. */
  readonly tetrahedra: readonly number[];
  readonly boundaryTriangles: readonly number[];
  readonly boundaryTags: readonly number[];
  readonly volumeMm3: number;
  readonly minTetVolumeMm3: number;
}

export interface SavedSolidPayload {
  readonly kind: SolidAnalysisResult['kind'];
  readonly result: SolidAnalysisResult;
  readonly mesh: TetraMeshResult;
}
