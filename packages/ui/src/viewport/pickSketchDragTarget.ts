import type { ConstraintTarget, ResolvedSketch } from '@pointercad/model';
import { CONSTRAINT_PICK_RADIUS_PIXELS, vertexAt } from '../sketch/constraintPicking.js';
import { pickSketchElement } from '../sketch/pickMath.js';
import type { ProjectToScreen } from '../sketch/snapMath.js';

/** Visible shared points own a drag even when several line endpoints overlap them. */
export function pickSketchDragTarget(
  resolved: ResolvedSketch,
  project: ProjectToScreen,
  pointer: readonly [number, number],
): ConstraintTarget | null {
  const picked = pickSketchElement(resolved, project, pointer, CONSTRAINT_PICK_RADIUS_PIXELS);
  if (picked?.kind === 'point') return { kind: 'point', pointId: picked.elementId };
  const vertex = vertexAt(resolved, project, pointer);
  return vertex === null ? null : { kind: 'vertex', featureId: vertex.featureId, vertex: vertex.vertex };
}
