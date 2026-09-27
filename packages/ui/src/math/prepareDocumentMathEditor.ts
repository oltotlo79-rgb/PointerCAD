import { analyzeParameters, createEmptyPartDocument, evaluateDocumentMath, expressionParameterNames, prepareDocumentMathIdentity,
  analyzeMathGeometryDependencies, checkGeometryDerivedOperations, mathGeometryCoefficientValue,
  mathGeometryDerivedParameters, mathGeometryParameterDraft, mathGeometryReferencesOf, resolvableMathGeometryDefinitions,
  type MathGeometryOutcome, type MathGeometryValueUnit, type ParameterUnit, type PartDocument, type DocumentMathContext } from '@pointercad/model';
import type { ExpressionValue, StoredMathExpression } from '@pointercad/expression';
import type { MathWorkRequest } from '@pointercad/expression/math/client';
import {
  legacyDefinitionToLatex,
  prepareLegacyMathInput,
} from '@pointercad/expression/math/contracts';

import type { MathInsertGroup } from './MathEditorSurface.js';
import { t } from '../i18n/t.js';
import { mathGeometryInputsFor, waitForCurrentMathGeometry } from './mathGeometryResults.js';
import { useAppStore } from '../store/useAppStore.js';

export interface MathGeometryEditorTarget {
  readonly coefficientName: string;
  readonly unit: ParameterUnit;
}

/** The model supplies the cycle/order/depth sentences; never evaluate a blocked candidate. */
export function mathGeometryEditorProblem(document: PartDocument): string | null {
  const analysis = analyzeMathGeometryDependencies(document);
  const dependencyProblem = analysis.unreadable ?? analysis.blocked.values().next().value;
  if (dependencyProblem !== undefined) return dependencyProblem;
  for (const parameter of document.parameters) {
    if (!analysis.geometryDerived.has(parameter.name) || parameter.value.mathDefinition === undefined) continue;
    const issue = checkGeometryDerivedOperations(parameter.value.mathDefinition.expression);
    if (issue !== null) return issue.message;
  }
  return null;
}

export function mathGeometryEditorCandidate(document: PartDocument, name: string, value: ExpressionValue): PartDocument {
  return { ...document, parameters: document.parameters.map(parameter => parameter.name === name ? { ...parameter, value } : parameter) };
}

/** Wait without starting math work; a cancelled/failed measurement never supplies a previous value. */
export async function waitForMathEditorGeometry(document: PartDocument, signal: AbortSignal,
  isCurrent: () => boolean, onPending: () => void): Promise<ReadonlyMap<string, MathGeometryOutcome>> {
  if (signal.aborted || !isCurrent()) throw new Error(t('math.operation.cancelled'));
  let geometry = mathGeometryInputsFor(useAppStore.getState(), document);
  if (geometry === null) {
    onPending();
    const result = await waitForCurrentMathGeometry(signal);
    if (signal.aborted || !isCurrent() || result.status === 'aborted') throw new Error(t('math.operation.cancelled'));
    if (result.status === 'cancelled') throw new Error(t('mathGeometry.status.cancelled'));
    if (result.status === 'notEvaluated') throw new Error(result.message ?? t('mathGeometry.status.notEvaluated'));
    if (result.status === 'notPart') throw new Error(t('mathGeometry.disabled.notPart'));
    geometry = mathGeometryInputsFor(useAppStore.getState(), document);
  }
  if (geometry === null) throw new Error(t('mathGeometry.editor.pending'));
  return geometry;
}

const UNIT_LABELS: Readonly<Record<MathGeometryValueUnit, string>> = {
  mm: 'mm', mm2: 'mm²', mm3: 'mm³', degree: '°', radian: 'rad',
};

/** Notices do not convert measured doubles or prevent acceptance. */
export function mathGeometryEditorNotices(document: PartDocument, target: MathGeometryEditorTarget,
  definition: StoredMathExpression, geometry: ReadonlyMap<string, MathGeometryOutcome>): readonly string[] {
  const candidate = mathGeometryEditorCandidate(document, target.coefficientName,
    { source: definition.source, value: 0, display: '', mathDefinition: definition });
  const ids = mathGeometryDerivedParameters(candidate.parameters).get(target.coefficientName) ?? [];
  const notices = new Set<string>();
  for (const id of ids) {
    const outcome = geometry.get(id);
    if (outcome?.status !== 'value' || outcome.kind !== 'real') continue;
    if ((outcome.unit === 'degree' || outcome.unit === 'radian') && outcome.unit !== definition.angleUnit) {
      notices.add(t('mathGeometry.editor.angleUnitMismatch').replace('{unit}', t(`mathGeometry.unit.${outcome.unit}`)));
    }
  }
  const root = definition.expression;
  if (root.kind === 'symbol' && root.reference.role === 'coefficient') {
    const reference = mathGeometryReferencesOf(definition)[0];
    const outcome = reference === undefined ? undefined : geometry.get(reference.definitionId);
    if (outcome?.status === 'value' && outcome.kind === 'real') {
      const expected = outcome.unit === 'mm' ? 'mm' : outcome.unit === 'degree' ? 'degree' : 'none';
      if (target.unit !== expected) notices.add(t('mathGeometry.editor.unitMismatch').replace('{unit}', UNIT_LABELS[outcome.unit]));
    }
  }
  return [...notices];
}

/** Probe with the real dependency analyzer, including paths through other measured shapes. */
function excludedGeometry(document: PartDocument, name: string | undefined): ReadonlySet<string> {
  if (name === undefined) return new Set();
  const excluded = new Set<string>();
  for (const definition of resolvableMathGeometryDefinitions(document).values()) {
    const draft = mathGeometryParameterDraft(document, definition.id, { name, value: 0, unit: 'mm', description: '' });
    if (!draft.ok) continue;
    const analysis = analyzeMathGeometryDependencies(mathGeometryEditorCandidate(document, name, draft.parameter.value));
    // A dependent coefficient may be the cycle's witness, so test the measured definition rather than the witness's name.
    if (analysis.unreadable !== undefined || analysis.cycles.some(cycle => cycle.definitionIds.includes(definition.id))) excluded.add(definition.id);
  }
  return excluded;
}

/** Omit the edited coefficient and its dependents so an old invalid value cannot prevent repairing that value. */
export async function prepareDocumentMathEnvironment(document: PartDocument,
  context: DocumentMathContext, excludedCoefficient?: string, includeGeometry = false) {
  const prepared = prepareDocumentMathIdentity(document);
  const derived = mathGeometryDerivedParameters(prepared.parameters);
  const excludedDefinitions = excludedGeometry(prepared, excludedCoefficient);
  const excluded = new Set(excludedCoefficient === undefined ? [] : [excludedCoefficient]);
  let added = true;
  while (added) {
    added = false;
    for (const parameter of prepared.parameters) {
      if (!excluded.has(parameter.name) && (expressionParameterNames(parameter.value, prepared.parameters).some(name => excluded.has(name))
        || derived.get(parameter.name)?.some(id => excludedDefinitions.has(id)))) {
        excluded.add(parameter.name); added = true;
      }
    }
  }
  const table = { ...createEmptyPartDocument(), id: prepared.id, parameters: prepared.parameters.filter(parameter => !excluded.has(parameter.name)),
    ...(prepared.mathGeometry === undefined ? {} : { mathGeometry: prepared.mathGeometry }) };
  // The model retains exact expressions only for evaluated immutable parameter
  // snapshots. A loaded file or changed parameter array has no such proof.
  // Filtering after lookup keeps repairable coefficients and their dependents out.
  // A shape can change while the parameter array stays identical. Geometry-derived values must never reuse that memo.
  const known = derived.size === 0 ? analyzeParameters(prepared.parameters, []) : undefined;
  const reusable = known !== undefined && known.mathCoefficients !== undefined && known.failures.length === 0 && known.circular.length === 0
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
  const geometryChoices: MathInsertGroup['choices'][number][] = [];
  if (includeGeometry && excludedCoefficient !== undefined && !context.signal?.aborted && context.isCurrent()
    && context.identity.documentId === prepared.id) {
    for (const definition of resolvableMathGeometryDefinitions(prepared).values()) {
      if (excludedDefinitions.has(definition.id)) continue;
      const outcome = context.geometry?.get(definition.id);
      const input = mathGeometryCoefficientValue(prepared, definition, outcome);
      if (input.status !== 'value' || outcome?.status !== 'value' || outcome.kind !== 'real') continue;
      const { coefficient } = input;
      const quantity = definition.quantity;
      const kind = quantity.kind === 'coordinate' ? t(`mathGeometry.kind.coordinate.${quantity.component}`) : t(`mathGeometry.kind.${quantity.kind}`);
      geometryChoices.push({ id: coefficient.id, label: coefficient.label,
        meaning: t('mathGeometry.palette.meaning').replace('{name}', coefficient.label)
          .replace('{value}', `${coefficient.decimal} ${UNIT_LABELS[outcome.unit]}`).replace('{kind}', kind),
        template: legacyDefinitionToLatex({ kind: 'symbol', reference: { role: 'coefficient', id: coefficient.id, label: coefficient.label } }) });
      coefficients.push(coefficient);
    }
  }
  const groups: readonly MathInsertGroup[] = [{ id: 'coefficients', label: t('math.coefficients'), choices: coefficients.filter(coefficient => !geometryChoices.some(choice => choice.id === coefficient.id)).map(coefficient => ({
    id: coefficient.id, label: coefficient.label, meaning: `${coefficient.label} = ${coefficient.decimal}`,
    template: legacyDefinitionToLatex({ kind: 'symbol', reference: { role: 'coefficient', id: coefficient.id, label: coefficient.label } }),
  })) }, ...(includeGeometry ? [{ id: 'parameters' as const, label: t('mathGeometry.palette.group'), choices: geometryChoices }] : []),
  { id: 'constants', label: t('math.constants'), choices: [
    { id: 'pi', label: 'π', meaning: t('math.constant.pi'), template: String.raw`\pi` },
    { id: 'e', label: 'e', meaning: t('math.constant.e'), template: String.raw`\exponentialE` },
    { id: 'i', label: 'ⅈ', meaning: t('math.constant.i'), template: String.raw`\mathrm{i}` },
  ] }];
  return { prepared, coefficients, groups,
    coefficientProblem: result.ok ? null : result.failures[0]?.message ?? t('math.coefficientsUnavailable') };
}

export async function prepareDocumentMathEditor(document: PartDocument, value: ExpressionValue,
  context: DocumentMathContext, excludedCoefficient?: string, includeGeometry = false) {
  const environment = await prepareDocumentMathEnvironment(document, context, excludedCoefficient, includeGeometry);
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
