import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import type { Parameter } from '../parameters/types.js';
import { createDefaultConfigurations } from '../part/configurationDefaults.js';
import { appendSolid } from '../part/createPartDocument.js';
import type { ExtrudeFeature, PartDocument } from '../part/types.js';
import { drillTop, rectangleProfile, solidIdentity } from './exampleGeometry.js';
import type { PartExample } from './partExample.js';

/** A stored formula with its current value, as the parameter table and the fields keep them. */
function formula(source: string, value: number): ExpressionValue {
  return { source, value, display: String(value) };
}

const zero = expressionValueFromNumber(0);

/**
 * A box whose size follows the parameter table: depth = width / 2 and hole = depth / 4.
 * Changing the width alone resizes the outline, the depth and the hole together.
 */
function createParameterBox(): PartDocument {
  const parameters: readonly Parameter[] = [
    { name: '幅', value: expressionValueFromNumber(80), unit: 'mm', description: '' },
    { name: '奥行', value: formula('幅 / 2', 40), unit: 'mm', description: '' },
    { name: '高さ', value: expressionValueFromNumber(20), unit: 'mm', description: '' },
    { name: '穴径', value: formula('奥行 / 4', 10), unit: 'mm', description: '' },
  ];
  const outline = rectangleProfile('xy',
    { mode: 'absolute', x: formula('-幅 / 2', -40), y: formula('-奥行 / 2', -20), z: zero },
    { mode: 'absolute', x: formula('幅 / 2', 40), y: formula('奥行 / 2', 20), z: zero });
  // The default configuration holds every parameter's source, as the parameter table keeps it in step.
  const part: PartDocument = { ...outline.part, parameters, configurations: createDefaultConfigurations(parameters) };
  const box: ExtrudeFeature = {
    ...solidIdentity(part, 'extrude'), kind: 'extrude', profile: outline.profile,
    distance: formula('高さ', 20), reversed: false, symmetric: false,
  };
  return drillTop(appendSolid(part, box), {
    targetId: box.id, faceIndex: 5, height: 20, faceArea: 80 * 40, centerX: 0, diameter: formula('穴径', 10),
  }).part;
}

export const parameterBoxExample: PartExample = { id: 'parameterBox', create: createParameterBox };
