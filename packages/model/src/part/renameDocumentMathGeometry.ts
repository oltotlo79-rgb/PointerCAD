/**
 * 図形の測定値の改名。定義の名前と、係数IDを持つ全 `coef` 節の表示ラベルを一括更新する。
 * IDは `math-geometry:` + 定義IDのまま保ち、どの式も同じ測定値を参照し続ける。
 * 文書全体を検証してから呼出し側が一度だけ公開し、1回のUndoで戻せるようにする。
 *
 * - 係数と測定値は名前空間を共有する。`checkMathGeometryName` は自分自身を重複検査から除く。
 * - 数学計算部の `renameCoefficient` は、原式の表記を保ってラベルを書き換え、意味と他の参照の
 *   不変を確認する。通常の係数改名(`renameDocumentMathParameter`)と同じ依頼を使う。
 * - 測定値を直接読むのは係数の式と、それを保持する構成・未解決の式に限る(FR-210/FR-211)。
 *   ただし保存された係数・寸法欄・関数式・未解決の式・構成を全て巡り、該当IDの旧ラベルを残さない。
 * - `evaluateDocumentMath` へ呼出し元の `context` をそのまま渡す。`context.geometry` は
 *   現在の再計算の測定値を定義IDで解決する。改名自体は形も値も変えないが、
 *   `mathGeometry` の編集なので `affectsShape` により一度再計算する。
 * - 取消や文書変更では文書を返さず、途中の変更を公開しない。
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
