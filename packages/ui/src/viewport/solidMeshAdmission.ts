import { affectsShape, type SolidBody } from '@pointercad/model';
import type { AppState } from '../store/appState.js';
import { activePartDocument } from '../store/documentKind.js';
import { captureMeshBodyLayout, currentStagedSolid, finalMeshAccountingFits, isStagedSolidOwnershipCurrent,
  type MeshBodyLayout, type MeshJsAccountingState, type StagedSolidState } from '../store/recomputeSlice.js';
import { displayedSheetBodies } from '../sheetMetal/sheetCreationActions.js';

export type SolidMeshAdmissionState = AppState;
/** `stagedSolid` is the admitted staged preview (null for the committed display). */
type SolidMeshOwnership = Pick<AppState,
  | 'document' | 'activeDocumentId' | 'assembly' | 'drawing' | 'bodies'
  | 'sheetMetalPreview' | 'sheetMetalTool' | 'timelineIndex'
  | 'requestedGeneration' | 'completedGeneration' | 'lastOutcome'
  | 'recomputeCancelled' | 'cancelRequestCount' | 'meshJsAccounting' | 'stagedSolid'> & { readonly modelDocumentId: string };

const EMPTY_BODIES: readonly SolidBody[] = Object.freeze([]);

function byteCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** A display ownership check. It does not reserve UI/GPU copies or measure a process peak. */
export interface SolidMeshAdmission {
  readonly bodies: readonly SolidBody[];
  readonly state: SolidMeshOwnership | null;
  readonly accounting: MeshJsAccountingState | null;
  readonly layouts: readonly MeshBodyLayout[];
}

/**
 * The ready staged extrusion shown instead of the committed bodies while its input is open
 * and its ownership is current. A sheet-metal preview keeps precedence; failed, pending, stale
 * or released staged work never replaces the committed display.
 */
export function stagedPreviewOf(state: SolidMeshAdmissionState): StagedSolidState | null {
  if (activePartDocument(state) === null || displayedSheetBodies(state) !== state.bodies) return null;
  const staged = currentStagedSolid(state);
  return staged !== null && staged.status === 'ready' && staged.result !== null && staged.accounting !== null
    ? staged : null;
}

export function solidBodiesForAdmission(state: SolidMeshAdmissionState): readonly SolidBody[] {
  if (activePartDocument(state) === null) return EMPTY_BODIES;
  return stagedPreviewOf(state)?.result?.bodies ?? displayedSheetBodies(state);
}

function localReceiptMatches(state: SolidMeshAdmissionState, bodies: readonly SolidBody[]): boolean {
  const accounting = state.meshJsAccounting;
  if (accounting === null || accounting.bodies !== state.bodies || bodies !== accounting.bodies
    || activePartDocument(state) === null || accounting.timelineIndex !== state.timelineIndex || state.recomputeCancelled
    || state.lastOutcome !== accounting.outcome || state.completedGeneration !== state.requestedGeneration
    || accounting.receipt.generation !== state.requestedGeneration
    || accounting.receipt.documentId !== state.document.id || accounting.document.id !== state.document.id
    || accounting.activeDocumentId !== state.activeDocumentId || affectsShape(accounting.document, state.document)) return false;
  return receiptFitsBodies(accounting, bodies);
}

/**
 * A staged preview is admitted only with the staged result's own receipt: the exact result
 * bodies, its generation, the displayed document it was computed for and the prepared document
 * confirmation will store. The committed generation pair and receipt are never relabelled.
 */
function stagedReceiptMatches(state: SolidMeshAdmissionState, staged: StagedSolidState,
  bodies: readonly SolidBody[]): boolean {
  const accounting = staged.accounting, result = staged.result;
  if (accounting === null || result === null || stagedPreviewOf(state) !== staged || bodies !== result.bodies
    || accounting.bodies !== bodies || accounting.outcome !== 'success'
    || accounting.document !== staged.placement.document || accounting.timelineIndex !== staged.placement.timelineIndex
    || accounting.activeDocumentId !== state.activeDocumentId || accounting.receipt.generation !== result.generation
    || accounting.receipt.documentId !== staged.displayed.id) return false;
  return receiptFitsBodies(accounting, bodies);
}

/** The receipt's own bounds, the post-token union, every local frame and the captured layouts. */
function receiptFitsBodies(accounting: MeshJsAccountingState, bodies: readonly SolidBody[]): boolean {
  const reading = accounting.receipt.reading;
  if (reading.status !== 'known') return false;
  const cache = reading.cacheActiveBytes + reading.cacheRetiredBytes;
  const reserved = cache + reading.retainedReplyBytes;
  if (accounting.receipt.partId.length === 0 || !byteCount(accounting.receipt.generation)
    || !Number.isSafeInteger(reading.limitBytes) || reading.limitBytes <= 0 || reading.limitBytes > 512 * 1024 * 1024
    || !byteCount(reading.cacheActiveBytes) || !byteCount(reading.cacheRetiredBytes) || !byteCount(reading.cacheProtectedBytes)
    || !byteCount(reading.retainedReplyBytes) || !byteCount(reading.requestPeakReservedBytes) || !byteCount(cache) || !byteCount(reserved)
    || reading.cacheProtectedBytes > cache || reserved > reading.requestPeakReservedBytes
    || reading.requestPeakReservedBytes > reading.limitBytes) return false;
  // Local display also needs the kernel's post-token Worker union; a missing one is not zero.
  if (!finalMeshAccountingFits(accounting.receipt.final, reading.limitBytes)
    || displayCopyBaseline(accounting) === null) return false;
  for (const body of bodies) {
    const frame = body.coordinateFrame;
    if (frame === undefined || frame.space !== 'local'
      || frame.maximumLiveMeshBytes !== reading.limitBytes
      || !Number.isFinite(frame.maximumFloat32ErrorMm) || frame.maximumFloat32ErrorMm <= 0
      || frame.origin.length !== 3 || !frame.origin.every(Number.isFinite)) return false;
  }
  return layoutsMatch(bodies, accounting.bodyLayouts);
}

function layoutsMatch(bodies: readonly SolidBody[], layouts: readonly MeshBodyLayout[]): boolean {
  if (bodies.length !== layouts.length) return false;
  for (let index = 0; index < layouts.length; index += 1) {
    const layout = layouts[index], body = bodies[index];
    if (body !== layout.body || body.mesh !== layout.mesh || body.coordinateFrame !== layout.frame) return false;
    const mesh = body.mesh, frame = body.coordinateFrame;
    if (mesh.positions !== layout.positions || mesh.normals !== layout.normals || mesh.indices !== layout.indices
      || mesh.edgePositions !== layout.edges || mesh.triangleCount !== layout.triangleCount
      || mesh.positions.byteLength !== layout.byteLengths[0] || mesh.normals.byteLength !== layout.byteLengths[1]
      || mesh.indices.byteLength !== layout.byteLengths[2] || mesh.edgePositions.byteLength !== layout.byteLengths[3]
      || frame?.maximumLiveMeshBytes !== layout.budget || frame?.maximumFloat32ErrorMm !== layout.error) return false;
    if (frame !== undefined && (frame.origin[0] !== layout.origin[0]
      || frame.origin[1] !== layout.origin[1] || frame.origin[2] !== layout.origin[2])) return false;
  }
  return true;
}

/** The same body array with its captured arrays, lengths and frames; ownership is checked separately. */
export function meshLayoutsUnchanged(admission: SolidMeshAdmission, bodies: readonly SolidBody[]): boolean {
  return admission.bodies === bodies && layoutsMatch(bodies, admission.layouts);
}

export function captureSolidMeshAdmission(state: SolidMeshAdmissionState): SolidMeshAdmission | null {
  const bodies = solidBodiesForAdmission(state);
  const staged = stagedPreviewOf(state);
  const preview = staged !== null && staged.result?.bodies === bodies ? staged : null;
  const local = bodies.some(body => body.coordinateFrame !== undefined);
  if (local && !(preview === null ? localReceiptMatches(state, bodies) : stagedReceiptMatches(state, preview, bodies))) return null;
  const accounting = preview === null ? state.meshJsAccounting : preview.accounting;
  // Capture current identities, not a mutable caller's container or a freshly reconstructed receipt.
  const ownership: SolidMeshOwnership = { document: state.document, modelDocumentId: state.document.id, activeDocumentId: state.activeDocumentId,
    assembly: state.assembly, drawing: state.drawing, bodies: state.bodies,
    sheetMetalPreview: state.sheetMetalPreview, sheetMetalTool: state.sheetMetalTool, timelineIndex: state.timelineIndex,
    requestedGeneration: state.requestedGeneration, completedGeneration: state.completedGeneration,
    lastOutcome: state.lastOutcome, recomputeCancelled: state.recomputeCancelled,
    cancelRequestCount: state.cancelRequestCount, meshJsAccounting: state.meshJsAccounting, stagedSolid: preview };
  return Object.freeze({ bodies, state: Object.freeze(ownership),
    accounting: local ? accounting : null,
    layouts: local && accounting !== null ? accounting.bodyLayouts : Object.freeze(bodies.map(captureMeshBodyLayout)) });
}

/** Standalone world callers retain their historical API; local bodies always need a live state reader. */
export function captureWorldMeshAdmission(bodies: readonly SolidBody[]): SolidMeshAdmission | null {
  return bodies.some(body => body.coordinateFrame !== undefined) ? null
    : Object.freeze({ bodies, state: null, accounting: null, layouts: Object.freeze(bodies.map(captureMeshBodyLayout)) });
}

export function isSolidMeshAdmissionCurrent(admission: SolidMeshAdmission, state?: SolidMeshAdmissionState): boolean {
  if (!layoutsMatch(admission.bodies, admission.layouts)) return false;
  const before = admission.state;
  if (before === null) return state === undefined;
  if (state === undefined || state.document !== before.document || state.document.id !== before.modelDocumentId
    || state.activeDocumentId !== before.activeDocumentId || state.assembly !== before.assembly || state.drawing !== before.drawing
    || state.timelineIndex !== before.timelineIndex || state.requestedGeneration !== before.requestedGeneration
    || state.completedGeneration !== before.completedGeneration || state.lastOutcome !== before.lastOutcome
    || state.cancelRequestCount !== before.cancelRequestCount || state.recomputeCancelled !== before.recomputeCancelled
    || stagedPreviewOf(state) !== before.stagedSolid || solidBodiesForAdmission(state) !== admission.bodies) return false;
  if (admission.accounting === null) return true;
  return before.stagedSolid === null
    ? state.meshJsAccounting === admission.accounting && localReceiptMatches(state, admission.bodies)
    : before.stagedSolid.accounting === admission.accounting && stagedReceiptMatches(state, before.stagedSolid, admission.bodies);
}

export function solidMeshOwnershipChanged(next: SolidMeshAdmissionState, previous: SolidMeshAdmissionState): boolean {
  return next.document !== previous.document || next.activeDocumentId !== previous.activeDocumentId
    || next.assembly !== previous.assembly || next.drawing !== previous.drawing || next.bodies !== previous.bodies
    || next.sheetMetalPreview !== previous.sheetMetalPreview || next.sheetMetalTool !== previous.sheetMetalTool
    || next.timelineIndex !== previous.timelineIndex || next.requestedGeneration !== previous.requestedGeneration
    || next.completedGeneration !== previous.completedGeneration || next.lastOutcome !== previous.lastOutcome
    || next.recomputeCancelled !== previous.recomputeCancelled || next.cancelRequestCount !== previous.cancelRequestCount
    || next.meshJsAccounting !== previous.meshJsAccounting || next.stagedSolid !== previous.stagedSolid
    || stagedOwnershipLost(next, previous);
}

/** A published staged preview whose bindings (input, selection, history, attachments...) just changed. */
function stagedOwnershipLost(next: SolidMeshAdmissionState, previous: SolidMeshAdmissionState): boolean {
  const staged = previous.stagedSolid;
  return staged !== null && isStagedSolidOwnershipCurrent(previous, staged.ownership)
    && !isStagedSolidOwnershipCurrent(next, staged.ownership);
}

/**
 * A local display's known CPU baseline: the kernel's post-token Worker union plus the reply
 * clone. The received source arrays are inside it, so UI copies are added on top, never the
 * sources again. Null when the receipt lacks a valid known union (never treated as zero).
 */
export function displayCopyBaseline(accounting: MeshJsAccountingState):
  { readonly limitBytes: number; readonly baselineBytes: number } | null {
  const reading = accounting.receipt.reading;
  const final = accounting.receipt.final;
  if (reading.status !== 'known' || !finalMeshAccountingFits(final, reading.limitBytes)) return null;
  const main = accounting.mainMeshBacking;
  let mainBytes = 0;
  if (main !== undefined) {
    const seen = new Set<ArrayBuffer>();
    for (const buffer of main.buffers) {
      if (!(buffer instanceof ArrayBuffer) || seen.has(buffer)
        || ('resizable' in buffer && buffer.resizable === true)) return null;
      seen.add(buffer); mainBytes += buffer.byteLength;
    }
    if (!byteCount(mainBytes) || mainBytes !== main.retainedBackingBytes
      || !byteCount(main.limitBytes) || main.limitBytes > 512 * 1024 * 1024
      || reading.limitBytes + mainBytes !== main.limitBytes) return null;
    // Each imported display allocation must be among the separately accounted main backings.
    for (const body of accounting.bodies) {
      if (body.bodyKind !== 'mesh') continue;
      for (const array of [body.mesh.positions, body.mesh.normals, body.mesh.indices, body.mesh.edgePositions]) {
        if (array.byteLength !== 0 && (!(array.buffer instanceof ArrayBuffer) || !seen.has(array.buffer))) return null;
      }
    }
  } else if (accounting.bodies.some(body => body.bodyKind === 'mesh')) return null;
  const limitBytes = main?.limitBytes ?? reading.limitBytes;
  const baselineBytes = final.retainedBackingBytes + final.replyCloneReservedBytes + mainBytes;
  return !byteCount(baselineBytes) || baselineBytes > limitBytes ? null : { limitBytes, baselineBytes };
}

/**
 * Finite GPU mesh-buffer reservations shared by every renderer that shows local meshes. One
 * owner is one renderer (one viewport scene); its quad panes share that one reservation, while
 * two canvases hold two even for the same CPU arrays. A new reservation replaces the owner's
 * previous one, a refused reservation leaves it unchanged, and releasing one owner never
 * touches another. The value is an attribute byte count, not a measured driver high-water;
 * textures, PMREM, materials and the non-mesh helper lines stay outside it.
 */
export interface GpuMeshBudget {
  readonly limitBytes: number;
  reserve(owner: symbol, bytes: number): boolean;
  release(owner: symbol): void;
  reservedBytes(owner?: symbol): number;
}

/**
 * The process-wide pool every viewport canvas shares for local displays (each canvas is one
 * renderer owner). 512 MiB matches the local live-mesh ceiling; world displays do not reserve.
 */
export const LOCAL_DISPLAY_GPU_MESH_BUDGET: GpuMeshBudget = createGpuMeshBudget(512 * 1024 * 1024);

export function createGpuMeshBudget(limitBytes: number): GpuMeshBudget {
  if (!byteCount(limitBytes) || limitBytes === 0) throw new RangeError('GPU mesh budget must be a positive safe integer');
  const owners = new Map<symbol, number>();
  let total = 0;
  return {
    limitBytes,
    reserve(owner, bytes): boolean {
      if (!byteCount(bytes)) return false;
      const next = total - (owners.get(owner) ?? 0) + bytes;
      if (!byteCount(next) || next > limitBytes) return false;
      owners.set(owner, bytes);
      total = next;
      return true;
    },
    release(owner): void {
      total -= owners.get(owner) ?? 0;
      owners.delete(owner);
    },
    reservedBytes(owner): number {
      return owner === undefined ? total : owners.get(owner) ?? 0;
    },
  };
}
