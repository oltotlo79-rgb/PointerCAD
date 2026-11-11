import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOST_RECORD_BYTES, MeshHostRetention } from './meshHostRetention.js';

describe('host backing ownership candidate', () => {
  it('a cancelled old session still holding its body keeps whole backing counted and blocks overlapping reply', () => {
    const ledger = new MeshHostRetention(32), positions = new Float32Array(8);
    const oldSession = { slot: { bodies: [{ mesh: { positions } }] }, cancelled: false };
    expect(ledger.reserveReply('old-request', 32)).toBe(true);
    expect(ledger.adoptReply('old-request', 'old-generation-session', [positions.buffer])).toMatchObject({ status: 'known', retainedBackingBytes: 32 });
    oldSession.cancelled = true; ledger.revokeOwner('old-generation-session');
    expect(oldSession.slot.bodies[0].mesh.positions.buffer.byteLength).toBe(32);
    expect(ledger.observe()).toMatchObject({ status: 'known', retainedBackingBytes: 32, revokedRetainedBackingBytes: 32 });
    expect(ledger.reserveReply('new-request', 1)).toBe(false);
  });
  it('whole backing identity is counted once across owners and slices', () => {
    const ledger = new MeshHostRetention(128), buffer = new ArrayBuffer(64), slice = new Float32Array(buffer, 16, 2);
    expect(ledger.reserveReply('a', 64)).toBe(true);
    ledger.adoptReply('a', 'a-owner', [buffer, slice.buffer]);
    expect(ledger.reserveReply('b', 0)).toBe(true);
    ledger.adoptReply('b', 'b-owner', [buffer]);
    ledger.revokeOwner('a-owner');
    expect(ledger.observe()).toMatchObject({ retainedBackingBytes: 64, revokedRetainedBackingBytes: 0 });
    ledger.revokeOwner('b-owner');
    expect(ledger.observe()).toMatchObject({ retainedBackingBytes: 64, revokedRetainedBackingBytes: 64 });
  });
  it('late reply is adopted and still counted even if its owner is immediately revoked', () => {
    const ledger = new MeshHostRetention(64), late = new ArrayBuffer(16);
    ledger.reserveReply('late-request', 16);
    expect(ledger.observe()).toMatchObject({ pendingCloneBytes: 16, retainedBackingBytes: 0 });
    ledger.adoptReply('late-request', 'late-owner', [late]); ledger.revokeOwner('late-owner');
    expect(ledger.observe()).toMatchObject({ retainedBackingBytes: 16, pendingCloneBytes: 0, revokedRetainedBackingBytes: 16 });
    expect(late.byteLength).toBe(16);
  });
  it('cancelling one reservation cannot erase another request reservation', () => {
    const ledger = new MeshHostRetention(64);
    ledger.reserveReply('first', 16); ledger.reserveReply('second', 24);
    ledger.settleWithoutReply('first');
    expect(ledger.observe()).toMatchObject({ pendingCloneBytes: 24 });
  });
  it('unexpected unreserved reply or capacity overflow makes unknown rather than zero', () => {
    const missing = new MeshHostRetention(64);
    expect(missing.adoptReply('missing', 'owner', [new ArrayBuffer(8)])).toMatchObject({ status: 'unknown', retainedBackingBytes: null });
    const bounded = new MeshHostRetention(64, 1);
    bounded.reserveReply('request', 16);
    expect(bounded.adoptReply('request', 'owner', [new ArrayBuffer(8), new ArrayBuffer(8)])).toMatchObject({ status: 'unknown', retainedBackingBytes: null });
    const insufficient = new MeshHostRetention(64);
    insufficient.reserveReply('small', 1);
    expect(insufficient.adoptReply('small', 'too-large', [new ArrayBuffer(8)])).toMatchObject({ status: 'unknown', reason: 'reply-exceeds-clone-reservation' });
  });
  it('detached source backing is not zero for a newly transferred recipient that is separately registered', () => {
    const ledger = new MeshHostRetention(64), source = new ArrayBuffer(16);
    ledger.reserveReply('source', 16); ledger.adoptReply('source', 'old', [source]); ledger.revokeOwner('old');
    const recipient = structuredClone(source, { transfer: [source] });
    expect(source.byteLength).toBe(0);
    ledger.reserveReply('recipient', 16); ledger.adoptReply('recipient', 'recipient-owner', [recipient]);
    expect(ledger.observe()).toMatchObject({ retainedBackingBytes: 16 });
    expect(recipient.byteLength).toBe(16);
  });
  it('retires more than 128 logical generations while every old session backing remains live', () => {
    const ledger = new MeshHostRetention(1024, 512, 2);
    const sessions: { mesh: Uint8Array }[] = [];
    for (let generation = 0; generation < 256; generation += 1) {
      const session = { mesh: new Uint8Array(1) };
      sessions.push(session);
      expect(ledger.reserveReply(`request-${generation}`, 1)).toBe(true);
      ledger.adoptReply(`request-${generation}`, `owner-${generation}`, [session.mesh.buffer]);
      ledger.revokeOwner(`owner-${generation}`);
    }
    expect(sessions.every(session => session.mesh.buffer.byteLength === 1)).toBe(true);
    expect(ledger.observe()).toMatchObject({ status: 'known', retainedBackingBytes: 256, revokedRetainedBackingBytes: 256 });
  });
  it('reclaims detached entry metadata without confusing an attached empty backing with detachment', () => {
    const ledger = new MeshHostRetention(16, 1, 1);
    const recipients: ArrayBuffer[] = [];
    for (let generation = 0; generation < 256; generation += 1) {
      const source = new ArrayBuffer(1);
      expect(ledger.reserveReply(`source-${generation}`, 1)).toBe(true);
      ledger.adoptReply(`source-${generation}`, `owner-${generation}`, [source]);
      ledger.revokeOwner(`owner-${generation}`);
      recipients.push(structuredClone(source, { transfer: [source] }));
      expect(ledger.observe()).toMatchObject({ status: 'known', retainedBackingBytes: 0 });
    }
    // This ledger covers the sending realm only; recipients remain live and are not a whole-app zero.
    expect(recipients.reduce((sum, buffer) => sum + buffer.byteLength, 0)).toBe(256);
    const attachedEmpty = new ArrayBuffer(0);
    ledger.reserveReply('empty', 0); ledger.adoptReply('empty', 'empty-owner', [attachedEmpty]);
    ledger.revokeOwner('empty-owner');
    expect(ledger.reserveReply('second', 1)).toBe(true);
    expect(ledger.adoptReply('second', 'second-owner', [new ArrayBuffer(1)])).toMatchObject({ status: 'unknown', reason: 'metadata-capacity' });
  });
  it('a full-budget main reservation lets preview wait until actual adoption frees unused reservation', async () => {
    const ledger = new MeshHostRetention(512);
    expect(ledger.reserveReply('main', 512)).toBe(true);
    let settled = false;
    const preview = ledger.waitAndReserveReply('preview', 512, () => false, () => true)
      .then(granted => { settled = true; return granted; });
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    const mainBacking = new ArrayBuffer(16);
    ledger.adoptReply('main', 'main-owner', [mainBacking]);
    expect(await preview).toBe(496);
    expect(ledger.observe()).toMatchObject({ retainedBackingBytes: 16, pendingCloneBytes: 496 });
  });
  it('queued cancellation and stop leave the unrelated actual pending reservation intact', async () => {
    const ledger = new MeshHostRetention(512);
    ledger.reserveReply('main', 512);
    let cancelled = false, alive = true;
    const cancelledReply = ledger.waitAndReserveReply('preview', 512, () => cancelled, () => true);
    const stoppedReply = ledger.waitAndReserveReply('other', 512, () => false, () => alive);
    await Promise.resolve(); await Promise.resolve();
    cancelled = true; alive = false; ledger.advanceEpoch();
    expect(await cancelledReply).toBeNull(); expect(await stoppedReply).toBeNull();
    expect(ledger.observe()).toMatchObject({ pendingCloneBytes: 512 });
    ledger.settleWithoutReply('main');
    expect(await ledger.waitAndReserveReply('recovered', 512, () => false, () => true)).toBe(512);
  });

});

describe('reservation deadline includes asynchronous cancellation', () => {
  afterEach(() => vi.useRealTimers());
  it('a never resolving cancel check stops at the default ten second deadline and releases its waiter only', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const ledger = new MeshHostRetention(512);
    expect(ledger.reserveReply('another-actual-request', 512)).toBe(true);
    const pending = ledger.reserveReplyWhenReady('waiting', 512, () => new Promise<boolean>(() => {}), () => true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ status: 'timeout', reason: 'cancel-check-deadline' });
    expect(ledger.replyReservation('waiting')).toBeNull();
    expect(ledger.replyReservation('another-actual-request')).toBe(512);
    ledger.settleWithoutReply('another-actual-request');
    expect(await ledger.reserveReplyWhenReady('normal-after-deadline', 512, () => false, () => true))
      .toEqual({ status: 'reserved', bytes: 512 });
  });
  it('stop wins even while asynchronous cancel never settles and does not allocate a stale owner', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const ledger = new MeshHostRetention(512); let current = true;
    const pending = ledger.reserveReplyWhenReady('stale', 512, () => new Promise<boolean>(() => {}), () => current);
    current = false; await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toMatchObject({ status: 'stopped' });
    expect(ledger.replyReservation('stale')).toBeNull();
  });
  it('current is checked again when an asynchronous false cancel check resumes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const ledger = new MeshHostRetention(512); let current = true;
    let finish: (value: boolean) => void = () => { throw new Error('check not started'); };
    const check = new Promise<boolean>(resolve => { finish = resolve; });
    const pending = ledger.reserveReplyWhenReady('old-owner', 512, () => check, () => current);
    current = false; finish(false);
    expect(await pending).toMatchObject({ status: 'stopped', reason: 'owner-changed-after-cancel-check' });
    expect(ledger.replyReservation('old-owner')).toBeNull();
  });
  it('budget exhaustion is timeout, cancellation is cancelled, and neither changes another reservation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const ledger = new MeshHostRetention(512); ledger.reserveReply('main', 512);
    const waiting = ledger.reserveReplyWhenReady('preview', 512, () => false, () => true, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await waiting).toMatchObject({ status: 'timeout' });
    expect(await ledger.reserveReplyWhenReady('cancel', 512, () => Promise.resolve(true), () => true)).toMatchObject({ status: 'cancelled' });
    expect(ledger.replyReservation('main')).toBe(512); expect(ledger.replyReservation('preview')).toBeNull();
  });
  it('readonly identity intersection deduplicates input aliases and retains logically retired borrowers', () => {
    const ledger = new MeshHostRetention(1024), source = new ArrayBuffer(32), distinct = new ArrayBuffer(24);
    expect(ledger.reserveReply('raw', 32)).toBe(true); ledger.adoptReply('raw', 'source', [source]);
    ledger.revokeOwner('source');
    const reading = ledger.observe(); if (reading.status !== 'known') throw new Error('Actual host reading');
    const membership = ledger.inspectBackings(reading.epoch, [source, distinct, source, distinct]);
    if (membership.status !== 'known') throw new Error('Actual identity reading');
    expect(membership.inputBackingBytes).toBe(56); expect(membership.additionalBackingBytes).toBe(24);
    expect(membership.sameSourceBackings).toHaveLength(1); expect(membership.sameSourceBackings[0]?.deref()).toBe(source);
    expect(ledger.observe()).toEqual(reading); // Readonly inspection does not adopt/own new UI buffers.
    expect(source.byteLength).toBe(32);
    expect(ledger.reserveReply('returned-ui', 24)).toBe(true);
    ledger.adoptReply('returned-ui', 'future-source', [distinct]);
    expect(ledger.inspectBackings(reading.epoch, [distinct]).status).toBe('unknown');
    const next = ledger.observe(); if (next.status !== 'known') throw new Error('Fresh actual host reading');
    const reentered = ledger.inspectBackings(next.epoch, [distinct]);
    if (reentered.status !== 'known') throw new Error('Fresh registered UI-to-Source identity');
    expect(reentered.additionalBackingBytes).toBe(0); expect(reentered.sameSourceBackings[0]?.deref()).toBe(distinct);
    expect(next.retainedBackingBytes).toBe(56);
  });
  it('detached, shared, unknown and stale backing observations cannot supply identity evidence', () => {
    const ledger = new MeshHostRetention(1024), buffer = new ArrayBuffer(32);
    ledger.reserveReply('raw', 32); ledger.adoptReply('raw', 'source', [buffer]);
    const reading = ledger.observe(); if (reading.status !== 'known') throw new Error('Actual host reading');
    structuredClone(buffer, { transfer: [buffer] });
    expect(ledger.inspectBackings(reading.epoch, [buffer]).status).toBe('unknown');
    const after = ledger.observe(); if (after.status !== 'known') throw new Error('Actual detached observation');
    expect(ledger.inspectBackings(after.epoch, [new SharedArrayBuffer(8)]).status).toBe('unknown');
    ledger.markCoverageUnknown('unobserved-source-provider');
    expect(ledger.inspectBackings(after.epoch, [new ArrayBuffer(8)]).status).toBe('unknown');
  });

});

describe('EX12 capacity-managed owners: 1,000 distinct part definitions', () => {
  // One display owner per distinct part definition, four backings per body (positions, normals, indices, edges).
  const OWNERS = 1_000, PER_OWNER = 4;
  afterEach(() => vi.useRealTimers());
  /** The bridge's order: reserve the whole remaining budget, adopt the actual reply (which frees the unused part). */
  async function adoptOwners(ledger: MeshHostRetention, count: number, limitBytes: number, backingBytes: number): Promise<ArrayBuffer[][]> {
    const held: ArrayBuffer[][] = [];
    for (let index = 0; index < count; index += 1) {
      const reading = ledger.observe(); if (reading.status !== 'known') throw new Error('Actual host reading');
      expect(await ledger.reserveReplyWhenReady(`part-request-${String(index)}`, limitBytes, () => false, () => true))
        .toEqual({ status: 'reserved', bytes: limitBytes - reading.retainedBackingBytes });
      const buffers = Array.from({ length: PER_OWNER }, () => new ArrayBuffer(backingBytes));
      expect(ledger.adoptReply(`part-request-${String(index)}`, `part-owner-${String(index)}`, buffers))
        .toMatchObject({ status: 'known', retainedBackingBytes: reading.retainedBackingBytes + PER_OWNER * backingBytes, pendingCloneBytes: 0 });
      held.push(buffers);
    }
    return held;
  }
  const detach = (buffers: readonly ArrayBuffer[]): void => { for (const buffer of buffers) structuredClone(buffer, { transfer: [buffer] }); };
  // A capacity whose record bound (one per HOST_RECORD_BYTES) is exactly 1,000 owners x 4 entries, filled by 4 KiB backings.
  const FULL_BYTES = OWNERS * PER_OWNER * HOST_RECORD_BYTES;

  it('the product capacity (512 MiB, 131,072 records) registers 1,000 owners of four backings each and stays known', async () => {
    const limitBytes = 512 * 1024 * 1024, ledger = MeshHostRetention.forCapacity(limitBytes);
    const held = await adoptOwners(ledger, OWNERS, limitBytes, 16);
    expect(ledger.observe()).toMatchObject({ status: 'known', retainedBackingBytes: OWNERS * PER_OWNER * 16,
      revokedRetainedBackingBytes: 0, pendingCloneBytes: 0, limitBytes, fits: true });
    expect(ledger.readDiagnostics()).toMatchObject({ owners: OWNERS, entries: OWNERS * PER_OWNER, pendingRequests: 0, unknownReason: null });
    // A newer generation of every part supersedes its owner, as the bridge's bind does; still 1,000 current owners.
    for (let index = 0; index < OWNERS; index += 1) {
      expect(ledger.reserveReply(`next-request-${String(index)}`, PER_OWNER * 16)).toBe(true);
      expect(ledger.adoptReply(`next-request-${String(index)}`, `next-owner-${String(index)}`,
        Array.from({ length: PER_OWNER }, () => new ArrayBuffer(16)))).toMatchObject({ status: 'known' });
      ledger.revokeOwner(`part-owner-${String(index)}`);
    }
    expect(ledger.readDiagnostics()).toMatchObject({ owners: OWNERS, unknownReason: null });
    expect(held.every(buffers => buffers.every(buffer => buffer.byteLength === 16))).toBe(true);
  });
  it('releases 1,000 owners: retired backings stay counted until detached, then entries and owners are pruned', async () => {
    const ledger = MeshHostRetention.forCapacity(FULL_BYTES);
    const held = await adoptOwners(ledger, OWNERS, FULL_BYTES, HOST_RECORD_BYTES);
    for (let index = 0; index < OWNERS; index += 1) ledger.revokeOwner(`part-owner-${String(index)}`);
    expect(ledger.observe()).toMatchObject({ status: 'known', retainedBackingBytes: FULL_BYTES, revokedRetainedBackingBytes: FULL_BYTES });
    expect(ledger.readDiagnostics()).toMatchObject({ owners: 0, entries: OWNERS * PER_OWNER });
    for (const buffers of held) detach(buffers);
    expect(ledger.observe()).toMatchObject({ status: 'known', retainedBackingBytes: 0, revokedRetainedBackingBytes: 0, pendingCloneBytes: 0 });
    expect(ledger.readDiagnostics()).toMatchObject({ owners: 0, entries: 0, unknownReason: null });
    expect(await ledger.reserveReplyWhenReady('after-release', FULL_BYTES, () => false, () => true))
      .toEqual({ status: 'reserved', bytes: FULL_BYTES });
  });
  it('refuses a reservation beyond the byte capacity with its reason while the reading stays known', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const ledger = MeshHostRetention.forCapacity(FULL_BYTES);
    const held = await adoptOwners(ledger, OWNERS, FULL_BYTES, HOST_RECORD_BYTES);
    expect(ledger.observe()).toMatchObject({ status: 'known', retainedBackingBytes: FULL_BYTES, fits: true });
    expect(ledger.reserveReply('over-capacity', 1)).toBe(false);
    const waiting = ledger.reserveReplyWhenReady('waiting', HOST_RECORD_BYTES, () => false, () => true, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await waiting).toEqual({ status: 'timeout', reason: 'reservation-deadline' });
    expect(ledger.replyReservation('waiting')).toBeNull();
    expect(ledger.observe()).toMatchObject({ status: 'known', retainedBackingBytes: FULL_BYTES, pendingCloneBytes: 0 });
    expect(ledger.readDiagnostics()).toMatchObject({ owners: OWNERS, unknownReason: null });
    expect(held).toHaveLength(OWNERS);
  });
  it('recovers below the capacity: a retired and detached owner frees its bytes and the 1,001st owner is admitted', async () => {
    const ledger = MeshHostRetention.forCapacity(FULL_BYTES);
    const held = await adoptOwners(ledger, OWNERS, FULL_BYTES, HOST_RECORD_BYTES);
    const ownerBytes = PER_OWNER * HOST_RECORD_BYTES;
    expect(ledger.reserveReply('next', ownerBytes)).toBe(false);
    ledger.revokeOwner('part-owner-0'); // Logical retirement alone: the backing is still reachable and counted.
    expect(ledger.reserveReply('next', ownerBytes)).toBe(false);
    detach(held[0] ?? []);
    expect(ledger.reserveReply('next', ownerBytes)).toBe(true);
    expect(ledger.adoptReply('next', 'part-owner-1000', Array.from({ length: PER_OWNER }, () => new ArrayBuffer(HOST_RECORD_BYTES))))
      .toMatchObject({ status: 'known', retainedBackingBytes: FULL_BYTES, pendingCloneBytes: 0, fits: true });
    expect(ledger.readDiagnostics()).toMatchObject({ owners: OWNERS, entries: OWNERS * PER_OWNER, unknownReason: null });
  });
  it('more than 128 waiters wait on the byte capacity and are all admitted when it frees', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const ledger = MeshHostRetention.forCapacity(FULL_BYTES), waiters = 200;
    const held = await adoptOwners(ledger, OWNERS, FULL_BYTES, HOST_RECORD_BYTES);
    const outcomes = Array.from({ length: waiters }, (_, index) =>
      ledger.reserveReplyWhenReady(`waiter-${String(index)}`, HOST_RECORD_BYTES, () => false, () => true));
    await vi.advanceTimersByTimeAsync(25);
    expect(ledger.readDiagnostics().pendingRequests).toBe(0);
    // 50 owners x 4 backings = 200 waiters x one backing each.
    for (let index = 0; index < 50; index += 1) { ledger.revokeOwner(`part-owner-${String(index)}`); detach(held[index] ?? []); }
    await vi.advanceTimersByTimeAsync(50);
    expect(await Promise.all(outcomes)).toEqual(Array.from({ length: waiters }, () => ({ status: 'reserved', bytes: HOST_RECORD_BYTES })));
    expect(ledger.observe()).toMatchObject({ status: 'known', retainedBackingBytes: FULL_BYTES - 50 * PER_OWNER * HOST_RECORD_BYTES,
      pendingCloneBytes: waiters * HOST_RECORD_BYTES, fits: true });
    expect(ledger.readDiagnostics()).toMatchObject({ pendingRequests: waiters, unknownReason: null });
  });
  it('the record bound refuses with its reason without making the ledger unknown, and admits again below it', () => {
    const ledger = MeshHostRetention.forCapacity(4 * HOST_RECORD_BYTES); // Four owners and four entries.
    const owners: ArrayBuffer[][] = [];
    for (let index = 0; index < 4; index += 1) {
      expect(ledger.reserveReply(`owner-request-${String(index)}`, 1)).toBe(true);
      const buffers = [new ArrayBuffer(1)];
      expect(ledger.adoptReply(`owner-request-${String(index)}`, `owner-${String(index)}`, buffers)).toMatchObject({ status: 'known' });
      owners.push(buffers);
    }
    // Owner bound: refused at reservation (recoverable), never by poisoning a later adoption.
    expect(ledger.reserveReply('fifth-owner', 5)).toBe(false);
    ledger.revokeOwner('owner-0'); detach(owners[0] ?? []);
    expect(ledger.reserveReply('fifth-owner', 5)).toBe(true);
    // Entry bound: three live entries + two new backings > 4 refuses only this adoption, with its reason.
    const refused = [new ArrayBuffer(2), new ArrayBuffer(3)];
    expect(ledger.adoptReply('fifth-owner', 'fifth', refused)).toEqual({ status: 'unknown', reason: 'metadata-capacity',
      retainedBackingBytes: null, pendingCloneBytes: null });
    // The received backings stay counted (as that request's pending bytes) and the reading stays known.
    expect(ledger.observe()).toMatchObject({ status: 'known', retainedBackingBytes: 3, pendingCloneBytes: 5 });
    expect(ledger.readDiagnostics()).toMatchObject({ refusedReplies: 1, unknownReason: null });
    ledger.settleWithoutReply('fifth-owner'); // A received reply cannot be settled as unsent.
    expect(ledger.observe()).toMatchObject({ status: 'known', pendingCloneBytes: 5 });
    detach(refused);
    expect(ledger.observe()).toMatchObject({ status: 'known', retainedBackingBytes: 3, pendingCloneBytes: 0 });
    expect(ledger.readDiagnostics()).toMatchObject({ refusedReplies: 0, pendingRequests: 0, owners: 3, unknownReason: null });
    expect(ledger.reserveReply('sixth-owner', 1)).toBe(true);
    expect(ledger.adoptReply('sixth-owner', 'sixth', [new ArrayBuffer(1)])).toMatchObject({ status: 'known', retainedBackingBytes: 4 });
    expect(owners.slice(1).every(buffers => buffers[0]?.byteLength === 1)).toBe(true);
  });
});

describe('non-mutating host epoch diagnostics', () => {
  it('does not discover detachment until the original observation, and preserves a strong borrower', () => {
    const ledger = new MeshHostRetention(64), borrowed = new ArrayBuffer(16), detached = new ArrayBuffer(8);
    ledger.reserveReply('borrowed', 16); ledger.adoptReply('borrowed', 'borrowed-owner', [borrowed]);
    ledger.reserveReply('detached', 8); ledger.adoptReply('detached', 'detached-owner', [detached]);
    ledger.revokeOwner('borrowed-owner');
    const before = ledger.readDiagnostics();
    structuredClone(detached, { transfer: [detached] });
    expect(ledger.readDiagnostics()).toEqual(before); // No WeakRef dereference or detach/prune by diagnostics.
    expect(ledger.diagnosticEpoch()).toBe(before.epoch);
    expect(ledger.observe()).toMatchObject({ retainedBackingBytes: 16, revokedRetainedBackingBytes: 16 });
    const after = ledger.readDiagnostics();
    expect(after.changes.slice(-2).map(change => change.reason)).toEqual(['backing-detached', 'owner-backings-pruned']);
    expect(after.changes.at(-2)).toMatchObject({ reason: 'backing-detached', lastObservedBackingBytes: 8,
      activeOwnersAtMutation: 1 }); // Registered active owner existed; no actual reachable backing is inferred after transfer.
    expect(after.changes.at(-2)?.backingId).toBeGreaterThan(0);
    expect(after.changes.at(-1)).toMatchObject({ backingId: null, lastObservedBackingBytes: null,
      activeOwnersAtMutation: null }); // Owner metadata retirement is a separate mutation, not a backing measurement.
    expect(after.epoch).toBe(before.epoch + 2); expect(borrowed.byteLength).toBe(16);
    expect(ledger.readDiagnostics()).toEqual(after); expect(Object.isFrozen(after.changes)).toBe(true);
    expect(after.acceptanceComplete).toBe(false);
  });
  it('distinguishes pending/settled/dispatch changes and reports bounded history loss', () => {
    const ledger = new MeshHostRetention(64);
    ledger.reserveReply('pending', 32);
    expect(ledger.readDiagnostics().pendingRequests).toBe(1);
    const before = ledger.readDiagnostics(); expect(ledger.readDiagnostics()).toEqual(before);
    ledger.settleWithoutReply('pending'); ledger.advanceEpoch();
    expect(ledger.readDiagnostics().changes.slice(-2).map(change => change.reason))
      .toEqual(['reply-settled-without-clone', 'owned-worker-dispatch-or-connection']);
    for (let index = 0; index < 130; index += 1) ledger.advanceEpoch();
    const lost = ledger.readDiagnostics();
    expect(lost.changes).toHaveLength(128); expect(lost.dropped).toBe(5);
    expect(lost.pendingRequests).toBe(0); expect(lost.acceptanceComplete).toBe(false);
    expect(lost.changes.every((change, index) => index === 0 || change.epoch > lost.changes[index - 1].epoch)).toBe(true);
  });
});
