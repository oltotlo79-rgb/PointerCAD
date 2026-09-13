/** Function definitions use the same strict scalar and mathematical readers as other document inputs. */
import { decodeMathExpressionStorage, FREE_WORK_PLANE_ID, FunctionDefinitionProblem, mapFunctionDefinition, readFunctionDefinition,
  type FunctionDefinition, type SketchFunctionCurveFeature } from '@pointercad/model';
import { checkRecord, fieldProblem, joinPath, readExpressionItem, readString, type Checked } from '../guards.js';
import { serializeExpression } from './fields.js';
import { readConstructionFlag, type SketchFeatureBase } from './sketchBase.js';

export function decodeFunctionDefinition(value: unknown): FunctionDefinition {
  return readFunctionDefinition(value, {
    scalar: (input, field) => {
      const read = readExpressionItem(input, field);
      if (!read.ok) throw new FunctionDefinitionProblem(read.problem.path, '数値の原式を確認してください。');
      return read.value;
    },
    math: (input, field) => {
      const record = checkRecord(input, field);
      if (!record.ok) throw new FunctionDefinitionProblem(field, '関数の原式を確認してください。');
      const source = readString(record.value, 'source', field);
      if (!source.ok) throw new FunctionDefinitionProblem(joinPath(field, 'source'), '関数の原式を入力してください。');
      try { return decodeMathExpressionStorage(input, source.value); }
      catch { throw new FunctionDefinitionProblem(field, '関数の数学定義を確認してください。'); }
    },
  });
}

export function serializeFunctionDefinition(definition: FunctionDefinition): FunctionDefinition {
  return decodeFunctionDefinition(mapFunctionDefinition(definition, serializeExpression,
    expression => decodeMathExpressionStorage(expression, expression.source)));
}

export function readFunctionCurveFeature(record: Record<string, unknown>, path: string,
  base: SketchFeatureBase): Checked<SketchFunctionCurveFeature> {
  if (base.planeId !== FREE_WORK_PLANE_ID) return fieldProblem(joinPath(path, 'planeId'), 'type');
  const construction = readConstructionFlag(record, path);
  if (!construction.ok) return construction;
  const definitionPath = joinPath(path, 'definition');
  try {
    const definition = decodeFunctionDefinition(record.definition);
    if (definition.formula.kind !== 'coordinate-curve' && definition.formula.kind !== 'parametric-curve'
      && definition.formula.kind !== 'implicit-curve') return fieldProblem(joinPath(definitionPath, 'formula.kind'), 'type');
    return { ok: true, value: { ...base, kind: 'functionCurve', construction: construction.value, definition } };
  } catch (error) {
    return fieldProblem(error instanceof FunctionDefinitionProblem ? joinPath(definitionPath, error.field) : definitionPath, 'type');
  }
}
