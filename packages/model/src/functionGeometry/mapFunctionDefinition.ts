/** Traverse scalar bounds separately from formulas with free coordinate/parameter variables. */
import type { ExpressionValue, StoredMathExpression } from '@pointercad/expression';
import type { FunctionDefinition, FunctionFormula, FunctionInputRange } from './functionDefinitionTypes.js';

export function mapFunctionDefinition(definition: FunctionDefinition,
  mapValue: (value: ExpressionValue) => ExpressionValue,
  mapFormula: (formula: StoredMathExpression) => StoredMathExpression = formula => formula): FunctionDefinition {
  let changed = false;
  const value = (input: ExpressionValue) => { const next = mapValue(input); changed ||= next !== input; return next; };
  const math = (input: StoredMathExpression) => { const next = mapFormula(input); changed ||= next !== input; return next; };
  const range = (input: FunctionInputRange): FunctionInputRange => ({ min: value(input.min), max: value(input.max) });
  const bounds = { X: range(definition.bounds.X), Y: range(definition.bounds.Y), Z: range(definition.bounds.Z) };
  const tolerance = value(definition.tolerance), source = definition.formula;
  const formula = (): FunctionFormula => {
    switch (source.kind) {
      case 'coordinate-curve':
        if (source.independent === 'X') return { ...source, outputs: { Y: math(source.outputs.Y), Z: math(source.outputs.Z) } };
        if (source.independent === 'Y') return { ...source, outputs: { X: math(source.outputs.X), Z: math(source.outputs.Z) } };
        return { ...source, outputs: { X: math(source.outputs.X), Y: math(source.outputs.Y) } };
      case 'parametric-curve': return { ...source, T: range(source.T),
        outputs: { X: math(source.outputs.X), Y: math(source.outputs.Y), Z: math(source.outputs.Z) } };
      case 'implicit-curve': return { ...source, fixedCoordinate: value(source.fixedCoordinate), expression: math(source.expression) };
      case 'coordinate-surface': case 'implicit-surface': return { ...source, expression: math(source.expression) };
      case 'parametric-surface': return { ...source, U: range(source.U), V: range(source.V),
        outputs: { X: math(source.outputs.X), Y: math(source.outputs.Y), Z: math(source.outputs.Z) } };
    }
  };
  const nextFormula = formula();
  return changed ? { ...definition, bounds, tolerance, formula: nextFormula } : definition;
}
