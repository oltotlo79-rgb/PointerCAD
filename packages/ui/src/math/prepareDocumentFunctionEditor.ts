import type { StoredMathExpression } from '@pointercad/expression';
import type { PartDocument, DocumentMathContext } from '@pointercad/model';
import { decodeMathVariableScope, type MathVariableScope } from '@pointercad/expression/math/contracts';
import { prepareDocumentMathEnvironment } from './prepareDocumentMathEditor.js';
import type { MathInsertGroup } from './MathEditorSurface.js';
import { t } from '../i18n/t.js';

export interface FunctionEditorInitial {
  readonly source: string;
  readonly notation: 'text' | 'latex';
  readonly angleUnit: 'degree' | 'radian';
  readonly definition?: StoredMathExpression;
}
/** A function draft has no invented numeric cache. Its variables are separate from named coefficients. */
export async function prepareDocumentFunctionEditor(document: PartDocument, input: FunctionEditorInitial,
  variables: MathVariableScope, context: DocumentMathContext) {
  const scope = decodeMathVariableScope(variables), environment = await prepareDocumentMathEnvironment(document, context);
  const groups: MathInsertGroup[] = [];
  if (scope.axes.length > 0) groups.push({ id: 'axes', label: t('math.axes'), choices: scope.axes.map(name => ({
    id: name, label: name, meaning: `${name}: ${t('math.axisMeaning')}`,
    // Only the six validated one-letter variable names use this path. Named coefficients keep their quoted templates.
    template: name,
  })) });
  if (scope.parameters.length > 0) groups.push({ id: 'parameters', label: t('math.functionParameters'), choices: scope.parameters.map(name => ({
    id: name, label: name, meaning: `${name}: ${t('math.parameterMeaning')}`,
    template: name,
  })) });
  return { ...environment, purpose: 'function' as const, source: input.source, notation: input.notation, angleUnit: input.angleUnit,
    groups: [...groups, ...environment.groups], functionScope: scope };
}
