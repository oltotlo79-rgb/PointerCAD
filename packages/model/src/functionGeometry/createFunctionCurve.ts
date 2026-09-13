import { nextFeatureId, nextFeatureName } from '../sketch/createSketchDocument.js';
import { FREE_WORK_PLANE_ID } from '../sketch/planeMath.js';
import type { SketchDocument, SketchFunctionCurveFeature } from '../sketch/types.js';
import type { FunctionDefinition } from './functionDefinitionTypes.js';

export function createFunctionCurve(sketch: SketchDocument, definition: FunctionDefinition): SketchFunctionCurveFeature {
  const kind = definition.formula.kind;
  if (kind !== 'coordinate-curve' && kind !== 'parametric-curve' && kind !== 'implicit-curve') throw new Error('曲線の関数を指定してください。');
  return { id: nextFeatureId(sketch, 'functionCurve'), name: nextFeatureName(sketch, 'functionCurve'),
    kind: 'functionCurve', planeId: FREE_WORK_PLANE_ID, construction: false, definition };
}
