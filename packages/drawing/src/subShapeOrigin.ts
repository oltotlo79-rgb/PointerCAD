/** Saved semantic identity and runtime address are deliberately separate. */
export type OriginShapeKind = 'face' | 'edge' | 'vertex';
export type BoxFaceRole = 'bottom' | 'top' | 'front' | 'back' | 'left' | 'right';
export type BoxEdgeRole =
  | 'bottom-front' | 'bottom-back' | 'bottom-left' | 'bottom-right'
  | 'top-front' | 'top-back' | 'top-left' | 'top-right'
  | 'front-left' | 'front-right' | 'back-left' | 'back-right';
export type BoxVertexRole =
  | 'bottom-front-left' | 'bottom-front-right' | 'bottom-back-left' | 'bottom-back-right'
  | 'top-front-left' | 'top-front-right' | 'top-back-left' | 'top-back-right';
export type CylinderFaceRole = 'side' | 'start' | 'end';
export type CylinderEdgeRole = 'start-ring' | 'end-ring' | 'seam';
export type CylinderVertexRole = 'seam-start' | 'seam-end';
export interface ProfileLineAnchor {
  readonly sketchId: string;
  readonly faceFeatureId: string;
  readonly lineFeatureId: string;
  readonly role: 'whole-line';
}
export interface ProfileRegionAnchor {
  readonly sketchId: string;
  readonly faceFeatureId: string;
  readonly lineFeatureIds: readonly [string, string, string, ...string[]];
}
/** Logical producer roles, never a current topology index or an array offset. */
export type PointProducerAnchor =
  | { readonly kind: 'point'; readonly featureId: string }
  | { readonly kind: 'linear-point'; readonly featureId: string; readonly step: number }
  | { readonly kind: 'grid-point'; readonly featureId: string; readonly row: number; readonly column: number }
  | { readonly kind: 'circular-point'; readonly featureId: string; readonly numerator: number; readonly denominator: number }
  | { readonly kind: 'copied-point'; readonly featureId: string; readonly source: PointProducerAnchor;
      readonly placement: CopyPointPlacementRole };
export type CopyPointPlacementRole =
  | { readonly kind: 'mirror' | 'translate' }
  | { readonly kind: 'linear'; readonly step: number }
  | { readonly kind: 'circular'; readonly fullCircle: boolean;
      readonly numerator: number; readonly denominator: number };
export interface HoleCenterAnchor {
  readonly sketchId: string;
  readonly producer: PointProducerAnchor;
}
export type PointPlacementSourceAnchor =
  | { readonly kind: 'origin' }
  | { readonly kind: 'sketch-point'; readonly anchor: HoleCenterAnchor }
  | { readonly kind: 'reference-point'; readonly featureId: string }
  | { readonly kind: 'curve-vertex'; readonly sketchId: string; readonly featureId: string;
      readonly vertex: 'start' | 'end' | 'center' }
  | { readonly kind: 'semantic-subshape'; readonly bodyFeatureId: string; readonly origin: SubShapeOrigin }
  | { readonly kind: 'sphere-grid'; readonly featureId: string;
      readonly latitudeSource: string; readonly longitudeSource: string;
      readonly latitudeMathDefinition?: string; readonly longitudeMathDefinition?: string };
export type HolePlacementRole =
  | { readonly kind: 'original' }
  | { readonly kind: 'linear'; readonly step: number }
  | { readonly kind: 'circular'; readonly fullCircle: boolean;
      readonly numerator: number; readonly denominator: number }
  | { readonly kind: 'point-slot'; readonly slotId: string; readonly source: PointPlacementSourceAnchor };
export interface HoleFaceOrigin {
  readonly kind: 'hole-face';
  readonly featureId: string;
  readonly center: HoleCenterAnchor;
  readonly placement: HolePlacementRole;
  readonly stage: 'bore' | 'counterbore' | 'countersink';
  readonly role: 'wall' | 'floor' | 'entry-cap';
}
/** A modeled thread's own groove face, named only from the thread operation's native history.
 * Saved only as this exact stage/role pair; old stages never take `groove`. */
export interface HoleThreadGrooveOrigin {
  readonly kind: 'hole-face';
  readonly featureId: string;
  readonly center: HoleCenterAnchor;
  readonly placement: HolePlacementRole;
  readonly stage: 'thread';
  readonly role: 'groove';
}
export type FaceOrigin =
  | { readonly kind: 'surface-side'; readonly featureId: string; readonly profile: {
      readonly sketchId: string; readonly lineFeatureId: string; readonly role: 'whole-line' } }
  | HoleFaceOrigin
  | HoleThreadGrooveOrigin
  | { readonly kind: 'box-face'; readonly featureId: string; readonly role: BoxFaceRole }
  | { readonly kind: 'cylinder-face'; readonly featureId: string; readonly role: CylinderFaceRole }
  | { readonly kind: 'sphere-face'; readonly featureId: string; readonly role: 'surface' }
  | { readonly kind: 'cone-face'; readonly featureId: string; readonly role: 'side' | 'start' | 'end' }
  | { readonly kind: 'torus-face'; readonly featureId: string; readonly role: 'surface' }
  | { readonly kind: 'extrude-curve-side'; readonly featureId: string; readonly profile: {
      readonly sketchId: string; readonly faceFeatureId: string;
      readonly curveFeatureId: string; readonly role: 'whole-curve' } }
  | { readonly kind: 'extrude-curve-cap'; readonly featureId: string; readonly end: 'start' | 'end';
      readonly profile: { readonly sketchId: string; readonly faceFeatureId: string;
        readonly curveFeatureIds: readonly [string, string, string, ...string[]] } }
  | { readonly kind: 'extrude-side'; readonly featureId: string; readonly profile: ProfileLineAnchor }
  | { readonly kind: 'extrude-cap'; readonly featureId: string; readonly end: 'start' | 'end'; readonly profile: ProfileRegionAnchor }
  | { readonly kind: 'blend-face'; readonly featureId: string; readonly operation: 'fillet' | 'chamfer'; readonly source: EdgeOrigin }
  | { readonly kind: 'merged-face'; readonly featureId: string; readonly sources: readonly [FaceOrigin, FaceOrigin, ...FaceOrigin[]] };
export type EdgeOrigin =
  | { readonly kind: 'box-edge'; readonly featureId: string; readonly role: BoxEdgeRole }
  | { readonly kind: 'cylinder-edge'; readonly featureId: string; readonly role: CylinderEdgeRole }
  | { readonly kind: 'face-intersection-edge'; readonly featureId: string; readonly faces: readonly [FaceOrigin, FaceOrigin] }
  | { readonly kind: 'merged-edge'; readonly featureId: string; readonly sources: readonly [EdgeOrigin, EdgeOrigin, ...EdgeOrigin[]] };
export type VertexOrigin =
  | { readonly kind: 'box-vertex'; readonly featureId: string; readonly role: BoxVertexRole }
  | { readonly kind: 'cylinder-vertex'; readonly featureId: string; readonly role: CylinderVertexRole }
  | { readonly kind: 'face-intersection-vertex'; readonly featureId: string; readonly faces: readonly [FaceOrigin, FaceOrigin, FaceOrigin] }
  | { readonly kind: 'merged-vertex'; readonly featureId: string; readonly sources: readonly [VertexOrigin, VertexOrigin, ...VertexOrigin[]] };
export type SubShapeOrigin =
  | { readonly version: 1; readonly shapeKind: 'face'; readonly identity: FaceOrigin }
  | { readonly version: 1; readonly shapeKind: 'edge'; readonly identity: EdgeOrigin }
  | { readonly version: 1; readonly shapeKind: 'vertex'; readonly identity: VertexOrigin };
export type UntrackedReason = 'legacy' | 'imported' | 'unsupported-producer' | 'unsupported-operation'
  | 'unsupported-profile-piece' | 'missing-native-map' | 'limit';
export interface ShapeAddress { readonly kind: OriginShapeKind; readonly index: number }
export type OriginBinding = { readonly origin: SubShapeOrigin } & (
  | { readonly state: 'unique'; readonly current: ShapeAddress }
  | { readonly state: 'split'; readonly candidates: readonly [ShapeAddress, ShapeAddress, ...ShapeAddress[]] }
  | { readonly state: 'merged'; readonly current: ShapeAddress; readonly coOrigins: readonly [SubShapeOrigin, SubShapeOrigin, ...SubShapeOrigin[]] }
  | { readonly state: 'missing'; readonly reason: 'deleted' | 'source-missing' | 'history-missing' }
  | { readonly state: 'untracked'; readonly reason: UntrackedReason });
/** Runtime output only; never persist this current-address table. */
export type CurrentOriginIndex =
  | { readonly version: 1; readonly state: 'tracked'; readonly bindings: readonly OriginBinding[];
      /** Current native-proved unnamed regions; never persisted or used to rescue a saved semantic ref. */
      readonly fingerprintFallback?: readonly { readonly current: ShapeAddress;
        readonly reason: 'legacy' | 'imported' | 'unsupported-producer' }[] }
  | { readonly version: 1; readonly state: 'untracked'; readonly reason: UntrackedReason };
export type OriginLookup =
  | { readonly status: 'matched'; readonly address: ShapeAddress; readonly basis: 'semantic' }
  | { readonly status: 'ambiguous'; readonly reason: 'split' | 'merged'; readonly candidates: readonly ShapeAddress[] }
  | { readonly status: 'missing'; readonly reason: 'deleted' | 'source-missing' | 'history-missing' | 'origin-index-missing' | UntrackedReason };
