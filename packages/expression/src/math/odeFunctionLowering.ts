/** Select a verified ODE branch once; sampling receives only ordinary expressions and original domains. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import type { OdeSolutions } from './differentialEquations.js';
import { exactMathBoolean } from './pruneMathPiecewise.js';
import { prepareMathCalculation } from './prepareMathCalculation.js';
import { evaluatePreparedScalarMath, type PreparedScalarMathContext } from './evaluatePreparedScalarMath.js';
import { mathScalarValue } from './mathScalarExpression.js';

export interface PreparedOdeFunction {
  readonly expression: MathNode;
  readonly guards: readonly MathNode[];
}
const number = (decimal: string): MathNode => ({ kind: 'number', decimal });
const operation = (name: string, ...operands: MathNode[]): MathNode => ({ kind: 'operation', operation: name, operands });
export const odeProblemKey = (source: MathNode, angleUnit: 'degree' | 'radian'): string => JSON.stringify([angleUnit, source]);
export function containsOdeProblem(source: MathNode): boolean {
  const pending = [source];
  let remaining = 4096;
  while (pending.length > 0) {
    if (--remaining < 0) throw new MathInputProblem('budget', '微分方程式を含む入力が大きすぎます。');
    const node = pending.pop();
    if (node?.kind === 'operation') {
      if (node.operation === 'solve-ode' || node.operation === 'ode-value') return true;
      pending.push(...node.operands);
    } else if (node?.kind === 'binder') pending.push(node.body);
  }
  return false;
}

/** Only real-input rules are used to turn complex intermediate finiteness into real guards. */
function provablyReal(node: MathNode): boolean {
  if (node.kind === 'number') return true;
  if (node.kind === 'symbol') return node.reference.role === 'axis' || node.reference.role === 'parameter';
  if (node.kind === 'constant') return node.name === 'pi' || node.name === 'e';
  return node.kind === 'operation' && ['add', 'subtract', 'multiply', 'divide', 'negate', 'absolute',
    'exponential', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinh', 'cosh', 'tanh'].includes(node.operation)
    && node.operands.every(provablyReal);
}
function finiteOriginal(node: MathNode): readonly MathNode[] {
  if (node.kind === 'operation') {
    // Finite complex operands are closed under these operations. Each original
    // child is retained; 0*anUndefinedValue must never lose that child's guard.
    if (['add', 'subtract', 'multiply', 'negate', 'absolute', 'conjugate', 'real-part', 'imaginary-part',
      'exponential', 'sin', 'cos', 'sinh', 'cosh'].includes(node.operation)) return node.operands.flatMap(finiteOriginal);
    if (node.operation === 'natural-log' && node.operands.length === 1 && provablyReal(node.operands[0])) {
      // log(negative real) is complex but finite. log(abs(x)) preserves exactly
      // its zero exclusion without incorrectly requiring a positive argument.
      return [operation('natural-log', operation('absolute', node.operands[0]))];
    }
  }
  if (node.kind === 'constant' && node.name === 'imaginary-unit') return [];
  return [node];
}
function conditionGuards(node: MathNode): readonly MathNode[] {
  const known = exactMathBoolean(node);
  if (known === true) return [];
  if (known === false) throw new MathInputProblem('domain', '指定した定数は微分方程式の条件を満たしません。');
  if (node.kind === 'operation' && node.operation === 'and') return node.operands.flatMap(conditionGuards);
  if (node.kind === 'operation' && node.operands.length === 2) {
    const [left, right] = node.operands;
    if (node.operation === 'not-equal') return [operation('divide', number('1'), operation('subtract', left, right))];
    const reversed = node.operation === 'less' || node.operation === 'less-equal';
    const difference = operation('subtract', reversed ? right : left, reversed ? left : right);
    if (node.operation === 'greater' || node.operation === 'less') return [operation('natural-log', difference)];
    if (node.operation === 'greater-equal' || node.operation === 'less-equal') {
      return [operation('power', difference, operation('divide', number('1'), number('2')))];
    }
  }
  throw new MathInputProblem('unsupported', 'この解候補の成立条件を作図区間で確認できません。条件を具体的に指定してください。');
}
function substituteBound(node: MathNode, replacements: ReadonlyMap<string, MathNode>, depth = 0): MathNode {
  if (depth > 64) throw new MathInputProblem('budget', '解候補の式が深すぎます。');
  if (node.kind === 'symbol' && node.reference.role === 'bound') {
    const replacement = replacements.get(node.reference.id);
    if (replacement === undefined) throw new MathInputProblem('syntax', '解候補の変数が元の式と一致しません。');
    return replacement;
  }
  if (node.kind === 'operation') return { ...node, operands: node.operands.map(value => substituteBound(value, replacements, depth + 1)) };
  if (node.kind === 'binder') throw new MathInputProblem('syntax', '解候補に未確認の変数が残っています。');
  return node;
}
export function lowerOdeFunction(source: MathNode, solutions: ReadonlyMap<string, OdeSolutions>,
  context: PreparedScalarMathContext): PreparedOdeFunction {
  const guards: MathNode[] = [];
  let remaining = 4096;
  function constant(node: MathNode): number {
    const pending = [node];
    while (pending.length > 0) {
      const item = pending.pop();
      if (item?.kind === 'symbol' || item?.kind === 'binder') {
        throw new MathInputProblem('domain', '解候補の番号と積分定数には、作図変数を含まない有限の実数を指定してください。');
      }
      if (item?.kind === 'operation') pending.push(...item.operands);
    }
    const prepared = prepareMathCalculation(node, { angleUnit: context.angleUnit, resolve: () => null });
    if (prepared.status !== 'ready') throw new MathInputProblem('domain', '積分定数を先に確定してください。');
    const value = mathScalarValue(evaluatePreparedScalarMath(prepared.expression, node, context));
    if (!value.ok) throw new MathInputProblem('domain', value.message);
    return value.value;
  }
  function visit(node: MathNode, depth = 0): MathNode {
    if (--remaining < 0 || depth > 64 || context.shouldStop() !== undefined) {
      throw new MathInputProblem('budget', '解曲線の準備を中止しました。');
    }
    if (node.kind !== 'operation') {
      if (node.kind === 'binder') return { ...node, body: visit(node.body, depth + 1) };
      return node;
    }
    if (node.operation !== 'ode-value') return { ...node, operands: node.operands.map(value => visit(value, depth + 1)) };
    if (node.operands.length !== 4) throw new MathInputProblem('syntax', '解候補と定数、調べる位置を指定してください。');
    const [problem, indexNode, constantsNode, positionNode] = node.operands;
    const result = solutions.get(odeProblemKey(problem, context.angleUnit));
    if (result === undefined) throw new MathInputProblem('unsupported', '微分方程式の解候補を準備できませんでした。');
    const index = constant(visit(indexNode, depth + 1));
    if (!Number.isSafeInteger(index) || index < 1 || index > result.branches.length) {
      throw new MathInputProblem('domain', '表示された解候補の番号を指定してください。');
    }
    const values = visit(constantsNode, depth + 1), position = visit(positionNode, depth + 1), branch = result.branches[index - 1];
    if (values.kind !== 'operation' || values.operation !== 'list' || values.operands.length !== branch.formula.bindings.length - 1) {
      throw new MathInputProblem('domain', '表示された積分定数を順番に全て指定してください。');
    }
    values.operands.forEach(constant);
    const bindings = new Map(branch.formula.bindings.map((binding, index) => [binding.variable.id, index === 0 ? position : values.operands[index - 1]]));
    const condition = substituteBound(branch.condition.body, bindings);
    guards.push(...conditionGuards(condition));
    const original = substituteBound(branch.originals.body, bindings);
    if (original.kind !== 'operation' || original.operation !== 'list') throw new MathInputProblem('syntax', '元の式の確認条件がありません。');
    guards.push(...original.operands.flatMap(finiteOriginal));
    return substituteBound(branch.formula.body, bindings);
  }
  return { expression: visit(source), guards };
}
