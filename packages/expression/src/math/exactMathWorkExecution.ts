/** Worker-owned optional exact evaluation. Construction of a concrete engine belongs to its host. */
import { MathInputProblem, type MathEvaluation, type MathNode } from './mathInputContract.js';
import { createMathWorkEnvelope, decodeMathWorkEnvelope } from './mathWorkRequest.js';
import { executeMathWorkRequest, type MathExecutionBackend, type MathExecutionReply } from './mathWorkExecution.js';
import { coefficientExpressionMap, substituteCoefficientExpressions } from './mathCoefficientExpression.js';
import { prepareExactMathCalculation } from './prepareMathCalculation.js';
import { evaluateExactMathResult } from './evaluateExactMathResult.js';
import { isAntiderivativeOf } from './exactMathResult.js';
import { ExactMathEngineStopped } from './exactMathEngineClient.js';
import { referencedMathDeclarations } from './mathDeclarations.js';
import { checkMathDeclaredValue, mathDeclaredValueRequest } from './mathDeclaredValues.js';
import { plusMinusEvaluation } from './plusMinus.js';
import { planMathCandidates } from './absoluteValueCandidates.js';

export interface ExactMathEngine {
  /** Only an already parsed, domain-checked AST; never formula text as executable code. */
  readonly evaluate: (expression: MathNode, angleUnit: 'degree' | 'radian') => Promise<unknown>;
  /** One bounded geometric request may prepare several distinct ODEs together. */
  readonly evaluateMany?: (inputs: readonly { readonly expression: MathNode; readonly angleUnit: 'degree' | 'radian' }[]) => Promise<readonly unknown[]>;
}
export interface ExactMathWorkOptions {
  readonly backend: MathExecutionBackend;
  readonly engine: ExactMathEngine;
  /** The host owns the finite deadline and terminates the Worker to interrupt a blocked engine. */
  readonly shouldStop: () => 'cancelled' | 'deadline' | undefined;
}
function needsExactResult(value: MathEvaluation): boolean {
  // A bound sequence term may discharge its integer conditions only at the
  // concrete index. Preparation below still rejects every unhandled obligation.
  return value.status === 'unresolved' && (value.reason === 'unevaluated' || value.reason === 'missing-condition')
    || value.status === 'invalid' && value.reason === 'unsupported'
    || value.status === 'value' && value.kind === 'symbolic'
    || isUnprovedEstimate(value);
}
function isUnprovedEstimate(value: MathEvaluation): boolean {
  return value.status === 'value' && value.kind === 'real' && value.approximation?.absoluteError === null;
}

/** Retain the immutable request envelope through loading/calculation; delayed values cannot acquire a new identity. */
export async function executeExactMathWorkRequest(value: unknown, options: ExactMathWorkOptions): Promise<MathExecutionReply> {
  const envelope = decodeMathWorkEnvelope(value), { request } = envelope;
  const stopped = options.shouldStop();
  if (stopped !== undefined) return { kind: 'math-result', serial: envelope.serial, identity: request.identity,
    source: request.source, notation: request.notation, angleUnit: request.angleUnit, expression: null,
    evaluation: { status: 'stopped', reason: stopped },
    ...(request.presentationNotation === undefined ? {} : { presentation: null }),
    ...(request.renameCoefficient === undefined && request.renameDeclaration === undefined ? {} : { renamedDefinition: null }) };
  const original = executeMathWorkRequest(envelope, options.backend);
  if (original.expression === null || request.renameCoefficient !== undefined || request.renameDeclaration !== undefined || request.functionScope !== undefined
    || !needsExactResult(original.evaluation)) return original;
  // No untyped exact-backend assumption may turn a declared vector, set, or
  // unknown value into a scalar (even when an enclosing expression cancels it).
  const declarations = referencedMathDeclarations(original.expression, request.declarations ?? []);
  if (declarations.some(declaration => declaration.valueSource === undefined)) return original;
  const source = original.expression;
  const reply = (evaluation: MathEvaluation): MathExecutionReply => ({ ...original, evaluation });
  try {
    const values = new Map<string, MathNode>();
    for (const declaration of declarations) {
      if (declaration.valueSource === undefined) continue;
      const value = await executeExactMathWorkRequest(createMathWorkEnvelope(envelope.serial,
        mathDeclaredValueRequest(request, declaration.valueSource)), options);
      if (value.expression === null) return reply(value.evaluation);
      const problem = checkMathDeclaredValue(declaration, value.expression, value.evaluation);
      if (problem !== null) return reply(problem);
      values.set(declaration.id, value.expression);
    }
    const withValues = declarations.length === 0 ? source : substituteCoefficientExpressions(source, values, 'declared');
    const coefficients = coefficientExpressionMap(request.coefficients, request.angleUnit);
    // This also freshens the bound IDs of expanded coefficient expressions.
    const expanded = substituteCoefficientExpressions(withValues, coefficients);
    // The same readings of |x| and the same ± and ∓ candidates as the scalar calculation above.
    const plan = options.backend.withinDeadline(() => planMathCandidates(expanded, request.angleUnit, true));
    const candidates = plan.candidates, calculated = plan.expression;
    if (candidates !== null) {
      const prepared = options.backend.withinDeadline(() => candidates.map(expression => ({ expression,
        prepared: prepareExactMathCalculation(expression, { angleUnit: request.angleUnit, resolve: () => null }) })));
      const missing = prepared.flatMap(value => value.prepared.status === 'unresolved' ? value.prepared.operations : []);
      if (missing.length > 0) return reply({ status: 'unresolved', reason: 'missing-condition', names: [...new Set(missing)] });
      const inputs = prepared.map(value => {
        if (value.prepared.status !== 'ready') throw new MathInputProblem('unsupported', '候補の計算条件を確認してください。');
        return { expression: value.prepared.expression, angleUnit: request.angleUnit };
      });
      const before = options.shouldStop(); if (before !== undefined) return reply({ status: 'stopped', reason: before });
      const raw = options.engine.evaluateMany === undefined
        ? await Promise.all(inputs.map(input => options.engine.evaluate(input.expression, input.angleUnit)))
        : await options.engine.evaluateMany(inputs);
      const after = options.shouldStop(); if (after !== undefined) return reply({ status: 'stopped', reason: after });
      if (raw.length !== candidates.length) throw new MathInputProblem('unsupported', '候補の計算結果の数が一致しません。');
      return reply(plusMinusEvaluation(candidates.map((expression, index) => ({ expression,
        evaluation: evaluateExactMathResult(raw[index], expression, {
          backend: options.backend, angleUnit: request.angleUnit, shouldStop: options.shouldStop,
          references: { coefficientIds: new Set(), declaredIds: new Set() }, resolve: () => null,
        }) }))));
    }
    const prepared = options.backend.withinDeadline(() => prepareExactMathCalculation(calculated, {
      angleUnit: request.angleUnit, resolve: () => null,
    }));
    if (prepared.status !== 'ready') return reply({ status: 'unresolved', reason: 'missing-condition', names: prepared.operations });
    const before = options.shouldStop(); if (before !== undefined) return reply({ status: 'stopped', reason: before });
    const raw = await options.engine.evaluate(prepared.expression, request.angleUnit);
    const after = options.shouldStop(); if (after !== undefined) return reply({ status: 'stopped', reason: after });
    const evaluated = evaluateExactMathResult(raw, calculated, {
      backend: options.backend, angleUnit: request.angleUnit, shouldStop: options.shouldStop,
      references: { coefficientIds: new Set(), declaredIds: new Set() }, resolve: () => null,
    });
    // An unevaluated exact integral may retain its clearly marked estimate for display only.
    // A domain error, divergence or interruption must never fall back to an apparent success.
    if (isUnprovedEstimate(original.evaluation) && evaluated.status === 'unresolved' && evaluated.reason === 'unevaluated') return original;
    // The expansion has been checked against substituted values above. Its
    // editable source must retain coefficient identities and original bindings.
    // A whole-formula indefinite integral's answer is its lambda (MC-20), not the source: keep it.
    if (evaluated.status === 'value' && ((evaluated.kind === 'function' && !isAntiderivativeOf(evaluated.expression, calculated)) || evaluated.kind === 'series' || evaluated.kind === 'fourier-series' || evaluated.kind === 'equation-system' || evaluated.kind === 'ode-solutions')) return reply({ ...evaluated, expression: source });
    return reply(evaluated);
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
