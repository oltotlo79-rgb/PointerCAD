/** Explicit values are closed formulas, not assignments or assumptions about an unknown symbol. */
import { type MathEvaluation, type MathNode } from './mathInputContract.js';
import type { MathDeclaration } from './mathDeclarations.js';
import type { MathWorkRequest } from './mathWorkRequest.js';
import { CANDIDATE_MATH_OPERATIONS } from './mathOperations.js';
import { parseMathText } from './mathTextSyntax.js';
import { rationalOfExpression } from './exactRational.js';

/** No axes, coefficients or other declarations: values cannot acquire cycles or ambient state. */
export function parseMathDeclaredValue(source: string): MathNode {
  return parseMathText(source, { operations: CANDIDATE_MATH_OPERATIONS,
    names: { axes: new Set(), parameters: new Set(), coefficients: [], declared: [] } });
}

export function mathDeclaredValueRequest(request: MathWorkRequest, source: string): MathWorkRequest {
  return { identity: request.identity, source, notation: 'text', angleUnit: request.angleUnit, coefficients: [] };
}

/** A known conflict is invalid; an unproved integer/rational property remains unresolved. */
export function checkMathDeclaredValue(declaration: MathDeclaration, expression: MathNode,
  evaluation: MathEvaluation): MathEvaluation | null {
  if (evaluation.status !== 'value') return evaluation;
  const invalid = (): MathEvaluation => ({ status: 'invalid', reason: 'domain',
    detail: `${declaration.label}の値と指定した種類が一致しません。値の式または種類を確認してください。` });
  const type = declaration.type, kind = evaluation.kind;
  if (type === 'symbolic') return null;
  if (type === 'complex') return kind === 'real' || kind === 'complex' ? null : invalid();
  if (type === 'set') return kind === 'set' || kind === 'interval' ? null : invalid();
  if (type === 'real') return kind === 'real' ? null : invalid();
  if (type === 'integer' || type === 'natural' || type === 'rational') {
    if (kind !== 'real') return invalid();
    const exact = rationalOfExpression(evaluation.exact ?? expression);
    if (exact === null) return { status: 'unresolved', reason: 'missing-condition', names: [declaration.label] };
    if (type !== 'rational' && exact.denominator !== 1n || type === 'natural' && exact.numerator < 0n) return invalid();
    return null;
  }
  return kind === type ? null : invalid();
}
