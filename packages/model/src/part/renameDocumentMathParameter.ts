/** One transaction covers the table, geometry expressions, and every saved configuration. */
import { collectMathCoefficients, renameVariable,
  type ExpressionValue, type StoredMathExpression } from '@pointercad/expression';
import { prepareDocumentMathIdentity } from './documentMathIdentity.js';
import { evaluateDocumentMath, type DocumentMathContext } from './evaluateDocumentMath.js';
import { mapDocumentExpressions } from './reevaluatePart.js';
import { mapDocumentNonScalarExpressions } from './documentFunctions.js';
import type { FunctionExpressionScope } from '../functionGeometry/readFunctionDefinition.js';
import { synchronizeConfigurations } from './configurations.js';
import type { PartDocument } from './types.js';
import { checkNewParameterName } from '../parameters/parameterTable.js';
import { resolvableMathGeometryDefinitions } from '../measure/mathGeometryCoefficients.js';
import { mathGeometryCoefficientId } from '../measure/mathGeometryIdentity.js';

export type MathParameterRenameResult =
  | { readonly ok: true; readonly document: PartDocument }
  | { readonly ok: false; readonly cancelled: boolean; readonly message: string };

export async function renameDocumentMathParameter(original: PartDocument, from: string, to: string,
  context: DocumentMathContext): Promise<MathParameterRenameResult> {
  const current = () => !context.signal?.aborted && context.isCurrent() && context.identity.documentId === original.id;
  const rejected = (message: string): MathParameterRenameResult => ({ ok: false, cancelled: !current(), message });
  if (!current()) return rejected('係数の改名を中止しました。');
  if (!original.parameters.some(parameter => parameter.name === from)) return rejected('改名する係数がありません。');
  if (from === to) return { ok: true, document: original };
  // Coefficients and math-geometry definitions share one `coef` label space (GR-01, GR-08): a coefficient named
  // like a definition would drop that definition out of `resolvableMathGeometryDefinitions`, so refuse it here.
  if (checkNewParameterName(to) !== null || original.parameters.some(parameter => parameter.name === to)
    || (original.mathGeometry ?? []).some(definition => definition.name === to)) {
    return rejected('係数の新しい名前が不正、または既に使われています。');
  }
  try {
    const document = prepareDocumentMathIdentity(original);
    const parameterId = document.parameters.find(parameter => parameter.name === from)?.mathId;
    if (parameterId === undefined) return rejected('係数の参照先を確認できません。');
    const definitions = new Set<StoredMathExpression>();
    const scopes = new Map<StoredMathExpression, FunctionExpressionScope>();
    const collect = (value: ExpressionValue): ExpressionValue => {
      if (value.mathDefinition !== undefined) definitions.add(value.mathDefinition);
      return value;
    };
    document.parameters.forEach(parameter => collect(parameter.value));
    mapDocumentExpressions(document, collect);
    mapDocumentNonScalarExpressions(document, (definition, _ownerId, scope) => {
      definitions.add(definition);
      if (scope !== undefined) scopes.set(definition, scope);
      return definition;
    });
    for (const configuration of document.configurations) {
      for (const definition of Object.values(configuration.mathDefinitions ?? {})) definitions.add(definition);
    }
    const byId = new Map(document.parameters.map(parameter => [parameter.mathId, parameter.name]));
    // A formula may also read measured values (GR-04); a `math-geometry:` reference is verified by its definition's name.
    for (const definition of resolvableMathGeometryDefinitions(document).values()) byId.set(mathGeometryCoefficientId(definition.id), definition.name);
    const replacements = new Map<StoredMathExpression, StoredMathExpression>();
    let revision = 0;
    for (const definition of definitions) {
      if (!current()) return rejected('係数の改名を中止しました。');
      const references = collectMathCoefficients(definition.expression);
      if (!references.some(reference => reference.id === parameterId)) continue;
      if (references.some(reference => byId.get(reference.id) !== reference.label)) return rejected('保存された係数の参照先を確認できません。');
      revision += 1;
      const completion = await context.client.evaluate({
        identity: { ...context.identity, editorId: 'rename-coefficient', inputRevision: revision },
        source: definition.source, notation: definition.inputNotation, angleUnit: definition.angleUnit, definition,
        // This request only rewrites labels. Its protocol rejects every numeric result; no cached coordinate is evaluated.
        coefficients: references.map(reference => ({ id: reference.id, label: reference.label, decimal: '0' })),
        renameCoefficient: { id: parameterId, label: to },
        ...(scopes.has(definition) ? { functionScope: scopes.get(definition) } : {}),
      }, 5_000, context.signal);
      if (!current()) return rejected('係数の改名を中止しました。');
      if (completion.status !== 'result' || completion.result.renamedDefinition == null) {
        return rejected('数式の参照先を保った改名ができませんでした。');
      }
      replacements.set(definition, completion.result.renamedDefinition);
    }
    const rewrite = (value: ExpressionValue): ExpressionValue => {
      const definition = value.mathDefinition;
      if (definition === undefined) {
        const source = renameVariable(value.source, from, to);
        return source === value.source ? value : { ...value, source };
      }
      const next = replacements.get(definition);
      return next === undefined ? value : { ...value, source: next.source, mathDefinition: next };
    };
    const geometry = mapDocumentNonScalarExpressions(mapDocumentExpressions(document, rewrite), definition => replacements.get(definition) ?? definition);
    const parameters = document.parameters.map(parameter => ({ ...parameter,
      name: parameter.name === from ? to : parameter.name, value: rewrite(parameter.value) }));
    const configurations = document.configurations.map(configuration => {
      const values: Record<string, string> = {}, mathDefinitions: Record<string, StoredMathExpression> = {};
      for (const [name, source] of Object.entries(configuration.values)) {
        const key = name === from ? to : name, definition = configuration.mathDefinitions?.[name];
        if (definition === undefined) values[key] = renameVariable(source, from, to);
        else {
          const next = replacements.get(definition) ?? definition;
          mathDefinitions[key] = next;
          values[key] = next.source;
        }
      }
      return { id: configuration.id, name: configuration.name, values,
        ...(Object.keys(mathDefinitions).length === 0 ? {} : { mathDefinitions }) };
    });
    // `context` passes through unchanged: no definition is renamed here, so `context.geometry` (GR-04) still resolves.
    const result = await evaluateDocumentMath(synchronizeConfigurations({ ...geometry, parameters, configurations }), context);
    if (!current()) return rejected('係数の改名を中止しました。');
    return result.ok ? { ok: true, document: result.document }
      : rejected(result.failures[0]?.message ?? '係数を改名した文書を再計算できませんでした。');
  } catch (error) {
    return rejected(error instanceof Error ? error.message : '係数の改名を完了できませんでした。');
  }
}
