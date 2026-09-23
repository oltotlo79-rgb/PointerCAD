import { analyzeParameters, createEmptyPartDocument, evaluateDocumentMath, expressionParameterNames, prepareDocumentMathIdentity,
  type PartDocument, type DocumentMathContext } from '@pointercad/model';
import type { ExpressionValue } from '@pointercad/expression';
import type { MathWorkRequest } from '@pointercad/expression/math/client';
import {
  legacyDefinitionToLatex,
  prepareLegacyMathInput,
} from '@pointercad/expression/math/contracts';

import type { MathInsertGroup } from './MathEditorSurface.js';
import { t } from '../i18n/t.js';

/** Omit the edited coefficient and its dependents so an old invalid value cannot prevent repairing that value. */
export async function prepareDocumentMathEnvironment(document: PartDocument,
  context: DocumentMathContext, excludedCoefficient?: string) {
  const prepared = prepareDocumentMathIdentity(document);
  const excluded = new Set(excludedCoefficient === undefined ? [] : [excludedCoefficient]);
  let added = true;
  while (added) {
    added = false;
    for (const parameter of prepared.parameters) {
      if (!excluded.has(parameter.name) && expressionParameterNames(parameter.value, prepared.parameters).some(name => excluded.has(name))) {
        excluded.add(parameter.name); added = true;
      }
    }
  }
  const table = { ...createEmptyPartDocument(), id: prepared.id, parameters: prepared.parameters.filter(parameter => !excluded.has(parameter.name)) };
  // The model retains exact expressions only for evaluated immutable parameter
  // snapshots. A loaded file or changed parameter array has no such proof.
  // Filtering after lookup keeps repairable coefficients and their dependents out.
  const known = analyzeParameters(prepared.parameters, []);
  const reusable = known.mathCoefficients !== undefined && known.failures.length === 0 && known.circular.length === 0
    && !context.signal?.aborted && context.isCurrent() && context.identity.documentId === prepared.id;
  const result = reusable ? { ok: true as const, document: table, analysis: known } : await evaluateDocumentMath(table, context);
  const coefficients: MathWorkRequest['coefficients'][number][] = [];
  if (result.ok) {
    for (const parameter of result.document.parameters) {
      const decimal = result.analysis.exactVariables.get(parameter.name);
      if (parameter.mathId !== undefined && decimal !== undefined) {
        const original = result.analysis.mathCoefficients?.get(parameter.name);
        if (original !== undefined && original.id === parameter.mathId) coefficients.push(original);
      }
    }
  }
  const groups: readonly MathInsertGroup[] = [{ id: 'coefficients', label: t('math.coefficients'), choices: coefficients.map(coefficient => ({
    id: coefficient.id, label: coefficient.label, meaning: `${coefficient.label} = ${coefficient.decimal}`,
    template: legacyDefinitionToLatex({ kind: 'symbol', reference: { role: 'coefficient', id: coefficient.id, label: coefficient.label } }),
  })) }, { id: 'constants', label: t('math.constants'), choices: [
    { id: 'pi', label: 'π', meaning: t('math.constant.pi'), template: String.raw`\pi` },
    { id: 'e', label: 'e', meaning: t('math.constant.e'), template: String.raw`\exponentialE` },
    { id: 'i', label: 'ⅈ', meaning: t('math.constant.i'), template: String.raw`\mathrm{i}` },
  ] }];
  return { prepared, coefficients, groups,
    coefficientProblem: result.ok ? null : result.failures[0]?.message ?? t('math.coefficientsUnavailable') };
}

export async function prepareDocumentMathEditor(document: PartDocument, value: ExpressionValue,
  context: DocumentMathContext, excludedCoefficient?: string) {
  const environment = await prepareDocumentMathEnvironment(document, context, excludedCoefficient);
  let source = value.source;
  if (value.mathDefinition === undefined) {
    try {
      source = prepareLegacyMathInput(source, { resolveVariable: name => {
        const parameter = environment.prepared.parameters.find(parameter => parameter.name === name);
        return parameter?.mathId === undefined ? null : { reference: { role: 'coefficient', id: parameter.mathId, label: name },
          kind: parameter.unit === 'mm' ? 'length' : parameter.unit === 'degree' ? 'angle' : 'scalar' };
      } });
    } catch {
      // A previously invalid short expression remains editable. No cached value or invented conversion is accepted.
    }
  }
  return { ...environment, purpose: 'scalar' as const, source, notation: value.mathDefinition?.inputNotation ?? 'text' as const,
    angleUnit: value.mathDefinition?.angleUnit ?? 'degree' as const };
}
