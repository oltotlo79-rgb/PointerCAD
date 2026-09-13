/** Explicit free variables for a function-definition editor; scalar coordinate editors omit this scope. */
import { MathInputProblem, type MathAxis, type MathParameter, type MathNode } from './mathInputContract.js';

export interface MathVariableScope { readonly axes: readonly MathAxis[]; readonly parameters: readonly MathParameter[] }
function axis(value: unknown): value is MathAxis { return value === 'X' || value === 'Y' || value === 'Z'; }
function parameter(value: unknown): value is MathParameter { return value === 'T' || value === 'U' || value === 'V'; }
function variables<T extends string>(input: unknown, accepts: (value: unknown) => value is T): readonly T[] {
  if (!Array.isArray(input) || input.length > 3) throw new MathInputProblem('syntax', '関数の変数一覧が不正です。');
  const result: T[] = [];
  for (const value of input) {
    if (!accepts(value) || result.includes(value)) throw new MathInputProblem('syntax', '関数の変数が重複しているか、未対応の変数です。');
    result.push(value);
  }
  return Object.freeze(result);
}
export function decodeMathVariableScope(input: unknown): MathVariableScope {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || !('axes' in input) || !('parameters' in input)
    || Object.keys(input).length !== 2) throw new MathInputProblem('syntax', '関数で使う軸と媒介変数を明示してください。');
  return Object.freeze({ axes: variables(input.axes, axis), parameters: variables(input.parameters, parameter) });
}
/** A saved/returned AST cannot add a free axis just because its label resembles a coefficient. */
export function assertMathVariableScope(expression: MathNode, scope: MathVariableScope): void {
  const pending = [expression]; let remaining = 4096;
  while (pending.length > 0) {
    const node = pending.pop(); if (node === undefined) break;
    if (--remaining < 0) throw new MathInputProblem('budget', '関数の変数を調べる式が大きすぎます。');
    if (node.kind === 'symbol') {
      const reference = node.reference;
      if (reference.role === 'axis' && !scope.axes.includes(reference.name)
        || reference.role === 'parameter' && !scope.parameters.includes(reference.name) || reference.role === 'declared') {
        throw new MathInputProblem('syntax', 'この関数で指定していない軸や媒介変数が含まれています。');
      }
    } else if (node.kind === 'operation') pending.push(...node.operands);
    else if (node.kind === 'binder') {
      pending.push(node.body);
      for (const { domain } of node.bindings) {
        if (domain.kind === 'set') pending.push(domain.value);
        else if (domain.kind === 'range') {
          pending.push(domain.lower, domain.upper); if (domain.step !== null) pending.push(domain.step);
        }
      }
    }
  }
}
