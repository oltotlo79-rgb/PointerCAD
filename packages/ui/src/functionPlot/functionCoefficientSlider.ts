import { collectMathCoefficients, exactExpressionValueFromNumber, type StoredMathExpression } from '@pointercad/expression';
import type { FunctionDefinition, Parameter, PartDocument } from '@pointercad/model';
import { commitReplaceParameter } from '../parameters/parameterCommands.js';
import { useAppStore } from '../store/useAppStore.js';
import { activePartDocument } from '../store/documentKind.js';
import { t } from '../i18n/t.js';

function formulaExpressions(definition: FunctionDefinition): readonly StoredMathExpression[] {
  const formula = definition.formula;
  switch (formula.kind) {
    case 'implicit-curve': case 'implicit-surface': case 'coordinate-surface': return [formula.expression];
    case 'coordinate-curve': return Object.values(formula.outputs);
    case 'parametric-curve': case 'parametric-surface': return [formula.outputs.X, formula.outputs.Y, formula.outputs.Z];
  }
}

export function functionCoefficientParameters(document: PartDocument, definition: FunctionDefinition): readonly Parameter[] {
  const ids = new Set(formulaExpressions(definition).flatMap(expression => collectMathCoefficients(expression.expression).map(item => item.id)));
  return document.parameters.filter(parameter => parameter.mathId !== undefined && ids.has(parameter.mathId));
}

export interface CoefficientSliderRange { readonly minimum: number; readonly maximum: number }
export function coefficientSliderRange(minimum: string, maximum: string): CoefficientSliderRange | null {
  if (minimum.trim() === '' || maximum.trim() === '') return null;
  const min = Number(minimum), max = Number(maximum);
  return Number.isFinite(min) && Number.isFinite(max) && min < max && Number.isFinite(max - min)
    ? { minimum: min, maximum: max } : null;
}

export function initialCoefficientSliderRange(value: number): CoefficientSliderRange {
  if (!Number.isFinite(value)) return { minimum: -1, maximum: 1 };
  const radius = Math.max(1, Math.abs(value) / 2);
  return { minimum: Math.max(-Number.MAX_VALUE, value - radius), maximum: Math.min(Number.MAX_VALUE, value + radius) };
}

/** Each gesture owns one unique history key; fresh lookups prevent writing into a reopened document. */
export function applyFunctionCoefficientSlider(input: {
  readonly documentId: string; readonly documentVersion: number; readonly coefficientId: string;
  readonly gesture: string; readonly value: number; readonly range: CoefficientSliderRange;
}): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  const state = useAppStore.getState();
  if (activePartDocument(state) === null || state.document.id !== input.documentId
    || state.documentVersion !== input.documentVersion || input.gesture === '') {
    return { ok: false, message: t('math.operation.cancelled') };
  }
  const range = coefficientSliderRange(String(input.range.minimum), String(input.range.maximum));
  if (range === null || !Number.isFinite(input.value) || input.value < range.minimum || input.value > range.maximum) {
    return { ok: false, message: t('functionCoefficient.invalidRange') };
  }
  const parameter = state.document.parameters.find(item => item.mathId === input.coefficientId);
  if (parameter === undefined) return { ok: false, message: t('parameter.error.notFound') };
  const nextValue = exactExpressionValueFromNumber(input.value);
  if (parameter.value.value === input.value && parameter.value.source === nextValue.source) return { ok: true };
  const outcome = commitReplaceParameter(state.document, parameter.name, { value: nextValue });
  if (!outcome.ok) return outcome;
  state.applyDocument(outcome.document, {
    coalesceKey: `functionCoefficient:${input.coefficientId}:${input.gesture}`, coalesceMode: 'gesture',
  });
  return { ok: true };
}
