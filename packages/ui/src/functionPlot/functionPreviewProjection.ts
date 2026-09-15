/** Fit the rotated XYZ box in CSS pixels, preserving room for axis names and point buttons. */
import type { Vec3 } from '@pointercad/model';

/** Candidate buttons occupy the drawing area; axis callouts have their own right-hand strip. */
export function createFunctionPointPreviewProjection(minimum: Vec3, maximum: Vec3,
  rotation: { readonly yaw: number; readonly pitch: number }) {
  const project = createFunctionPreviewProjection(minimum, maximum, rotation);
  return (point: Vec3, width: number, height: number): readonly [number, number] =>
    project(point, Math.max(1, width - 40), height);
}

export function createFunctionPreviewProjection(minimum: Vec3, maximum: Vec3,
  rotation: { readonly yaw: number; readonly pitch: number }) {
  const spans = maximum.map((value, axis) => value - minimum[axis]);
  const span = Math.max(...spans, Number.MIN_VALUE);
  const center = minimum.map((value, axis) => value + spans[axis] / 2);
  const cy = Math.cos(rotation.yaw), sy = Math.sin(rotation.yaw);
  const cp = Math.cos(rotation.pitch), sp = Math.sin(rotation.pitch);
  // Normalize before summing: 2 * span may overflow even when every XYZ extent is finite.
  // This also retains the rotated proportions of very small representable boxes.
  const normalizedSpans = spans.map(value => value / span);
  const horizontalRadius = (Math.abs(cy) * normalizedSpans[0] + Math.abs(sy) * normalizedSpans[1]) / 2;
  const verticalRadius = (Math.abs(sp * sy) * normalizedSpans[0] + Math.abs(sp * cy) * normalizedSpans[1]
    + Math.abs(cp) * normalizedSpans[2]) / 2;

  return (point: Vec3, width: number, height: number): readonly [number, number] => {
    const margin = Math.min(24, Math.min(width, height) / 2);
    const horizontalScale = horizontalRadius > 0 ? (width / 2 - margin) / horizontalRadius : Infinity;
    const verticalScale = verticalRadius > 0 ? (height / 2 - margin) / verticalRadius : Infinity;
    const candidate = Math.min(horizontalScale, verticalScale);
    const scale = Number.isFinite(candidate) ? Math.max(0, candidate) : 0;
    const [x, y, z] = point.map((value, axis) => (value - center[axis]) / span);
    return [width / 2 + (cy * x - sy * y) * scale,
      height / 2 - (cp * z - sp * (sy * x + cy * y)) * scale];
  };
}
