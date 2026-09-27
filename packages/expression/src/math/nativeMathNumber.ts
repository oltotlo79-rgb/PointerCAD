/** Exact rationals and the existing 40-digit decimal arithmetic, without an external CAS. */
import type { Decimal } from 'decimal.js';
import { ExpressionDecimal, PI, E } from '../evaluate.js';
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { CANDIDATE_MATH_OPERATIONS } from './mathOperations.js';
import { rationalOfExpression, decimalRational, type ExactRational } from './exactRational.js';
import type { EngineMathJson } from './encodeMathJson.js';

export const numberJson = (value: string | number | bigint): EngineMathJson => ({ num: String(value) });
export function rationalJson(value: ExactRational): EngineMathJson {
  return value.denominator === 1n ? numberJson(value.numerator)
    : ['Rational', numberJson(value.numerator), numberJson(value.denominator)];
}
export function scalarNode(value: EngineMathJson, depth = 0): MathNode | null {
  if (depth > 64) throw new MathInputProblem('budget', '数式の入れ子が深すぎます。');
  if (typeof value === 'string') return value === 'Pi' ? { kind: 'constant', name: 'pi' }
    : value === 'ExponentialE' ? { kind: 'constant', name: 'e' } : null;
  if ('num' in value) return { kind: 'number', decimal: value.num };
  const operation = value[0] === 'Rational' ? 'divide' : CANDIDATE_MATH_OPERATIONS.get(value[0])?.id;
  if (operation === undefined) return null;
  const operands: MathNode[] = [];
  for (const child of value.slice(1)) {
    const node = scalarNode(child, depth + 1); if (node === null) return null;
    operands.push(node);
  }
  return { kind: 'operation', operation, operands };
}
export function jsonRational(value: EngineMathJson): ExactRational | null {
  if (typeof value !== 'string' && 'num' in value) return decimalRational(value.num);
  const node = scalarNode(value); return node === null ? null : rationalOfExpression(node);
}
export function jsonDecimal(value: EngineMathJson): Decimal | null {
  if (typeof value !== 'string' && 'num' in value) return new ExpressionDecimal(value.num);
  if (value === 'Pi') return PI;
  if (value === 'ExponentialE') return E;
  const rational = jsonRational(value);
  return rational === null ? null : new ExpressionDecimal(rational.numerator.toString()).div(rational.denominator.toString());
}
export function decimalOperation(head: string, args: readonly EngineMathJson[]): EngineMathJson | null {
  const values: Decimal[] = [];
  for (const value of args) { const decimal = jsonDecimal(value); if (decimal === null) return null; values.push(decimal); }
  const [a, b] = values;
  let result: Decimal;
  switch (head) {
    case 'Add': result = values.reduce((x, y) => x.add(y), new ExpressionDecimal(0)); break;
    case 'Multiply': result = values.reduce((x, y) => x.mul(y), new ExpressionDecimal(1)); break;
    case 'Subtract': result = a.sub(b); break;
    case 'Divide': case 'Rational': result = a.div(b); break;
    case 'Power': result = a.pow(b); break;
    case 'Square': result = a.mul(a); break;
    case 'Sqrt': result = a.sqrt(); break;
    case 'Root': result = a.pow(new ExpressionDecimal(1).div(b)); break;
    case 'Negate': result = a.neg(); break;
    case 'Abs': result = a.abs(); break;
    case 'Sign': return numberJson(a.isZero() ? 0 : a.isNegative() ? -1 : 1);
    case 'Floor': result = a.floor(); break;
    case 'Ceil': result = a.ceil(); break;
    case 'Round': {
      const digits = b?.toNumber() ?? 0;
      if (!Number.isSafeInteger(digits) || Math.abs(digits) > 2048) throw new MathInputProblem('budget', '丸める桁数が大きすぎます。');
      const scale = new ExpressionDecimal(10).pow(digits);
      result = a.mul(scale).toDecimalPlaces(0, ExpressionDecimal.ROUND_HALF_EVEN).div(scale); break;
    }
    case 'Min': result = ExpressionDecimal.min(...values); break;
    case 'Max': result = ExpressionDecimal.max(...values); break;
    case 'Mod': result = a.sub(a.div(b).floor().mul(b)); break;
    case 'Exp': result = a.exp(); break;
    case 'Ln': result = a.ln(); break;
    case 'Log': result = a.log(b); break;
    case 'Lb': result = a.log(2); break;
    case 'Lg': result = a.log(10); break;
    case 'Sin': result = a.sin(); break;
    case 'Cos': result = a.cos(); break;
    case 'Tan': result = a.tan(); break;
    case 'Cot': result = new ExpressionDecimal(1).div(a.tan()); break;
    case 'Sec': result = new ExpressionDecimal(1).div(a.cos()); break;
    case 'Csc': result = new ExpressionDecimal(1).div(a.sin()); break;
    case 'Arcsin': result = a.asin(); break;
    case 'Arccos': result = a.acos(); break;
    case 'Arctan': result = a.atan(); break;
    case 'Sinh': result = a.sinh(); break;
    case 'Cosh': result = a.cosh(); break;
    case 'Tanh': result = a.tanh(); break;
    case 'Arsinh': result = a.asinh(); break;
    case 'Arcosh': result = a.acosh(); break;
    case 'Artanh': result = a.atanh(); break;
    default: return null;
  }
  return result.isFinite() ? numberJson(result.toString()) : result.isNaN() ? 'NaN' : 'ComplexInfinity';
}
