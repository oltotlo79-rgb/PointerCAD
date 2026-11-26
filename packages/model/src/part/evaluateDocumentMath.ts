/** Evaluate a complete immutable input snapshot before any cached coordinate reaches geometry. */
import { bindMathCompositionNames, collectMathCoefficients, collectVariableNames, evaluateExpression, evaluateExpressionExact,
  inspectMathScalarExpression, originalCoefficientExpression, exactCoefficientScalar,
  type ExpressionError, type ExpressionValue, type MathCompositionCoefficient, type MathScalarIssue } from '@pointercad/expression';
import { MathInputProblem } from '@pointercad/expression/math/contracts';
import type { MathWorkerClient, MathRequestIdentity, MathWorkRequest } from '@pointercad/expression/math/client';
import { parameterEvaluationOrder } from '../parameters/parameterTable.js';
import { expressionParameterNames } from '../parameters/expressionReferences.js';
import { isParameterMathId } from '../parameters/parameterMathIdentity.js';
import { rememberMathParameterEvaluation } from '../parameters/mathParameterEvaluation.js';
import type { Parameter, ParameterAnalysis } from '../parameters/types.js';
import { nonLengthVariables } from '../units/length.js';
import { MATH_GEOMETRY_COEFFICIENT_PREFIX, mathGeometryDefinitionIdOf } from '../measure/mathGeometryIdentity.js';
import { checkGeometryDerivedOperations, mathGeometryBooleanMessage, mathGeometryCoefficientValue,
  mathGeometryDerivedParameters, mathGeometryOutsideCoefficientMessage, mathGeometryPendingMessage,
  mathGeometryReferenceMismatchMessage, mathGeometryUnresolvedMessage, resolvableMathGeometryDefinitions,
} from '../measure/mathGeometryCoefficients.js';
import type { MathGeometryOutcome } from '../measure/mathGeometryTypes.js';
import { mapDocumentExpressions, type ReevaluationFailure } from './reevaluatePart.js';
import type { PartDocument } from './types.js';
import { plainText, type FailureText } from '../failureText.js';
import { mapDocumentNonScalarExpressions } from './documentFunctions.js';
import type { WorkerBrokenCode } from '../kernelBridge/bridgeContracts.js';

export interface DocumentMathContext {
  readonly client: Pick<MathWorkerClient, 'evaluate'>;
  readonly identity: Pick<MathRequestIdentity, 'documentId' | 'documentVersion'>;
  readonly signal?: AbortSignal;
  readonly isCurrent: () => boolean;
  /**
   * Measured math-geometry values of THIS document's current recomputation, by definition ID.
   * A definition without an entry here is "計算待ち": the coefficient reading it fails with a pending
   * reason, its ID is listed in `recompute.pendingGeometry`, and its users land in `invalidInputs`.
   * Values are used as the kernel's doubles only; an old or foreign value must not be passed.
   */
  readonly geometry?: ReadonlyMap<string, MathGeometryOutcome>;
  /**
   * Coefficient name → reason it must not be evaluated in this pass (the dependency analysis's cycle, order and depth
   * findings, supplied by the stage recomputation). A blocked coefficient fails with exactly that reason
   * and is never sent to the math engine; everything depending on it fails as well.
   */
  readonly blocked?: ReadonlyMap<string, FailureText>;
}
type DocumentMathResult =
  | { readonly ok: true; readonly document: PartDocument; readonly analysis: ParameterAnalysis }
  | { readonly ok: false; readonly cancelled: boolean; readonly failures: readonly ReevaluationFailure[];
      /** Transient recomputation only. Invalid owners MUST be excluded; never publish this as an edit. */
      readonly recompute?: { readonly document: PartDocument; readonly analysis: ParameterAnalysis;
        readonly invalidInputs: ReadonlyMap<string, FailureText>;
        /** Definition IDs whose measured value was needed but absent from `context.geometry` (計算待ち). */
        readonly pendingGeometry: ReadonlySet<string> } };

/** 鍵と値の組が同じか(差し込む値の入れ子も比べる。同じ持ち主の同じ理由を 2 回つながない)。 */
function sameText(a: FailureText, b: FailureText): boolean {
  const names = Object.keys(a.parameters);
  return a.key === b.key && names.length === Object.keys(b.parameters).length && names.every((name) => {
    if (!Object.hasOwn(b.parameters, name)) return false;
    const left = a.parameters[name], right = b.parameters[name];
    return typeof left === 'string' || typeof right === 'string' ? left === right : sameText(left, right);
  });
}

/** 同じ持ち主の値の不正な入力の理由を改行でつなぐ(同じ理由は 2 回つながない)。 */
function joinedInputText(previous: FailureText | undefined, text: FailureText): FailureText {
  return previous === undefined || sameText(previous, text) ? text : { key: 'math.error.lines', parameters: { first: previous, rest: text } };
}

export function hasDocumentMath(document: PartDocument): boolean {
  let found = document.parameters.some(parameter => parameter.value.mathDefinition !== undefined)
    || document.solids.some(feature => feature.kind === 'functionSurface')
    || document.sketches.some(sketch => sketch.features.some(feature => feature.kind === 'functionCurve'));
  mapDocumentExpressions(document, value => { found ||= value.mathDefinition !== undefined; return value; });
  return found;
}

function internalDocumentMathFailure(stage: string, cause: unknown): FailureText {
  console.error('PointerCAD document math', stage, cause);
  return { key: 'assembly.error.internal', parameters: {} };
}

function documentMathException(stage: string, cause: unknown): FailureText {
  return cause instanceof MathInputProblem ? cause.diagnostic ?? plainText(cause.message)
    : internalDocumentMathFailure(stage, cause);
}

function documentMathScalarFailure(issue: MathScalarIssue): FailureText {
  switch (issue.code) {
    case 'invalidEvaluation': return issue.evaluation.diagnostic ?? plainText(issue.evaluation.detail);
    case 'stopped': return issue.evaluation.diagnostic ?? { key: `math.${issue.evaluation.reason}`, parameters: {} };
    case 'internal': return internalDocumentMathFailure(issue.reason, issue.cause);
    default: return { key: `mathScalar.${issue.code}`, parameters: {} };
  }
}

type ValueResult = { readonly ok: true; readonly value: ExpressionValue; readonly decimal: string }
  | { readonly ok: false; readonly text: FailureText; readonly code?: WorkerBrokenCode; readonly unavailable?: true };

async function evaluateWorkerValue(context: DocumentMathContext, request: MathWorkRequest): Promise<ValueResult> {
  let completion: Awaited<ReturnType<MathWorkerClient['evaluate']>>;
  try {
    completion = await context.client.evaluate(request, 5_000, context.signal);
  } catch (error) {
    if (!(error instanceof MathInputProblem)) throw error;
    return { ok: false, text: documentMathException('request', error) };
  }
  if (completion.status !== 'result') {
    const unavailable = true as const;
    if (completion.status === 'worker-error') return { ok: false, unavailable, text: internalDocumentMathFailure('worker', completion.status) };
    if (completion.status === 'deadline' || completion.status === 'cancelled') {
      return { ok: false, unavailable, text: { key: `math.${completion.status}`, parameters: {} } };
    }
    return { ok: false, unavailable, text: { key: 'math.error.calculationIncomplete', parameters: { status: completion.status } } };
  }
  const result = inspectMathScalarExpression(completion.result);
  return result.ok ? result : { ok: false, text: documentMathScalarFailure(result.issue) };
}

const verifiedFields = new WeakMap<PartDocument, ReadonlyMap<ExpressionValue, ExpressionValue>>();
/** Only a successfully evaluated field of this exact immutable document can supply displayed coordinates. */
export function evaluatedDocumentMathValue(document: PartDocument, value: ExpressionValue): ExpressionValue | null {
  return verifiedFields.get(document)?.get(value) ?? null;
}

/** The caller owns cancellation and current-document identity; this function never mutates or publishes. */
/** Names used by either a scalar field or an exact/non-scalar formula in this document. */
function usedDocumentParameterNames(document: PartDocument, fields: readonly { readonly value: ExpressionValue }[],
  byId: ReadonlyMap<string, Parameter>): ReadonlySet<string> {
  const used = new Set<string>();
  mapDocumentNonScalarExpressions(document, definition => {
    for (const reference of collectMathCoefficients(definition.expression)) {
      if (byId.get(reference.id)?.name === reference.label) used.add(reference.label);
    }
    return definition;
  });
  for (const { value } of fields) for (const name of expressionParameterNames(value, document.parameters)) used.add(name);
  for (const parameter of document.parameters) for (const name of expressionParameterNames(parameter.value, document.parameters)) {
    if (name !== parameter.name) used.add(name);
  }
  return used;
}

export async function evaluateDocumentMath(document: PartDocument, context: DocumentMathContext): Promise<DocumentMathResult> {
  const current = () => !context.signal?.aborted && context.isCurrent() && context.identity.documentId === document.id;
  const failures: ReevaluationFailure[] = [];
  const cancelled = (): DocumentMathResult => ({ ok: false, cancelled: true, failures });
  if (!current()) return cancelled();
  verifiedFields.delete(document);
  const compositionNames: readonly MathCompositionCoefficient[] = document.parameters.flatMap(parameter => parameter.mathId === undefined ? [] : [{
    id: parameter.mathId, label: parameter.name, kind: parameter.unit === 'mm' ? 'length' : parameter.unit === 'degree' ? 'angle' : 'scalar',
  }]);
  const variables = new Map<string, number>(), exactVariables = new Map<string, string>();
  const coefficients = new Map<string, MathWorkRequest['coefficients'][number]>();
  const coefficientNames = new Map<string, MathWorkRequest['coefficients'][number]>();
  const nonLength = nonLengthVariables(document.parameters);
  const byName = new Map<string, Parameter>(), byId = new Map<string, Parameter>();
  const evaluatedParameters = new Map<string, Parameter>();
  const parameterFailures = new Map<string, FailureText>(), invalidInputs = new Map<string, FailureText>(), workerBrokenParameters = new Set<string>();
  const geometryDefinitions = resolvableMathGeometryDefinitions(document), pendingGeometry = new Set<string>();
  /** Coefficient name → math-geometry definition IDs it uses; filled before any formula is evaluated. */
  let geometryDerived: ReadonlyMap<string, readonly string[]> = new Map();
  let calculationUnavailable = false;
  let inputRevision = 0;
  const fail = (ownerId: string, value: ExpressionValue, text: FailureText) => { failures.push({ ownerId, source: value.source, text }); };

  for (const parameter of document.parameters) {
    // The `math-geometry:` prefix is reserved for measured values, so a `coef` ID never names both kinds.
    if (byName.has(parameter.name) || (parameter.mathId !== undefined && (!isParameterMathId(parameter.mathId)
      || parameter.mathId.startsWith(MATH_GEOMETRY_COEFFICIENT_PREFIX) || byId.has(parameter.mathId)))) {
      fail(parameter.name, parameter.value, { key: 'math.error.invalidParameterName', parameters: {} });
    }
    byName.set(parameter.name, parameter);
    if (parameter.mathId !== undefined) byId.set(parameter.mathId, parameter);
  }
  if (failures.length > 0) return { ok: false, cancelled: false, failures };
  const legacyNames = { resolveVariable: (name: string) => {
    const parameter = byName.get(name), coefficient = coefficientNames.get(name);
    if (parameter === undefined || coefficient === undefined) return null;
    return { reference: { role: 'coefficient' as const, id: coefficient.id, label: name },
      kind: parameter.unit === 'mm' ? 'length' as const : parameter.unit === 'degree' ? 'angle' as const : 'scalar' as const };
  } };

  /** Whether `value` reads a geometry-derived coefficient (by math `coef` ID or by legacy name). */
  const usesGeometryDerived = (value: ExpressionValue): boolean => geometryDerived.size > 0
    && expressionParameterNames(value, document.parameters).some(name => geometryDerived.has(name));
  /** One `coef` reference to a measured value, read by the formula of the coefficient `coefficientName`. */
  const geometryInput = (reference: { readonly label: string }, definitionId: string, coefficientName: string):
    { readonly input: MathWorkRequest['coefficients'][number] } | { readonly problem: FailureText; readonly pending: boolean; readonly code?: WorkerBrokenCode } => {
    const definition = geometryDefinitions.get(definitionId);
    if (definition === undefined || definition.name !== reference.label) {
      return { problem: mathGeometryReferenceMismatchMessage(reference.label), pending: false };
    }
    const input = mathGeometryCoefficientValue(document, definition, context.geometry?.get(definitionId));
    switch (input.status) {
      case 'value': return { input: input.coefficient };
      case 'pending':
        pendingGeometry.add(definitionId);
        return { problem: mathGeometryPendingMessage(definition.name), pending: true };
      case 'boolean': return { problem: mathGeometryBooleanMessage(definition.name), pending: false };
      case 'unresolved': return { problem: mathGeometryUnresolvedMessage(definition.name, coefficientName, input.text), pending: false, ...(input.code === undefined ? {} : { code: input.code }) };
    }
  };

  /**
   * A legacy (name-referencing) formula naming an already-failed coefficient must relay that
   * coefficient's own reason (circular or otherwise), not the generic "決まっていない名前です" (unknown
   * name, `packages/expression/src/errors.ts`, code `unknownVariable`) — that text is reserved for a
   * name this document never defines. `parameterFailures` only holds names that ARE real parameters,
   * so this never fires for a genuinely undefined name. Only the legacy branch needs this: the
   * `mathDefinition`-based branch below already reports its own referenced-coefficient failure
   * (`参照する係数を計算できません`) without going through `unknownVariable` at all.
   */
  const dependentFailureMessage = (error: ExpressionError, source: string): FailureText | null => {
    if (error.code !== 'unknownVariable') return null;
    for (const name of collectVariableNames(source)) {
      const reason = parameterFailures.get(name);
      if (reason !== undefined) return { key: 'math.error.dependentCoefficient', parameters: { name, reason } };
    }
    return null;
  };

  /** `coefficientName` is set only for a coefficient's own formula: the one place a measured value may be read. */
  const evaluate = async (value: ExpressionValue, coefficientName?: string): Promise<ValueResult> => {
    bindMathCompositionNames(value, compositionNames);
    const definition = value.mathDefinition;
    if (definition === undefined) {
      const options = { variables, exactVariables, nonLengthVariables: nonLength };
      const exact = evaluateExpressionExact(value.source, options);
      if (!exact.ok) return { ok: false, text: dependentFailureMessage(exact.error, value.source) ?? plainText(exact.error.message) };
      const result = evaluateExpression(value.source, options);
      if (!result.ok) return { ok: false, text: dependentFailureMessage(result.error, value.source) ?? plainText(result.error.message) };
      // A measured double is never re-read as an exact rational, not even after legacy arithmetic.
      if (usesGeometryDerived(value)) return { ok: true, value: result.value, decimal: exact.value.exact };
      try {
        const original = originalCoefficientExpression(result.value, legacyNames, [...coefficientNames.values()]);
        const rational = exactCoefficientScalar(original);
        return rational === null ? { ok: true, value: result.value, decimal: exact.value.exact }
          : { ok: true, value: { ...result.value, value: rational.value, display: rational.display }, decimal: rational.decimal };
      } catch (error) {
        return { ok: false, text: documentMathException('coefficient expression', error) };
      }
    }
    if (definition.source !== value.source) return { ok: false, text: { key: 'math.error.definitionMismatch', parameters: {} } };
    const references = collectMathCoefficients(definition.expression);
    const measured = references.filter(reference => mathGeometryDefinitionIdOf(reference.id) !== null);
    if (measured.length > 0 && coefficientName === undefined) {
      return { ok: false, text: mathGeometryOutsideCoefficientMessage(measured[0].label) };
    }
    // Allowed operations: checked before any value is looked up, so a refused operation is never reported as pending.
    if (measured.length > 0 || usesGeometryDerived(value)) {
      const issue = checkGeometryDerivedOperations(definition.expression);
      if (issue !== null) return { ok: false, text: issue.text };
    }
    const inputs: MathWorkRequest['coefficients'][number][] = [];
    // Every reference is examined so all pending measurements are listed; the first real problem wins.
    let problem: FailureText | undefined, pending: FailureText | undefined, problemCode: WorkerBrokenCode | undefined;
    for (const reference of references) {
      const definitionId = mathGeometryDefinitionIdOf(reference.id);
      if (definitionId !== null && coefficientName !== undefined) {
        const resolved = geometryInput(reference, definitionId, coefficientName);
        if ('input' in resolved) inputs.push(resolved.input);
        else if (resolved.pending) pending ??= resolved.problem;
        else if (problem === undefined) { problem = resolved.problem; problemCode = resolved.code; }
        continue;
      }
      const parameter = byId.get(reference.id), coefficient = coefficients.get(reference.id);
      if (parameter === undefined || parameter.name !== reference.label) problem ??= { key: 'math.error.referenceUnverified', parameters: { label: reference.label } };
      else if (coefficient === undefined) problem ??= { key: 'math.error.referenceUncomputable', parameters: { label: reference.label } };
      else inputs.push(coefficient);
    }
    if (problem !== undefined) return { ok: false, text: problem, ...(problemCode === undefined ? {} : { code: problemCode }) };
    if (pending !== undefined) return { ok: false, text: pending };
    inputRevision += 1;
    const request: MathWorkRequest = { identity: { ...context.identity, editorId: 'document-math', inputRevision },
      source: value.source, notation: definition.inputNotation, angleUnit: definition.angleUnit, definition, coefficients: inputs };
    const result = await evaluateWorkerValue(context, request);
    if (result.ok) bindMathCompositionNames(result.value, compositionNames);
    else if (result.unavailable) calculationUnavailable = true;
    return result;
  };

  try {
    geometryDerived = mathGeometryDerivedParameters(document.parameters);
    const { order, circular } = parameterEvaluationOrder(document.parameters);
    for (const name of circular) {
      const parameter = byName.get(name);
      if (parameter) {
        const text: FailureText = { key: 'math.error.circular', parameters: {} };
        fail(name, parameter.value, text); parameterFailures.set(name, text);
      }
    }
    for (const name of order) {
      if (!current()) return cancelled();
      const parameter = byName.get(name);
      if (!parameter) continue;
      const blocked = context.blocked?.get(name);
      if (blocked !== undefined) { fail(name, parameter.value, blocked); parameterFailures.set(name, blocked); continue; }
      const result = await evaluate(parameter.value, name);
      if (!current()) return cancelled();
      if (!result.ok) { fail(name, parameter.value, result.text); parameterFailures.set(name, result.text); if (result.code !== undefined) workerBrokenParameters.add(name); continue; }
      let coefficient: MathWorkRequest['coefficients'][number];
      try {
        const id = parameter.mathId ?? `legacy-coefficient:${document.parameters.indexOf(parameter)}`;
        // A geometry-derived coefficient travels as its decimal only: no exact original expression.
        coefficient = geometryDerived.has(name) ? { id, label: name, decimal: result.decimal } : { id, label: name,
          decimal: result.decimal, exactExpression: originalCoefficientExpression(result.value, legacyNames, [...coefficientNames.values()]) };
      } catch (error) {
        const text = documentMathException('coefficient expression', error);
        fail(name, parameter.value, text); parameterFailures.set(name, text); continue;
      }
      variables.set(name, result.value.value);
      exactVariables.set(name, result.decimal);
      evaluatedParameters.set(name, { ...parameter, value: result.value });
      coefficientNames.set(name, coefficient);
      if (parameter.mathId !== undefined) coefficients.set(parameter.mathId, coefficient);
    }
    const fields: { readonly value: ExpressionValue; readonly ownerId: string }[] = [];
    mapDocumentExpressions(document, (value, ownerId) => { fields.push({ value, ownerId }); return value; });
    const replacements = new Map<ExpressionValue, ValueResult>();
    for (const field of fields) {
      if (!current()) return cancelled();
      const result = replacements.get(field.value) ?? await evaluate(field.value);
      if (!current()) return cancelled();
      replacements.set(field.value, result);
      if (!result.ok) {
        fail(field.ownerId, field.value, result.text);
        const previous = invalidInputs.get(field.ownerId);
        invalidInputs.set(field.ownerId, joinedInputText(previous, result.text));
      }
    }
    if (calculationUnavailable) return { ok: false, cancelled: false, failures };
    const next = mapDocumentExpressions(document, value => {
      const result = replacements.get(value);
      return result?.ok ? result.value : value;
    });
    const used = usedDocumentParameterNames(document, fields, byId);
    const analysis: ParameterAnalysis = { variables, exactVariables, mathCoefficients: coefficientNames, nonLengthVariables: nonLength, circular,
      failures: document.parameters.flatMap(parameter => {
        const text = parameterFailures.get(parameter.name);
        return text === undefined ? [] : [{ name: parameter.name, text, ...(workerBrokenParameters.has(parameter.name) ? { code: 'workerBroken' as const } : {}) }];
      }),
      unused: document.parameters.map(parameter => parameter.name).filter(name => !used.has(name)),
      ...(geometryDerived.size === 0 ? {} : { geometryDerived }) };
    const parameters = document.parameters.map(parameter => evaluatedParameters.get(parameter.name) ?? parameter);
    // A measured value changes with the shape while this parameter array may stay the same: never memoize it.
    if (geometryDerived.size === 0) rememberMathParameterEvaluation(parameters, analysis);
    const values = new Map<ExpressionValue, ExpressionValue>();
    for (const [original, result] of replacements) if (result.ok) {
      values.set(original, result.value);
      values.set(result.value, result.value);
    }
    const evaluated = { ...next, parameters };
    verifiedFields.set(document, values);
    verifiedFields.set(evaluated, values);
    if (failures.length > 0) return { ok: false, cancelled: false, failures,
      recompute: { document: evaluated, analysis, invalidInputs, pendingGeometry } };
    return { ok: true, document: evaluated, analysis };
  } catch (error) {
    if (!current()) return cancelled();
    failures.push({ ownerId: document.id, source: '', text: internalDocumentMathFailure('recomputation', error) });
    return { ok: false, cancelled: false, failures };
  }
}
