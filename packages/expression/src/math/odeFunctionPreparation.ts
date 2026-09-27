/** Async ODE preparation is request-local. No solver runs inside a geometric sample. */
import { MathInputProblem, type MathNode, type StoredMathExpression } from './mathInputContract.js';
import { readFunctionMathSource } from './functionMathSource.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import type { ExactMathWorkOptions } from './exactMathWorkExecution.js';
import type { MathWorkRequest } from './mathWorkRequest.js';
import type { ScalarInput } from './scalarMathTape.js';
import { coefficientExpressionMap, substituteCoefficientExpressions } from './mathCoefficientExpression.js';
import { decodeExactMathResult } from './exactMathResult.js';
import type { OdeSolutions } from './differentialEquations.js';
import { lowerOdeFunction, odeProblemKey } from './odeFunctionLowering.js';
import { ExactMathEngineStopped } from './exactMathEngineClient.js';

export interface OdeFunctionInput {
  readonly definition: StoredMathExpression;
  readonly inputs: readonly ScalarInput[];
  readonly coefficients: MathWorkRequest['coefficients'];
}
export async function prepareOdeFunctions(inputs: readonly OdeFunctionInput[], options: ExactMathWorkOptions): Promise<MathExecutionBackend> {
  const problems = new Map<string, { expression: MathNode; angleUnit: 'degree' | 'radian' }>();
  function checkStop(): void {
    const reason = options.shouldStop();
    if (reason !== undefined) throw new ExactMathEngineStopped(reason);
  }
  checkStop();
  for (const input of inputs) {
    const stored = readFunctionMathSource(input.definition, {
      axes: input.inputs.filter(value => value === 'X' || value === 'Y' || value === 'Z'),
      parameters: input.inputs.filter(value => value === 'T' || value === 'U' || value === 'V'), coefficients: input.coefficients,
    }, options.backend);
    const expression = substituteCoefficientExpressions(stored.expression, coefficientExpressionMap(input.coefficients, stored.angleUnit));
    const pending = [expression];
    let remaining = 4096;
    while (pending.length > 0) {
      if (--remaining < 0) throw new MathInputProblem('budget', '解曲線の式が大きすぎます。');
      const node = pending.pop();
      if (node?.kind === 'operation') {
        if (node.operation === 'solve-ode') {
          problems.set(odeProblemKey(node, stored.angleUnit), { expression: node, angleUnit: stored.angleUnit });
          if (problems.size > 8) throw new MathInputProblem('budget', '一度に準備する微分方程式は8種類までにしてください。');
        } else pending.push(...node.operands);
      } else if (node?.kind === 'binder') pending.push(node.body);
    }
  }
  if (problems.size === 0) return options.backend;
  checkStop();
  const entries = [...problems.entries()], payloads = entries.map(([, value]) => value);
  const results: readonly unknown[] = options.engine.evaluateMany === undefined
    ? await sequential() : await options.engine.evaluateMany(payloads);
  async function sequential(): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const payload of payloads) { checkStop(); results.push(await options.engine.evaluate(payload.expression, payload.angleUnit)); }
    return results;
  }
  checkStop();
  if (results.length !== entries.length) throw new MathInputProblem('syntax', '微分方程式の返信数が一致しません。');
  const solutions = new Map<string, OdeSolutions>();
  entries.forEach(([key, payload], index) => {
    const result = decodeExactMathResult(results[index], payload.expression, {
      operationsById: options.backend.operationsById, coefficientIds: new Set(), declaredIds: new Set(),
    });
    if (result.status !== 'value' || result.reportedKind !== 'ode-solutions') {
      throw new MathInputProblem(result.status === 'invalid' && (result.reason === 'domain' || result.reason === 'syntax') ? result.reason : 'unsupported',
        '微分方程式の解候補を確認できませんでした。式と初期値・境界の条件を確認してください。');
    }
    solutions.set(key, result.solutions);
  });
  return { ...options.backend, prepareOdeFunction: (source, context) => lowerOdeFunction(source, solutions, context) };
}
