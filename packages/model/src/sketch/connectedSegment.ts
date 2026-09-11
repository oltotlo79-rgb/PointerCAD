import type { ResolvedSegment, ResolvedSketch } from './types.js';
import { isSamePoint } from './vec3.js';

/** A previously divided interval can be removed whole using the same trim gesture. */
export function hasConnectedSegmentEnd(segment: ResolvedSegment, resolved: ResolvedSketch): boolean {
  return [segment.from, segment.to].some((end) =>
    resolved.points.some((point) => isSamePoint(point.position, end))
    && resolved.segments.some((other) => other.featureId !== segment.featureId
      && (isSamePoint(end, other.from) || isSamePoint(end, other.to))));
}
