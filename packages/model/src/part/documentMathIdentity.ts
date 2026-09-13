import { collectMathCoefficients } from '@pointercad/expression';
import { allocateParameterMathIds } from '../parameters/parameterMathIdentity.js';
import { mapDocumentExpressions } from './reevaluatePart.js';
import { mapDocumentFunctionExpressions } from './documentFunctions.js';
import type { PartDocument } from './types.js';

/** Prepare privately; the editor publishes this only together with its accepted mathematical expression. */
export function prepareDocumentMathIdentity(document: PartDocument): PartDocument {
  let serial = document.mathParameterSerial ?? 0;
  // Unresolved references also reserve their old IDs, including before the first persisted counter existed.
  const reserve = (id: string) => {
    const match = /^coefficient:([1-9][0-9]*)$/u.exec(id);
    if (match === null) return;
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value)) throw new Error('係数の参照番号が上限を超えています。');
    serial = Math.max(serial, value);
  };
  mapDocumentExpressions(document, value => {
    if (value.mathDefinition) for (const reference of collectMathCoefficients(value.mathDefinition.expression)) reserve(reference.id);
    return value;
  });
  for (const parameter of document.parameters) {
    if (parameter.value.mathDefinition) for (const reference of collectMathCoefficients(parameter.value.mathDefinition.expression)) reserve(reference.id);
  }
  for (const configuration of document.configurations) for (const definition of Object.values(configuration.mathDefinitions ?? {})) {
    for (const reference of collectMathCoefficients(definition.expression)) reserve(reference.id);
  }
  mapDocumentFunctionExpressions(document, definition => {
    for (const reference of collectMathCoefficients(definition.expression)) reserve(reference.id);
    return definition;
  });
  const assigned = allocateParameterMathIds(document.parameters, serial);
  return assigned.parameters === document.parameters && assigned.nextSerial === document.mathParameterSerial ? document
    : { ...document, parameters: assigned.parameters, mathParameterSerial: assigned.nextSerial };
}
