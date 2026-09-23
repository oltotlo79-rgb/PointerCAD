/** Free-variable formulas have their own visitor; they must never enter scalar coordinate evaluation. */
import type { StoredMathExpression } from '@pointercad/expression';
import { mapFunctionDefinition } from '../functionGeometry/mapFunctionDefinition.js';
import type { FunctionFormula } from '../functionGeometry/functionDefinitionTypes.js';
import type { FunctionExpressionScope } from '../functionGeometry/readFunctionDefinition.js';
import type { PartDocument } from './types.js';

export function functionExpressionScope(formula: FunctionFormula): FunctionExpressionScope {
  switch (formula.kind) {
    case 'coordinate-curve': return { axes: [formula.independent], parameters: [] };
    case 'parametric-curve': return { axes: [], parameters: ['T'] };
    case 'parametric-surface': return { axes: [], parameters: ['U', 'V'] };
    case 'implicit-surface': return { axes: ['X', 'Y', 'Z'], parameters: [] };
    case 'coordinate-surface': return { axes: (['X', 'Y', 'Z'] as const).filter(axis => axis !== formula.output), parameters: [] };
    case 'implicit-curve': return { axes: (['X', 'Y', 'Z'] as const).filter(axis => axis !== formula.fixedAxis), parameters: [] };
  }
}

export function mapDocumentFunctionExpressions(document: PartDocument,
  map: (definition: StoredMathExpression, ownerId: string, scope: FunctionExpressionScope) => StoredMathExpression): PartDocument {
  let changed = false;
  const sketches = document.sketches.map(sketch => {
    let sketchChanged = false;
    const features = sketch.features.map(feature => {
      if (feature.kind !== 'functionCurve') return feature;
      const scope = functionExpressionScope(feature.definition.formula);
      const definition = mapFunctionDefinition(feature.definition, value => value, formula => map(formula, feature.id, scope));
      if (definition === feature.definition) return feature;
      sketchChanged = true;
      return { ...feature, definition };
    });
    changed ||= sketchChanged;
    return sketchChanged ? { ...sketch, features } : sketch;
  });
  const solids = document.solids.map(feature => {
    if (feature.kind !== 'functionSurface') return feature;
    const scope = functionExpressionScope(feature.definition.formula);
    const definition = mapFunctionDefinition(feature.definition, value => value, formula => map(formula, feature.id, scope));
    if (definition === feature.definition) return feature;
    changed = true;
    return { ...feature, definition };
  });
  return changed ? { ...document, sketches, solids } : document;
}

/** Visit formulas used for references/renaming without evaluating them as scalar coordinates. */
export function mapDocumentNonScalarExpressions(document: PartDocument,
  map: (definition: StoredMathExpression, ownerId: string, scope: FunctionExpressionScope) => StoredMathExpression): PartDocument {
  const result = mapDocumentFunctionExpressions(document, map);
  if (result.unresolvedMathProblems === undefined) return result;
  let changed = false;
  const unresolvedMathProblems = result.unresolvedMathProblems.map(problem => {
    const definition = map(problem.definition, problem.id, { axes: [], parameters: [] });
    if (definition === problem.definition) return problem;
    changed = true;
    return { ...problem, definition };
  });
  return changed ? { ...result, unresolvedMathProblems } : result;
}
