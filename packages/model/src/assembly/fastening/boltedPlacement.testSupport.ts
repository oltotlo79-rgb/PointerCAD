import { expressionValueFromNumber } from '@pointercad/expression';
import type { Vec3 } from '../../sketch/vec3.js';
import type { Placement } from '../types.js';

export function placement(position: Vec3): Placement {
  return { position: [expressionValueFromNumber(position[0]), expressionValueFromNumber(position[1]),
    expressionValueFromNumber(position[2])], rotation: [0, 0, 0, 1] };
}
