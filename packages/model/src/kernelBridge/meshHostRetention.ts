import type { MeshLedgerRelease, MeshReplySettlement } from './bridgeContracts.js';

/** Candidate only: main-realm backing reachability, never RSS/native/driver memory. */
export type HostRetentionReading =
  | { readonly status: 'unknown'; readonly reason: string; readonly retainedBackingBytes: null; readonly pendingCloneBytes: null }
  | { readonly status: 'known'; readonly epoch: number; readonly retainedBackingBytes: number; readonly revokedRetainedBackingBytes: number;
      readonly pendingCloneBytes: number; readonly limitBytes: number; readonly fits: boolean;
      readonly coverage: 'registered-main-realm-backing-only' };
export type HostReservationOutcome =
  | { readonly status: 'reserved'; readonly bytes: number }
  | { readonly status: 'cancelled' | 'stopped' | 'timeout' | 'unavailable'; readonly reason: string };
export type HostBackingMembership =
  | { readonly status: 'unknown'; readonly reason: string }
  | { readonly status: 'known'; readonly epoch: number; readonly inputBackingBytes: number;
      readonly additionalBackingBytes: number; readonly sameSourceBackings: readonly WeakRef<ArrayBuffer>[];
      readonly coverage: 'registered-main-realm-backing-only' };
interface Entry { readonly buffer: WeakRef<ArrayBuffer>; observedBytes: number; activeOwners: number }
interface Owner { readonly ids: ReadonlySet<number> }
/**
 * Capacity charged per ledger record when the record bounds follow the byte capacity (MeshHostRetention.forCapacity):
 * the same fixed per-reply metadata allowance the Worker mesh accounting uses (recomputeSolids.ts, 4,096 bytes).
 */
export const HOST_RECORD_BYTES = 4096;
/**
 * The one deadline for waiting on reply clones: a reservation waiting for capacity and an observation waiting for no
 * pending clone (CI 2026-11-12) use this same value.
 */
export const REPLY_RESERVATION_WAIT_MS = 10_000;
/**
 * Changes that only release what the ledger already held. Each one removes one record (an entry, an owner, a refused
 * reply or a reservation) and none adds one, so a run of them is finite. Every other change is growth.
 */
const RELEASE_ONLY_CHANGES: ReadonlySet<string> = new Set(['weak-backing-unreachable', 'backing-detached',
  'owner-backings-pruned', 'refused-reply-backings-released', 'reply-settled-without-clone']);

export class MeshHostRetention {
  private identities = new WeakMap<ArrayBuffer, number>();
  private entries = new Map<number, Entry>();
  private owners = new Map<string, Owner>();
  private pending = new Map<string, number>();
  private nextId = 0;
  private hostGeneration = 0;
  /** The host generation of the latest growth change (any change outside RELEASE_ONLY_CHANGES). */
  private lastGrowth = 0;
  private readonly generationChanges: { readonly epoch: number; readonly reason: string;
    readonly backingId: number | null; readonly lastObservedBackingBytes: number | null;
    readonly activeOwnersAtMutation: number | null }[] = [];
  private diagnosticDropped = 0;
  private diagnosticFailures = 0;
  /** Primitive cached metadata only: no observe, WeakRef dereference, prune or reservation. */
  diagnosticEpoch(): number { return this.hostGeneration; }
  readDiagnostics() {
    return Object.freeze({ epoch: this.hostGeneration, changes: Object.freeze(this.generationChanges.slice()),
      dropped: this.diagnosticDropped, failures: this.diagnosticFailures,
      entries: this.entries.size, owners: this.owners.size, pendingRequests: this.pending.size,
      refusedReplies: this.refusedReplies.size,
      unknownReason: this.unknown, coverage: 'host-epoch-mutations-only', acceptanceComplete: false });
  }
  private readonly changes = new Set<() => void>();
  private waiting = 0;
  private changed(reason: string, backingId: number | null = null,
    lastObservedBackingBytes: number | null = null, activeOwnersAtMutation: number | null = null): void {
    if (!Number.isSafeInteger(this.hostGeneration + 1)) this.unknown = 'epoch-overflow';
    else this.hostGeneration += 1;
    if (!RELEASE_ONLY_CHANGES.has(reason)) this.lastGrowth = this.hostGeneration;
    try {
      if (this.generationChanges.length === 128) { this.generationChanges.shift(); this.diagnosticDropped += 1; }
      this.generationChanges.push(Object.freeze({ epoch: this.hostGeneration, reason, backingId, lastObservedBackingBytes, activeOwnersAtMutation }));
    } catch { this.diagnosticFailures += 1; }
    for (const notify of this.changes) queueMicrotask(notify);
  }
  private unknown: string | null = null;
  /** Adoptions refused by the record bound: their received new backings, counted as that request's pending bytes. */
  private readonly refusedReplies = new Map<string, readonly WeakRef<ArrayBuffer>[]>();
  constructor(private readonly limitBytes: number, private readonly maximumEntries = 4096, private readonly maximumOwners = 128) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0 || !Number.isSafeInteger(maximumEntries) || maximumEntries < 1
      || !Number.isSafeInteger(maximumOwners) || maximumOwners < 1) throw new RangeError('Invalid host retention bounds');
  }
  /**
   * A ledger whose record bounds follow its byte capacity (one display owner per distinct part definition, so a
   * fixed 128 owners / 4,096 entries refused an assembly of 1,000 definitions). One owner or entry per
   * HOST_RECORD_BYTES of limitBytes: 512 MiB admits 131,072 of each. The bound stays (metadata never grows without
   * limit); reaching it refuses at reservation (owners) or that one adoption (entries) with its reason and admits
   * again once retired backings become unreachable or detached.
   */
  static forCapacity(limitBytes: number): MeshHostRetention {
    const records = Math.max(1, Math.floor(limitBytes / HOST_RECORD_BYTES));
    return new MeshHostRetention(limitBytes, records, records);
  }
  /** Invalidates issued receipts when any owned Worker dispatch can change its current union. */
  advanceEpoch(): void { this.changed('owned-worker-dispatch-or-connection'); }
  /**
   * Why an observation taken at host generation `previous` conflicts now: `host-backings-released` when every change
   * since then only released records and no reply clone is reserved, otherwise `host-epoch-changed`. A released-only
   * conflict still needs a fresh observation (receipts keep their meaning); it only tells the caller it is finite.
   */
  conflictSince(previous: number, pendingCloneBytes: number | null): 'host-backings-released' | 'host-epoch-changed' {
    return pendingCloneBytes === 0 && this.hostGeneration !== previous && this.lastGrowth <= previous
      ? 'host-backings-released' : 'host-epoch-changed';
  }
  /**
   * Whether the host changed since `previous` by releases only (false for null, no change, growth, a reserved clone or
   * an unknown ledger), with the releasable record count that every released-only change strictly lowers.
   */
  releaseSince(previous: number | null): MeshLedgerRelease {
    const reading = this.observe();
    const releasedOnly = previous !== null && reading.status === 'known'
      && this.conflictSince(previous, reading.pendingCloneBytes) === 'host-backings-released';
    return { releasedOnly, records: this.entries.size + this.owners.size + this.pending.size + this.refusedReplies.size };
  }
  /** Call before sending a request. A cancelled request keeps reservation until settled/adopted. */
  reserveReply(requestId: string, bytes: number): boolean {
    const reading = this.observe();
    // Each pending request may become one owner, so the owner bound is kept here, where refusal is recoverable.
    if (reading.status !== 'known' || requestId.length === 0 || this.pending.has(requestId)
      || this.pending.size + this.owners.size >= this.maximumOwners || !Number.isSafeInteger(bytes) || bytes < 0
      || reading.retainedBackingBytes + reading.pendingCloneBytes + bytes > this.limitBytes) return false;
    this.changed('reply-reserved');
    this.pending.set(requestId, bytes);
    return true;
  }
  replyReservation(requestId: string): number | null { return this.pending.get(requestId) ?? null; }
  /** Compatibility helper; detailed callers must distinguish ordinary budget refusal from transport failure. */
  async waitAndReserveReply(requestId: string, requested: number,
    shouldCancel: () => boolean | Promise<boolean>, alive: () => boolean,
    maximumWaitMs = REPLY_RESERVATION_WAIT_MS): Promise<number | null> {
    const outcome = await this.reserveReplyWhenReady(requestId, requested, shouldCancel, alive, maximumWaitMs);
    return outcome.status === 'reserved' ? outcome.bytes : null;
  }
  /** The deadline includes asynchronous cancellation checks, and stop/current is rechecked after every await. */
  async reserveReplyWhenReady(requestId: string, requested: number,
    shouldCancel: () => boolean | Promise<boolean>, alive: () => boolean,
    maximumWaitMs = REPLY_RESERVATION_WAIT_MS): Promise<HostReservationOutcome> {
    const unavailable = (reason: string): HostReservationOutcome => ({ status: 'unavailable', reason });
    if (!Number.isSafeInteger(requested) || requested <= 0 || requested > this.limitBytes
      || !Number.isSafeInteger(maximumWaitMs) || maximumWaitMs <= 0 || this.waiting >= this.maximumOwners)
      return unavailable('invalid-or-capacity-limited-request');
    this.waiting += 1;
    const deadline = performance.now() + maximumWaitMs;
    try {
      while (true) {
        if (!alive()) return { status: 'stopped', reason: 'owner-no-longer-current' };
        const remainingBeforeCheck = deadline - performance.now();
        if (remainingBeforeCheck <= 0) return { status: 'timeout', reason: 'reservation-deadline' };
        let check: boolean | Promise<boolean>;
        try { check = shouldCancel(); } catch { return unavailable('cancel-check-failed'); }
        let cancelled: boolean;
        if (typeof check === 'boolean') cancelled = check;
        else {
          const checked = await new Promise<boolean | 'timeout' | 'stopped' | 'failed'>(resolve => {
            let done = false;
            let poll: ReturnType<typeof setTimeout> | undefined;
            const finish = (value: boolean | 'timeout' | 'stopped' | 'failed'): void => {
              if (done) return; done = true;
              if (poll !== undefined) clearTimeout(poll);
              if (expiry !== undefined) clearTimeout(expiry);
              resolve(value);
            };
            const watch = (): void => {
              if (!alive()) finish('stopped');
              else if (!done) poll = setTimeout(watch, Math.min(25, Math.max(1, deadline - performance.now())));
            };
            // An externally held never-resolving cancellation promise retains only a weak
            // settlement hook after this deadline, never this bridge/owner/timer closure.
            const settlement = new WeakRef(finish);
            Promise.resolve(check).then(value => settlement.deref()?.(value), () => settlement.deref()?.('failed'));
            const expiry = setTimeout(() => finish('timeout'), Math.max(1, deadline - performance.now()));
            poll = setTimeout(watch, Math.min(25, remainingBeforeCheck));
          });
          if (checked === 'timeout') return { status: 'timeout', reason: 'cancel-check-deadline' };
          if (checked === 'stopped') return { status: 'stopped', reason: 'owner-no-longer-current' };
          if (checked === 'failed') return unavailable('cancel-check-failed');
          cancelled = checked;
        }
        if (!alive()) return { status: 'stopped', reason: 'owner-changed-after-cancel-check' };
        if (performance.now() >= deadline) return { status: 'timeout', reason: 'reservation-deadline' };
        if (cancelled) return { status: 'cancelled', reason: 'cancelled-before-dispatch' };
        const reading = this.observe();
        if (reading.status !== 'known') return unavailable(reading.reason);
        const granted = Math.min(requested, this.limitBytes - reading.retainedBackingBytes - reading.pendingCloneBytes);
        // No await exists between this last current/deadline check and the actual reservation.
        if (granted > 0 && this.reserveReply(requestId, granted)) return { status: 'reserved', bytes: granted };
        const remaining = deadline - performance.now();
        if (remaining <= 0) return { status: 'timeout', reason: 'reservation-deadline' };
        await this.nextChange(remaining);
      }
    } finally { this.waiting -= 1; }
  }
  /**
   * Waits until no reply clone is reserved: the precondition of a fresh current-ledger capture (CI 2026-11-12: a new
   * empty assembly observed while the startup Part reply was still reserved). It only observes; another request's
   * reservation clears through its own adoption or settleWithoutReply, never here. Same deadline as reservations.
   */
  async waitForNoPendingClone(alive: () => boolean,
    maximumWaitMs = REPLY_RESERVATION_WAIT_MS): Promise<MeshReplySettlement> {
    const deadline = performance.now() + maximumWaitMs;
    while (true) {
      if (!alive()) return 'stopped';
      const reading = this.observe();
      if (reading.status !== 'known') return 'unavailable';
      if (reading.pendingCloneBytes === 0) return 'settled';
      const remaining = deadline - performance.now();
      if (remaining <= 0) return 'timeout';
      await this.nextChange(remaining);
    }
  }
  /** Resolves on the next ledger change, or after the existing short poll so liveness and the deadline are rechecked. */
  private nextChange(remaining: number): Promise<void> {
    return new Promise<void>(resolve => {
      const notify = (): void => { clearTimeout(timer); this.changes.delete(notify); resolve(); };
      const timer = setTimeout(notify, Math.min(remaining, 25));
      this.changes.add(notify);
    });
  }
  /** Register every actual received backing before clearing its request's clone reservation. */
  adoptReply(requestId: string, ownerId: string, buffers: readonly ArrayBuffer[]): HostRetentionReading {
    if (this.unknown !== null) return this.observe();
    if (!this.pending.has(requestId) || this.refusedReplies.has(requestId) || ownerId.length === 0 || this.owners.has(ownerId)
      || this.owners.size >= this.maximumOwners || buffers.some(buffer => !(buffer instanceof ArrayBuffer)
        || 'resizable' in buffer && buffer.resizable === true)) {
      this.unknown = 'invalid-or-unreserved-adoption'; return this.observe();
    }
    const unique = new Set(buffers);
    this.observe();
    const newBuffers = [...unique].filter(buffer => { const id = this.identities.get(buffer); return id === undefined || !this.entries.has(id); });
    const newlyReceivedBytes = newBuffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
    const reserved = this.pending.get(requestId);
    if (reserved === undefined || !Number.isSafeInteger(newlyReceivedBytes) || newlyReceivedBytes > reserved) {
      this.unknown = 'reply-exceeds-clone-reservation'; return this.observe();
    }
    if (this.nextId + newBuffers.length > Number.MAX_SAFE_INTEGER) {
      this.unknown = 'metadata-capacity'; return this.observe();
    }
    if (this.entries.size + newBuffers.length > this.maximumEntries) {
      // Record bound: refuse only this adoption and keep coverage. Its received new backings stay counted as this
      // request's pending bytes until they become unreachable or detached (observe), then the capacity returns.
      this.pending.set(requestId, newlyReceivedBytes);
      this.refusedReplies.set(requestId, Object.freeze(newBuffers.map(buffer => new WeakRef(buffer))));
      this.changed('reply-refused-record-capacity');
      return { status: 'unknown', reason: 'metadata-capacity', retainedBackingBytes: null, pendingCloneBytes: null };
    }
    const ids = new Set<number>();
    for (const buffer of unique) {
      let id = this.identities.get(buffer);
      if (id === undefined || !this.entries.has(id)) {
        id = ++this.nextId; this.identities.set(buffer, id); this.entries.set(id, { buffer: new WeakRef(buffer), observedBytes: buffer.byteLength, activeOwners: 0 });
      }
      ids.add(id);
      const entry = this.entries.get(id);
      if (entry !== undefined) entry.activeOwners += 1;
    }
    this.changed('reply-adopted');
    this.owners.set(ownerId, { ids });
    this.pending.delete(requestId);
    return this.observe();
  }
  /** Logical cancellation is not physical backing release; the weak entry stays until actually unreachable/detached. */
  revokeOwner(ownerId: string): void {
    const owner = this.owners.get(ownerId);
    if (owner === undefined) return;
    // Metadata retirement never establishes physical collection of a backing.
    for (const id of owner.ids) {
      const entry = this.entries.get(id);
      if (entry !== undefined) entry.activeOwners -= 1;
    }
    this.owners.delete(ownerId);
    this.changed('owner-logically-retired');
  }
  /** No reply was cloned/received; only the corresponding settled request may clear its reservation. */
  settleWithoutReply(requestId: string): void {
    // A refused reply was received: only the observed release of its backings clears that reservation.
    if (!this.refusedReplies.has(requestId) && this.pending.delete(requestId)) this.changed('reply-settled-without-clone');
  }
  markCoverageUnknown(reason: string): void { this.unknown = reason || 'unobserved-host-owner'; }
  /** A genuine empty allocation is attached; byteLength===0 alone is insufficient. */
  private isDetached(buffer: ArrayBuffer): boolean {
    try { new Uint8Array(buffer, 0, 0); return false; }
    catch { return true; }
  }
  /** Identity evidence for this registered main ledger only; never global/provider evidence alone. */
  inspectBackings(expectedGeneration: number, buffers: readonly ArrayBufferLike[]): HostBackingMembership {
    const reading = this.observe();
    const unknown = (reason: string): HostBackingMembership => ({ status: 'unknown', reason });
    if (reading.status !== 'known') return unknown(reading.reason);
    if (reading.epoch !== expectedGeneration || reading.pendingCloneBytes !== 0) return unknown('host-epoch-changed');
    if (buffers.length > this.maximumEntries) return unknown('unsupported-input-backing');
    const validated: ArrayBuffer[] = [];
    for (const buffer of buffers) {
      if (!(buffer instanceof ArrayBuffer) || this.isDetached(buffer)
        || 'resizable' in buffer && buffer.resizable === true) return unknown('unsupported-input-backing');
      validated.push(buffer);
    }
    const intersection: WeakRef<ArrayBuffer>[] = [];
    let inputBackingBytes = 0, additionalBackingBytes = 0;
    for (const buffer of new Set(validated)) {
      inputBackingBytes += buffer.byteLength;
      const id = this.identities.get(buffer), entry = id === undefined ? undefined : this.entries.get(id);
      if (entry !== undefined && entry.buffer.deref() === buffer) intersection.push(new WeakRef(buffer));
      else additionalBackingBytes += buffer.byteLength;
    }
    if (![inputBackingBytes, additionalBackingBytes].every(Number.isSafeInteger)) return unknown('overflow');
    const after = this.observe();
    if (after.status !== 'known' || after.epoch !== expectedGeneration || after.pendingCloneBytes !== 0) return unknown('host-epoch-changed');
    return { status: 'known', epoch: expectedGeneration, inputBackingBytes, additionalBackingBytes,
      sameSourceBackings: Object.freeze(intersection), coverage: 'registered-main-realm-backing-only' };
  }
  observe(): HostRetentionReading {
    if (this.unknown !== null) return { status: 'unknown', reason: this.unknown, retainedBackingBytes: null, pendingCloneBytes: null };
    let retained = 0, revoked = 0;
    for (const [id, entry] of this.entries) {
      const buffer = entry.buffer.deref();
      if (buffer === undefined || this.isDetached(buffer)) {
        this.changed(buffer === undefined ? 'weak-backing-unreachable' : 'backing-detached', id, entry.observedBytes, entry.activeOwners); this.entries.delete(id); continue;
      }
      if (entry.observedBytes !== buffer.byteLength) { this.changed('backing-size-changed', id, entry.observedBytes, entry.activeOwners); entry.observedBytes = buffer.byteLength; }
      retained += buffer.byteLength;
      if (entry.activeOwners === 0) revoked += buffer.byteLength;
    }
    for (const [id, owner] of this.owners) {
      if ([...owner.ids].every(bufferId => !this.entries.has(bufferId))) { this.owners.delete(id); this.changed('owner-backings-pruned'); }
    }
    for (const [requestId, backings] of this.refusedReplies) {
      if (backings.every(backing => { const buffer = backing.deref(); return buffer === undefined || this.isDetached(buffer); })) {
        this.refusedReplies.delete(requestId); this.pending.delete(requestId); this.changed('refused-reply-backings-released');
      }
    }
    const pending = [...this.pending.values()].reduce((sum, bytes) => sum + bytes, 0);
    if (![retained, revoked, pending, retained + pending].every(Number.isSafeInteger)) {
      this.unknown = 'overflow'; return this.observe();
    }
    if (this.unknown !== null) return this.observe();
    return { status: 'known', epoch: this.hostGeneration, retainedBackingBytes: retained, revokedRetainedBackingBytes: revoked,
      pendingCloneBytes: pending, limitBytes: this.limitBytes, fits: retained + pending <= this.limitBytes,
      coverage: 'registered-main-realm-backing-only' };
  }
}
