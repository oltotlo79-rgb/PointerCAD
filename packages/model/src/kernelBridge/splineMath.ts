/** Sole model adapter to the reviewed import-free kernel arithmetic subpath. No Worker, barrel or OCCT access. */
export { basisValues, findSpan, expandKnots, interpolateOpen, interpolateClosed, controlPointData,
  explicitCubicData, splineDegree, hasDuplicateSplinePoint, SPLINE_MIN_SPAN_MM } from '@pointercad/kernel/math/spline-interpolation';
