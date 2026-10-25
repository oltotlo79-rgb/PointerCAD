import type { AnalysisSource, BeamAnalysisDocument, BeamModeNode, BeamNodalLoad } from './analysisModel.js';

export type BucklingRestraints = readonly [boolean, boolean, boolean, boolean, boolean, boolean];
/** Independent core input, not a new saved CAD schema. Geometry is an unloaded,
 * unrestrained schema-2 snapshot; its modal settings specify mesh/mode count.
 * Supports below are zero prescribed global [u,v,w,rx,ry,rz] components.
 * Reference loads scale together by the returned positive multiplier.
 */
export interface BeamBucklingInput {
  readonly schema: 'pointercad-beam-buckling/1';
  readonly geometry: BeamAnalysisDocument;
  readonly supports: readonly { readonly nodeId: string; readonly restrained: BucklingRestraints }[];
  readonly referenceLoads: readonly BeamNodalLoad[];
}
export interface BeamBucklingResult {
  readonly kind: 'oofem-beam-buckling-3d';
  readonly method: 'oofem-axial-geometric-stiffness-flexural-eigh/1';
  readonly scope: 'linear-elastic-axial-prestress-flexural-buckling';
  readonly analysisId: string;
  readonly analysisRevision: number;
  readonly source: AnalysisSource;
  readonly inputSha256: string;
  readonly normalizationLengthM: number;
  readonly meshNodes: number;
  readonly meshElements: number;
  readonly freeDofs: number;
  readonly referenceEquilibriumResidual: number;
  readonly maximumStiffnessOrthogonalityError: number;
  readonly modes: readonly {
    readonly number: number;
    readonly loadFactor: number;
    readonly normalizedResidual: number;
    readonly nodes: readonly BeamModeNode[];
  }[];
  readonly structuralCertification: false;
}
