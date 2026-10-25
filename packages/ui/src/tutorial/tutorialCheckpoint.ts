import { contentHashOf, drawingSourceInputHash, type DrawingSourceInput, type PartDocument } from '@pointercad/model';
import type { DrawingDocument } from '@pointercad/drawing';

/** A hint for the guide UI. Completion is always re-derived from normal documents and operations. */
export const TUTORIAL_CHECKPOINT_STAGES = [
  'pointCoordinates', 'thicknessParameter', 'dimensionChange', 'drawing', 'stepStl',
] as const;
export type TutorialCheckpointStage = typeof TUTORIAL_CHECKPOINT_STAGES[number];
export const TUTORIAL_CHECKPOINT_KEY = 'pointercad:tutorial:parameterToExport:v1';
const MAX_RECORD_LENGTH = 4096;
const MAX_DRAFT_LENGTH = 1024;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
export interface TutorialCheckpointStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem?: (key: string) => void;
}
/** Only committed owner IDs are kept. Missing IDs mean the corresponding step is still pending. */
export interface TutorialOwnedIds {
  readonly sketchId: string;
  readonly pointId?: string;
  readonly outlineId?: string;
  readonly faceId?: string;
  readonly extrudeId?: string;
  readonly parameterName?: string;
}
/** Raw guide-owned fields and focus only; no numeric result, selection, toggle or commit proof. */
export interface TutorialNumericStageDraft {
  readonly operation: 'point' | 'rectangleCorner1' | 'rectangleCorner2' | 'extrudeDistance';
  readonly mode: 'absolute' | 'relative' | 'polar';
  readonly fields: readonly { readonly key: string; readonly source: string }[];
  readonly focusedKey: string;
}
export type TutorialDraft =
  | ({ readonly kind: 'numeric'; readonly previousStage?: TutorialNumericStageDraft } & TutorialNumericStageDraft)
  | { readonly kind: 'parameter'; readonly parameterName: string; readonly source: string; readonly focusedKey: 'source' };
export interface TutorialCheckpointInput {
  readonly stageHint: TutorialCheckpointStage;
  readonly owned: TutorialOwnedIds;
  readonly draft?: TutorialDraft;
}
/** Bytes must come from a successful ordinary save/open/restore; no second document store is created here. */
export interface TutorialSavedEvidence {
  readonly part: { readonly document: PartDocument; readonly savedBytes?: Uint8Array };
  readonly drawing?: {
    readonly document: DrawingDocument;
    readonly source: DrawingSourceInput;
    readonly savedBytes: Uint8Array;
  };
}

export interface TutorialCheckpoint extends TutorialCheckpointInput {
  readonly version: 1;
  readonly course: 'parameterToExport';
  readonly ownerPartId: string;
  readonly savedKind: 'part' | 'drawing';
  readonly savedSha256: string;
  readonly partSourceHash: string;
  readonly drawing?: {
    readonly ownerDrawingId: string;
    readonly sourceRef: string;
    readonly sourceHash: string;
  };
}

export type TutorialCheckpointFailure =
  | 'missing' | 'storageUnavailable' | 'storageQuota' | 'storageFailure'
  | 'corrupt' | 'unsupportedVersion' | 'differentDocument' | 'staleContent'
  | 'staleSource' | 'missingOwner' | 'staleRequest' | 'storageConflict';
export type TutorialCheckpointResult =
  | { readonly ok: true; readonly checkpoint: TutorialCheckpoint }
  | { readonly ok: false; readonly reason: TutorialCheckpointFailure };

const refusal = (reason: TutorialCheckpointFailure): { readonly ok: false; readonly reason: TutorialCheckpointFailure } =>
  ({ ok: false, reason });
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const keysAre = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const boundedId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;

function validOwned(value: unknown): value is TutorialOwnedIds {
  if (!record(value) || !keysAre(value, ['sketchId'], ['pointId', 'outlineId', 'faceId', 'extrudeId', 'parameterName'])
      || !boundedId(value.sketchId)) return false;
  return ['pointId', 'outlineId', 'faceId', 'extrudeId', 'parameterName'].every(key =>
    !Object.hasOwn(value, key) || boundedId(value[key]));
}

function numericFieldLength(value: Record<string, unknown>, previous: boolean): number | null {
  if (!keysAre(value, previous ? ['operation', 'mode', 'fields', 'focusedKey']
    : ['kind', 'operation', 'mode', 'fields', 'focusedKey'], previous ? [] : ['previousStage'])
      || !['point', 'rectangleCorner1', 'rectangleCorner2', 'extrudeDistance'].includes(String(value.operation))
      || (value.mode !== 'absolute' && value.mode !== 'relative' && value.mode !== 'polar') || !Array.isArray(value.fields)
      || value.fields.length < 1 || value.fields.length > 3 || typeof value.focusedKey !== 'string'
      || value.operation === 'extrudeDistance' && value.mode !== 'absolute') return null;
  const allowed = value.operation === 'extrudeDistance' ? ['distance'] : value.mode === 'relative'
    ? ['dx', 'dy', 'dz'] : value.mode === 'polar' ? ['distance', 'azimuth', 'elevation'] : ['x', 'y', 'z'];
  const fields: readonly unknown[] = value.fields;
  if (fields.length !== allowed.length || !fields.every(field => record(field) && keysAre(field, ['key', 'source'])
    && typeof field.key === 'string' && SAFE_FIELD.test(field.key) && allowed.includes(field.key)
    && typeof field.source === 'string' && field.source.length <= MAX_DRAFT_LENGTH)
    || new Set(fields.map(field => record(field) ? field.key : null)).size !== fields.length
    || !fields.some(field => record(field) && field.key === value.focusedKey)) return null;
  return fields.reduce<number>((size, field) => size + (record(field) && typeof field.source === 'string' ? field.source.length : 0), 0);
}

function validDraft(value: unknown): value is TutorialDraft {
  if (!record(value)) return false;
  if (value.kind === 'parameter') return keysAre(value, ['kind', 'parameterName', 'source', 'focusedKey'])
    && boundedId(value.parameterName) && value.focusedKey === 'source'
    && typeof value.source === 'string' && value.source.length <= MAX_DRAFT_LENGTH;
  if (value.kind !== 'numeric') return false;
  const size = numericFieldLength(value, false);
  if (size === null) return false;
  if (!Object.hasOwn(value, 'previousStage')) return size <= MAX_DRAFT_LENGTH;
  if (value.operation !== 'rectangleCorner2' || !record(value.previousStage)
      || value.previousStage.operation !== 'rectangleCorner1') return false;
  const previousSize = numericFieldLength(value.previousStage, true);
  return previousSize !== null && size + previousSize <= MAX_DRAFT_LENGTH;
}

function draftBelongsToStage(draft: TutorialDraft, stage: TutorialCheckpointStage, owned: TutorialOwnedIds): boolean {
  if (draft.kind === 'parameter') return stage === 'thicknessParameter'
    ? owned.parameterName === undefined || draft.parameterName === owned.parameterName
    : stage === 'dimensionChange' && draft.parameterName === owned.parameterName;
  return stage === 'pointCoordinates' ? draft.operation === 'point'
    : stage === 'thicknessParameter' && draft.operation !== 'point';
}

function validInput(value: unknown): value is TutorialCheckpointInput {
  return record(value) && keysAre(value, ['stageHint', 'owned'], ['draft'])
    && TUTORIAL_CHECKPOINT_STAGES.some(stage => stage === value.stageHint)
    && validOwned(value.owned)
    && (!Object.hasOwn(value, 'draft') || (validDraft(value.draft)
      && draftBelongsToStage(value.draft, value.stageHint as TutorialCheckpointStage, value.owned)));
}

function validCheckpoint(value: unknown): value is TutorialCheckpoint {
  if (!record(value) || !keysAre(value, ['version', 'course', 'ownerPartId', 'savedKind', 'savedSha256', 'partSourceHash', 'stageHint', 'owned'],
    ['drawing', 'draft']) || value.version !== 1 || value.course !== 'parameterToExport' || !boundedId(value.ownerPartId)
    || (value.savedKind !== 'part' && value.savedKind !== 'drawing')
    || typeof value.savedSha256 !== 'string' || !HEX_SHA256.test(value.savedSha256)
    || typeof value.partSourceHash !== 'string' || !HEX_SHA256.test(value.partSourceHash)
    || !validInput({ stageHint: value.stageHint, owned: value.owned,
      ...(Object.hasOwn(value, 'draft') ? { draft: value.draft } : {}) })) return false;
  if (Object.hasOwn(value, 'drawing')) {
    const drawing = value.drawing;
    if (!record(drawing) || !keysAre(drawing, ['ownerDrawingId', 'sourceRef', 'sourceHash'])
        || !boundedId(drawing.ownerDrawingId) || !boundedId(drawing.sourceRef)
        || typeof drawing.sourceHash !== 'string' || !HEX_SHA256.test(drawing.sourceHash)) return false;
  }
  return (value.savedKind === 'drawing') === Object.hasOwn(value, 'drawing');
}

function decode(raw: string): TutorialCheckpointResult {
  if (raw.length > MAX_RECORD_LENGTH) return refusal('corrupt');
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { return refusal('corrupt'); }
  if (!record(value)) return refusal('corrupt');
  if (value.version !== 1) return refusal('unsupportedVersion');
  if (!validCheckpoint(value)) return refusal('corrupt');
  return { ok: true, checkpoint: value };
}

function ownersExist(owned: TutorialOwnedIds, part: PartDocument): boolean {
  const sketch = part.sketches.find(item => item.id === owned.sketchId);
  if (sketch === undefined) return false;
  const feature = (id: string | undefined, kind: string): boolean => id === undefined
    || sketch.features.some(item => item.id === id && item.kind === kind);
  if (!feature(owned.pointId, 'point') || !feature(owned.outlineId, 'rectangle')
      || !feature(owned.faceId, 'face')) return false;
  const face = owned.faceId === undefined ? undefined : sketch.features.find(item => item.id === owned.faceId);
  if (owned.outlineId !== undefined && face?.kind === 'face'
      && (face.boundary.length !== 1 || face.boundary[0].featureId !== owned.outlineId
        || face.boundary[0].index !== undefined)) return false;
  if (owned.extrudeId !== undefined && !part.solids.some(item => item.id === owned.extrudeId
      && item.kind === 'extrude' && item.profile.sketchId === owned.sketchId
      && (owned.faceId === undefined || item.profile.faceFeatureId === owned.faceId))) return false;
  return owned.parameterName === undefined || part.parameters.some(item => item.name === owned.parameterName);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  let input: Uint8Array<ArrayBuffer>;
  if (bytes.buffer instanceof ArrayBuffer) {
    input = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } else {
    input = new Uint8Array(new ArrayBuffer(bytes.byteLength));
    input.set(bytes);
  }
  const digest = await crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function observed(evidence: TutorialSavedEvidence): Promise<TutorialCheckpointResult> {
  const part = evidence.part.document;
  if (!boundedId(part.id)) return refusal('corrupt');
  try {
    const partSourceHash = await contentHashOf(part);
    const savedBytes = evidence.drawing === undefined ? evidence.part.savedBytes : evidence.drawing.savedBytes;
    if (!(savedBytes instanceof Uint8Array) || savedBytes.byteLength === 0) return refusal('corrupt');
    const result: TutorialCheckpoint = {
      version: 1, course: 'parameterToExport', ownerPartId: part.id,
      savedKind: evidence.drawing === undefined ? 'part' : 'drawing',
      savedSha256: await sha256(savedBytes), partSourceHash,
      stageHint: 'pointCoordinates', owned: { sketchId: part.activeSketchId },
    };
    if (evidence.drawing === undefined) return { ok: true, checkpoint: result };
    const drawing = evidence.drawing.document;
    const source = evidence.drawing.source;
    if (!boundedId(drawing.id)) return refusal('corrupt');
    if (source.sourceKind !== 'part' || source.document.id !== part.id
        || await contentHashOf(source.document) !== partSourceHash
        || drawing.source.sourceKind !== 'part'
        || drawing.source.contentHash !== await drawingSourceInputHash(source)
        || !boundedId(drawing.source.sourceRef)) return refusal('staleSource');
    return { ok: true, checkpoint: { ...result, drawing: {
      ownerDrawingId: drawing.id,
      sourceRef: drawing.source.sourceRef, sourceHash: drawing.source.contentHash,
    } } };
  } catch { return refusal('corrupt'); }
}

function storageFailure(error: unknown): { readonly ok: false; readonly reason: TutorialCheckpointFailure } {
  return refusal(record(error) && error.name === 'QuotaExceededError' ? 'storageQuota' : 'storageFailure');
}
function live(isCurrent: () => boolean): boolean {
  try { return isCurrent(); } catch { return false; }
}

/** No persisted step is accepted as proof of completion; callers re-check normal document state. */
export async function readTutorialCheckpoint(
  evidence: TutorialSavedEvidence, storage: TutorialCheckpointStorage | null,
): Promise<TutorialCheckpointResult> {
  if (storage === null) return refusal('storageUnavailable');
  let raw: string | null;
  try { raw = storage.getItem(TUTORIAL_CHECKPOINT_KEY); } catch (error) { return storageFailure(error); }
  if (raw === null) return refusal('missing');
  const parsed = decode(raw);
  if (!parsed.ok) return parsed;
  const current = await observed(evidence);
  if (!current.ok) return current;
  const saved = parsed.checkpoint, now = current.checkpoint;
  if (saved.ownerPartId !== now.ownerPartId
      || saved.drawing?.ownerDrawingId !== now.drawing?.ownerDrawingId) return refusal('differentDocument');
  if (saved.savedKind !== now.savedKind || saved.savedSha256 !== now.savedSha256
      || saved.partSourceHash !== now.partSourceHash) return refusal('staleContent');
  if (saved.drawing?.sourceRef !== now.drawing?.sourceRef
      || saved.drawing?.sourceHash !== now.drawing?.sourceHash) return refusal('staleSource');
  if (!ownersExist(saved.owned, evidence.part.document)) return refusal('missingOwner');
  return parsed;
}

/** Called only after ordinary save succeeds; existing corrupt/foreign checkpoints are never overwritten silently. */
export async function saveTutorialCheckpoint(
  input: TutorialCheckpointInput, evidence: TutorialSavedEvidence, storage: TutorialCheckpointStorage | null,
  isCurrent: () => boolean = () => true,
): Promise<TutorialCheckpointResult> {
  if (storage === null) return refusal('storageUnavailable');
  if (!live(isCurrent)) return refusal('staleRequest');
  if (!validInput(input)) return refusal('corrupt');
  if (!ownersExist(input.owned, evidence.part.document)) return refusal('missingOwner');
  const current = await observed(evidence);
  if (!current.ok) return current;
  if (!live(isCurrent)) return refusal('staleRequest');
  let existing: string | null;
  try { existing = storage.getItem(TUTORIAL_CHECKPOINT_KEY); } catch (error) { return storageFailure(error); }
  if (existing !== null) {
    const parsed = decode(existing);
    if (!parsed.ok) return parsed;
    if (parsed.checkpoint.ownerPartId !== current.checkpoint.ownerPartId) return refusal('differentDocument');
  }
  const checkpoint: TutorialCheckpoint = { ...current.checkpoint, ...input };
  const json = JSON.stringify(checkpoint);
  if (json.length > MAX_RECORD_LENGTH) return refusal('corrupt');
  let currentRaw: string | null;
  try { currentRaw = storage.getItem(TUTORIAL_CHECKPOINT_KEY); } catch (error) { return storageFailure(error); }
  if (currentRaw !== existing) return refusal('storageConflict');
  if (!live(isCurrent)) return refusal('staleRequest');
  try { storage.setItem(TUTORIAL_CHECKPOINT_KEY, json); } catch (error) { return storageFailure(error); }
  return { ok: true, checkpoint };
}

/** Update only unfinished text against the same validated saved document; no saved ZIP is retained. */
export async function updateTutorialCheckpointDraft(
  draft: TutorialDraft | null, savedDocument: PartDocument, storage: TutorialCheckpointStorage | null,
  isCurrent: () => boolean = () => true,
): Promise<TutorialCheckpointResult> {
  if (storage === null) return refusal('storageUnavailable');
  if (!live(isCurrent)) return refusal('staleRequest');
  let raw: string | null;
  try { raw = storage.getItem(TUTORIAL_CHECKPOINT_KEY); } catch (error) { return storageFailure(error); }
  if (raw === null) return refusal('missing');
  const parsed = decode(raw);
  if (!parsed.ok) return parsed;
  const original = parsed.checkpoint;
  if (original.ownerPartId !== savedDocument.id) return refusal('differentDocument');
  if (!ownersExist(original.owned, savedDocument)) return refusal('missingOwner');
  if (draft !== null && (!validDraft(draft)
      || !draftBelongsToStage(draft, original.stageHint, original.owned))) return refusal('corrupt');
  let hash: string;
  try { hash = await contentHashOf(savedDocument); } catch { return refusal('corrupt'); }
  if (!live(isCurrent)) return refusal('staleRequest');
  if (hash !== original.partSourceHash) return refusal('staleContent');
  const updated: TutorialCheckpoint = { ...original };
  Reflect.deleteProperty(updated, 'draft');
  const next: TutorialCheckpoint = draft === null ? updated : { ...updated, draft };
  const json = JSON.stringify(next);
  if (json.length > MAX_RECORD_LENGTH) return refusal('corrupt');
  let currentRaw: string | null;
  try { currentRaw = storage.getItem(TUTORIAL_CHECKPOINT_KEY); } catch (error) { return storageFailure(error); }
  if (currentRaw !== raw) return refusal('storageConflict');
  if (!live(isCurrent)) return refusal('staleRequest');
  try { storage.setItem(TUTORIAL_CHECKPOINT_KEY, json); } catch (error) { return storageFailure(error); }
  return { ok: true, checkpoint: next };
}

/** The UI alone invokes this after an explicit request; ordinary cancel never deletes a checkpoint. */
export function discardTutorialCheckpoint(
  storage: TutorialCheckpointStorage | null, ownsCurrentRequest: () => boolean,
): { readonly ok: true } | { readonly ok: false; readonly reason: TutorialCheckpointFailure } {
  if (storage === null || storage.removeItem === undefined) return refusal('storageUnavailable');
  if (!live(ownsCurrentRequest)) return refusal('staleRequest');
  let snapshot: string | null;
  try { snapshot = storage.getItem(TUTORIAL_CHECKPOINT_KEY); } catch (error) { return storageFailure(error); }
  if (snapshot === null) return refusal('missing');
  if (!live(ownsCurrentRequest)) return refusal('staleRequest');
  let current: string | null;
  try { current = storage.getItem(TUTORIAL_CHECKPOINT_KEY); } catch (error) { return storageFailure(error); }
  if (current !== snapshot) return refusal('storageConflict');
  if (!live(ownsCurrentRequest)) return refusal('staleRequest');
  try { storage.removeItem(TUTORIAL_CHECKPOINT_KEY); } catch (error) { return storageFailure(error); }
  return { ok: true };
}
