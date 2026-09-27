/**
 * Geometry-derived coefficients inside function-plot formulas (GR-06b, `scratchpad/claude/plans/geomref-plan.md`
 * §4(e)「関数作図の式」and §5.2 GR-06b; the lead's decision of 2026-09-24).
 *
 * A geometry-derived coefficient carries the shape kernel's double (GR-04). A coefficient formula computed from one
 * may only use continuous operations (Q4=S1, `GEOMETRY_DERIVED_OPERATIONS`). A function plot (a curve, a surface and
 * the points placed on them) also contains its own axes and parameters, so the rule is applied per operation: an
 * operation outside the Q4=S1 list, or a binder (sum, integral, …), is refused only when its own operands read a
 * geometry-derived coefficient. `floor(X)+coef("R")` is accepted (the floor jumps with X, which the plot samples on
 * purpose); `floor(coef("R"))` is refused (a measured 2.9999999999999996 would silently become 2). The one exception
 * is the `=` at the root of an implicit curve or surface: it defines the geometry (F = G) and is not a comparison;
 * both of its sides are checked by the same rule.
 *
 * Scalar fields of a plot (bounds, tolerance, T/U/V ranges, the fixed coordinate) are not formulas here:
 * `evaluateDocumentMath` already applies GR-04's stricter whole-formula check to them. Kept pure so the
 * recomputation (`resolveFunctionInputs`, every recompute path including an opened file) and the plot editor
 * (GR-18b) share this one rule.
 */
import type { StoredMathExpression } from '@pointercad/expression';
import type { MathNode } from '@pointercad/expression/math/contracts';
import type { FunctionDefinition } from '../functionGeometry/functionDefinitionTypes.js';
import type { FunctionPlotAxis } from '../functionGeometry/functionPlotBounds.js';
import type { Parameter } from '../parameters/types.js';
import { checkGeometryDerivedOperations, GEOMETRY_DERIVED_OPERATIONS, type GeometryDerivedOperationIssue,
} from './mathGeometryCoefficients.js';

/** GR-04's issue, plus which formula of the plot holds the refused operation (so the editor can mark that field). */
export interface GeometryDerivedFunctionOperationIssue extends GeometryDerivedOperationIssue {
  /** The output axis of that formula, or `null` for the single equation of an implicit curve or surface. */
  readonly output: FunctionPlotAxis | null;
}

interface FunctionFormulaEntry {
  readonly output: FunctionPlotAxis | null;
  readonly expression: StoredMathExpression;
}

function functionFormulas(definition: FunctionDefinition): readonly FunctionFormulaEntry[] {
  const formula = definition.formula;
  switch (formula.kind) {
    case 'implicit-curve': case 'implicit-surface': return [{ output: null, expression: formula.expression }];
    case 'coordinate-surface': return [{ output: formula.output, expression: formula.expression }];
    case 'coordinate-curve':
      if (formula.independent === 'X') {
        return [{ output: 'Y', expression: formula.outputs.Y }, { output: 'Z', expression: formula.outputs.Z }];
      }
      if (formula.independent === 'Y') {
        return [{ output: 'X', expression: formula.outputs.X }, { output: 'Z', expression: formula.outputs.Z }];
      }
      return [{ output: 'X', expression: formula.outputs.X }, { output: 'Y', expression: formula.outputs.Y }];
    case 'parametric-curve': case 'parametric-surface':
      return [{ output: 'X', expression: formula.outputs.X }, { output: 'Y', expression: formula.outputs.Y },
        { output: 'Z', expression: formula.outputs.Z }];
  }
}

/**
 * The formulas of a function plot: the single expression of an implicit or coordinate-surface form, otherwise every
 * output in X, Y, Z order (a coordinate curve has no formula for its independent axis). The same list as the plot
 * editor's (`packages/ui/src/functionPlot/functionCoefficientSlider.ts`); scalar fields are not formulas.
 */
export function functionFormulaExpressions(definition: FunctionDefinition): readonly StoredMathExpression[] {
  return functionFormulas(definition).map(entry => entry.expression);
}

/**
 * The `coef` IDs (`Parameter.mathId`) of the geometry-derived coefficients among `parameters`. `derived` maps a
 * coefficient name to the definitions it uses: `ParameterAnalysis.geometryDerived`, or GR-04's
 * `mathGeometryDerivedParameters(parameters)`. A derived coefficient without a math ID cannot appear in a plot formula
 * (formulas name coefficients by ID) and adds nothing.
 */
export function mathGeometryDerivedCoefficientIds(parameters: readonly Parameter[],
  derived: ReadonlyMap<string, readonly string[]> | undefined): ReadonlySet<string> {
  const ids = new Set<string>();
  if (derived === undefined || derived.size === 0) return ids;
  for (const parameter of parameters) {
    if (parameter.mathId !== undefined && derived.has(parameter.name)) ids.add(parameter.mathId);
  }
  return ids;
}

/** Operands left to right: an operation's operands, or a binder's binding domains (in binding order) and then its body. */
function operandsOf(node: MathNode): readonly MathNode[] {
  if (node.kind === 'operation') return node.operands;
  if (node.kind !== 'binder') return [];
  const operands: MathNode[] = [];
  for (const { domain } of node.bindings) {
    if (domain.kind === 'set') operands.push(domain.value);
    else if (domain.kind === 'range') {
      operands.push(domain.lower, domain.upper);
      if (domain.step !== null) operands.push(domain.step);
    }
  }
  operands.push(node.body);
  return operands;
}

/**
 * Every node of `root` whose subtree reads a coefficient in `ids`. One iterative post-order pass (no recursion, R27):
 * each node is expanded once even when the parser shares a node object, so the cost stays linear in the stored
 * formula, which the decoder already bounds (nodes and depth).
 */
function nodesReading(root: MathNode, ids: ReadonlySet<string>): ReadonlySet<MathNode> {
  const reading = new Set<MathNode>(), expanded = new Set<MathNode>();
  const pending: { readonly node: MathNode; readonly exit: boolean }[] = [{ node: root, exit: false }];
  while (pending.length > 0) {
    const step = pending.pop();
    if (step === undefined) break;
    const node = step.node;
    if (step.exit) {
      if (operandsOf(node).some(operand => reading.has(operand))) reading.add(node);
      continue;
    }
    if (expanded.has(node)) continue;
    expanded.add(node);
    if (node.kind === 'symbol') {
      if (node.reference.role === 'coefficient' && ids.has(node.reference.id)) reading.add(node);
      continue;
    }
    pending.push({ node, exit: true });
    for (const operand of operandsOf(node)) pending.push({ node: operand, exit: false });
  }
  return reading;
}

/** Q4=S1 applied to one node: a binder, or an operation outside `GEOMETRY_DERIVED_OPERATIONS` (GR-04's list). */
function refusedOperation(node: MathNode): boolean {
  return node.kind === 'binder' || (node.kind === 'operation' && !GEOMETRY_DERIVED_OPERATIONS.has(node.operation));
}

/** The `=` of `F = G` at the root of an implicit curve or surface: it defines the geometry and is not a comparison. */
function definingEquation(node: MathNode): node is Extract<MathNode, { readonly kind: 'operation' }> {
  return node.kind === 'operation' && node.operation === 'equal' && node.operands.length === 2;
}

/**
 * The first refused operation (pre-order, left to right, like GR-04) whose operands read a coefficient in `ids`.
 * Subtrees that read none are skipped: nothing inside them can be refused.
 */
function firstRefusedOperation(root: MathNode, ids: ReadonlySet<string>, implicit: boolean): GeometryDerivedOperationIssue | null {
  const reading = nodesReading(root, ids);
  if (!reading.has(root)) return null;
  const pending: MathNode[] = implicit && definingEquation(root) ? [...root.operands].reverse() : [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    if (!reading.has(node)) continue;
    if (refusedOperation(node)) {
      // GR-04's checker reports its own root first (pre-order), so for a refused node it yields exactly GR-04's
      // issue: the same operation ID and the same spelling in Appendix C's sentence (e.g. `ceiling` → 「ceil」).
      const issue = checkGeometryDerivedOperations(node);
      if (issue !== null) return issue;
    }
    const operands = operandsOf(node);
    for (let index = operands.length - 1; index >= 0; index -= 1) pending.push(operands[index]);
  }
  return null;
}

/**
 * GR-06b: the first operation in the plot's formulas (in `functionFormulaExpressions` order) that feeds a
 * geometry-derived coefficient (`derivedCoefficientIds`, see `mathGeometryDerivedCoefficientIds`) into a value
 * boundary, or `null` when the plot may use them. The reason is GR-04's Appendix C sentence「演算」. With no derived
 * coefficient nothing is examined. A measured value referenced directly by a plot formula is a different refusal
 * (GR-04's `mathGeometryOutsideCoefficientMessage`), made where the coefficients are resolved.
 */
export function checkGeometryDerivedFunctionOperations(definition: FunctionDefinition,
  derivedCoefficientIds: ReadonlySet<string>): GeometryDerivedFunctionOperationIssue | null {
  if (derivedCoefficientIds.size === 0) return null;
  const implicit = definition.formula.kind === 'implicit-curve' || definition.formula.kind === 'implicit-surface';
  for (const { output, expression } of functionFormulas(definition)) {
    const issue = firstRefusedOperation(expression.expression, derivedCoefficientIds, implicit);
    if (issue !== null) return { ...issue, output };
  }
  return null;
}
