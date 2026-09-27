/** Check the original argument before a component or zero product can erase it. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { rationalOfExpression } from './exactRational.js';
import { resolveTypedMathProduct } from './mathProductTypes.js';
import { exactComplexRational } from './exactComplexRational.js';
import { validateComplexErrorArgument } from './complexErrorFunctionNumeric.js';
import { createNativeMathBox } from './nativeMathBackend.js';
import { complexParts } from './nativeMathComplex.js';
import { jsonRational } from './nativeMathNumber.js';
import { encodeMathInRadians } from './mathAngleConvention.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import type { EngineMathJson } from './encodeMathJson.js';

export function normalizeErrorFunction(node: MathNode, angleUnit: 'degree' | 'radian'): MathNode {
  if (node.kind !== 'operation' || !['erf', 'erfc'].includes(node.operation)) return node;
  const argument = node.operands[0];
  if (node.operands.length !== 1) throw new MathInputProblem('syntax', '誤差関数には引数を1つ指定してください。');
  if (resolveTypedMathProduct('times', [argument, { kind: 'number', decimal: '1' }], () => true) !== 'multiply') {
    throw new MathInputProblem('domain', '誤差関数の引数は一つの数の式で指定してください。');
  }
  let dynamic = false;
  const pending = [argument];
  while (pending.length > 0) {
    const part = pending.pop(); if (part === undefined) break;
    if (part.kind === 'constant' && part.name === 'infinity') {
      throw new MathInputProblem('domain', '誤差関数の引数は有限の値で指定してください。');
    }
    if (part.kind === 'symbol') dynamic = true;
    else if (part.kind === 'operation') pending.push(...part.operands);
    else if (part.kind === 'binder') throw new MathInputProblem('unsupported', '誤差関数の引数の計算を先に確定してください。');
  }
  const exact = rationalOfExpression(argument);
  if (!dynamic) {
    let pair = exactComplexRational(argument);
    if (pair === null) {
      // Check the complete closed argument before zero/component rewrites. Exact
      // rational components above must not be rounded onto a numerical boundary.
      const deadline = performance.now() + 1000;
      const check = (): void => {
        if (performance.now() > deadline) throw new MathInputProblem('budget', '誤差関数の引数の確認が計算時間を超えました。');
      };
      const box = createNativeMathBox(encodeMathInRadians(argument, CANDIDATE_MATH_BY_ID, angleUnit), check);
      const parts = complexParts(box.evaluate().N().json as EngineMathJson);
      const real = parts === null ? null : jsonRational(parts[0]);
      const imaginary = parts === null ? null : jsonRational(parts[1]);
      if (real === null || imaginary === null) throw new MathInputProblem('unsupported', '誤差関数の引数を有限の数へ確定できません。');
      pair = [real, imaginary];
    }
    if (pair[1].numerator !== 0n) validateComplexErrorArgument(...pair);
    else if (pair[0].numerator > 500_000n * pair[0].denominator || pair[0].numerator < -500_000n * pair[0].denominator) {
      throw new MathInputProblem('budget', '誤差関数の引数は絶対値500000までです。');
    }
  }
  return exact?.numerator === 0n ? { kind: 'number', decimal: node.operation === 'erf' ? '0' : '1' } : node;
}
