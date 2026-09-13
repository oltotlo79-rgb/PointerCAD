/** Resolve current scalar sources and coefficient IDs for both curves and surfaces. */
import { collectMathCoefficients } from '@pointercad/expression';
import type { ParameterAnalysis } from '../parameters/types.js';
import { evaluatedDocumentMathValue } from '../part/evaluateDocumentMath.js';
import type { PartDocument } from '../part/types.js';
import type { FunctionDefinition } from './functionDefinitionTypes.js';
import { mapFunctionDefinition } from './mapFunctionDefinition.js';
import { resolveFunctionRanges } from './resolveFunctionRanges.js';

export async function resolveFunctionInputs(document: PartDocument, definition: FunctionDefinition,
  analysis: ParameterAnalysis, isCurrent: () => boolean) {
  const ranges = await resolveFunctionRanges(definition, { isCurrent, evaluate: value => {
    const evaluated = evaluatedDocumentMathValue(document, value);
    return Promise.resolve(evaluated === null ? { ok: false, message: '描画範囲の原式を再計算できません。' }
      : { ok: true, value: evaluated.value });
  } });
  if (!isCurrent() || ranges.status === 'cancelled') return { status: 'cancelled' } as const;
  if (ranges.status === 'invalid') throw new Error(ranges.issues.map(issue => `${issue.field}: ${issue.message}`).join('\n'));
  const references = new Map<string, string>();
  mapFunctionDefinition(definition, value => value, expression => {
    for (const reference of collectMathCoefficients(expression.expression)) {
      if (references.has(reference.id) && references.get(reference.id) !== reference.label) throw new Error('係数の参照名が一致しません。');
      references.set(reference.id, reference.label);
    }
    return expression;
  });
  const coefficients = [...references].map(([id, label]) => {
    const parameter = document.parameters.find(item => item.mathId === id && item.name === label);
    const decimal = parameter === undefined ? undefined : analysis.exactVariables.get(parameter.name);
    if (decimal === undefined) throw new Error(`係数の原式を再計算できません: ${label}`);
    const original = analysis.mathCoefficients?.get(label);
    if (original === undefined || original.id !== id) throw new Error(`係数の原式を確認できません: ${label}`);
    return original;
  });
  return { status: 'ready', ranges: ranges.ranges, coefficients } as const;
}
