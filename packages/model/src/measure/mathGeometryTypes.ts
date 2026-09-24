/** Persistent targets contain identities, never copied coordinates or display text. */
import type { SubShapeFingerprint, SubShapeRef } from '../geometry/subShapeRef.js';
import type { PointReference } from '../sketch/types.js';

export type MathSubShapeReference<K extends SubShapeFingerprint['kind']> =
  SubShapeRef & { readonly fingerprint: Extract<SubShapeFingerprint, { readonly kind: K }> };

export type MathGeometryPoint =
  | { readonly kind: 'sketch-point'; readonly sketchId: string;
      readonly reference: Extract<PointReference, { readonly kind: 'point' }> }
  | { readonly kind: 'vertex'; readonly reference: MathSubShapeReference<'vertex'> };
export type MathGeometryCurve =
  | { readonly kind: 'sketch-curve'; readonly sketchId: string; readonly featureId: string }
  | { readonly kind: 'edge'; readonly reference: MathSubShapeReference<'edge'> };
export type MathGeometryFrame = { readonly kind: 'reference'; readonly featureId: string };
export type MathGeometryBody = { readonly kind: 'body'; readonly featureId: string };
export type MathGeometryFace = { readonly kind: 'face'; readonly reference: MathSubShapeReference<'face'> };
export type MathGeometryShape = MathGeometryBody | MathGeometryFace
  | Extract<MathGeometryCurve, { readonly kind: 'edge' }> | Extract<MathGeometryPoint, { readonly kind: 'vertex' }>;

/** Tolerances are geometry comparison thresholds, NOT certified arithmetic error bounds. */
export interface MathGeometryTolerance {
  readonly linearMm: number;
  readonly angularRadians: number;
}
export type MathGeometryQuantity =
  /** Components in the current resolved frame; omitting frame means world coordinates. */
  | { readonly kind: 'coordinate'; readonly point: MathGeometryPoint; readonly component: 'X' | 'Y' | 'Z';
      readonly frame?: MathGeometryFrame }
  | { readonly kind: 'point-distance'; readonly first: MathGeometryPoint; readonly second: MathGeometryPoint }
  | { readonly kind: 'shape-distance'; readonly first: MathGeometryShape; readonly second: MathGeometryShape }
  | { readonly kind: 'length'; readonly curve: MathGeometryCurve }
  /** Circular sketch arcs and current circular solid edges only. */
  | { readonly kind: 'radius'; readonly curve: MathGeometryCurve }
  /** Absolute arc sweep; circular solid edges use length / radius, without folding at 90 or 180 degrees. */
  | { readonly kind: 'central-angle'; readonly curve: MathGeometryCurve; readonly unit: 'degree' | 'radian' }
  /** The entire sketch feature, including every segment and arc of a compound contour (Q9=CL1). */
  | { readonly kind: 'contour-length'; readonly sketchId: string; readonly featureId: string }
  | { readonly kind: 'area'; readonly shape: MathGeometryBody | MathGeometryFace }
  | { readonly kind: 'volume'; readonly body: MathGeometryBody }
  /** Unoriented angle between lines, from 0 to 90 degrees; a circular edge has no line direction. */
  | { readonly kind: 'angle'; readonly first: MathGeometryCurve; readonly second: MathGeometryCurve;
      readonly unit: 'degree' | 'radian' }
  /** Unoriented plane/line angles are 0..90 degrees; non-planar faces are unsupported. */
  | { readonly kind: 'plane-angle'; readonly first: MathGeometryFace; readonly second: MathGeometryFace;
      readonly unit: 'degree' | 'radian' }
  | { readonly kind: 'line-plane-angle'; readonly line: MathGeometryCurve; readonly plane: MathGeometryFace;
      readonly unit: 'degree' | 'radian' }
  /** Angle ABC, with second as the vertex, from 0 to 180 degrees. */
  | { readonly kind: 'point-angle'; readonly first: MathGeometryPoint; readonly second: MathGeometryPoint;
      readonly third: MathGeometryPoint; readonly unit: 'degree' | 'radian' }
  | { readonly kind: 'parallel'; readonly first: MathGeometryCurve | MathGeometryFace;
      readonly second: MathGeometryCurve | MathGeometryFace }
  | { readonly kind: 'perpendicular'; readonly first: MathGeometryCurve | MathGeometryFace;
      readonly second: MathGeometryCurve | MathGeometryFace }
  /**
   * G1: segments compare lengths; circular arcs/circles compare radius and absolute sweep.
   * A sketch-curve may also name one entire closed, simple planar polygon of straight edges.
   * Polygon edge lengths and signed turns (including concave corners) must match under a cyclic
   * shift or reversed traversal. Position, spatial orientation and reflection do not matter.
   * All differences use <= linearMm / angularRadians. Mixed kinds, different vertex counts,
   * open/non-planar/self-intersecting contours and degenerate shapes are unsupported, not false.
   */
  | { readonly kind: 'congruent'; readonly first: MathGeometryCurve; readonly second: MathGeometryCurve }
  /**
   * Same targets/correspondences as congruent. Non-degenerate segments are always similar;
   * arcs/circles compare only absolute sweep. Polygons use the perimeter ratio, enlarging the
   * smaller perimeter to the larger, then compare each edge in mm and each turn in radians.
   * This symmetric length rule uses the definition's T3 tolerance, not a new relative tolerance.
   * Segment lengths, polygon edges and circular radii <= linearMm are degenerate.
   */
  | { readonly kind: 'similar'; readonly first: MathGeometryCurve; readonly second: MathGeometryCurve };

export interface MathGeometryRequest {
  readonly id: string;
  readonly documentId: string;
  readonly quantity: MathGeometryQuantity;
  readonly tolerance: MathGeometryTolerance;
}
/** Only the definition is stored; measured values belong to a recomputation generation. */
export interface MathGeometryDefinition extends MathGeometryRequest {
  readonly name: string;
}
export type MathGeometryOutcome = {
  readonly id: string;
  readonly documentId: string;
  readonly generation: number;
} & (
  | { readonly status: 'value'; readonly kind: 'real'; readonly value: number;
      readonly unit: 'mm' | 'mm2' | 'mm3' | 'degree' | 'radian';
      readonly representation: 'geometry-double'; readonly tolerance: MathGeometryTolerance }
  | { readonly status: 'value'; readonly kind: 'boolean'; readonly value: boolean;
      readonly representation: 'geometry-double'; readonly tolerance: MathGeometryTolerance }
  /** ambiguous-reference: after a shape change, two current candidates score too close to pick one. */
  | { readonly status: 'unresolved';
      readonly reason: 'missing-reference' | 'failed-geometry' | 'unsupported' | 'invalid-request' | 'ambiguous-reference';
      readonly message: string }
);
