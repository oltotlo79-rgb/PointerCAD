/**
 * Renaming a math-geometry definition (GR-08, `scratchpad/claude/plans/geomref-plan.md` §4(b) and §5.2 GR-08).
 *
 * One transaction: the definition's `name` and the label of every `coef` node that carries its coefficient
 * ID (`math-geometry:` + definition ID) change together, the result is validated as a whole document, and
 * the caller publishes it once (one Undo step, §4(b)). IDs never change, so every formula keeps pointing at
 * the same measurement (R23); only the label it displays follows the new name.
 *
 * - Names share one `coef` label space with coefficients (GR-01): the new name goes through
 *   `checkMathGeometryName` with this definition excluded from the duplicate check.
 * - Labels are rewritten by the math engine's `renameCoefficient` request, the protocol the coefficient
 *   rename (`renameDocumentMathParameter`) uses: it re-formats a formula in its own notation and proves that
 *   the meaning and every other reference stay the same. The walk visits every stored formula that rename
 *   visits (coefficients, fields, function formulas, unresolved problems, configurations). Q2=U1 lets only
 *   coefficient formulas, configurations and unresolved problems read a measured value, but no stale label
 *   may survive wherever a node with this ID exists.
 * - Validation: `evaluateDocumentMath` with the caller's `context` unchanged, so `context.geometry` (GR-04:
 *   the measured values of this document's current recomputation, keyed by definition ID) resolves the
 *   relabelled formulas. A rename changes no shape and no value (rules §10.303); as an edit of
 *   `mathGeometry` it still triggers one recomputation (`affectsShape`, §4(b)).
 * - Cancellation or a document change returns no document at all; nothing partial is ever published.
 */
import { collectMathCoefficients, type ExpressionValue, type StoredMathExpression } from '@pointercad/expression';
import type { FunctionExpressionScope } from '../functionGeometry/readFunctionDefinition.js';
import { resolvableMathGeometryDefinitions } from '../measure/mathGeometryCoefficients.js';
import { checkMathGeometryName, mathGeometryCoefficientId, type MathGeometryNameIssue } from '../measure/mathGeometryIdentity.js';
import { synchronizeConfigurations } from './configurations.js';
import { mapDocumentNonScalarExpressions } from './documentFunctions.js';
import { evaluateDocumentMath, type DocumentMathContext } from './evaluateDocumentMath.js';
import { mapDocumentExpressions } from './reevaluatePart.js';
import type { PartDocument } from './types.js';

/**
 * Why a rename refused. Name issues are GR-01's `MathGeometryNameIssue` verbatim, so the screen can show its
 * own `parameter.error.*` text (付録B). The rest:
 * - `notFound`: no single definition carries this ID.
 * - `cancelled`: the request was aborted, or the document is no longer the current one.
 * - `unverifiedReference`: a formula to relabel carries a label that differs from the current name of what
 *   it references, so it cannot be relabelled safely.
 * - `rewriteFailed`: the math engine could not relabel a formula while keeping its meaning.
 * - `invalidDocument`: the renamed document does not evaluate; `message` is its first failure (for example
 *   a measured value that is not current yet).
 */
export type MathGeometryRenameReason = MathGeometryNameIssue
  | 'notFound' | 'cancelled' | 'unverifiedReference' | 'rewriteFailed' | 'invalidDocument';

export type MathGeometryRenameResult =
  | { readonly ok: true; readonly document: PartDocument }
  | { readonly ok: false; readonly cancelled: boolean; readonly reason: MathGeometryRenameReason; readonly message: string };

/**
 * Renames definition `definitionId` of `original` to `newName`. Renaming to the current name returns
 * `original` itself (nothing to publish, no Undo step). Never mutates `original`.
 */
export async function renameDocumentMathGeometry(original: PartDocument, definitionId: string, newName: string,
  context: DocumentMathContext): Promise<MathGeometryRenameResult> {
  const current = () => !context.signal?.aborted && context.isCurrent() && context.identity.documentId === original.id;
  const refuse = (reason: MathGeometryRenameReason, message: string): MathGeometryRenameResult =>
    ({ ok: false, cancelled: !current(), reason, message });
  const stopped = (): MathGeometryRenameResult => refuse('cancelled', '図形の測定値の名前の変更を中止しました。');
  if (!current()) return stopped();
  const targets = (original.mathGeometry ?? []).filter(definition => definition.id === definitionId);
  if (targets.length !== 1) return refuse('notFound', '名前を変える図形の測定値がありません。');
  const target = targets[0];
  if (target.name === newName) return { ok: true, document: original };
  const issue = checkMathGeometryName(original, newName, definitionId);
  if (issue !== null) return refuse(issue, '図形の測定値の新しい名前が不正、または既に使われています。');
  try {
    const coefficientId = mathGeometryCoefficientId(definitionId);
    // The label each referenced ID must carry now: coefficients by math ID, measured values by definition name.
    const labels = new Map<string, string>();
    for (const parameter of original.parameters) if (parameter.mathId !== undefined) labels.set(parameter.mathId, parameter.name);
    for (const definition of resolvableMathGeometryDefinitions(original).values()) {
      labels.set(mathGeometryCoefficientId(definition.id), definition.name);
    }
    labels.set(coefficientId, target.name);
    const { formulas, scopes } = storedFormulas(original);
    const replacements = new Map<StoredMathExpression, StoredMathExpression>();
    let revision = 0;
    for (const formula of formulas) {
      if (!current()) return stopped();
      const references = collectMathCoefficients(formula.expression);
      if (!references.some(reference => reference.id === coefficientId)) continue;
      if (references.some(reference => labels.get(reference.id) !== reference.label)) {
        return refuse('unverifiedReference', '保存された式の参照先を確認できません。');
      }
      revision += 1;
      const scope = scopes.get(formula);
      const completion = await context.client.evaluate({
        identity: { ...context.identity, editorId: 'rename-math-geometry', inputRevision: revision },
        source: formula.source, notation: formula.inputNotation, angleUnit: formula.angleUnit, definition: formula,
        // Only labels are rewritten: the protocol refuses any numeric result, so no measured value is sent.
        coefficients: references.map(reference => ({ id: reference.id, label: reference.label, decimal: '0' })),
        renameCoefficient: { id: coefficientId, label: newName },
        ...(scope === undefined ? {} : { functionScope: scope }),
      }, 5_000, context.signal);
      if (!current()) return stopped();
      if (completion.status !== 'result' || completion.result.renamedDefinition == null) {
        return refuse('rewriteFailed', '数式の参照先を保った名前の変更ができませんでした。');
      }
      replacements.set(formula, completion.result.renamedDefinition);
    }
    const result = await evaluateDocumentMath(synchronizeConfigurations(relabel(original, replacements, definitionId, newName)), context);
    if (!current()) return stopped();
    return result.ok ? { ok: true, document: result.document }
      : refuse('invalidDocument', result.failures[0]?.message ?? '名前を変えた文書を計算し直せませんでした。');
  } catch (error) {
    if (!current()) return stopped();
    return refuse('rewriteFailed', error instanceof Error ? error.message : '図形の測定値の名前を変更できませんでした。');
  }
}

/** Every stored formula of `document`, and the variable scope each function formula is parsed in. */
function storedFormulas(document: PartDocument): {
  readonly formulas: ReadonlySet<StoredMathExpression>;
  readonly scopes: ReadonlyMap<StoredMathExpression, FunctionExpressionScope>;
} {
  const formulas = new Set<StoredMathExpression>();
  const scopes = new Map<StoredMathExpression, FunctionExpressionScope>();
  const collect = (value: ExpressionValue): ExpressionValue => {
    if (value.mathDefinition !== undefined) formulas.add(value.mathDefinition);
    return value;
  };
  document.parameters.forEach(parameter => collect(parameter.value));
  mapDocumentExpressions(document, collect);
  mapDocumentNonScalarExpressions(document, (definition, _ownerId, scope) => {
    formulas.add(definition);
    // An unresolved problem has no function scope; its declared symbols travel inside its own definition.
    if (scope !== undefined) scopes.set(definition, scope);
    return definition;
  });
  for (const configuration of document.configurations) {
    for (const definition of Object.values(configuration.mathDefinitions ?? {})) formulas.add(definition);
  }
  return { formulas, scopes };
}

/** `document` with every relabelled formula swapped in and the definition renamed; nothing else changes. */
function relabel(document: PartDocument, replacements: ReadonlyMap<StoredMathExpression, StoredMathExpression>,
  definitionId: string, name: string): PartDocument {
  const rewrite = (value: ExpressionValue): ExpressionValue => {
    const next = value.mathDefinition === undefined ? undefined : replacements.get(value.mathDefinition);
    return next === undefined ? value : { ...value, source: next.source, mathDefinition: next };
  };
  const relabelled = mapDocumentNonScalarExpressions(mapDocumentExpressions(document, rewrite),
    formula => replacements.get(formula) ?? formula);
  const parameters = document.parameters.map(parameter => {
    const value = rewrite(parameter.value);
    return value === parameter.value ? parameter : { ...parameter, value };
  });
  const configurations = document.configurations.map(configuration => {
    const entries = Object.entries(configuration.mathDefinitions ?? {});
    if (!entries.some(([, definition]) => replacements.has(definition))) return configuration;
    const values = { ...configuration.values }, mathDefinitions: Record<string, StoredMathExpression> = {};
    for (const [key, definition] of entries) {
      const next = replacements.get(definition) ?? definition;
      mathDefinitions[key] = next;
      // A configuration keeps each math entry's source equal to its definition's (`configurationDefinitions`).
      if (next !== definition) values[key] = next.source;
    }
    return { ...configuration, values, mathDefinitions };
  });
  const mathGeometry = (document.mathGeometry ?? []).map(definition => definition.id === definitionId ? { ...definition, name } : definition);
  return { ...relabelled, parameters, configurations, mathGeometry };
}
