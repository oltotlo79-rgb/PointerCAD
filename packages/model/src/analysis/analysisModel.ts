/** Linear, small-displacement, isotropic 3D Timoshenko frames. No capacity claim. */
export type Vector3 = readonly [number, number, number];
export type Vector6 = readonly [number, number, number, number, number, number];
export interface AnalysisSource {
  readonly documentId: string;
  readonly documentRevision: number;
  readonly geometryRevision: string;
}
export interface PropertySource {
  readonly kind: 'user-supplied' | 'measured' | 'published';
  readonly reference: string;
  readonly condition: string;
}
export interface BeamNode { readonly id: string; readonly position: Vector3 }
/** Explicit condition-specific yield evidence in MPa, independent of the analysis length unit.
 * Absence means missing capacity data; it does not prevent the legacy elastic analysis. */
export interface AnalysisMaterialCapacity {
  readonly materialConditionId: string;
  readonly condition: string;
  readonly thicknessMm: number | null;
  readonly yieldMPa: number;
  readonly sourceId: string;
  readonly evidence: 'supplier-excerpt' | 'manufacturer-reference' | 'measured-reference' | 'standard-draft';
  readonly basis: 'minimum' | 'reference';
}
export interface BeamMaterial {
  readonly id: string;
  /** N/length² in the selected unit system; isotropic consistency is checked. */
  readonly youngModulus: number;
  readonly shearModulus: number;
  readonly densityKgM3: number;
  readonly source: PropertySource;
  readonly capacity?: AnalysisMaterialCapacity;
}
export interface BeamSection {
  readonly id: string;
  readonly area: number;
  /** Centroidal principal axes matching local y/z; offsets and Iyz are unsupported. */
  readonly iy: number;
  readonly iz: number;
  /** Saint-Venant torsion constant, not the polar second moment by default. */
  readonly torsionConstant: number;
  /** Same correction in both shear directions; anisotropic shear is unsupported. */
  readonly shearFactor: number;
  readonly source: PropertySource;
}
export interface BeamCadAssociation {
  readonly expectedPartKey: string;
  readonly sectionFrameSource: PropertySource;
  readonly shearCenterModel: 'coincident-with-centroid';
}
export interface BeamMember {
  readonly id: string;
  readonly componentId: string;
  /** Explicit occurrence identity; '/' in an id has no path semantics. */
  readonly occurrencePath: readonly string[];
  readonly startNodeId: string;
  readonly endNodeId: string;
  readonly materialId: string;
  readonly sectionId: string;
  /** Projected normal to start→end, then normalized; right-handed z=x×y. */
  readonly localYHint: Vector3;
  /** CAD interpretation participates in the canonical input hash, even when geometry is unchanged. */
  readonly cadSource?: BeamCadAssociation;
}
export interface BeamClamp { readonly id: string; readonly kind: 'fixed'; readonly nodeId: string }
export interface BeamNodalLoad {
  readonly id: string;
  readonly kind: 'nodal';
  readonly nodeId: string;
  /** Global force in N and moment in N·length. */
  readonly force: Vector3;
  readonly moment: Vector3;
}
export interface BeamModalSettings {
  readonly modeCount: number;
  /** Uniform finite-element subdivision per original straight CAD member. */
  readonly segmentsPerMember: number;
}
export interface BeamAnalysisDocument {
  readonly schema: 'pointercad-beam/1' | 'pointercad-beam/2';
  /** Required only in schema 2; schema 1 always means static analysis. */
  readonly modal?: BeamModalSettings;
  readonly id: string;
  readonly revision: number;
  readonly source: AnalysisSource;
  readonly units: 'N-m' | 'N-mm';
  readonly nodes: readonly BeamNode[];
  readonly members: readonly BeamMember[];
  readonly materials: readonly BeamMaterial[];
  readonly sections: readonly BeamSection[];
  readonly constraints: readonly BeamClamp[];
  readonly loads: readonly BeamNodalLoad[];
}
export interface AnalysisIssue { readonly code: string; readonly path: string; readonly message: string }
export type AnalysisCheck = { readonly ok: true; readonly document: BeamAnalysisDocument }
  | { readonly ok: false; readonly issue: AnalysisIssue };
export interface BeamFrame { readonly x: Vector3; readonly y: Vector3; readonly z: Vector3; readonly lengthM: number }
export interface BeamNodeResult {
  readonly nodeId: string;
  readonly solverNode: number;
  readonly displacementM: Vector3;
  readonly rotationRad: Vector3;
  /** Assembled native element forces minus applied nodal loads, global axes. */
  readonly reactionN: Vector3;
  readonly reactionNm: Vector3;
  readonly constrained: boolean;
}
export interface BeamElementResult {
  readonly memberId: string;
  readonly componentId: string;
  readonly occurrencePath: readonly string[];
  readonly solverElement: number;
  readonly nodeIds: readonly [string, string];
  readonly frame: BeamFrame;
  /** Local end action vectors [Fx,Fy,Fz,Mx,My,Mz], N and N·m. */
  readonly start: Vector6;
  readonly end: Vector6;
}
export interface BeamAnalysisResult {
  readonly kind: 'oofem-linear-beam-3d';
  readonly model: 'linear-timoshenko-isotropic';
  readonly analysisId: string;
  readonly analysisRevision: number;
  readonly source: AnalysisSource;
  readonly inputSha256: string;
  readonly nodes: readonly BeamNodeResult[];
  readonly elements: readonly BeamElementResult[];
  readonly balance: { readonly referenceM: Vector3; readonly forceN: Vector3; readonly momentNm: Vector3; readonly maximumFreeResidual: number };
  readonly structuralCertification: false;
}

export interface BeamModeNode {
  readonly solverNode: number;
  readonly nodeId: string | null;
  readonly positionM: Vector3;
  /** Relative translation divided by the normalization length, dimensionless. */
  readonly translation: Vector3;
  /** Relative rotation, dimensionless radians; not a load-induced displacement. */
  readonly rotation: Vector3;
}
export interface BeamModeShape {
  readonly number: number;
  readonly frequencyHz: number;
  readonly eigenvaluePerSecondSquared: number;
  readonly normalizedResidual: number;
  readonly generalizedMassKgM2: number;
  readonly nodes: readonly BeamModeNode[];
}
export interface BeamModalResult {
  readonly kind: 'oofem-beam-modal-3d';
  readonly method: 'oofem-beam3d-rotary-mass-numpy-eigh/1';
  readonly analysisId: string;
  readonly analysisRevision: number;
  readonly source: AnalysisSource;
  readonly inputSha256: string;
  readonly modes: readonly BeamModeShape[];
  readonly rigidBodyModes: number;
  readonly normalization: 'max-nodal-translation-over-length-or-rotation=1';
  readonly normalizationLengthM: number;
  readonly totalMassKg: number;
  readonly meshNodes: number;
  readonly meshElements: number;
  readonly edges: readonly { readonly memberId: string; readonly nodes: readonly [number, number] }[];
  readonly freeDofs: number;
  readonly maximumMassOrthogonalityError: number;
  readonly maximumRigidMotionResidual: number;
  readonly structuralCertification: false;
}
