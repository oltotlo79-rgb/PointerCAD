/** Worker-owned optional exact evaluation. Construction of a concrete engine belongs to its host. */
import { MathInputProblem, type MathEvaluation, type MathNode } from './mathInputContract.js';
import { decodeMathWorkEnvelope } from './mathWorkRequest.js';
import { executeMathWorkRequest, type MathExecutionBackend, type MathExecutionReply } from './mathWorkExecution.js';
import { coefficientExpressionMap, substituteCoefficientExpressions } from './mathCoefficientExpression.js';
import { prepareMathCalculation } from './prepareMathCalculation.js';
import { evaluateExactMathResult } from './evaluateExactMathResult.js';
import { ExactMathEngineStopped } from './exactMathEngineClient.js';

export interface ExactMathEngine {
  /** Only an already parsed, domain-checked AST; never formula text as executable code. */
  readonly evaluate: (expression: MathNode, angleUnit: 'degree' | 'radian') => Promise<unknown>;
}
export interface ExactMathWorkOptions {
  readonly backend: MathExecutionBackend;
  readonly engine: ExactMathEngine;
  /** The host owns the finite deadline and terminates the Worker to interrupt a blocked engine. */
  readonly shouldStop: () => 'cancelled' | 'deadline' | undefined;
}
function needsExactResult(value: MathEvaluation): boolean {
  return value.status === 'unresolved' && value.reason === 'unevaluated'
    || value.status === 'invalid' && value.reason === 'unsupported'
    || value.status === 'value' && value.kind === 'symbolic';
}

/** Retain the immutable request envelope through loading/calculation; delayed values cannot acquire a new identity. */
export async function executeExactMathWorkRequest(value: unknown, options: ExactMathWorkOptions): Promise<MathExecutionReply> {
  const envelope = decodeMathWorkEnvelope(value), { request } = envelope;
  const stopped = options.shouldStop();
  if (stopped !== undefined) return { kind: 'math-result', serial: envelope.serial, identity: request.identity,
    source: request.source, notation: request.notation, angleUnit: request.angleUnit, expression: null,
    evaluation: { status: 'stopped', reason: stopped },
    ...(request.presentationNotation === undefined ? {} : { presentation: null }),
    ...(request.renameCoefficient === undefined ? {} : { renamedDefinition: null }) };
  const original = executeMathWorkRequest(envelope, options.backend);
  if (original.expression === null || request.renameCoefficient !== undefined || request.functionScope !== undefined
    || !needsExactResult(original.evaluation)) return original;
  const source = original.expression;
  const reply = (evaluation: MathEvaluation): MathExecutionReply => ({ ...original, evaluation });
  try {
    const coefficients = coefficientExpressionMap(request.coefficients, request.angleUnit);
    // This also freshens the bound IDs of expanded coefficient expressions.
    const expanded = substituteCoefficientExpressions(source, coefficients);
    const prepared = options.backend.withinDeadline(() => prepareMathCalculation(expanded, {
      angleUnit: request.angleUnit, resolve: () => null, deferNonRationalRank: true, deferNonRationalLinear: true,
    }));
    if (prepared.status !== 'ready') return reply({ status: 'unresolved', reason: 'missing-condition', names: prepared.operations });
    const before = options.shouldStop(); if (before !== undefined) return reply({ status: 'stopped', reason: before });
    const raw = await options.engine.evaluate(prepared.expression, request.angleUnit);
    const after = options.shouldStop(); if (after !== undefined) return reply({ status: 'stopped', reason: after });
    return reply(evaluateExactMathResult(raw, expanded, {
      backend: options.backend, angleUnit: request.angleUnit, shouldStop: options.shouldStop,
      references: { coefficientIds: new Set(), declaredIds: new Set() }, resolve: () => null,
    }));
  } catch (error) {
    const stop = options.shouldStop(); if (stop !== undefined) return reply({ status: 'stopped', reason: stop });
    if (error instanceof ExactMathEngineStopped) return reply({ status: 'stopped', reason: error.reason });
    if (error instanceof MathInputProblem) {
      if (error.code === 'budget') return reply({ status: 'stopped', reason: 'budget' });
      return reply({ status: 'invalid', reason: error.code === 'forbidden' ? 'unsupported' : error.code, detail: error.message });
    }
    return reply({ status: 'invalid', reason: 'unsupported', detail: 'この式の厳密な結果を決定できませんでした。入力と条件を確認してください。' });
  }
}
