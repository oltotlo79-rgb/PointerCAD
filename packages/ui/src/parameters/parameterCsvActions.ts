import { checkVariableName, decodeMathExpressionStorage,
  type VariableNameIssue } from '@pointercad/expression';
import type { MathWorkerClient } from '@pointercad/expression/math/client';
import {
  applyParameters,
  evaluateDocumentMath,
  hasDocumentMath,
  isParameterMathId,
  MATH_GEOMETRY_COEFFICIENT_PREFIX,
  prepareDocumentMathIdentity,
  parameterEvaluationOrder,
  synchronizeConfigurations,
  type DocumentMathContext,
  type Parameter,
  type ParameterCsvRecord,
  type PartDocument,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import { createBrowserMathClient } from '../math/createBrowserMathClient.js';
import { mathGeometryInputsFor } from '../math/mathGeometryResults.js';
import { activePartDocument } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { parameterUsageSites } from './parameterSearch.js';

export type ParameterCsvInputRecord = ParameterCsvRecord;

export interface ParameterCsvIssue {
  readonly recordNumber: number;
  readonly column: string;
  readonly reason: string;
}

export interface ParameterCsvChange {
  readonly name: string;
  readonly kind: 'added' | 'updated' | 'unchanged';
  readonly before?: { readonly expression: string; readonly unit: Parameter['unit']; readonly description: string };
  readonly after: { readonly expression: string; readonly unit: Parameter['unit']; readonly description: string };
  readonly usageSiteCount: number;
  readonly beforeMathId?: string;
  readonly afterMathId?: string;
  readonly mathDefinitionChanged: boolean;
}

export type ParameterCsvPreview =
  | { readonly ok: false; readonly issues: readonly ParameterCsvIssue[] }
  | { readonly ok: true; readonly owner: PartDocument; readonly documentVersion: number;
      readonly document: PartDocument; readonly changes: readonly ParameterCsvChange[] };

const issue = (recordNumber: number, column: string, reason: string): ParameterCsvIssue =>
  ({ recordNumber, column, reason });
const consumedCsvPreviews = new WeakSet<object>();

const NAME_ISSUE_KEYS: Readonly<Record<VariableNameIssue, MessageKey>> = {
  empty: 'parameter.error.empty',
  startsWithDigit: 'parameter.error.startsWithDigit',
  reserved: 'parameter.error.reserved',
  invalidCharacter: 'parameter.error.invalidCharacter',
};

/** Validate every input row before constructing one immutable candidate. Existing rows not in CSV remain. */
export async function prepareParameterCsv(
  document: PartDocument,
  documentVersion: number,
  records: readonly ParameterCsvInputRecord[],
  mathContext?: DocumentMathContext,
): Promise<ParameterCsvPreview> {
  const issues: ParameterCsvIssue[] = [];
  if (records.length === 0) issues.push(issue(0, '*', t('parameter.csv.empty')));
  const current = new Map(document.parameters.map(parameter => [parameter.name, parameter]));
  const currentIds = new Map(document.parameters.flatMap(parameter => parameter.mathId === undefined
    ? [] : [[parameter.mathId, parameter.name] as const]));
  const names = new Set<string>();
  const importedIds = new Map<string, string>();
  for (const record of records) {
    const invalid = checkVariableName(record.name);
    if (invalid !== null) issues.push(issue(record.recordNumber, 'name', t(NAME_ISSUE_KEYS[invalid])));
    if (document.mathGeometry?.some(definition => definition.name === record.name)) {
      issues.push(issue(record.recordNumber, 'name', t('parameter.csv.geometryName')));
    }
    if (names.has(record.name)) issues.push(issue(record.recordNumber, 'name', t('parameter.csv.duplicateName')));
    names.add(record.name);
    if (record.expression.trim() === '') issues.push(issue(record.recordNumber, 'expression', t('parameter.csv.emptyExpression')));
    if (record.unit !== 'mm' && record.unit !== 'degree' && record.unit !== 'none') {
      issues.push(issue(record.recordNumber, 'unit', t('parameter.csv.invalidUnit')));
    }
    if (record.mathDefinition !== undefined && record.mathId === undefined) {
      issues.push(issue(record.recordNumber, 'mathId', t('parameter.csv.mathIdRequired')));
    }
    if (record.mathDefinition !== undefined) {
      try { decodeMathExpressionStorage(record.mathDefinition, record.expression); }
      catch { issues.push(issue(record.recordNumber, 'mathDefinition', t('parameter.csv.invalidMathDefinition'))); }
    }
    if (record.mathId !== undefined) {
      if (!isParameterMathId(record.mathId) || record.mathId.startsWith(MATH_GEOMETRY_COEFFICIENT_PREFIX)) {
        issues.push(issue(record.recordNumber, 'mathId', t('parameter.csv.invalidMathId')));
      }
      const owner = currentIds.get(record.mathId) ?? importedIds.get(record.mathId);
      if (owner !== undefined && owner !== record.name) issues.push(issue(record.recordNumber, 'mathId', t('parameter.csv.duplicateMathId')));
      importedIds.set(record.mathId, record.name);
      const previous = current.get(record.name);
      if (previous?.mathId !== undefined && previous.mathId !== record.mathId) {
        issues.push(issue(record.recordNumber, 'mathId', t('parameter.csv.mathIdMismatch')));
      }
      const numbered = /^coefficient:([1-9][0-9]*)$/u.exec(record.mathId);
      if (previous === undefined && !currentIds.has(record.mathId) && numbered !== null
        && document.mathParameterSerial !== undefined
        && Number(numbered[1]) <= document.mathParameterSerial) {
        issues.push(issue(record.recordNumber, 'mathId', t('parameter.csv.reusedMathId')));
      }
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  const byName = new Map(document.parameters.map(parameter => [parameter.name, parameter]));
  const usages = parameterUsageSites(document);
  const changes: ParameterCsvChange[] = [];
  for (const record of records) {
    const previous = byName.get(record.name);
    const retainedMath = record.mathDefinition ?? (previous?.value.source === record.expression
      ? previous.value.mathDefinition : undefined);
    const next: Parameter = {
      name: record.name,
      value: { source: record.expression, value: previous?.value.value ?? 0,
        display: previous?.value.display ?? '0',
        ...(retainedMath === undefined ? {} : { mathDefinition: retainedMath }) },
      unit: record.unit,
      description: record.description,
      ...((record.mathId ?? previous?.mathId) === undefined ? {} : { mathId: record.mathId ?? previous?.mathId }),
    };
    const unchanged = previous !== undefined && previous.name === next.name
      && previous.value.source === next.value.source && previous.unit === next.unit
      && previous.description === next.description && previous.mathId === next.mathId
      && JSON.stringify(previous.value.mathDefinition) === JSON.stringify(next.value.mathDefinition);
    changes.push({ name: record.name, kind: previous === undefined ? 'added' : unchanged ? 'unchanged' : 'updated',
      ...(previous === undefined ? {} : { before: { expression: previous.value.source,
        unit: previous.unit, description: previous.description } }),
      after: { expression: record.expression, unit: record.unit, description: record.description },
      usageSiteCount: usages.get(record.name)?.length ?? 0,
      ...(previous?.mathId === undefined ? {} : { beforeMathId: previous.mathId }),
      ...(next.mathId === undefined ? {} : { afterMathId: next.mathId }),
      mathDefinitionChanged: JSON.stringify(previous?.value.mathDefinition) !== JSON.stringify(next.value.mathDefinition) });
    byName.set(record.name, unchanged && previous !== undefined ? previous : next);
  }
  let candidate: PartDocument = { ...document, parameters: [...byName.values()] };
  try {
    if (hasDocumentMath(candidate) || candidate.mathParameterSerial !== undefined
      || candidate.parameters.some(parameter => parameter.mathId !== undefined)) {
      candidate = prepareDocumentMathIdentity(candidate);
    }
    candidate = synchronizeConfigurations(candidate);
  }
  catch (caught) { return { ok: false, issues: [issue(0, 'mathId', caught instanceof Error ? caught.message : t('parameter.csv.invalidMathId'))] }; }

  const order = parameterEvaluationOrder(candidate.parameters);
  for (const name of order.circular) {
    issues.push(issue(records.find(record => record.name === name)?.recordNumber ?? 0, 'expression',
      `${t('parameter.csv.circularPrefix')}${name}${t('parameter.csv.circularSuffix')}`));
  }
  if (issues.length > 0) return { ok: false, issues };

  if (hasDocumentMath(candidate)) {
    if (mathContext === undefined) return { ok: false, issues: [issue(0, '*', t('parameter.csv.mathCheckRequired'))] };
    const result = await evaluateDocumentMath(candidate, mathContext);
    if (!mathContext.isCurrent() || mathContext.signal?.aborted) return {
      ok: false, issues: [issue(0, '*', t('parameter.csv.stale'))],
    };
    if (!result.ok) return { ok: false, issues: result.failures.length > 0 ? result.failures.map(failure =>
      issue(records.find(record => record.name === failure.ownerId)?.recordNumber ?? 0,
        'expression', failure.message)) : [issue(0, '*', result.cancelled
      ? t('parameter.csv.stale') : t('parameter.csv.mathCheckFailed'))] };
    candidate = result.document;
  } else {
    const result = applyParameters(candidate);
    for (const failure of result.analysis.failures) {
      issues.push(issue(records.find(record => record.name === failure.name)?.recordNumber ?? 0,
        'expression', failure.message));
    }
    for (const failure of result.failures) issues.push(issue(0, 'expression', failure.message));
    if (issues.length > 0) return { ok: false, issues };
    candidate = result.document;
  }
  // The unchanged rows still appear in the preview; a no-op preview never creates an Undo entry.
  return { ok: true, owner: document, documentVersion, document: candidate, changes };
}

/** Publish a fully checked snapshot at most once. The caller owns the store's single applyDocument call. */
export function applyParameterCsvPreview(
  preview: Extract<ParameterCsvPreview, { ok: true }>,
  current: { readonly document: PartDocument; readonly documentVersion: number },
  applyDocument: (document: PartDocument) => void,
): boolean {
  if (consumedCsvPreviews.has(preview)) return false;
  if (current.document !== preview.owner || current.documentVersion !== preview.documentVersion) return false;
  consumedCsvPreviews.add(preview);
  if (preview.changes.every(change => change.kind === 'unchanged')) return true;
  applyDocument(preview.document);
  return true;
}

/** Own the existing math worker only while building the preview; a changed document cancels it. */
export async function prepareParameterCsvForStore(records: readonly ParameterCsvInputRecord[], options: {
  readonly signal?: AbortSignal;
  readonly createClient?: () => MathWorkerClient;
} = {}): Promise<ParameterCsvPreview> {
  const state = useAppStore.getState();
  const document = activePartDocument(state);
  if (document === null || options.signal?.aborted) return {
    ok: false, issues: [issue(0, '*', t('parameter.csv.stale'))],
  };
  const needsMath = hasDocumentMath(document) || records.some(record => record.mathDefinition !== undefined);
  if (!needsMath) return prepareParameterCsv(document, state.documentVersion, records);
  const geometry = mathGeometryInputsFor(state, document);
  if (geometry === null) return { ok: false, issues: [issue(0, '*', t('mathGeometry.editor.pending'))] };
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const isCurrent = () => !controller.signal.aborted && activePartDocument(useAppStore.getState()) === document
    && useAppStore.getState().documentVersion === state.documentVersion
    && mathGeometryInputsFor(useAppStore.getState(), document) === geometry;
  const unsubscribe = useAppStore.subscribe(() => { if (!isCurrent()) abort(); });
  let client: MathWorkerClient | undefined;
  try {
    client = (options.createClient ?? createBrowserMathClient)();
    const preview = await prepareParameterCsv(document, state.documentVersion, records, {
      client, geometry, signal: controller.signal,
      identity: { documentId: document.id, documentVersion: state.documentVersion }, isCurrent,
    });
    return isCurrent() ? preview : { ok: false, issues: [issue(0, '*', t('parameter.csv.stale'))] };
  } catch {
    return { ok: false, issues: [issue(0, '*', t('parameter.csv.mathCheckFailed'))] };
  } finally {
    unsubscribe();
    options.signal?.removeEventListener('abort', abort);
    abort();
    client?.dispose();
  }
}
