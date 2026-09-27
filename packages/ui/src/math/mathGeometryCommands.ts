/** GR-16: definition edits publish one immutable document, hence one Undo entry. */
import {
  addMathGeometryDefinition,
  checkMathGeometryName,
  removeMathGeometryDefinition,
  renameDocumentMathGeometry,
  replaceMathGeometryQuantity,
  setMathGeometryAngleUnit,
  setMathGeometryTolerance,
  validateMathGeometryTolerance,
  type MathGeometryDefinitionReason,
  type MathGeometryDefinitionResult,
  type MathGeometryQuantity,
  type MathGeometryRenameReason,
  type MathGeometryTolerance,
  type PartDocument,
} from '@pointercad/model';
import type { MathWorkerClient } from '@pointercad/expression/math/client';
import { t } from '../i18n/t.js';
import type { AppState } from '../store/appState.js';
import { activePartDocument } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { createBrowserMathClient } from './createBrowserMathClient.js';
import { currentMathGeometry, mathGeometryInputsFor, type MathGeometryResultStatus } from './mathGeometryResults.js';

export type MathGeometryCommandReason = MathGeometryDefinitionReason | MathGeometryRenameReason
  | Exclude<MathGeometryResultStatus, 'current'> | 'staleDocument';
export type MathGeometryCommandResult = { readonly ok: true }
  | { readonly ok: false; readonly reason: MathGeometryCommandReason; readonly message: string };
type Refusal = Extract<MathGeometryCommandResult, { readonly ok: false }>;

/** Call synchronous commands with the latest state and the document that owns the row/candidate. */
export type MathGeometryCommandState = Pick<AppState, 'document' | 'assembly' | 'drawing' | 'applyDocument'>;

function ownerRefusal(state: MathGeometryCommandState, owner: PartDocument): Refusal | null {
  if (activePartDocument(state) === null) {
    return { ok: false, reason: 'notPart', message: t('mathGeometry.disabled.notPart') };
  }
  return state.document === owner ? null
    : { ok: false, reason: 'staleDocument', message: t('math.operation.cancelled') };
}

/** The model owns validation; only the existing screen wording for name issues is substituted here. */
function refusalMessage(reason: MathGeometryDefinitionReason | MathGeometryRenameReason, message: string): string {
  switch (reason) {
    case 'empty': return t('parameter.error.empty');
    case 'startsWithDigit': return t('parameter.error.startsWithDigit');
    case 'reserved': return t('parameter.error.reserved');
    case 'invalidCharacter': case 'whitespace': return t('parameter.error.invalidCharacter');
    case 'duplicateName': return t('parameter.error.duplicateName');
    default: return message;
  }
}

function publish(state: MathGeometryCommandState, owner: PartDocument,
  result: MathGeometryDefinitionResult): MathGeometryCommandResult {
  if (!result.ok) return { ...result, message: refusalMessage(result.reason, result.message) };
  if (result.document !== owner) state.applyDocument(result.document);
  return { ok: true };
}

/** Localized prefix + the smallest free positive integer, in the shared parameter/geometry namespace. */
export function defaultMathGeometryName(document: PartDocument, quantity: MathGeometryQuantity): string {
  const prefix = t(quantity.kind === 'coordinate'
    ? `mathGeometry.defaultName.coordinate.${quantity.component}` : `mathGeometry.defaultName.${quantity.kind}`);
  for (let serial = 1; ; serial += 1) {
    const name = `${prefix}${String(serial)}`;
    // A broken prefix is passed to the model to refuse instead of searching forever.
    if (checkMathGeometryName(document, name) !== 'duplicateName') return name;
  }
}

/** `quantity` is the chosen GR-15 mathGeometrySelection candidate; the panel owns selection/readiness. */
export function createMathGeometryFromSelection(state: MathGeometryCommandState, owner: PartDocument,
  quantity: MathGeometryQuantity, name: string = defaultMathGeometryName(owner, quantity)): MathGeometryCommandResult {
  const refusal = ownerRefusal(state, owner);
  if (refusal !== null) return refusal;
  return publish(state, owner, addMathGeometryDefinition(owner, { name, quantity }, crypto.randomUUID()));
}

/** Keep the definition's identity/name/tolerance, replacing it with a GR-15 candidate of the same kind/unit. */
export function reselectMathGeometry(state: MathGeometryCommandState, owner: PartDocument,
  id: string, quantity: MathGeometryQuantity): MathGeometryCommandResult {
  const refusal = ownerRefusal(state, owner);
  if (refusal !== null) return refusal;
  return publish(state, owner, replaceMathGeometryQuantity(owner, id, quantity));
}

export function changeMathGeometryAngleUnit(state: MathGeometryCommandState, owner: PartDocument,
  id: string, unit: 'degree' | 'radian'): MathGeometryCommandResult {
  const refusal = ownerRefusal(state, owner);
  if (refusal !== null) return refusal;
  // GR-09's new angle kinds are deliberately left to the model's existing refusal until its follow-up.
  return publish(state, owner, setMathGeometryAngleUnit(owner, id, unit));
}

/** Input units are mm and radians. The editor converts degrees before calling (GR-19a). */
export function changeMathGeometryTolerance(state: MathGeometryCommandState, owner: PartDocument,
  id: string, tolerance: MathGeometryTolerance): MathGeometryCommandResult {
  const refusal = ownerRefusal(state, owner);
  if (refusal !== null) return refusal;
  const field = validateMathGeometryTolerance(tolerance);
  if (field !== null) return { ok: false, reason: 'invalidTolerance', message: t(`mathGeometry.tolerance.error.${field}`) };
  return publish(state, owner, setMathGeometryTolerance(owner, id, tolerance));
}

export function removeMathGeometry(state: MathGeometryCommandState, owner: PartDocument, id: string): MathGeometryCommandResult {
  const refusal = ownerRefusal(state, owner);
  if (refusal !== null) return refusal;
  return publish(state, owner, removeMathGeometryDefinition(owner, id));
}

function geometryRefusal(state: AppState): Refusal {
  const current = currentMathGeometry(state);
  switch (current.status) {
    case 'notPart': return { ok: false, reason: current.status, message: t('mathGeometry.disabled.notPart') };
    case 'timeline': case 'cancelled': case 'notEvaluated':
      return { ok: false, reason: current.status, message: t(`mathGeometry.status.${current.status}`) };
    case 'computing': case 'current':
      return { ok: false, reason: 'computing', message: t('mathGeometry.editor.pending') };
  }
}

export interface MathGeometryRenameOptions {
  readonly signal?: AbortSignal;
  readonly createClient?: () => MathWorkerClient;
  /** A row may pass its original document to reject an event from a closed/replaced editor. */
  readonly owner?: PartDocument;
}

/** Like runMathParameterRename: cancel obsolete work, dispose its client, and publish all labels once. */
export async function runMathGeometryRename(id: string, name: string,
  options: MathGeometryRenameOptions = {}): Promise<MathGeometryCommandResult> {
  const state = useAppStore.getState(), document = activePartDocument(state);
  const stopped = (): Refusal => ({ ok: false, reason: 'cancelled', message: t('math.operation.cancelled') });
  if (options.signal?.aborted) return stopped();
  if (document === null) return { ok: false, reason: 'notPart', message: t('mathGeometry.disabled.notPart') };
  const refusal = ownerRefusal(state, options.owner ?? document);
  if (refusal !== null) return refusal;
  const geometry = mathGeometryInputsFor(state, document);
  if (geometry === null) return geometryRefusal(state);

  const controller = new AbortController(), abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const isCurrent = () => {
    const current = useAppStore.getState();
    return !controller.signal.aborted && current.documentVersion === state.documentVersion
      && activePartDocument(current) === document && current.requestedGeneration === state.requestedGeneration
      && mathGeometryInputsFor(current, document) === geometry;
  };
  const unsubscribe = useAppStore.subscribe(() => { if (!isCurrent()) abort(); });
  let client: MathWorkerClient | undefined;
  try {
    client = (options.createClient ?? createBrowserMathClient)();
    const result = await renameDocumentMathGeometry(document, id, name, { client, geometry,
      identity: { documentId: document.id, documentVersion: state.documentVersion }, signal: controller.signal, isCurrent });
    if (!isCurrent()) return stopped();
    if (!result.ok) return { ok: false, reason: result.reason, message: refusalMessage(result.reason, result.message) };
    if (result.document !== document) useAppStore.getState().applyDocument(result.document);
    return { ok: true };
  } catch {
    return isCurrent() ? { ok: false, reason: 'rewriteFailed', message: t('math.rename.failed') } : stopped();
  } finally {
    unsubscribe();
    options.signal?.removeEventListener('abort', abort);
    abort();
    client?.dispose();
  }
}
