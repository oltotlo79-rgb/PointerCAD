import { nextFeatureId, nextSolidId, type PartDocument, type SolidBody } from '@pointercad/model';
import type { DrawingDocument } from '@pointercad/drawing';
import { TUTORIAL_CHECKPOINT_KEY, type TutorialCheckpoint, type TutorialCheckpointFailure,
  type TutorialCheckpointInput, type TutorialCheckpointStorage, type TutorialDraft,
  type TutorialOwnedIds } from './tutorialCheckpoint.js';
import type { AppState } from '../store/appState.js';

export const TUTORIAL_STEPS = ['point', 'outline', 'face', 'extrude', 'hole', 'save', 'complete'] as const;
export type TutorialStep = typeof TUTORIAL_STEPS[number];
/** Only the guide's ownership is kept here. Geometry and Undo remain in the ordinary document. */
export interface TutorialSession {
  readonly course?: 'plate' | 'parameterToExport';
  readonly documentId: string;
  readonly documentVersion: number;
  readonly sketchId: string;
  readonly pointId: string;
  readonly outlineId: string;
  readonly faceId: string;
  readonly extrudeId: string;
  readonly holeId: string;
  readonly parameterName?: string;
  /** Identity of the last checkpoint actually accepted by ordinary save/open. Ephemeral, never stage proof. */
  readonly checkpointIdentity?: string;
  readonly paused: boolean;
}

/** Draft-only edits leave this saved-file identity unchanged. */
export function parameterCheckpointIdentity(checkpoint: TutorialCheckpoint): string {
  return JSON.stringify([checkpoint.ownerPartId, checkpoint.savedKind, checkpoint.savedSha256,
    checkpoint.partSourceHash, checkpoint.drawing?.ownerDrawingId ?? null,
    checkpoint.drawing?.sourceRef ?? null, checkpoint.drawing?.sourceHash ?? null,
    checkpoint.stageHint, checkpoint.owned]);
}

function rawCheckpointIdentity(raw: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const checkpoint = parsed as Record<string, unknown>;
  if (checkpoint.course !== 'parameterToExport' || checkpoint.version !== 1
      || typeof checkpoint.ownerPartId !== 'string' || typeof checkpoint.savedKind !== 'string'
      || typeof checkpoint.savedSha256 !== 'string' || typeof checkpoint.partSourceHash !== 'string'
      || typeof checkpoint.stageHint !== 'string' || typeof checkpoint.owned !== 'object'
      || checkpoint.owned === null || Array.isArray(checkpoint.owned)) return null;
  const drawing = checkpoint.drawing;
  if (drawing !== undefined && (typeof drawing !== 'object' || drawing === null || Array.isArray(drawing))) return null;
  const source = drawing as Record<string, unknown> | undefined;
  if (source !== undefined && (typeof source.ownerDrawingId !== 'string'
      || typeof source.sourceRef !== 'string' || typeof source.sourceHash !== 'string')) return null;
  return JSON.stringify([checkpoint.ownerPartId, checkpoint.savedKind, checkpoint.savedSha256,
    checkpoint.partSourceHash, source?.ownerDrawingId ?? null, source?.sourceRef ?? null,
    source?.sourceHash ?? null, checkpoint.stageHint, checkpoint.owned]);
}

export type ParameterCheckpointWriteGuard =
  | { readonly ok: true; readonly isCurrent: () => boolean }
  | { readonly ok: false; readonly reason: TutorialCheckpointFailure };

/** Existing storage must be the checkpoint accepted earlier by this exact guide session. */
export function parameterCheckpointWriteGuard(session: TutorialSession, storage: TutorialCheckpointStorage | null,
  isCurrent: () => boolean): ParameterCheckpointWriteGuard {
  if (storage === null) return { ok: false, reason: 'storageUnavailable' };
  if (!isCurrent()) return { ok: false, reason: 'staleRequest' };
  let raw: string | null;
  try { raw = storage.getItem(TUTORIAL_CHECKPOINT_KEY); }
  catch { return { ok: false, reason: 'storageFailure' }; }
  if ((raw === null && session.checkpointIdentity !== undefined)
      || (raw !== null && (session.checkpointIdentity === undefined
        || rawCheckpointIdentity(raw) !== session.checkpointIdentity))) {
    return { ok: false, reason: 'storageConflict' };
  }
  return { ok: true, isCurrent: () => {
    if (!isCurrent()) return false;
    try { return storage.getItem(TUTORIAL_CHECKPOINT_KEY) === raw; } catch { return false; }
  } };
}

/** A queued second save may follow the first save's identity update, but never a new course. */
export function continuingParameterSession(requested: TutorialSession, latest: TutorialSession | null): boolean {
  if (latest === requested) return true;
  return latest?.course === 'parameterToExport' && latest.checkpointIdentity !== undefined
    && requested.course === latest.course && requested.documentId === latest.documentId
    && requested.documentVersion === latest.documentVersion && requested.sketchId === latest.sketchId
    && requested.pointId === latest.pointId && requested.outlineId === latest.outlineId
    && requested.faceId === latest.faceId && requested.extrudeId === latest.extrudeId
    && requested.holeId === latest.holeId
    && requested.parameterName === latest.parameterName && requested.paused === latest.paused;
}

export const PARAMETER_TUTORIAL_STEPS = ['pointCoordinates', 'thicknessParameter', 'dimensionChange', 'drawing', 'stepStl', 'complete'] as const;
export type ParameterTutorialStep = typeof PARAMETER_TUTORIAL_STEPS[number];
/** These are ordinary operation results tied to the current document reference, never saved checkmarks. */
export interface ParameterTutorialEvidence {
  readonly ready: boolean;
  readonly bodies: readonly SolidBody[];
  readonly savedPart: PartDocument | null;
  readonly activeDrawing: DrawingDocument | null;
  readonly drawingProof?: { readonly document: DrawingDocument; readonly sourcePart: PartDocument;
    readonly sourceRef: string; readonly sourceHash: string };
  readonly exports?: { readonly step?: PartDocument; readonly stl?: PartDocument };
}

export function parameterTutorialEvidence(state: AppState): ParameterTutorialEvidence {
  return { ready: !state.isComputing && state.requestedGeneration === state.completedGeneration
      && state.lastOutcome === 'success' && state.partErrors.length === 0 && state.sketchErrors.length === 0,
    bodies: state.bodies, savedPart: state.savedDocument, activeDrawing: state.drawing,
    drawingProof: state.tutorialDrawingProof ?? undefined, exports: state.tutorialExports };
}

export function createParameterTutorialSession(document: PartDocument, version: number): TutorialSession | null {
  const session = createTutorialSession(document, version);
  return session === null ? null : { ...session, course: 'parameterToExport', parameterName: '板厚' };
}

/** Rehydrate only guide-owned IDs after the ordinary loader has accepted a saved file. */
export function resumeParameterTutorialSession(checkpoint: TutorialCheckpoint, document: PartDocument,
  version: number): TutorialSession | null {
  if (checkpoint.course !== 'parameterToExport' || checkpoint.ownerPartId !== document.id
      || checkpoint.owned.sketchId !== document.activeSketchId) return null;
  const sketch = document.sketches.find(item => item.id === checkpoint.owned.sketchId);
  if (sketch === undefined) return null;
  return { course: 'parameterToExport', documentId: document.id, documentVersion: version, sketchId: sketch.id,
    pointId: checkpoint.owned.pointId ?? nextFeatureId(sketch, 'point'),
    outlineId: checkpoint.owned.outlineId ?? nextFeatureId(sketch, 'rectangle'),
    faceId: checkpoint.owned.faceId ?? nextFeatureId(sketch, 'face'),
    extrudeId: checkpoint.owned.extrudeId ?? nextSolidId(document, 'extrude'),
    holeId: nextSolidId(document, 'hole'), parameterName: checkpoint.owned.parameterName ?? '板厚',
    checkpointIdentity: parameterCheckpointIdentity(checkpoint), paused: true };
}

/** An ID enters the checkpoint only after the normal document actually owns it. */
export function parameterCheckpointInput(session: TutorialSession, document: PartDocument,
  stage: ParameterTutorialStep, draft: TutorialDraft | null = null): TutorialCheckpointInput | null {
  if (session.course !== 'parameterToExport' || document.id !== session.documentId) return null;
  const sketch = document.sketches.find(item => item.id === session.sketchId);
  if (sketch === undefined) return null;
  const feature = (id: string, kind: string): boolean => sketch.features.some(item => item.id === id && item.kind === kind);
  const owned: TutorialOwnedIds = { sketchId: session.sketchId,
    ...(feature(session.pointId, 'point') ? { pointId: session.pointId } : {}),
    ...(feature(session.outlineId, 'rectangle') ? { outlineId: session.outlineId } : {}),
    ...(feature(session.faceId, 'face') ? { faceId: session.faceId } : {}),
    ...(document.solids.some(item => item.id === session.extrudeId && item.kind === 'extrude')
      ? { extrudeId: session.extrudeId } : {}),
    ...(session.parameterName !== undefined && document.parameters.some(item => item.name === session.parameterName)
      ? { parameterName: session.parameterName } : {}),
  };
  return { stageHint: stage === 'complete' ? 'stepStl' : stage, owned,
    ...(draft === null ? {} : { draft }) };
}

function bodyHeight(body: SolidBody): number | null {
  const positions = body.mesh.positions;
  if (positions.length < 9) return null;
  let low = Infinity, high = -Infinity;
  for (let index = 2; index < positions.length; index += 3) {
    const z = positions[index];
    if (!Number.isFinite(z)) return null;
    low = Math.min(low, z); high = Math.max(high, z);
  }
  return high - low;
}

/** Re-derive visible progress from one owner, a settled body, and successful ordinary IO. */
export function parameterTutorialStep(session: TutorialSession, document: PartDocument, version: number,
  evidence: ParameterTutorialEvidence): ParameterTutorialStep | 'differentDocument' {
  if (session.course !== 'parameterToExport' || document.id !== session.documentId
      || version !== session.documentVersion || document.activeSketchId !== session.sketchId) return 'differentDocument';
  const sketch = document.sketches.find(item => item.id === session.sketchId);
  if (sketch === undefined) return 'differentDocument';
  const point = sketch.features.find(item => item.id === session.pointId);
  if (point?.kind !== 'point' || point.at.mode !== 'absolute'
      || Math.abs(point.at.x.value) > 1e-9 || Math.abs(point.at.y.value) > 1e-9
      || Math.abs(point.at.z.value) > 1e-9) return 'pointCoordinates';
  const parameter = document.parameters.find(item => item.name === session.parameterName);
  const rectangle = sketch.features.find(item => item.id === session.outlineId);
  const face = sketch.features.find(item => item.id === session.faceId);
  const extrude = document.solids.find(item => item.id === session.extrudeId);
  const linked = rectangle?.kind === 'rectangle' && face?.kind === 'face'
    && face.boundary.length === 1 && face.boundary[0].featureId === session.outlineId
    && face.boundary[0].index === undefined && extrude?.kind === 'extrude' && !extrude.suppressed
    && extrude.profile.sketchId === session.sketchId && extrude.profile.faceFeatureId === session.faceId
    && extrude.distance.source.trim() === session.parameterName;
  const body = evidence.bodies.find(item => item.featureId === session.extrudeId && item.isValid);
  const height = body === undefined ? null : bodyHeight(body);
  if (!linked || parameter?.unit !== 'mm' || !evidence.ready || height === null) return 'thicknessParameter';
  if (Math.abs(parameter.value.value - 3) < 1e-9 && Math.abs(height - 3) < 1e-3) return 'dimensionChange';
  if (Math.abs(parameter.value.value - 6) >= 1e-9 || Math.abs(height - 6) >= 1e-3
      || evidence.savedPart !== document) return 'dimensionChange';
  const proof = evidence.drawingProof;
  if (proof === undefined || proof.sourcePart !== document || proof.document.source.sourceKind !== 'part'
      || proof.document.source.sourceRef !== proof.sourceRef
      || proof.document.source.contentHash !== proof.sourceHash
      || evidence.activeDrawing !== null && evidence.activeDrawing !== proof.document
      || !['front', 'top', 'right'].every(kind => proof.document.views.some(view => view.kind === kind))) return 'drawing';
  if (evidence.exports?.step !== document || evidence.exports.stl !== document) return 'stepStl';
  return 'complete';
}

export function createTutorialSession(document: PartDocument, documentVersion: number): TutorialSession | null {
  const sketch = document.sketches.find(item => item.id === document.activeSketchId);
  if (sketch === undefined || document.sketches.some(item => item.features.length > 0)
      || document.solids.length > 0 || document.references.length > 0) return null;
  return { documentId: document.id, documentVersion, sketchId: sketch.id,
    pointId: nextFeatureId(sketch, 'point'), outlineId: nextFeatureId(sketch, 'rectangle'),
    faceId: nextFeatureId(sketch, 'face'), extrudeId: nextSolidId(document, 'extrude'),
    holeId: nextSolidId(document, 'hole'), paused: false };
}

/** Every step is re-derived: Undo/deletion cannot leave a stale completion checkmark. */
export function tutorialStep(session: TutorialSession, document: PartDocument,
  documentVersion: number, saved: PartDocument | null): TutorialStep | 'differentDocument' {
  if (document.id !== session.documentId || documentVersion !== session.documentVersion
      || document.activeSketchId !== session.sketchId) return 'differentDocument';
  const sketch = document.sketches.find(item => item.id === session.sketchId);
  if (sketch === undefined) return 'differentDocument';
  if (!sketch.features.some(item => item.id === session.pointId && item.kind === 'point')) return 'point';
  if (!sketch.features.some(item => item.id === session.outlineId && item.kind === 'rectangle')) return 'outline';
  const face = sketch.features.find(item => item.id === session.faceId);
  if (face?.kind !== 'face' || face.boundary.length !== 1
      || face.boundary[0].featureId !== session.outlineId || face.boundary[0].index !== undefined) return 'face';
  const extrude = document.solids.find(item => item.id === session.extrudeId);
  if (extrude?.kind !== 'extrude' || extrude.suppressed || extrude.profile.sketchId !== session.sketchId
      || extrude.profile.faceFeatureId !== session.faceId) return 'extrude';
  const hole = document.solids.find(item => item.id === session.holeId);
  if (hole?.kind !== 'hole' || hole.suppressed || hole.targetFeatureId !== session.extrudeId
      || !hole.centers.some(item => item.sketchId === session.sketchId && item.pointFeatureId === session.pointId)) return 'hole';
  return saved === document ? 'complete' : 'save';
}
