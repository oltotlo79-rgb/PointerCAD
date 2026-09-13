/** Original expressions keep rounding out of geometric existence/precision proofs. */
import { parse } from '../parse.js';
import { ExpressionDecimal } from '../evaluate.js';
import { DISPLAY_SIGNIFICANT_DIGITS } from '../evaluateExpression.js';
import type { ExpressionValue } from '../evaluateExpression.js';
import { legacyMathToDefinition, type LegacyMathNames } from './legacyMathBridge.js';
import { convertMathAngleConvention, mathInRadians } from './mathAngleConvention.js';
import { decodeStoredMathNode } from './decodeStoredMath.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { MATH_INPUT_LIMITS, MathInputProblem, type MathNode } from './mathInputContract.js';
import { rationalOfExpression } from './exactRational.js';

export interface MathCoefficientValue {
  readonly id: string;
  readonly label: string;
  /** Presentation cache, never the source of a geometric proof when exactExpression is present. */
  readonly decimal: string;
  /** Closed original expression in radians; historical point snapshots are decoded again before use. */
  readonly exactExpression?: MathNode;
}

/** Keep values unknown until their runtime shape has been checked. */
function nestedObjects(value: object): object[] {
  const children: unknown[] = Object.values(value);
  return children.filter((child): child is object => child !== null && typeof child === 'object');
}

/** Clone and close the transport value; axis/parameter leaves are forbidden even inside binders. */
export function decodeCoefficientExpression(value: unknown, spend?: () => void): MathNode {
  const result = decodeStoredMathNode(value, {
    operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(), declaredIds: new Set(),
  });
  const pending: object[] = [result];
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined) break;
    if ('kind' in item) spend?.();
    if ('kind' in item && item.kind === 'symbol' && 'reference' in item) {
      const reference = item.reference;
      if (reference === null || typeof reference !== 'object' || !('role' in reference) || reference.role !== 'bound') {
        throw new MathInputProblem('syntax', '係数の原式には未確定の座標や変数を含められません。');
      }
    }
    pending.push(...nestedObjects(item));
    Object.freeze(item);
  }
  return result;
}

export function coefficientExpression(value: MathCoefficientValue, angleUnit: 'degree' | 'radian' = 'radian'): MathNode {
  return value.exactExpression === undefined ? { kind: 'number', decimal: value.decimal }
    : convertMathAngleConvention(value.exactExpression, 'radian', angleUnit);
}

export function coefficientExpressionMap(values: readonly MathCoefficientValue[], angleUnit: 'degree' | 'radian' = 'radian'): ReadonlyMap<string, MathNode> {
  return new Map(values.map(value => [value.id, coefficientExpression(value, angleUnit)]));
}

/** Substitute closed expressions with fresh bound names and a shared expansion budget. */
export function substituteCoefficientExpressions(source: MathNode, values: ReadonlyMap<string, MathNode>): MathNode {
  let remaining = MATH_INPUT_LIMITS.nodes, serial = 0;
  const occupied = new Set<string>();
  const pending: object[] = [source];
  let scopeBudget = MATH_INPUT_LIMITS.nodes * 8;
  while (pending.length > 0) {
    if (--scopeBudget < 0) throw new MathInputProblem('budget', '係数を展開する式が大きすぎます。');
    const node = pending.pop();
    if (node === undefined) break;
    if ('id' in node && typeof node.id === 'string') occupied.add(node.id);
    pending.push(...nestedObjects(node));
  }
  const nextBoundId = (): string => {
    let id: string;
    do { id = `coefficient-bound:${++serial}`; } while (occupied.has(id));
    occupied.add(id);
    return id;
  };
  function visit(node: MathNode, depth: number, names: ReadonlyMap<string, string>, replacement: boolean): MathNode {
    if (--remaining < 0 || depth > MATH_INPUT_LIMITS.depth) throw new MathInputProblem('budget', '係数の原式を展開する範囲が大きすぎます。');
    if (node.kind === 'symbol') {
      if (node.reference.role === 'coefficient' && !replacement) {
        const value = values.get(node.reference.id);
        if (value === undefined) throw new MathInputProblem('syntax', '係数の原式を再計算できません。');
        return visit(value, depth + 1, new Map(), true);
      }
      if (node.reference.role === 'bound') {
        const id = names.get(node.reference.id);
        return id === undefined ? node : { ...node, reference: { ...node.reference, id } };
      }
      if (replacement) throw new MathInputProblem('syntax', '係数の原式に未確定の参照が残っています。');
      return node;
    }
    if (node.kind === 'operation') return { ...node, operands: node.operands.map(child => visit(child, depth + 1, names, replacement)) };
    if (node.kind === 'binder') {
      const nested = new Map(names);
      const bindings = node.bindings.map(binding => {
        const domain = binding.domain;
        const next = domain.kind === 'set' ? { ...domain, value: visit(domain.value, depth + 1, nested, replacement) }
          : domain.kind === 'range' ? { ...domain, lower: visit(domain.lower, depth + 1, nested, replacement),
            upper: visit(domain.upper, depth + 1, nested, replacement),
            step: domain.step === null ? null : visit(domain.step, depth + 1, nested, replacement) } : domain;
        const id = replacement ? nextBoundId() : binding.variable.id;
        nested.set(binding.variable.id, id);
        return { ...binding, variable: { ...binding.variable, id }, domain: next };
      });
      return { ...node, bindings, body: visit(node.body, depth + 1, nested, replacement) };
    }
    return node;
  }
  return visit(source, 0, new Map(), false);
}

/** Called only after the immutable document has validated this source and its dependencies. */
export function originalCoefficientExpression(value: ExpressionValue, names: LegacyMathNames,
  dependencies: readonly MathCoefficientValue[]): MathNode {
  const own = value.mathDefinition?.expression ?? legacyMathToDefinition(parse(value.source), names).expression;
  const radians = mathInRadians(own, value.mathDefinition?.angleUnit ?? 'degree');
  const expanded = substituteCoefficientExpressions(radians, coefficientExpressionMap(dependencies));
  const exact = rationalOfExpression(expanded);
  if (exact !== null) {
    const numerator = exact.numerator.toString(), denominator = exact.denominator.toString();
    if (numerator.replace('-', '').length <= MATH_INPUT_LIMITS.literalDigits && denominator.length <= MATH_INPUT_LIMITS.literalDigits) {
      const first: MathNode = { kind: 'number', decimal: numerator };
      return decodeCoefficientExpression(exact.denominator === 1n ? first
        : { kind: 'operation', operation: 'divide', operands: [first, { kind: 'number', decimal: denominator }] });
    }
  }
  return decodeCoefficientExpression(expanded);
}

/** Round once after rational dependencies have been expanded, including legacy coefficient chains. */
export function exactCoefficientScalar(expression: MathNode): { readonly value: number; readonly decimal: string; readonly display: string } | null {
  const exact = rationalOfExpression(expression);
  if (exact === null) return null;
  const result = new ExpressionDecimal(exact.numerator.toString()).div(exact.denominator.toString());
  const value = result.toNumber();
  if (!Number.isFinite(value) || (value === 0 && exact.numerator !== 0n)) throw new MathInputProblem('domain', '係数の原式の値を有限の座標で表せません。');
  return { value, decimal: result.toString(), display: result.toSignificantDigits(DISPLAY_SIGNIFICANT_DIGITS).toString() };
}
