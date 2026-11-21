import { expressionValueFromNumber } from '@pointercad/expression';
import { appendSolid } from '../part/createPartDocument.js';
import type { ExtrudeFeature, FilletFeature, PartDocument, ShellFeature, SubShapeRef } from '../part/types.js';
import { rectangularProfile, solidIdentity } from './exampleGeometry.js';
import type { PartExample } from './partExample.js';

const width = 60;
const depth = 40;
const height = 30;
const radius = 5;
const wall = 2;

/** Vertical edges of the extruded box in its own sub-shape order (index, corner x, corner y). */
const VERTICAL_EDGES: readonly (readonly [number, number, number])[] = [
  [0, -width / 2, -depth / 2], [1, width / 2, -depth / 2], [4, width / 2, depth / 2], [7, -width / 2, depth / 2],
];

function verticalEdge(bodyFeatureId: string, [index, x, y]: readonly [number, number, number]): SubShapeRef {
  return { bodyFeatureId, index, fingerprint: {
    kind: 'edge', curveKind: 'line', length: height, position: [x, y, height / 2], axis: [0, 0, 1], radius: null,
  } };
}

/** A 60 x 40 x 30 box rounded R5 on its four vertical edges, then hollowed to 2 mm walls with the top left open. */
function createShelledBox(): PartDocument {
  const { part, profile } = rectangularProfile('xy', [-width / 2, -depth / 2, 0], [width / 2, depth / 2, 0]);
  const box: ExtrudeFeature = {
    ...solidIdentity(part, 'extrude'), kind: 'extrude', profile,
    distance: expressionValueFromNumber(height), reversed: false, symmetric: false,
  };
  const extruded = appendSolid(part, box);
  const rounded: FilletFeature = {
    ...solidIdentity(extruded, 'fillet'), kind: 'fillet', targetFeatureId: box.id,
    targets: VERTICAL_EDGES.map(edge => verticalEdge(box.id, edge)), radius: expressionValueFromNumber(radius),
  };
  const filleted = appendSolid(extruded, rounded);
  // Each rounded corner replaces a radius-by-radius square by a quarter disc.
  const topArea = width * depth - (4 - Math.PI) * radius ** 2;
  const hollow: ShellFeature = {
    ...solidIdentity(filleted, 'shell'), kind: 'shell', targetFeatureId: rounded.id,
    openFaces: [{ bodyFeatureId: rounded.id, index: 4, fingerprint: {
      kind: 'face', surfaceKind: 'plane', area: topArea, position: [0, 0, height], axis: [0, 0, 1], radius: null,
    } }],
    thickness: expressionValueFromNumber(wall), outward: false,
  };
  return appendSolid(filleted, hollow);
}

export const shelledBoxExample: PartExample = { id: 'shelledBox', create: createShelledBox };
