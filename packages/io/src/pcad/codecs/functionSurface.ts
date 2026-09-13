/** Only source formulas, coefficient references and finite XYZ ranges belong in the document. */
import { FunctionDefinitionProblem, type FunctionSurfaceFeature } from '@pointercad/model';
import { fieldProblem, joinPath, type Checked } from '../guards.js';
import type { SolidFeatureBase } from './solidBase.js';
import { decodeFunctionDefinition, serializeFunctionDefinition } from './functionGeometry.js';

export function readFunctionSurfaceFeature(record: Record<string, unknown>, path: string,
  base: SolidFeatureBase): Checked<FunctionSurfaceFeature> {
  const definitionPath = joinPath(path, 'definition');
  try {
    const definition = decodeFunctionDefinition(record.definition), kind = definition.formula.kind;
    if (kind !== 'coordinate-surface' && kind !== 'parametric-surface' && kind !== 'implicit-surface') {
      return fieldProblem(joinPath(definitionPath, 'formula.kind'), 'type');
    }
    return { ok: true, value: { ...base, kind: 'functionSurface', definition } };
  } catch (error) {
    return fieldProblem(error instanceof FunctionDefinitionProblem ? joinPath(definitionPath, error.field) : definitionPath, 'type');
  }
}
export function serializeFunctionSurfaceFeature(feature: FunctionSurfaceFeature): FunctionSurfaceFeature {
  const definition = serializeFunctionDefinition(feature.definition), kind = definition.formula.kind;
  if (kind !== 'coordinate-surface' && kind !== 'parametric-surface' && kind !== 'implicit-surface') {
    throw new FunctionDefinitionProblem('formula.kind', '面を描く関数の形式を選んでください。');
  }
  return { id: feature.id, name: feature.name, suppressed: feature.suppressed, kind: 'functionSurface', definition };
}
