import { addExpression, subtractExpression, translateFunctionExpression, type ExpressionValue, type FunctionAxisTranslation } from '@pointercad/expression';
import type { ShiftAxes } from '../sketch/shiftCoordinate.js';
import type { FunctionDefinition, FunctionFormula, FunctionInputRange } from './functionDefinitionTypes.js';

/** The drawing box and function move together; T/U/V domains and tolerance are unchanged. */
export function shiftFunctionDefinition(definition: FunctionDefinition, shifts: ShiftAxes): FunctionDefinition {
  if (shifts.every(shift => shift.kind === 'keep')) return definition;
  const axes = { X: shifts[0], Y: shifts[1], Z: shifts[2] };
  const scalar = (value: ExpressionValue, shift: FunctionAxisTranslation) => shift.kind === 'keep' ? value
    : shift.kind === 'add' ? addExpression(value, shift.amount) : subtractExpression(value, shift.amount);
  const range = (value: FunctionInputRange, shift: FunctionAxisTranslation): FunctionInputRange => ({ min: scalar(value.min, shift), max: scalar(value.max, shift) });
  const source = definition.formula;
  const formula = (): FunctionFormula => {
    switch (source.kind) {
      case 'coordinate-curve':
        if (source.independent === 'X') return { ...source, outputs: { Y: translateFunctionExpression(source.outputs.Y, axes, 'Y'), Z: translateFunctionExpression(source.outputs.Z, axes, 'Z') } };
        if (source.independent === 'Y') return { ...source, outputs: { X: translateFunctionExpression(source.outputs.X, axes, 'X'), Z: translateFunctionExpression(source.outputs.Z, axes, 'Z') } };
        return { ...source, outputs: { X: translateFunctionExpression(source.outputs.X, axes, 'X'), Y: translateFunctionExpression(source.outputs.Y, axes, 'Y') } };
      case 'parametric-curve': case 'parametric-surface': return { ...source, outputs: {
        X: translateFunctionExpression(source.outputs.X, axes, 'X'), Y: translateFunctionExpression(source.outputs.Y, axes, 'Y'),
        Z: translateFunctionExpression(source.outputs.Z, axes, 'Z') } };
      case 'coordinate-surface': return { ...source, expression: translateFunctionExpression(source.expression, axes, source.output) };
      case 'implicit-curve': return { ...source, expression: translateFunctionExpression(source.expression, axes),
        fixedCoordinate: scalar(source.fixedCoordinate, axes[source.fixedAxis]) };
      case 'implicit-surface': return { ...source, expression: translateFunctionExpression(source.expression, axes) };
    }
  };
  return { ...definition, bounds: { X: range(definition.bounds.X, axes.X), Y: range(definition.bounds.Y, axes.Y), Z: range(definition.bounds.Z, axes.Z) }, formula: formula() };
}
