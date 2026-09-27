/**
 * How a measured math-geometry value enters a coefficient formula (GR-04,
 * `scratchpad/claude/plans/geomref-plan.md` §4(e) and §5.2 GR-04).
 *
 * A measured value is the shape kernel's own double. It is handed to the math engine exactly like a
 * coefficient (`MathCoefficientValue`), but only as its shortest round-trip decimal — never with an
 * `exactExpression`, never re-read as an exact rational, never memoized with the parameter table — and
 * every formula computed from it (directly, or through other coefficients) may only use operations that
 * are continuous in their inputs (Q4=S1). The comparison tolerance of a definition stays a comparison
 * margin; nothing here turns it into an error bound (R70).
 *
 * Kept free of evaluation state so the same contract serves `evaluateDocumentMath` (GR-04), the stage
 * recomputation (GR-06) and the coefficient editor (GR-17).
 */
import type { MathCoefficientValue } from '@pointercad/expression';
import { CANDIDATE_MATH_BY_ID, type MathNode } from '@pointercad/expression/math/contracts';
import { parameterDependencies } from '../parameters/parameterTable.js';
import type { Parameter } from '../parameters/types.js';
import type { PartDocument } from '../part/types.js';
import { mathGeometryCoefficientId, mathGeometryReferencesOf } from './mathGeometryIdentity.js';
import type { MathGeometryDefinition, MathGeometryOutcome } from './mathGeometryTypes.js';

/* ---------------------------------------------------------------------------
 * Q4=S1: operations allowed in a formula computed from a measured value
 * ------------------------------------------------------------------------- */

/** The 24 trigonometric and hyperbolic functions and their inverses (`sin` … `arcsch`). */
const TRIGONOMETRIC_OPERATIONS = [
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
  'arcsin', 'arccos', 'arctan', 'arccot', 'arcsec', 'arccsc',
  'sinh', 'cosh', 'tanh', 'coth', 'sech', 'csch',
  'arsinh', 'arcosh', 'artanh', 'arcoth', 'arsech', 'arcsch',
] as const;

/**
 * Q4=S1 (§4(e)): the operation IDs a geometry-derived formula may contain. Every one is continuous in
 * its operands, so a measured double that is off by a rounding step moves the result by a comparable
 * amount instead of jumping (floor, round, comparisons, cases, integer arithmetic, sets, equations and
 * ranged sums/integrals are all absent on purpose). The structural IDs only carry notation.
 */
export const GEOMETRY_DERIVED_OPERATIONS: ReadonlySet<string> = new Set<string>([
  'add', 'subtract', 'negate', 'multiply', 'divide', 'power', 'sqrt', 'root', 'square', 'absolute',
  'minimum', 'maximum', 'exponential', 'natural-log', 'log-base', 'log-two', 'log-ten',
  ...TRIGONOMETRIC_OPERATIONS, 'arctan-two', 'reciprocal', 'clamp',
  'list', 'tuple', 'component', 'norm', 'dot', 'cross',
  'delimiter', 'coefficient-reference', 'implicit-operation', 'times-token', 'dot-token',
]);

/** A formula computed from a measured value used an operation outside `GEOMETRY_DERIVED_OPERATIONS`. */
export interface GeometryDerivedOperationIssue {
  /** The rejected operation ID exactly as stored in the formula (e.g. `floor`, `less`, `sum`). */
  readonly operation: string;
  /** Appendix C's sentence, naming the operation the way the text notation spells it. */
  readonly message: string;
}

/** How the text notation writes an operation: its engine head in lower case (`ceiling` → `ceil`). */
function operationName(operation: string): string {
  return CANDIDATE_MATH_BY_ID.get(operation)?.engineHead.toLowerCase() ?? operation;
}

/**
 * The first operation (pre-order, left to right) in `expression` that a geometry-derived formula may
 * not use, or `null` when the whole formula is allowed. A binder (sum, product, integral, derivative,
 * limit, function literal, quantifier) is always rejected: none of them is in the Q4=S1 list. Numbers,
 * constants and symbols are not operations and are accepted; a declared value is a closed constant and
 * a declared map can only be applied through `mapping-value`, which is rejected here.
 *
 * Walks iteratively (R27): stored formulas are already bounded by the decoder's node and depth limits.
 */
export function checkGeometryDerivedOperations(expression: MathNode): GeometryDerivedOperationIssue | null {
  const pending: MathNode[] = [expression];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    if (node.kind === 'binder' || (node.kind === 'operation' && !GEOMETRY_DERIVED_OPERATIONS.has(node.operation))) {
      return { operation: node.operation, message: mathGeometryOperationMessage(operationName(node.operation)) };
    }
    if (node.kind === 'operation') {
      for (let index = node.operands.length - 1; index >= 0; index -= 1) pending.push(node.operands[index]);
    }
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * Which coefficients are geometry-derived (§4(e) 由来の保持)
 * ------------------------------------------------------------------------- */

/**
 * Coefficient name → the math-geometry definition IDs it uses, directly through `coef` references in
 * its own formula or through any coefficient it depends on (math `coef` references and legacy names
 * alike, via `parameterDependencies`). Only geometry-derived coefficients appear, in table order; each
 * list starts with the coefficient's own references and never repeats an ID. IDs are listed even when
 * no such definition exists, so a coefficient that points at a deleted measurement still counts as
 * geometry-derived (it fails with a reason instead of silently becoming exact).
 *
 * Static: needs no measured value, so callers can mark a coefficient before (or without) recomputing.
 * Circular dependencies terminate (each coefficient is visited once per start). Like
 * `parameterDependencies`, it throws `MathInputProblem` when one formula gives the same coefficient ID
 * two different labels.
 */
export function mathGeometryDerivedParameters(parameters: readonly Parameter[]): ReadonlyMap<string, readonly string[]> {
  const direct = new Map<string, readonly string[]>();
  for (const parameter of parameters) {
    if (direct.has(parameter.name)) continue;
    const definition = parameter.value.mathDefinition;
    direct.set(parameter.name, definition === undefined ? [] : mathGeometryReferencesOf(definition).map(reference => reference.definitionId));
  }
  const derived = new Map<string, readonly string[]>();
  // Without a single measured reference nothing can be derived; skip the dependency walk (R45: no cost
  // for documents that do not use math geometry).
  if ([...direct.values()].every(ids => ids.length === 0)) return derived;
  const dependencies = parameterDependencies(parameters);
  for (const name of direct.keys()) {
    const ids = new Set<string>();
    const visited = new Set<string>([name]);
    const queue: string[] = [name];
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      for (const id of direct.get(current) ?? []) ids.add(id);
      for (const dependency of dependencies.get(current) ?? []) {
        if (!visited.has(dependency)) {
          visited.add(dependency);
          queue.push(dependency);
        }
      }
    }
    if (ids.size > 0) derived.set(name, [...ids]);
  }
  return derived;
}

/* ---------------------------------------------------------------------------
 * Handing one measured value to the math engine (§4(e) 数式への入力)
 * ------------------------------------------------------------------------- */

/**
 * The definitions a `coef` reference may resolve to, by definition ID. A definition is left out when
 * another definition repeats its ID or its name, or a coefficient already has its name: definitions and
 * coefficients share one label space (GR-01), and the math engine refuses a request whose coefficient
 * labels repeat. A reference to a left-out definition fails with a reason; it never picks one of the
 * candidates.
 */
export function resolvableMathGeometryDefinitions(document: PartDocument): ReadonlyMap<string, MathGeometryDefinition> {
  const definitions = document.mathGeometry ?? [];
  const idCounts = new Map<string, number>(), nameCounts = new Map<string, number>();
  for (const definition of definitions) {
    idCounts.set(definition.id, (idCounts.get(definition.id) ?? 0) + 1);
    nameCounts.set(definition.name, (nameCounts.get(definition.name) ?? 0) + 1);
  }
  const parameterNames = new Set(document.parameters.map(parameter => parameter.name));
  const resolvable = new Map<string, MathGeometryDefinition>();
  for (const definition of definitions) {
    if (idCounts.get(definition.id) === 1 && nameCounts.get(definition.name) === 1 && !parameterNames.has(definition.name)) {
      resolvable.set(definition.id, definition);
    }
  }
  return resolvable;
}

type UnresolvedMathGeometryReason = Extract<MathGeometryOutcome, { readonly status: 'unresolved' }>['reason'];

/**
 * What one definition contributes to a formula, given the outcome the caller has for it:
 * - `value`: the coefficient to pass to the math engine (shortest decimal, no `exactExpression`);
 * - `pending`: no current outcome for this document yet ("計算待ち");
 * - `boolean`: a parallel/perpendicular-style judgment, which never enters a formula;
 * - `unresolved`: the measurement failed; `message` is the measuring code's reason.
 */
export type MathGeometryCoefficientInput =
  | { readonly status: 'value'; readonly coefficient: MathCoefficientValue }
  | { readonly status: 'pending' }
  | { readonly status: 'boolean' }
  | { readonly status: 'unresolved'; readonly reason: UnresolvedMathGeometryReason; readonly message: string };

/**
 * Convert `outcome` (the caller's current result for `definition`, or `undefined`) into the input the
 * math engine receives for `coef("<definition.name>")`. An outcome that belongs to another document or
 * another definition is not this definition's current value and reads as `pending`; freshness within
 * this document (same recomputation generation) is the caller's responsibility (GR-06 passes only this
 * generation's outcomes, GR-14/GR-18 only the current ones).
 *
 * The decimal is `String(value)`: the shortest decimal that reads back to the same double, possibly in
 * exponent notation (`1e-7`, `1.5e+21`), which the math engine's decimal grammar accepts. It is never
 * rounded further here and never accompanied by an `exactExpression` (§4(e)); the unit is the
 * definition's own (mm, mm², mm³, degree or radian) and is not converted.
 */
export function mathGeometryCoefficientValue(document: PartDocument, definition: MathGeometryDefinition,
  outcome: MathGeometryOutcome | undefined): MathGeometryCoefficientInput {
  if (outcome === undefined || outcome.id !== definition.id || outcome.documentId !== document.id) return { status: 'pending' };
  if (outcome.status === 'unresolved') return { status: 'unresolved', reason: outcome.reason, message: outcome.message };
  if (outcome.kind === 'boolean') return { status: 'boolean' };
  if (!Number.isFinite(outcome.value)) {
    return { status: 'unresolved', reason: 'failed-geometry', message: '図形から有限で妥当な測定値を取得できませんでした。' };
  }
  return { status: 'value',
    coefficient: { id: mathGeometryCoefficientId(definition.id), label: definition.name, decimal: String(outcome.value) } };
}

/* ---------------------------------------------------------------------------
 * Reasons shown to the user (Appendix C; the model keeps its own Japanese text because it cannot read
 * the UI's message files, like `LENGTH_UNIT_NAME_MESSAGE`)
 * ------------------------------------------------------------------------- */

/** Appendix C「参照先の不一致」: the definition is missing, renamed without this reference, or ambiguous. */
export function mathGeometryReferenceMismatchMessage(label: string): string {
  return `図形の測定値の参照先を確認できません: ${label}`;
}

/** Appendix C「測れない」: `reason` is the measuring code's own sentence. */
export function mathGeometryUnresolvedMessage(definitionName: string, coefficientName: string, reason: string): string {
  return `図形の測定値「${definitionName}」を測れないため、係数「${coefficientName}」を計算できません: ${reason}`;
}

/** Appendix C「真偽」. */
export function mathGeometryBooleanMessage(definitionName: string): string {
  return `平行・垂直などの判定の結果は係数の式に使えません: ${definitionName}`;
}

/** Appendix C「演算」. */
export function mathGeometryOperationMessage(operation: string): string {
  return `図形の測定値から計算する式では「${operation}」を使えません。値の境目で結果が変わる計算は使えません。`;
}

/** Not in Appendix C: the value is simply not measured yet in this recomputation ("計算待ち"). */
export function mathGeometryPendingMessage(definitionName: string): string {
  return `図形の測定値「${definitionName}」を計算中です。形の計算が終わると使えます。`;
}

/** Not in Appendix C: Q2=U1/U3 lets only a coefficient's own formula read a measured value. */
export function mathGeometryOutsideCoefficientMessage(label: string): string {
  return `図形の測定値は係数の式の中でだけ使えます: ${label}`;
}
