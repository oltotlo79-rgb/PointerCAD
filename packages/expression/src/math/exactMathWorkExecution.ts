/** Worker-owned optional exact evaluation. Construction of a concrete engine belongs to its host. */
import { MathInputProblem, type MathEvaluation, type MathNode } from './mathInputContract.js';
import { createMathWorkEnvelope, decodeMathWorkEnvelope } from './mathWorkRequest.js';
import { executeMathWorkRequest, MathDeadlineExceeded, type MathExecutionBackend, type MathExecutionReply } from './mathWorkExecution.js';
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

/** A new Worker still compiling its code, or a busy machine, can let the backend's wall clock stop a synchronous
 * stage that fits its limits. Only such a stop, never a step or size limit, is calculated once more, at most once
 * per request; the exact engine never runs twice (its progress and uses belong to one request). A stage still
 * stopped by the wall clock is reported as the time limit ('deadline'), never as the calculation size. */
interface Recalculation { used: boolean }
const timeLimit = (): MathEvaluation => ({ status: 'stopped', reason: 'deadline' });
function watchWallClock(options: ExactMathWorkOptions, recalculation: Recalculation) {
  let exceeded = false;
  const backend: MathExecutionBackend = { ...options.backend,
    withinDeadline: <T>(operation: () => T extends Promise<unknown> ? never : T, allowance?: number): T => {
      try { return options.backend.withinDeadline<T>(operation, allowance); }
      catch (error) { if (error instanceof MathDeadlineExceeded) exceeded = true; throw error; }
    } };
  // The synchronous calculation's own 200ms checks stop with 'deadline'; a stop requested by the host is final.
  const stoppedByClock = (evaluation: MathEvaluation): boolean => evaluation.status === 'stopped'
    && (evaluation.reason === 'deadline' || evaluation.reason === 'budget' && exceeded);
  const recalculate = (): boolean => {
    if (recalculation.used || options.shouldStop() !== undefined) return false;
    recalculation.used = true; exceeded = false;
    return true;
  };
  return {
    backend,
    /** A stage that reports its stop in the returned evaluation. */
    stage<T>(run: () => T, evaluation: (value: T) => MathEvaluation, stopped: (value: T) => T): T {
      exceeded = false;
      const first = run();
      const value = stoppedByClock(evaluation(first)) && recalculate() ? run() : first;
      return stoppedByClock(evaluation(value)) ? stopped(value) : value;
    },
    /** A block that throws; a second wall-clock stop reaches the request's catch below. */
    block<T>(operation: () => T extends Promise<unknown> ? never : T): T {
      try { return backend.withinDeadline<T>(operation); }
      catch (error) {
        if (!(error instanceof MathDeadlineExceeded) || !recalculate()) throw error;
        return backend.withinDeadline<T>(operation);
      }
    },
  };
}

/** Retain the immutable request envelope through loading/calculation; delayed values cannot acquire a new identity. */
export async function executeExactMathWorkRequest(value: unknown, options: ExactMathWorkOptions): Promise<MathExecutionReply> {
  return executeWithRecalculation(value, options, { used: false });
}
async function executeWithRecalculation(value: unknown, options: ExactMathWorkOptions,
  recalculation: Recalculation): Promise<MathExecutionReply> {
  const envelope = decodeMathWorkEnvelope(value), { request } = envelope;
  const stopped = options.shouldStop();
  if (stopped !== undefined) return { kind: 'math-result', serial: envelope.serial, identity: request.identity,
    source: request.source, notation: request.notation, angleUnit: request.angleUnit, expression: null,
    evaluation: { status: 'stopped', reason: stopped },
    ...(request.presentationNotation === undefined ? {} : { presentation: null }),
    ...(request.renameCoefficient === undefined && request.renameDeclaration === undefined ? {} : { renamedDefinition: null }) };
  const clock = watchWallClock(options, recalculation), backend = clock.backend;
  const original = clock.stage(() => executeMathWorkRequest(envelope, backend), reply => reply.evaluation,
    reply => ({ ...reply, evaluation: timeLimit() }));
  if (original.expression === null || request.renameCoefficient !== undefined || request.renameDeclaration !== undefined || request.functionScope !== undefined
    || !needsExactResult(original.evaluation)) return original;
  // No untyped exact-backend assumption may turn a declared vector, set, or
  // unknown value into a scalar (even when an enclosing expression cancels it).
  const declarations = referencedMathDeclarations(original.expression, request.declarations ?? []);
  if (declarations.some(declaration => declaration.valueSource === undefined)) return original;
  const source = original.expression;
  const reply = (evaluation: MathEvaluation): MathExecutionReply => ({ ...original, evaluation });
  const finish = (raw: unknown, expression: MathNode): MathEvaluation => clock.stage(() => evaluateExactMathResult(raw, expression, {
    backend, angleUnit: request.angleUnit, shouldStop: options.shouldStop,
    references: { coefficientIds: new Set(), declaredIds: new Set() }, resolve: () => null,
  }), evaluation => evaluation, timeLimit);
  try {
    const values = new Map<string, MathNode>();
    for (const declaration of declarations) {
      if (declaration.valueSource === undefined) continue;
      const value = await executeWithRecalculation(createMathWorkEnvelope(envelope.serial,
        mathDeclaredValueRequest(request, declaration.valueSource)), options, recalculation);
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
    const plan = clock.block(() => planMathCandidates(expanded, request.angleUnit, true));
    const candidates = plan.candidates, calculated = plan.expression;
    if (candidates !== null) {
      const prepared = clock.block(() => candidates.map(expression => ({ expression,
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
        evaluation: finish(raw[index], expression) }))));
    }
    const prepared = clock.block(() => prepareExactMathCalculation(calculated, {
      angleUnit: request.angleUnit, resolve: () => null,
    }));
    if (prepared.status !== 'ready') return reply({ status: 'unresolved', reason: 'missing-condition', names: prepared.operations });
    const before = options.shouldStop(); if (before !== undefined) return reply({ status: 'stopped', reason: before });
    const raw = await options.engine.evaluate(prepared.expression, request.angleUnit);
    const after = options.shouldStop(); if (after !== undefined) return reply({ status: 'stopped', reason: after });
    const evaluated = finish(raw, calculated);
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
    if (error instanceof MathDeadlineExceeded) return reply(timeLimit());
    if (error instanceof MathInputProblem) {
      if (error.code === 'budget') return reply({ status: 'stopped', reason: 'budget' });
      return reply({ status: 'invalid', reason: error.code === 'forbidden' ? 'unsupported' : error.code, detail: error.message });
    }
    return reply({ status: 'invalid', reason: 'unsupported', detail: 'この式の厳密な結果を決定できませんでした。入力と条件を確認してください。' });
  }
}
