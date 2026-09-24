/**
 * Operations registered before their calculation exists (plan MC-10).
 *
 * Registration alone makes an operation readable from text and structured
 * input, storable in `pointercad-math/1` and convertible between notations.
 * While its status is `pending`, every calculation that decodes it is rejected
 * as unsupported, before any operand is used: an outer 0, a selected component
 * or another simplification never turns it into a value.
 *
 * IDs and heads are persisted. Implementing tasks change only `status` here and
 * connect their calculation in their own module; they never rename an entry.
 * The exact runtime reaches a task's module through cas_extended_dispatch.py;
 * a TypeScript rewrite into existing operations is registered in the task's
 * `LOWERINGS` table, which prepareMathCalculation.ts applies once implemented.
 */
import { MATH_INPUT_LIMITS, MathInputProblem, type MathNode } from './mathInputContract.js';

/** Rewrite one implemented registered operation into existing operations (its operands already rewritten). */
export type ExtendedLowering = (node: Extract<MathNode, { readonly kind: 'operation' }>, angleUnit: 'degree' | 'radian') => MathNode;

export type ExtendedOperationResult = 'candidates' | 'scalar' | 'vector' | 'matrix' | 'boolean' | 'set';
/** Expected operand types in order; a variadic operation repeats its last type. */
export type ExtendedOperandType = 'value' | 'scalar' | 'integer' | 'vector' | 'set' | 'function';

export interface ExtendedOperationDefinition {
  readonly id: string;
  readonly head: string;
  readonly minimumArguments: number;
  readonly maximumArguments: number;
  /** Symbol or short Japanese name used in user messages and catalog entries. */
  readonly label: string;
  readonly result: ExtendedOperationResult;
  readonly operands: readonly ExtendedOperandType[];
  /** Plan task that implements the calculation. */
  readonly task: 'MC-11' | 'MC-12' | 'MC-16' | 'MC-18' | 'MC-19' | 'MC-23' | 'MC-24' | 'MC-30';
  readonly status: 'pending' | 'implemented';
}

/** An implementing task appends 'implemented' to its own entries when it connects the calculation. */
function operation(id: string, head: string, [minimumArguments, maximumArguments]: readonly [number, number], label: string,
  result: ExtendedOperationResult, operands: readonly ExtendedOperandType[], task: ExtendedOperationDefinition['task'],
  status: ExtendedOperationDefinition['status'] = 'pending'): ExtendedOperationDefinition {
  return { id, head, minimumArguments, maximumArguments, label, result, operands, task, status };
}

export const EXTENDED_OPERATION_DEFINITIONS: readonly ExtendedOperationDefinition[] = Object.freeze([
  // ±a = {a, -a}; a±b = {a+b, a-b}. Candidates are never collapsed to one value.
  operation('plus-minus', 'PlusMinus', [1, 2], '±', 'candidates', ['scalar', 'scalar'], 'MC-11', 'implemented'),
  // ∓a = {-a, a}; a∓b = {a-b, a+b}, in the order that pairs with ± in one formula.
  operation('minus-plus', 'MinusPlus', [1, 2], '∓', 'candidates', ['scalar', 'scalar'], 'MC-11', 'implemented'),
  // Number of elements of a finite set.
  operation('cardinality', 'Cardinality', [1, 1], '要素数', 'scalar', ['set'], 'MC-12', 'implemented'),
  // projection(u, v): projection of u onto a nonzero v, (u·v / v·v) v.
  operation('projection', 'Projection', [2, 2], '射影', 'vector', ['vector', 'vector'], 'MC-16', 'implemented'),
  // identitymatrix(n): n×n identity.
  operation('identity-matrix', 'IdentityMatrix', [1, 1], '単位行列', 'matrix', ['integer'], 'MC-18', 'implemented'),
  // zeromatrix(n) is n×n; zeromatrix(m, n) is m×n.
  operation('zero-matrix', 'ZeroMatrix', [1, 2], '零行列', 'matrix', ['integer', 'integer'], 'MC-18', 'implemented'),
  // notelement(x, A): x ∉ A, the negation of element(x, A) without unknown becoming true.
  operation('not-element', 'NotElement', [2, 2], '∉', 'boolean', ['value', 'set'], 'MC-23', 'implemented'),
  // subset(A, B): proper subset A ⊂ B (A ⊆ B and A ≠ B).
  operation('subset', 'Subset', [2, 2], '⊂', 'boolean', ['set', 'set'], 'MC-23', 'implemented'),
  // subsetequal(A, B): A ⊆ B.
  operation('subset-equal', 'SubsetEqual', [2, 2], '⊆', 'boolean', ['set', 'set'], 'MC-23', 'implemented'),
  // superset(A, B): proper superset A ⊃ B.
  operation('superset', 'Superset', [2, 2], '⊃', 'boolean', ['set', 'set'], 'MC-23', 'implemented'),
  // supersetequal(A, B): A ⊇ B.
  operation('superset-equal', 'SupersetEqual', [2, 2], '⊇', 'boolean', ['set', 'set'], 'MC-23', 'implemented'),
  // complement(A, U): complement of A in the explicit universe U; A must be contained in U.
  operation('complement', 'Complement', [2, 2], '補集合', 'set', ['set', 'set'], 'MC-23', 'implemented'),
  // cartesianproduct(A, B, ...): ordered tuples, at most 16 factors.
  operation('cartesian-product', 'CartesianProduct', [2, 16], '直積', 'set', ['set', 'set'], 'MC-23', 'implemented'),
  // approxequal(a, b, tolerance). The two-operand form is readable only so the
  // calculation can require the tolerance; it never compares without one.
  operation('approximately-equal', 'ApproxEqual', [2, 3], '≈', 'boolean', ['scalar', 'scalar', 'scalar'], 'MC-24', 'implemented'),
  // totaldifferentialat(Function(f, x1, ..., xn), [p1, ..., pn], [dx1, ..., dxn]):
  // the value of df at p for the given increments, in the declared variable order.
  operation('total-differential-at', 'TotalDifferentialAt', [3, 3], '全微分', 'scalar', ['function', 'vector', 'vector'], 'MC-30', 'implemented'),
  // ∮ and ∯ (MC-19d): closedlineintegral(f, [x, y], [x(t), y(t)], t, a, b) and the others are read like the
  // open integrals and calculated as them only after closedIntegrals.ts proves the curve or surface closed.
  operation('closed-line-integral', 'ClosedLineIntegral', [4, 4], '閉曲線の線積分', 'scalar', ['function', 'function', 'scalar', 'scalar'], 'MC-19', 'implemented'),
  operation('closed-circulation', 'ClosedCirculation', [4, 4], '閉曲線の循環', 'scalar', ['function', 'function', 'scalar', 'scalar'], 'MC-19', 'implemented'),
  operation('closed-surface-integral', 'ClosedSurfaceIntegral', [4, 4], '閉曲面の面積分', 'scalar', ['function', 'function', 'vector', 'vector'], 'MC-19', 'implemented'),
  operation('closed-flux-integral', 'ClosedFluxIntegral', [4, 4], '閉曲面の流束', 'scalar', ['function', 'function', 'vector', 'vector'], 'MC-19', 'implemented'),
]);

export const EXTENDED_OPERATION_IDS: ReadonlySet<string> = new Set(EXTENDED_OPERATION_DEFINITIONS.map(value => value.id));

/** Every pending operation anywhere in the expression, including binder bodies and bounds, in registry order. */
export function pendingExtendedOperations(expression: MathNode): readonly ExtendedOperationDefinition[] {
  const pending = new Map(EXTENDED_OPERATION_DEFINITIONS.filter(value => value.status === 'pending').map(value => [value.id, value]));
  const found = new Set<string>(), stack: MathNode[] = [expression];
  let remaining = MATH_INPUT_LIMITS.nodes;
  while (stack.length > 0) {
    const node = stack.pop(); if (node === undefined) break;
    if (--remaining < 0) throw new MathInputProblem('budget', '数式の構造が複雑すぎます。');
    if (node.kind === 'operation') {
      if (pending.has(node.operation)) found.add(node.operation);
      stack.push(...node.operands);
    } else if (node.kind === 'binder') {
      stack.push(node.body);
      for (const { domain } of node.bindings) {
        if (domain.kind === 'set') stack.push(domain.value);
        else if (domain.kind === 'range') {
          stack.push(domain.lower, domain.upper);
          if (domain.step !== null) stack.push(domain.step);
        }
      }
    }
  }
  return [...pending.values()].filter(value => found.has(value.id));
}

/** A user-facing reason naming the operations that still have no calculation, or null. */
export function pendingExtendedOperationMessage(expression: MathNode): string | null {
  const pending = pendingExtendedOperations(expression);
  return pending.length === 0 ? null : `「${pending.map(value => value.label).join('」「')}」の計算にはまだ対応していません。`;
}
