/** Resolve current scalar sources and coefficient IDs for both curves and surfaces. */
import { collectMathCoefficients } from '@pointercad/expression';
import { mathGeometryOutsideCoefficientMessage } from '../measure/mathGeometryCoefficients.js';
import { checkGeometryDerivedFunctionOperations, mathGeometryDerivedCoefficientIds } from '../measure/mathGeometryFunctionOperations.js';
import { mathGeometryDefinitionIdOf } from '../measure/mathGeometryIdentity.js';
import type { ParameterAnalysis } from '../parameters/types.js';
import { evaluatedDocumentMathValue } from '../part/evaluateDocumentMath.js';
import type { PartDocument } from '../part/types.js';
import type { FunctionDefinition } from './functionDefinitionTypes.js';
import { mapFunctionDefinition } from './mapFunctionDefinition.js';
import { resolveFunctionRanges } from './resolveFunctionRanges.js';

/**
 * rules/06 §10.317: the calculation tape (`scalarMathTape.ts`) has no `equal` outside a `which` condition, so only
 * F in the "F=0" form the explanation teaches (`function-curve.md`, `function-surface.md`) can ever be sampled. A
 * file saved before the draft editor refused this (GR-18b, `functionPlotDraft.ts`), or edited by hand, can still
 * hold an implicit curve or surface written "A=B" at the root. Left unchecked, it used to reach the tape and fail
 * with its own unclear "作図中に変化する演算「equal」の計算方法を確認してください。" This throws the same guidance
 * the draft editor shows before confirming, instead of silently rewriting to "A-(B)": which side becomes F is a
 * modeling choice the user makes, not one this fix can guess.
 */
export const IMPLICIT_EQUATION_EQUALS_MESSAGE =
  '陰関数は「=」を含む式を計算できません。F=0の左辺Fだけを入力してください。例: X^2+Y^2=1ではなく、X^2+Y^2-1と入力します。';

function implicitEquationRootHasEquals(definition: FunctionDefinition): boolean {
  const formula = definition.formula;
  if (formula.kind !== 'implicit-curve' && formula.kind !== 'implicit-surface') return false;
  const root = formula.expression.expression;
  return root.kind === 'operation' && root.operation === 'equal' && root.operands.length === 2;
}

export async function resolveFunctionInputs(document: PartDocument, definition: FunctionDefinition,
  analysis: ParameterAnalysis, isCurrent: () => boolean) {
  // rules/06 §10.317: unconditional and checked first, so an old file's "=" form always explains what to type
  // instead of reaching the tape's own unclear error further down (sampling, after this function returns).
  if (implicitEquationRootHasEquals(definition)) throw new Error(IMPLICIT_EQUATION_EQUALS_MESSAGE);
  // GR-06b: no plot formula may feed a geometry-derived coefficient into an operation that jumps at a value boundary.
  // The rule is static, so it runs before any range or coefficient value is looked up (a refusal never reads as
  // "pending"); a document without geometry-derived coefficients skips it and keeps its previous path.
  if (analysis.geometryDerived !== undefined) {
    const issue = checkGeometryDerivedFunctionOperations(definition,
      mathGeometryDerivedCoefficientIds(document.parameters, analysis.geometryDerived));
    if (issue !== null) throw new Error(issue.message);
  }
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
    // §4(e), as GR-04 rules: a measured value is read only by a coefficient's own formula, never by a plot formula.
    if (mathGeometryDefinitionIdOf(id) !== null) throw new Error(mathGeometryOutsideCoefficientMessage(label));
    const parameter = document.parameters.find(item => item.mathId === id && item.name === label);
    const decimal = parameter === undefined ? undefined : analysis.exactVariables.get(parameter.name);
    if (decimal === undefined) throw new Error(`係数の原式を再計算できません: ${label}`);
    const original = analysis.mathCoefficients?.get(label);
    if (original === undefined || original.id !== id) throw new Error(`係数の原式を確認できません: ${label}`);
    return original;
  });
  return { status: 'ready', ranges: ranges.ranges, coefficients } as const;
}
