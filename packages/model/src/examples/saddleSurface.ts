import { expressionValueFromNumber, type StoredMathExpression } from '@pointercad/expression';
import { FUNCTION_DEFINITION_FORMAT, type FunctionDefinition } from '../functionGeometry/functionDefinitionTypes.js';
import { createFunctionSurface } from '../functionGeometry/functionSurfaceFeature.js';
import type { Parameter } from '../parameters/types.js';
import { createDefaultConfigurations } from '../part/configurationDefaults.js';
import { appendSolid, createEmptyPartDocument } from '../part/createPartDocument.js';
import type { PartDocument } from '../part/types.js';
import type { PartExample } from './partExample.js';

const coefficient = { id: 'coefficient:1', label: 'a' } as const;
const half = 40;
const height = 20;

/**
 * Z = a(X² − Y²) as the function Worker parses it. The calculation boundary reparses the source and refuses
 * a stored tree that differs, so the test compares this literal with the parser's own output.
 */
const saddle: StoredMathExpression = {
  format: 'pointercad-math/1', source: 'coef("a")*(X^2-Y^2)', inputNotation: 'text', angleUnit: 'radian',
  expression: { kind: 'operation', operation: 'multiply', operands: [
    { kind: 'symbol', reference: { role: 'coefficient', id: coefficient.id, label: coefficient.label } },
    { kind: 'operation', operation: 'subtract', operands: [
      { kind: 'operation', operation: 'power', operands: [
        { kind: 'symbol', reference: { role: 'axis', name: 'X' } }, { kind: 'number', decimal: '2' }] },
      { kind: 'operation', operation: 'power', operands: [
        { kind: 'symbol', reference: { role: 'axis', name: 'Y' } }, { kind: 'number', decimal: '2' }] },
    ] },
  ] },
};

/** An open saddle over an 80 x 80 square. With a = 0.01 its height stays within ±16, inside the ±20 box. */
function createSaddleSurface(): PartDocument {
  const empty = createEmptyPartDocument();
  const parameters: readonly Parameter[] = [
    { mathId: coefficient.id, name: coefficient.label, value: expressionValueFromNumber(0.01), unit: 'none', description: '' },
  ];
  const definition: FunctionDefinition = {
    format: FUNCTION_DEFINITION_FORMAT,
    bounds: {
      X: { min: expressionValueFromNumber(-half), max: expressionValueFromNumber(half) },
      Y: { min: expressionValueFromNumber(-half), max: expressionValueFromNumber(half) },
      Z: { min: expressionValueFromNumber(-height), max: expressionValueFromNumber(height) },
    },
    formula: { kind: 'coordinate-surface', output: 'Z', expression: saddle },
    tolerance: expressionValueFromNumber(0.05),
  };
  const part: PartDocument = { ...empty, parameters, configurations: createDefaultConfigurations(parameters) };
  return appendSolid(part, createFunctionSurface(part, definition));
}

export const saddleSurfaceExample: PartExample = { id: 'saddleSurface', create: createSaddleSurface };
