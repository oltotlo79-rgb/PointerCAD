import { describe, expect, it } from 'vitest';
import { createViewportMeshObservation, type ViewportMeshOwner } from './viewportMeshObservation.js';

const owner: ViewportMeshOwner = { documentId: 'document-A', viewportOwnerId: 'viewport-A',
  resourceOwnerId: 'mesh-A', operationId: 'operation-A', publicationId: 'publication-A', generation: 7, preview: false };

describe('readonly viewport phase metadata', () => {
  it('collects one hundred updates without dropping metadata or retaining caller payloads', () => {
    const observer = createViewportMeshObservation('viewport-A');
    for (let generation = 0; generation < 100; generation += 1) {
      const current = { ...owner, generation, resourceOwnerId: `mesh-${generation}`,
        operationId: `operation-${generation}`, publicationId: `publication-${generation}`, payload: new ArrayBuffer(8) };
      const resources = { hostDisplayCopyBytes: 24, hostGpuReservedBytes: 132 };
      observer.record(current, 'build-start', null, resources);
      observer.record(current, 'build-complete', 'completed', resources);
      observer.record(current, 'publish-start', null, resources);
      observer.record(current, 'publish-complete', 'completed', resources);
      observer.record(current, 'release-start', 'disposed', resources);
      observer.record(current, 'release-complete', 'disposed', { hostDisplayCopyBytes: 0, hostGpuReservedBytes: 0 });
    }
    const snapshot = observer.snapshot();
    expect(snapshot.events).toHaveLength(600); expect(snapshot.droppedRecords).toBe(0);
    expect(snapshot.missingRecords).toBe(0); expect(snapshot.unfinishedOwners).toBe(0);
    expect(snapshot.events.every(event => !('payload' in event))).toBe(true);
    expect(Object.isFrozen(snapshot.events[0])).toBe(true);
  });

  it('reports missing starts, missing terminals and generation conflicts independently', () => {
    const observer = createViewportMeshObservation('viewport-A');
    observer.record(owner, 'publish-complete');
    expect(observer.snapshot().missingRecords).toBe(1);
    observer.record(owner, 'release-start');
    expect(observer.snapshot().unfinishedOwners).toBe(1);
    expect(observer.snapshot().missingTerminals).toBe(1);
    observer.record({ ...owner, generation: 8 }, 'release-complete');
    expect(observer.snapshot().conflictingOwners).toBe(1);
  });

  it('distinguishes duplicate terminals and retirement from actual host release', () => {
    const observer = createViewportMeshObservation('viewport-A');
    observer.record(owner, 'build-start'); observer.record(owner, 'build-complete');
    observer.record(owner, 'publish-start'); observer.record(owner, 'publish-complete');
    observer.record(owner, 'publication-retired', 'superseded');
    expect(observer.snapshot()).toMatchObject({ retiredPublications: 1, livePublications: 0, hostReleasedOwners: 0 });
    observer.record(owner, 'release-start'); observer.record(owner, 'release-complete');
    observer.record(owner, 'release-complete');
    expect(observer.snapshot()).toMatchObject({ duplicateTerminals: 1, missingStarts: 0,
      unfinishedOwners: 0, hostReleasedOwners: 1 });
    expect(observer.snapshot().unobserved).toContain('replacedDriverAllocationRelease');
  });
  it('keeps owner/generation, copies bounded snapshots and reports missing transfer coverage', () => {
    let now = 10;
    const observer = createViewportMeshObservation('viewport-A', 2, () => now, () => 1000);
    observer.record(owner, 'build-start');
    now = 11; observer.record(owner, 'publish-start');
    const before = observer.snapshot();
    now = 12; observer.record(owner, 'publish-complete', 'completed');
    const after = observer.snapshot();
    expect(before.events.map(event => event.sequence)).toEqual([1, 2]);
    expect(after.events.map(event => event.sequence)).toEqual([2, 3]);
    expect(after.droppedRecords).toBe(1);
    expect(after.epochAnchorMs).toBe(1000);
    expect(after.monotonicAnchorMs).toBe(10);
    expect(after.events[1]).toMatchObject({ ...owner, atMonotonicMs: 12, kind: 'publish-complete' });
    expect(after.unobserved).toContain('workerTransfer');
    expect(after.unobserved).toContain('driverGpuActual');
  });

  it('keeps preview owners distinct and rejects stale owner teardown and late publication', () => {
    const observer = createViewportMeshObservation('viewport-A', 8, () => 10, () => 1000);
    const preview = { ...owner, resourceOwnerId: 'preview-A', generation: 1, preview: true };
    observer.record(preview, 'build-start');
    observer.record(preview, 'geometry-cancel-request', 'superseded');
    observer.record(preview, 'geometry-cancel-ack', 'superseded');
    observer.close('viewport-B');
    expect(observer.snapshot().active).toBe(true);
    observer.record(preview, 'release-complete', 'superseded');
    observer.close('viewport-A');
    observer.record(preview, 'publish-complete');
    expect(observer.snapshot().events).toHaveLength(4);
    expect(observer.snapshot().droppedRecords).toBe(1);
    expect(observer.snapshot().events.every(event => event.preview && event.resourceOwnerId === 'preview-A')).toBe(true);
  });

  it('reports clock reversal and mismatched owners without fabricating observed transfer events', () => {
    let now = 10;
    const observer = createViewportMeshObservation('viewport-A', 4, () => now, () => 1000);
    observer.record({ ...owner, viewportOwnerId: 'other' }, 'build-start');
    now = 9; observer.record(owner, 'build-start');
    expect(observer.snapshot().clockDiscontinuity).toBe(true);
    expect(observer.snapshot().droppedRecords).toBe(1);
    expect(observer.snapshot().events.map(event => event.kind)).toEqual(['build-start']);
  });
});
