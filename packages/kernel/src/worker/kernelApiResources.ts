import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import type { SolidBodyMesh, SolidRecomputeResult } from '../types.js';
import { localCachedReferenceMesh, solidMeshBuffers, type CachedSolid } from './recomputeSolids.js';
import { finalMeshJsAccounting, type AcquireToken, type AcquiringShapeCache } from './shapeCache.js';
import { withinReplyOriginBudget } from './originBudget.js';
import type { CurrentMeshOwner, MeshReplyAdmission, ReferenceMeshLeaseRequest } from './kernelApi.js';

interface HiddenLeaseResourcesContext {
  cache: AcquiringShapeCache<CachedSolid>;
  loadOcct: () => Promise<OpenCascadeInstance>;
  hiddenLeases: Map<string, { readonly owner: CurrentMeshOwner; readonly token: AcquireToken; bodies: readonly SolidBodyMesh[] }>;
  pendingHiddenDispatches: Set<string>;
  changedOwner: () => void;
  sameCurrentMeshOwner: (a: CurrentMeshOwner, b: CurrentMeshOwner) => boolean;
  capturedCurrentMeshOwner: (owner: CurrentMeshOwner) => CurrentMeshOwner;
  retainedMeshBuffers: () => Generator<ArrayBufferLike>;
  displayMeshBuffers: () => Generator<ArrayBufferLike>;
  hiddenMeshBuffers: () => Generator<ArrayBufferLike>;
  prepareManagedReply: (owner: CurrentMeshOwner | undefined, result: SolidRecomputeResult,
    admitReply: MeshReplyAdmission | undefined) => Promise<SolidRecomputeResult>;
  missingBodyMessage: string;
}

/** Owns acquisition, publication, retryable cleanup and release of reference mesh leases. */
export function createHiddenLeaseResources(context: HiddenLeaseResourcesContext) {
  const { cache, loadOcct, hiddenLeases, pendingHiddenDispatches, changedOwner, sameCurrentMeshOwner,
    capturedCurrentMeshOwner, retainedMeshBuffers, displayMeshBuffers, hiddenMeshBuffers, prepareManagedReply,
    missingBodyMessage: MISSING_BODY_MESSAGE } = context;
  return {
    releaseReferenceMeshLease(this: void, owner: CurrentMeshOwner) {
      const lease = hiddenLeases.get(owner.dispatchId);
      if (lease === undefined) return Promise.resolve({ released: false, absent: true });
      if (!sameCurrentMeshOwner(lease.owner, owner)) return Promise.resolve({ released: false });
      try { cache.release(lease.token); }
      catch (error) {
        // Internal partial failure provides only failed backing owners; external pre-release
        // throws have no disposition proof and keep the complete lease for a safe retry.
        const failed = cache.failedReleaseBuffers?.(lease.token);
        if (failed !== undefined) {
          const held = new Set(failed);
          lease.bodies = lease.bodies.filter(body => solidMeshBuffers(body).some(buffer => buffer instanceof ArrayBuffer && held.has(buffer)));
          changedOwner();
        }
        throw error;
      }
      hiddenLeases.delete(owner.dispatchId); changedOwner();
      return Promise.resolve({ released: true });
    },
    async readCachedBodies(this: void, items: readonly { readonly id: string; readonly key: string }[], lease?: ReferenceMeshLeaseRequest, admitReply?: MeshReplyAdmission): Promise<SolidRecomputeResult> {
      if (lease !== undefined && (hiddenLeases.size + pendingHiddenDispatches.size >= 128
        || hiddenLeases.has(lease.owner.dispatchId) || pendingHiddenDispatches.has(lease.owner.dispatchId)
        || lease.owner.kind !== 'hidden' || lease.owner.dispatchId.length === 0
        || !Number.isSafeInteger(lease.limitBytes) || lease.limitBytes <= 0 || lease.limitBytes > 512 * 1024 * 1024
        || lease.owner.steps.length !== items.length
        || !items.every((item, index) => item.id === lease.owner.steps[index]?.id && item.key === lease.owner.steps[index]?.key)))
        return Promise.reject(new RangeError('Invalid reference mesh lease'));
      const token = lease === undefined ? undefined : cache.acquire(items.map(item => item.key));
      if (lease !== undefined) pendingHiddenDispatches.add(lease.owner.dispatchId);
      try {
      // Acquire protects these exact entries across native loading and concurrent key replacement.
      const captured = new Map(items.map(item => [item.key, cache.get(item.key)]));
      const oc = lease?.localMesh === undefined ? undefined : await loadOcct();
      if (lease !== undefined && hiddenLeases.has(lease.owner.dispatchId)) {
        throw new RangeError('Reference mesh owner already published');
      }
      const bodies: SolidRecomputeResult['bodies'][number][] = [];
      const failures: SolidRecomputeResult['failures'][number][] = [];
      const counts = new Map<string, number>();
      for (const item of items) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
      for (const item of items) {
        const cached = item.id.length > 0 && counts.get(item.id) === 1 ? captured.get(item.key) : undefined;
        if (cached === undefined || (cached.mesh.origins?.state === 'tracked' && cached.mesh.id !== item.id)) {
          failures.push({ id: item.id, message: MISSING_BODY_MESSAGE });
        }
        else bodies.push(lease?.localMesh === undefined || oc === undefined
          ? { ...cached.mesh, id: item.id }
          : localCachedReferenceMesh(oc, cache, cached, item.id,
            { ...lease.localMesh, maximumLiveMeshBytes: Math.min(lease.limitBytes, lease.localMesh.maximumLiveMeshBytes) },
            () => retainedMeshBuffers(), bodies));
      }
      const result = { bodies: withinReplyOriginBudget(bodies), failures,
        cacheHits: bodies.length, cancelled: false, appearanceMatches: [] };
      if (lease !== undefined && token !== undefined) {
        const final = finalMeshJsAccounting(cache.meshBufferSnapshot?.() ?? { status: 'unknown', reason: 'callback-missing' },
          displayMeshBuffers(), result.bodies.flatMap(body => solidMeshBuffers(body)), lease.limitBytes, hiddenMeshBuffers());
        if (final.status !== 'known' || final.retainedBackingBytes + final.replyCloneReservedBytes > lease.limitBytes) {
          throw new RangeError('Reference mesh backing budget unavailable');
        }
        hiddenLeases.set(lease.owner.dispatchId, { owner: capturedCurrentMeshOwner(lease.owner), token, bodies: result.bodies });
        changedOwner();
      }
      return await prepareManagedReply(lease?.owner, result, admitReply);
      } catch (error) {
        if (token !== undefined) {
          try { cache.release(token); }
          catch (cleanup) {
            if (lease !== undefined) {
              const retained = hiddenLeases.get(lease.owner.dispatchId);
              if (retained === undefined) {
                hiddenLeases.set(lease.owner.dispatchId, { owner: capturedCurrentMeshOwner(lease.owner), token, bodies: [] });
                changedOwner();
              } else {
                const failed = cache.failedReleaseBuffers?.(token);
                if (failed !== undefined) {
                  const held = new Set(failed);
                  retained.bodies = retained.bodies.filter(body => solidMeshBuffers(body).some(buffer => buffer instanceof ArrayBuffer && held.has(buffer)));
                  changedOwner();
                }
              }
            }
            return Promise.reject(new AggregateError([error, cleanup], 'Reference mesh lease cleanup failed'));
          }
        }
        if (lease !== undefined && hiddenLeases.delete(lease.owner.dispatchId)) changedOwner();
        return Promise.reject(error instanceof Error ? error : new Error('Reference mesh read failed', { cause: error }));
      } finally {
        if (lease !== undefined) pendingHiddenDispatches.delete(lease.owner.dispatchId);
      }
    },
  };
}
