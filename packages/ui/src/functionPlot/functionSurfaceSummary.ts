import type { FunctionSurfaceFeature } from '@pointercad/model';

/** A readable source summary remains available even when a function cannot be recomputed. */
export function functionSurfaceDetails(feature: FunctionSurfaceFeature) {
  const { formula, bounds, tolerance } = feature.definition;
  const formulas = formula.kind === 'coordinate-surface' ? [`${formula.output} = ${formula.expression.source}`]
    : formula.kind === 'parametric-surface' ? (['X', 'Y', 'Z'] as const).map(axis => `${axis} = ${formula.outputs[axis].source}`)
      : formula.kind === 'implicit-surface' ? [`${formula.expression.source} = 0`] : [];
  return [
    { labelKey: 'functionSurface.formula', text: formulas.join('; ') },
    ...(['X', 'Y', 'Z'] as const).map(axis => ({ labelKey: `functionSurface.range${axis}` as const,
      text: `${bounds[axis].min.source} ～ ${bounds[axis].max.source} mm` })),
    { labelKey: 'functionSurface.tolerance', text: `${tolerance.source} mm` },
  ] as const;
}
