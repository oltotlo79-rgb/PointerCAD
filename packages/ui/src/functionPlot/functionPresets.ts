import type { FunctionPlotDraft, FunctionFormulaDraft, FunctionScalarDraft, FunctionScalarField } from './functionPlotDraft.js';

export const FUNCTION_PRESETS = [
  {id:'parabola',geometry:'curve',labelKey:'functionPlot.presetParabola',form:'coordinate',outputs:{X:'',Y:'X^2',Z:'0'}},
  {id:'hyperbola',geometry:'curve',labelKey:'functionPlot.presetHyperbola',form:'coordinate',outputs:{X:'',Y:'1/X',Z:'0'}},
  {id:'circle',geometry:'curve',labelKey:'functionPlot.presetCircle',form:'parametric',outputs:{X:'cos(T)',Y:'sin(T)',Z:'0'},ranges:{'T.min':'0','T.max':'360'}},
  {id:'helix',geometry:'curve',labelKey:'functionPlot.presetHelix',form:'parametric',outputs:{X:'cos(T)',Y:'sin(T)',Z:'T/360'},ranges:{'T.min':'0','T.max':'720'}},
  {id:'implicit-circle',geometry:'curve',labelKey:'functionPlot.presetImplicitCircle',form:'implicit',equation:'X^2+Y^2-1',fixedAxis:'Z',fixedCoordinate:'0'},
  {id:'implicit-hyperbola',geometry:'curve',labelKey:'functionPlot.presetImplicitHyperbola',form:'implicit',equation:'X*Y-1',fixedAxis:'Z',fixedCoordinate:'0'},
  {id:'plane',geometry:'surface',labelKey:'functionPlot.presetPlane',form:'coordinate',outputs:{X:'',Y:'',Z:'X+Y'}},
  {id:'saddle',geometry:'surface',labelKey:'functionPlot.presetSaddle',form:'coordinate',outputs:{X:'',Y:'',Z:'X*Y'}},
  {id:'sphere',geometry:'surface',labelKey:'functionPlot.presetSphere',form:'parametric',outputs:{X:'sin(V)*cos(U)',Y:'sin(V)*sin(U)',Z:'cos(V)'},
    ranges:{'U.min':'0','U.max':'360','V.min':'0','V.max':'180'}},
  {id:'torus',geometry:'surface',labelKey:'functionPlot.presetTorus',form:'parametric',outputs:{X:'(2+cos(V))*cos(U)',Y:'(2+cos(V))*sin(U)',Z:'sin(V)'},
    ranges:{'U.min':'0','U.max':'360','V.min':'0','V.max':'360'}},
  {id:'implicit-sphere',geometry:'surface',labelKey:'functionPlot.presetImplicitSphere',form:'implicit',equation:'X^2+Y^2+Z^2-1'},
  {id:'implicit-torus',geometry:'surface',labelKey:'functionPlot.presetImplicitTorus',form:'implicit',equation:'(X^2+Y^2+Z^2+4-0.25)^2-16*(X^2+Y^2)'},
] as const;
export type FunctionPreset = typeof FUNCTION_PRESETS[number];

/** The user still supplies all six XYZ bounds. Presets only replace formulas and parameter ranges. */
export function applyFunctionPreset(draft: FunctionPlotDraft, preset: FunctionPreset): FunctionPlotDraft {
  if (preset.geometry !== draft.geometry) return draft;
  const formula = (source: string): FunctionFormulaDraft => ({source,angleUnit:'degree'});
  const ranges: Partial<Record<FunctionScalarField,FunctionScalarDraft>> = {};
  if('fixedCoordinate' in preset) ranges.fixedCoordinate={source:preset.fixedCoordinate,angleUnit:'degree'};
  if ('ranges' in preset) for (const key of ['T.min','T.max','U.min','U.max','V.min','V.max'] as const) {
    const source: unknown = Object.hasOwn(preset.ranges,key) ? Reflect.get(preset.ranges,key) : undefined;
    if (typeof source === 'string') ranges[key] = {source,angleUnit:'degree'};
  }
  return {...draft,form:preset.form,independent:'X',dependent:'Z',fixedAxis:'fixedAxis' in preset?preset.fixedAxis:draft.fixedAxis,
    outputs:'outputs' in preset ? {X:formula(preset.outputs.X),Y:formula(preset.outputs.Y),Z:formula(preset.outputs.Z)} : draft.outputs,
    equation:'equation' in preset ? formula(preset.equation) : draft.equation,
    scalars:{...draft.scalars,...ranges}};
}
