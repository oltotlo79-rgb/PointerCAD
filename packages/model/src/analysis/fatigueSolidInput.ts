import { InputIssue, revision, text } from './analysisValidation.js';
import { FATIGUE_SAVED_ID, FATIGUE_SAVED_LIMITS, denseFatigueList, exactFatigueFields, fatigueLabel,
  finiteFatigueNumber, readFatigueSavedCurve, type FatigueSavedCurve } from './fatigueInput.js';

/** Authored factors/curve and same-mesh selection only. No solved stress, tensor, cycles or damage is persisted. */
export const FATIGUE_SOLID_SAVED_SCHEMA = 'pointercad-fatigue-solid-saved/1';
/** Same element capacity as the native linear tet4 input; model must not import the FEM package. */
export const FATIGUE_SOLID_MAX_ELEMENTS = 50000;
export interface FatigueSolidSavedInput {
  readonly schema: typeof FATIGUE_SOLID_SAVED_SCHEMA;
  readonly id: typeof FATIGUE_SAVED_ID;
  readonly source: { readonly documentId: string; readonly revision: number; readonly meshKey: string };
  readonly inputSha256: string;
  readonly elementIndex: number;
  readonly historyId: string;
  readonly loadFactors: readonly number[];
  readonly sequence: 'once' | 'repeated-periodic';
  readonly repeats: number;
  readonly reference: string;
  readonly curve: FatigueSavedCurve;
}

function fail(path: string, message: string): never { throw new InputIssue('fatigue', path, message); }
function exact(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  const row = exactFatigueFields(value, keys, path);
  if (Reflect.ownKeys(row).length !== keys.length) fail(path, 'Unexpected own fields');
  return row;
}

export function readFatigueSolidSavedInput(value: unknown, path: string): FatigueSolidSavedInput {
  const row = exact(value, ['schema', 'id', 'source', 'inputSha256', 'elementIndex', 'historyId', 'loadFactors',
    'sequence', 'repeats', 'reference', 'curve'], path);
  if (row.schema !== FATIGUE_SOLID_SAVED_SCHEMA || row.id !== FATIGUE_SAVED_ID) fail(path, 'Expected solid fatigue saved schema 1');
  const rawSource = exact(row.source, ['documentId', 'revision', 'meshKey'], `${path}.source`);
  const source = { documentId: text(rawSource.documentId, `${path}.source.documentId`),
    revision: revision(rawSource.revision, `${path}.source.revision`), meshKey: text(rawSource.meshKey, `${path}.source.meshKey`) };
  if (typeof row.inputSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.inputSha256)) fail(`${path}.inputSha256`, 'Expected canonical input SHA-256');
  const elementIndex = row.elementIndex;
  if (typeof elementIndex !== 'number' || !Number.isSafeInteger(elementIndex) || elementIndex < 0
    || elementIndex >= FATIGUE_SOLID_MAX_ELEMENTS) fail(`${path}.elementIndex`, 'Expected same-mesh element index');
  const rows = denseFatigueList(row.loadFactors, `${path}.loadFactors`);
  if (rows.length < 1 || rows.length > FATIGUE_SAVED_LIMITS.maximumPoints
    || Reflect.ownKeys(rows).length !== rows.length + 1) fail(`${path}.loadFactors`, 'Expected dense bounded factors without extra fields');
  const loadFactors = rows.map((item, index) => finiteFatigueNumber(item, `${path}.loadFactors[${index}]`));
  const sequence = row.sequence;
  if (sequence !== 'once' && sequence !== 'repeated-periodic') fail(`${path}.sequence`, 'Expected explicit chronological sequence');
  const repeats = row.repeats;
  if (typeof repeats !== 'number' || !Number.isSafeInteger(repeats) || repeats < 1
    || repeats > FATIGUE_SAVED_LIMITS.maximumRepeats || (sequence === 'once' && repeats !== 1)) fail(`${path}.repeats`, 'Invalid repeat count');
  return { schema: FATIGUE_SOLID_SAVED_SCHEMA, id: FATIGUE_SAVED_ID, source, inputSha256: row.inputSha256,
    elementIndex, historyId: fatigueLabel(row.historyId, `${path}.historyId`, 64), loadFactors, sequence, repeats,
    reference: fatigueLabel(row.reference, `${path}.reference`, 512), curve: readFatigueSavedCurve(row.curve, `${path}.curve`) };
}

/** Fresh structural selection for the FEM adapter; the solved Cauchy reference must be obtained again. */
export function fatigueSolidSelection(value: FatigueSolidSavedInput) {
  return { source: { ...value.source }, inputSha256: value.inputSha256, elementIndex: value.elementIndex,
    historyId: value.historyId, loadFactors: [...value.loadFactors], sequence: value.sequence,
    repeats: value.repeats, reference: value.reference };
}

/** Metadata invalidation only; not proof of a native result. The FEM client recomputes the complete input digest and
 * revalidates every native action. A saved selection never migrates to a new mesh/revision, even at equal positions. */
export function fatigueSolidInputMatches(value: FatigueSolidSavedInput, current: {
  readonly source: FatigueSolidSavedInput['source']; readonly inputSha256: string; readonly elementCount: number;
}): boolean {
  return value.source.documentId === current.source.documentId && value.source.revision === current.source.revision
    && value.source.meshKey === current.source.meshKey && value.inputSha256 === current.inputSha256
    && Number.isSafeInteger(current.elementCount) && current.elementCount > 0
    && current.elementCount <= FATIGUE_SOLID_MAX_ELEMENTS && Number.isSafeInteger(value.elementIndex)
    && value.elementIndex >= 0 && value.elementIndex < current.elementCount;
}
