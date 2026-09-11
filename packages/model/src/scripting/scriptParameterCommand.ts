import { evaluateExpression } from '@pointercad/expression';
import { analyzeParameters, checkNewParameterName } from '../parameters/parameterTable.js';
import { applyParameters } from '../part/reevaluatePart.js';
import { synchronizeConfigurations } from '../part/configurations.js';
import { parseDisplayInput, normalizeInchQuotes } from '../units/length.js';
import { ScriptCommandError, type ScriptCommandChange, type ScriptCommandContext } from './scriptCommandContext.js';
import type { ScriptCommand } from './scriptTypes.js';

export function applyScriptParameterCommand(context: ScriptCommandContext,
  command: Extract<ScriptCommand, { readonly kind: 'parameter.set' }>): ScriptCommandChange {
  const { name, source: entered, unit: requestedUnit } = command.fields;
  if (checkNewParameterName(name) !== null) throw new ScriptCommandError('式から参照できる名前を付けてください。');
  const previous = context.document.parameters.find((parameter) => parameter.name === name);
  const unit = requestedUnit ?? previous?.unit ?? 'mm';
  const source = unit === 'mm' ? parseDisplayInput(normalizeInchQuotes(entered), context.lengthUnit) : entered;
  const analysis = analyzeParameters(context.document.parameters, []);
  const evaluated = evaluateExpression(source, { exactVariables: analysis.exactVariables, nonLengthVariables: analysis.nonLengthVariables });
  if (!evaluated.ok) throw new ScriptCommandError(evaluated.error.message);
  const parameter = { name, unit, value: evaluated.value, description: previous?.description ?? '' };
  const parameters = previous === undefined ? [...context.document.parameters, parameter]
    : context.document.parameters.map((value) => value.name === name ? parameter : value);
  const next = applyParameters(synchronizeConfigurations({ ...context.document, parameters }));
  if (next.analysis.circular.length > 0) throw new ScriptCommandError('パラメータの参照が循環しています。');
  const failure = next.analysis.failures[0] ?? next.failures[0];
  if (failure !== undefined) throw new ScriptCommandError(failure.message);
  return { document: next.document, reference: null, featureIds: [] };
}
