import type { ScriptFunctionDefinition } from '@pointercad/model/scripting';
import { functionPlotDraft, type FunctionPlotDraft, type FunctionTextDraft } from '../functionPlot/functionPlotDraft.js';
/** Script sources use exactly the same axis/parameter scopes and validation as the form. */
export function scriptFunctionDraft(input: ScriptFunctionDefinition): FunctionPlotDraft {
  const formula = input.formula;
  const geometry = formula.kind.endsWith('-curve') ? 'curve' : 'surface';
  const base = functionPlotDraft(undefined, geometry);
  const value = (source: string): FunctionTextDraft => ({ source, angleUnit: input.angleUnit });
  const scalars = { ...base.scalars, tolerance: value(input.tolerance) };
  for (const axis of ['X', 'Y', 'Z'] as const) {
    scalars[`${axis}.min`] = value(input.bounds[axis][0]);
    scalars[`${axis}.max`] = value(input.bounds[axis][1]);
  }
  const common = { ...base, scalars };
  switch (formula.kind) {
    case 'coordinate-curve': {
      const outputs = { ...base.outputs };
      for (const axis of ['X', 'Y', 'Z'] as const) {
        if (axis !== formula.independent)
          outputs[axis] = value(formula.outputs[axis] ?? '');
      }
      return { ...common, independent: formula.independent, outputs };
    }
    case 'coordinate-surface':
      return { ...common, dependent: formula.output, outputs: { ...base.outputs, [formula.output]: value(formula.expression) } };
    case 'parametric-curve':
    case 'parametric-surface': {
      if (formula.kind === 'parametric-curve') {
        scalars['T.min'] = value(formula.T[0]);
        scalars['T.max'] = value(formula.T[1]);
      }
      else {
        for (const axis of ['U', 'V'] as const) {
          scalars[`${axis}.min`] = value(formula[axis][0]);
          scalars[`${axis}.max`] = value(formula[axis][1]);
        }
      }
      return {
        ...common, form: 'parametric', outputs: {
          X: value(formula.outputs.X), Y: value(formula.outputs.Y), Z: value(formula.outputs.Z),
        }
      };
    }
    case 'implicit-curve':
      return {
        ...common, form: 'implicit', fixedAxis: formula.fixedAxis, equation: value(formula.expression),
        scalars: { ...scalars, fixedCoordinate: value(formula.fixedCoordinate) }
      };
    case 'implicit-surface':
      return { ...common, form: 'implicit', equation: value(formula.expression) };
  }
}
