// The legacy Error.message is retained for direct OCCT callers and older reply readers.
export type SolidGeometryFailureCode =
  | 'geometry-open-solid' | 'geometry-union-count' | 'geometry-nothing-left'
  | 'geometry-profile-no-removal' | 'geometry-profile-no-inside' | 'geometry-profile-no-outside'
  | 'geometry-pattern-missing-input' | 'geometry-pattern-upstream-failed' | 'geometry-pattern-mesh-input'
  | 'geometry-spring-coil' | 'geometry-spring-wire' | 'geometry-spring-wire-size'
  | 'geometry-spring-pitch' | 'geometry-spring-turns' | 'geometry-spring-pitch-size'
  | 'geometry-spring-axis' | 'geometry-spring-build' | 'geometry-spring-not-solid'
  | 'geometry-spring-internal' | 'geometry-spring-interrupted'
  | 'geometry-pattern-detached' | 'geometry-transform-not-finite' | 'geometry-transform-axis'
  | 'geometry-plane-not-finite' | 'geometry-mirror-normal' | 'geometry-scale-factor' | 'geometry-scale-choice'
  | 'geometry-placement-not-finite' | 'geometry-placement-rotation' | 'geometry-internal'
  | 'geometry-loft-segments'
  | 'geometry-loft-open-profile'
  | 'geometry-loft-two-spheres'
  | 'geometry-loft-sphere-profile'
  | 'geometry-loft-sphere-tangent'
  | 'geometry-loft-build'
  | 'geometry-loft-not-solid'
  | 'geometry-loft-twist'
  | 'geometry-loft-sphere-radius'
  | 'geometry-loft-missing-face'
  | 'geometry-loft-unusable-face'
  | 'geometry-loft-face-with-holes'
  | 'geometry-loft-sections'
  | 'geometry-pathSweep-path-disconnected'
  | 'geometry-pathSweep-profile-disconnected'
  | 'geometry-pathSweep-guide-disconnected'
  | 'geometry-pathSweep-no-path'
  | 'geometry-pathSweep-no-profile'
  | 'geometry-pathSweep-open-profile'
  | 'geometry-pathSweep-non-planar-profile'
  | 'geometry-pathSweep-self-intersecting-profile'
  | 'geometry-pathSweep-no-tangent'
  | 'geometry-pathSweep-build'
  | 'geometry-pathSweep-not-solid'
  | 'geometry-pathSweep-incomplete'
  | 'geometry-pathSweep-tight'
  | 'geometry-pathSweep-law-with-guide'
  | 'geometry-pathSweep-guide-interval'
  | 'geometry-pathSweep-guide-degenerate'
  | 'geometry-pathSweep-guide-contact'
  | 'geometry-pathSweep-guide-change'
  | 'geometry-pathSweep-guide-section'
  | 'geometry-pathSweep-law-frame'
  | 'geometry-pathSweep-law-joint'
  | 'geometry-pathSweep-law-closed'
  | 'geometry-pathSweep-law-twist'
  | 'geometry-pathSweep-law-scale'
  | 'geometry-pathSweep-hole-disconnected'
  | 'geometry-pathSweep-offset-disconnected'
  | 'geometry-pathSweep-wall-with-holes'
  | 'geometry-pathSweep-wall-value'
  | 'geometry-pathSweep-wall-too-thick'
  | 'geometry-pathSweep-hollow-cut'
  | 'geometry-surface-direction'
  | 'geometry-surface-extrude-distance'
  | 'geometry-surface-revolve-angle'
  | 'geometry-surface-axis'
  | 'geometry-surface-build'
  | 'geometry-surface-face-required'
  | 'geometry-surface-solid-result'
  | 'geometry-surface-offset-distance'
  | 'geometry-surface-offset-build'
  | 'geometry-profile-faceNoCurves'
  | 'geometry-profile-notConnected'
  | 'geometry-profile-faceOpen'
  | 'geometry-profile-faceNotPlanar'
  | 'geometry-profile-faceSelfIntersection'
  | 'geometry-profile-segmentEdge'
  | 'geometry-profile-arcEdge'
  | 'geometry-profile-arcRadius';

export type PlacementFailureCode = Extract<SolidGeometryFailureCode,
  'geometry-placement-not-finite' | 'geometry-placement-rotation'>;

export interface GeometryFailureDetails<Code extends SolidGeometryFailureCode = SolidGeometryFailureCode> {
  readonly code: Code;
  readonly parameters?: Readonly<Record<string, string>>;
}

export class SolidGeometryFailure<Code extends SolidGeometryFailureCode = SolidGeometryFailureCode>
  extends Error implements GeometryFailureDetails<Code> {
  constructor(
    readonly code: Code,
    message: string,
    readonly parameters?: Readonly<Record<string, string>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SolidGeometryFailure';
  }
}

export function isSolidGeometryFailure(error: unknown): error is SolidGeometryFailure {
  return error instanceof SolidGeometryFailure;
}

/** Legacy wire fallback for producers whose internal failures have no user-facing cause. */
export const GEOMETRY_INTERNAL_MESSAGE = '内部の誤りが起きました。';

/** Preserve the original exception on ordinary failure, and both faults when disposal also fails. */
export function releaseGeometryOnError(release: () => void, failure: unknown): never {
  try {
    release();
  } catch (disposalError) {
    throw new AggregateError([failure, disposalError], 'Geometry operation and native disposal failed',
      { cause: disposalError });
  }
  throw failure;
}
