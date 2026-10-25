export type ViewportMeshPhase = 'build-start' | 'publish-start' | 'publish-complete'
  | 'build-complete' | 'operation-aborted' | 'publication-retired'
  | 'candidate-return-start' | 'candidate-return-complete'
  | 'geometry-cancel-request' | 'geometry-cancel-ack' | 'release-start' | 'release-complete';

export interface ViewportMeshOwner {
  readonly documentId: string | null;
  readonly viewportOwnerId: string;
  readonly resourceOwnerId: string;
  readonly operationId?: string;
  readonly publicationId?: string;
  readonly generation: number | null;
  readonly preview: boolean;
}

export interface ViewportMeshPhaseEvent extends ViewportMeshOwner {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly atMonotonicMs: number;
  readonly kind: ViewportMeshPhase;
  readonly reason: 'completed' | 'superseded' | 'disposed' | 'rejected' | null;
  readonly hostDisplayCopyBytes: number | null;
  readonly hostGpuReservedBytes: number | null;
  readonly hostGpuAttributeBytes: number | null;
}

export interface ViewportMeshObservationSnapshot {
  readonly schemaVersion: 1;
  readonly viewportOwnerId: string;
  readonly epochAnchorMs: number;
  readonly monotonicAnchorMs: number;
  readonly active: boolean;
  readonly events: readonly ViewportMeshPhaseEvent[];
  readonly droppedRecords: number;
  readonly clockDiscontinuity: boolean;
  readonly unobserved: readonly string[];
  readonly missingRecords: number;
  readonly conflictingOwners: number;
  readonly unfinishedOwners: number;
  readonly missingStarts: number;
  readonly missingTerminals: number;
  readonly duplicateTerminals: number;
  readonly livePublications: number;
  readonly retiredPublications: number;
  readonly hostReleasedOwners: number;
}

/** Metadata only: never retain a mesh, texture, native owner or transfer backing. */
export function createViewportMeshObservation(
  viewportOwnerId: string,
  capacity = 4096,
  clock: () => number = () => performance.now(),
  epochClock: () => number = () => Date.now(),
) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('Invalid observation capacity');
  const monotonicAnchorMs = clock(), epochAnchorMs = epochClock();
  let active = true, sequence = 0, droppedRecords = 0;
  let clockDiscontinuity = !Number.isFinite(monotonicAnchorMs) || !Number.isFinite(epochAnchorMs);
  let previousTime = monotonicAnchorMs;
  const events: ViewportMeshPhaseEvent[] = [];
  return {
    record(owner: ViewportMeshOwner, kind: ViewportMeshPhase,
      reason: ViewportMeshPhaseEvent['reason'] = null,
      resources?: { readonly hostDisplayCopyBytes: number; readonly hostGpuReservedBytes: number | null;
        readonly hostGpuAttributeBytes?: number }): void {
      if (!active || owner.viewportOwnerId !== viewportOwnerId) { droppedRecords += 1; return; }
      const atMonotonicMs = clock();
      if (!Number.isFinite(atMonotonicMs) || atMonotonicMs < previousTime) clockDiscontinuity = true;
      previousTime = atMonotonicMs;
      sequence += 1;
      const count = (value: number | null | undefined): number | null =>
        value !== undefined && value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
      events.push(Object.freeze({ schemaVersion: 1, documentId: owner.documentId,
        viewportOwnerId: owner.viewportOwnerId, resourceOwnerId: owner.resourceOwnerId,
        ...(owner.operationId === undefined ? {} : { operationId: owner.operationId }),
        ...(owner.publicationId === undefined ? {} : { publicationId: owner.publicationId }),
        generation: owner.generation, preview: owner.preview, sequence, atMonotonicMs, kind, reason,
        hostDisplayCopyBytes: count(resources?.hostDisplayCopyBytes), hostGpuReservedBytes: count(resources?.hostGpuReservedBytes),
        hostGpuAttributeBytes: count(resources?.hostGpuAttributeBytes) }));
      if (events.length > capacity) { events.shift(); droppedRecords += 1; }
    },
    snapshot(): ViewportMeshObservationSnapshot {
      let missingRecords = 0, conflictingOwners = 0, missingStarts = 0, duplicateTerminals = 0, retiredPublications = 0;
      const owners = new Map<string, ViewportMeshPhaseEvent>();
      const unfinished = new Set<string>();
      const starts = new Set<string>();
      const completed = new Set<string>();
      const publications = new Map<string, string>();
      const retired = new Set<string>();
      const released = new Set<string>();
      for (const event of events) {
        const identity = event.operationId ?? event.publicationId ?? event.resourceOwnerId;
        const previous = owners.get(identity);
        if (previous !== undefined && (previous.documentId !== event.documentId
          || previous.generation !== event.generation || previous.preview !== event.preview)) conflictingOwners += 1;
        owners.set(identity, event);
        if (event.documentId === null || event.generation === null) missingRecords += 1;
        if (event.operationId === undefined || event.publicationId === undefined) missingRecords += 1;
        if (event.kind === 'publication-retired') {
          const publicationId = event.publicationId ?? identity;
          if (retired.has(publicationId)) duplicateTerminals += 1;
          else if (!publications.has(publicationId)) missingStarts += 1;
          else { publications.delete(publicationId); retired.add(publicationId); retiredPublications += 1; }
          continue;
        }
        if (event.kind === 'operation-aborted') {
          unfinished.delete(`${identity}:build`); starts.delete(`${identity}:build`);
          unfinished.delete(`${identity}:publish`); starts.delete(`${identity}:publish`);
          continue;
        }
        const phase = event.kind.startsWith('publish') ? 'publish'
          : event.kind.startsWith('release') ? 'release'
          : event.kind.startsWith('candidate-return') ? 'return'
          : event.kind.startsWith('geometry-cancel') ? 'cancel' : 'build';
        const key = `${phase === 'release' ? event.resourceOwnerId : identity}:${phase}`;
        if (event.kind.endsWith('-start') || event.kind.endsWith('-request')) {
          starts.add(key); unfinished.add(key); completed.delete(key);
        } else {
          if (completed.has(key)) duplicateTerminals += 1;
          else if (!starts.has(key)) missingStarts += 1;
          starts.delete(key); completed.add(key);
          unfinished.delete(key);
          if (event.kind === 'publish-complete') {
            publications.set(event.publicationId ?? identity, event.resourceOwnerId);
          }
          if (event.kind === 'release-complete') {
            released.add(event.resourceOwnerId);
            for (const [publication, resource] of publications) if (resource === event.resourceOwnerId) publications.delete(publication);
          }
        }
      }
      return Object.freeze({ schemaVersion: 1, viewportOwnerId, epochAnchorMs, monotonicAnchorMs,
        active, events: Object.freeze([...events]), droppedRecords, clockDiscontinuity,
        missingRecords: missingRecords + missingStarts, conflictingOwners, unfinishedOwners: unfinished.size,
        missingStarts, missingTerminals: unfinished.size, duplicateTerminals,
        livePublications: publications.size, retiredPublications, hostReleasedOwners: released.size,
        unobserved: Object.freeze(['kernelNativeBuild', 'workerTransfer', 'workerCancellation', 'driverGpuActual', 'replacedDriverAllocationRelease']) });
    },
    close(ownerId: string): void { if (ownerId === viewportOwnerId) active = false; },
  };
}
