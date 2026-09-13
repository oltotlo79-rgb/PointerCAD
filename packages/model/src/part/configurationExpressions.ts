import type { StoredMathExpression } from '@pointercad/expression';
import type { Parameter } from '../parameters/types.js';
import type { Configuration } from './configurations.js';

/** Definitions are optional per entry. A plain source override explicitly returns that entry to legacy input. */
export function configurationDefinitions(parameters: readonly Parameter[], values: Configuration['values']): Configuration['mathDefinitions'] {
  const entries: [string, StoredMathExpression][] = [];
  for (const parameter of parameters) {
    const definition = parameter.value.mathDefinition;
    if (definition !== undefined && definition.source === values[parameter.name]) entries.push([parameter.name, definition]);
  }
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

export function configurationParameters(parameters: readonly Parameter[], configuration: Pick<Configuration, 'values' | 'mathDefinitions'>): readonly Parameter[] {
  let changed = false;
  const result = parameters.map(parameter => {
    const source = configuration.values[parameter.name], mathDefinition = configuration.mathDefinitions?.[parameter.name];
    if (source === parameter.value.source && mathDefinition === parameter.value.mathDefinition) return parameter;
    changed = true;
    // Omit a previous definition when the target configuration explicitly contains a legacy expression.
    const value = { source, value: parameter.value.value, display: parameter.value.display,
      ...(mathDefinition === undefined ? {} : { mathDefinition }) };
    return { ...parameter, value };
  });
  return changed ? result : parameters;
}

export function sameConfigurationDefinitions(left: Configuration['mathDefinitions'], right: Configuration['mathDefinitions']): boolean {
  const entries = Object.entries(left ?? {});
  return entries.length === Object.keys(right ?? {}).length && entries.every(([name, definition]) => right?.[name] === definition);
}
