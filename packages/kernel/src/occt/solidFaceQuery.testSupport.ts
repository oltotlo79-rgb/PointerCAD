import type { SolidFaceInfo, SubShapeQuery } from '../types.js';

/** Preserve the selected face fingerprint, including nulls and the original tuple references. */
export function solidFaceQuery(face: SolidFaceInfo): Extract<SubShapeQuery, { kind: 'face' }> {
  return {
    kind: 'face',
    index: face.index,
    surfaceKind: face.surfaceKind,
    area: face.area,
    position: face.centroid,
    axis: face.axis,
    radius: face.radius,
  };
}
