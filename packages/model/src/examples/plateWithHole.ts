import { expressionValueFromNumber } from '@pointercad/expression';
import { appendSolid } from '../part/createPartDocument.js';
import type { ExtrudeFeature, PartDocument } from '../part/types.js';
import { drillTop, rectangularProfile, solidIdentity } from './exampleGeometry.js';
import type { PartExample } from './partExample.js';

/** A 60 x 40 x 8 plate centred on the origin with a through hole of diameter 10 in the middle. */
function createPlateWithHole(): PartDocument {
  const { part, profile } = rectangularProfile('xy', [-30, -20, 0], [30, 20, 0]);
  const plate: ExtrudeFeature = {
    ...solidIdentity(part, 'extrude'), kind: 'extrude', profile,
    distance: expressionValueFromNumber(8), reversed: false, symmetric: false,
  };
  return drillTop(appendSolid(part, plate), {
    targetId: plate.id, faceIndex: 5, height: 8, faceArea: 60 * 40, centerX: 0, diameter: 10,
  }).part;
}

export const plateWithHoleExample: PartExample = { id: 'plateWithHole', create: createPlateWithHole };
