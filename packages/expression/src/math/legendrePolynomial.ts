/** Standard P_n(1)=1 normalization. Exact Rodrigues coefficients, no sampled fit.
 * Reference: NIST DLMF 18.5.7 (Jacobi alpha=beta=0) and 18.9.1.
 */
import { MathInputProblem, MATH_INPUT_LIMITS, type MathNode } from './mathInputContract.js';
import { rational, rationalOfExpression } from './exactRational.js';
import { resolveTypedMathProduct } from './mathProductTypes.js';

const number = (value: bigint | number): MathNode => ({ kind: 'number', decimal: String(value) });
const op = (operation: string, ...operands: MathNode[]): MathNode => ({ kind: 'operation', operation, operands });

function measure(source: MathNode): { nodes: number; depth: number } {
  const pending = [{ node: source, depth: 0 }]; let nodes = 0, deepest = 0;
  while (pending.length > 0) {
    const entry = pending.pop(); if (entry === undefined) break;
    if (++nodes > MATH_INPUT_LIMITS.nodes || entry.depth > MATH_INPUT_LIMITS.depth) {
      throw new MathInputProblem('budget', 'Legendre多項式の引数が複雑すぎます。');
    }
    deepest = Math.max(deepest, entry.depth);
    if (entry.node.kind === 'operation') pending.push(...entry.node.operands.map(node => ({ node, depth: entry.depth + 1 })));
    else if (entry.node.kind === 'binder') {
      throw new MathInputProblem('unsupported', 'Legendre多項式の引数の計算を先に有限な値へ確定してください。');
    }
  }
  return { nodes, depth: deepest };
}

export function lowerLegendrePolynomial(source: MathNode): MathNode | null {
  if (source.kind !== 'operation' || source.operation !== 'legendre') return null;
  if (source.operands.length !== 2) throw new MathInputProblem('syntax', 'Legendre多項式には次数と引数を指定してください。');
  const [order, argument] = source.operands, degree = rationalOfExpression(order);
  if (degree === null) throw new MathInputProblem('unsupported', 'Legendre多項式の次数を整数に確定してください。');
  if (degree.denominator !== 1n || degree.numerator < 0n) throw new MathInputProblem('domain', 'Legendre多項式の次数は0以上の整数です。');
  if (degree.numerator > 128n) throw new MathInputProblem('budget', 'Legendre多項式の次数は128までです。');
  if (resolveTypedMathProduct('times', [argument, number(1)], () => true) !== 'multiply') {
    throw new MathInputProblem('domain', 'Legendre多項式の引数は実数または複素数の式にしてください。');
  }
  const size = measure(argument), n = Number(degree.numerator), count = Math.floor(n / 2) + 1;
  // Check the expanded size before duplicating the argument across polynomial terms.
  if ((size.nodes + 7) * (count + 1) > MATH_INPUT_LIMITS.nodes || size.depth + 4 > MATH_INPUT_LIMITS.depth) {
    throw new MathInputProblem('budget', 'Legendre多項式の式が個数または深さの上限を超えます。');
  }
  const factorial = [1n];
  for (let i = 1; i <= 2 * n; i++) factorial.push(factorial[i - 1] * BigInt(i));
  const terms: MathNode[] = [];
  for (let k = 0; k <= Math.floor(n / 2); k++) {
    const coefficient = rational((k % 2 === 0 ? 1n : -1n) * factorial[2 * n - 2 * k],
      (1n << BigInt(n)) * factorial[k] * factorial[n - k] * factorial[n - 2 * k]);
    if (coefficient === null) throw new MathInputProblem('budget', 'Legendre多項式の係数が桁数の上限を超えました。');
    const value = coefficient.denominator === 1n ? number(coefficient.numerator)
      : op('divide', number(coefficient.numerator), number(coefficient.denominator));
    const power = n - 2 * k;
    terms.push(power === 0 ? value : op('multiply', value, power === 1 ? argument : op('power', argument, number(power))));
  }
  // P_0 is 1 only for a valid scalar argument; retain its original domain in the VM.
  return n === 0 ? op('add', number(1), op('multiply', number(0), argument))
    : terms.length === 1 ? terms[0] : op('add', ...terms);
}
