import type { Vector3 } from '@pointercad/drawing';
import { applyPlacementToPoint } from '../assembly/placementMath.js';
import type { DrawingDimensionInstance } from './dimensionTarget.js';

/** 配置済みの全頂点で範囲を取る。大きい配列をspreadせず、非有限値を通さない。 */
export function drawingSourceCenter(instances: readonly DrawingDimensionInstance[]): Vector3 | null {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const instance of instances) {
    const positions = instance.body.mesh.positions;
    for (let index = 0; index + 2 < positions.length; index += 3) {
      const point = applyPlacementToPoint(instance.placement, [positions[index], positions[index + 1], positions[index + 2]]);
      if (!point.every(Number.isFinite)) return null;
      for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], point[axis]); max[axis] = Math.max(max[axis], point[axis]); }
    }
  }
  return min.every(Number.isFinite) ? [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] : null;
}
