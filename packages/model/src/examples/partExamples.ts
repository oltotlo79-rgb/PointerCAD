import { flangeExample } from './flange.js';
import { parameterBoxExample } from './parameterBox.js';
import type { PartExample } from './partExample.js';
import { plateWithHoleExample } from './plateWithHole.js';
import { saddleSurfaceExample } from './saddleSurface.js';
import { shelledBoxExample } from './shelledBox.js';
import { springExample } from './spring.js';

/** The examples in the order the picker lists them: from a single extrusion to formulas and surfaces. */
export const PART_EXAMPLES: readonly PartExample[] = [
  plateWithHoleExample,
  flangeExample,
  springExample,
  parameterBoxExample,
  saddleSurfaceExample,
  shelledBoxExample,
];
