import { expressionValueFromNumber } from '@pointercad/expression';
import { appendSolid, createEmptyPartDocument, replaceSketch } from '../part/createPartDocument.js';
import type { PartDocument, SpringFeature } from '../part/types.js';
import { absoluteCoordinate, appendFeature, createPointFeature } from '../sketch/createSketchDocument.js';
import { solidIdentity } from './exampleGeometry.js';
import type { PartExample } from './partExample.js';

const coilDiameter = 20;
const wireDiameter = 2;
const pitch = 5;
const turns = 4;

/** A right-handed coil of 4 turns about the world Z axis from the origin point of the first sketch. */
function createSpring(): PartDocument {
  const empty = createEmptyPartDocument();
  const sketch = empty.sketches[0];
  const start = createPointFeature(sketch, absoluteCoordinate(0, 0, 0));
  const part = replaceSketch(empty, appendFeature(sketch, start));
  const coil: SpringFeature = {
    ...solidIdentity(part, 'spring'), kind: 'spring', origin: { sketchId: sketch.id, pointFeatureId: start.id },
    axis: { kind: 'world', axis: 'z' },
    tiltAngle: expressionValueFromNumber(0), tiltAzimuth: expressionValueFromNumber(0),
    // The length is derived (length = pitch x turns), so the stored value is the same product.
    length: expressionValueFromNumber(pitch * turns), pitch: expressionValueFromNumber(pitch),
    turns: expressionValueFromNumber(turns), derived: 'length',
    coilDiameter: expressionValueFromNumber(coilDiameter), wireDiameter: expressionValueFromNumber(wireDiameter),
    handedness: 'right',
  };
  return appendSolid(part, coil);
}

export const springExample: PartExample = { id: 'spring', create: createSpring };
