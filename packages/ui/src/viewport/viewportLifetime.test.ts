import { describe, expect, it } from 'vitest';
import { createViewportLifetime, createViewportCleanupQueue, createViewportConstructionOwner } from './viewportLifetime.js';

describe('viewport cleanup ownership', () => {
  it('transfers actual resources without returning them and retains failed-only nested operations', () => {
    const child = createViewportConstructionOwner(), parent = createViewportConstructionOwner();
    const first = {}, second = {};
    let refusal = true, firstAttempts = 0, secondAttempts = 0;
    child.acquire('first', first, () => { firstAttempts += 1; if (refusal) throw new Error('first retained'); });
    child.acquire('second', second, () => { secondAttempts += 1; });
    child.handoff((resource, label, release) => { parent.acquire(label, resource, release); });
    expect(firstAttempts).toBe(0); expect(secondAttempts).toBe(0);
    const failure = parent.fail(new Error('later acquisition failed'));
    expect(firstAttempts).toBe(1); expect(secondAttempts).toBe(1);
    expect(failure.cleanup.pendingCount).toBe(1);
    refusal = false; failure.cleanup.dispose(); failure.cleanup.dispose();
    expect(firstAttempts).toBe(2); expect(secondAttempts).toBe(1);
    expect(failure.cleanup.pendingCount).toBe(0);
  });

  it('holds multiple failed owners behind one bounded scheduler and cancels ended waiting mounts', () => {
    const scheduled: { retry: () => void; delay: number; cancelled: boolean }[] = [];
    const queue = createViewportCleanupQueue((retry, delay) => {
      const task = { retry, delay, cancelled: false }; scheduled.push(task);
      return () => { task.cancelled = true; };
    });
    let firstFails = true, secondFails = true;
    let firstAttempts = 0, secondAttempts = 0, starts = 0;
    queue.whenAvailable('first', () => undefined); queue.whenAvailable('second', () => undefined);
    const read = (viewportOwnerId: string) => ({ viewportOwnerId, pendingCount: 1,
      errors: ['return failure'], hostDisplayCopyBytes: 24, hostGpuAttributeBytes: 48,
      unknown: ['driverGpuActual'], observationActive: true });
    queue.retain('first', { retry: () => { firstAttempts += 1; return !firstFails; }, read: () => read('first') });
    queue.retain('second', { retry: () => { secondAttempts += 1; return !secondFails; }, read: () => read('second') });
    const cancel = queue.whenAvailable('ended mount', () => { starts += 1; }); cancel();
    queue.whenAvailable('new mount', () => { starts += 1; });
    expect(scheduled).toHaveLength(1); expect(scheduled[0].delay).toBe(250);
    scheduled[0].retry();
    expect(queue.pendingCount).toBe(2); expect(queue.snapshot()[0]).toMatchObject({ hostGpuAttributeBytes: 48 });
    expect(scheduled[1].delay).toBe(500); expect(starts).toBe(0);
    firstFails = false; scheduled[1].retry();
    expect(queue.pendingCount).toBe(1); expect(firstAttempts).toBe(2);
    secondFails = false; scheduled[2].retry();
    expect(firstAttempts).toBe(2); expect(secondAttempts).toBe(3); expect(starts).toBe(1);
    expect(queue.pendingCount).toBe(0); expect(queue.scheduled).toBe(false);
    expect(queue.waitingCount).toBe(0); expect(queue.ownerCount).toBe(1);
    queue.returned('new mount'); expect(queue.ownerCount).toBe(0);
  });

  it('bounds admitted owners and preserves persistent failures with capped retry intervals', () => {
    let task: () => void = () => { throw new Error('scheduler missing'); }, delay = 0;
    const queue = createViewportCleanupQueue((retry, interval) => { task = retry; delay = interval; return () => { task = () => undefined; }; });
    for (let owner = 0; owner < 16; owner += 1) queue.whenAvailable(`owner-${owner}`, () => undefined);
    let started = false;
    queue.whenAvailable('waiting', () => { started = true; });
    expect(queue.ownerCount).toBe(16); expect(started).toBe(false);
    queue.retain('owner-0', { retry: () => false, read: () => { throw new Error('unknown resource reading'); } });
    for (let attempt = 0; attempt < 10; attempt += 1) task();
    expect(delay).toBe(4000); expect(queue.pendingCount).toBe(1); expect(queue.ownerCount).toBe(16);
    expect(queue.snapshot()[0]).toMatchObject({ pendingCount: 1, hostGpuAttributeBytes: null, unknown: ['retiredViewportResources'] });
  });
  it('attempts independent cleanup and retries only failed owners', () => {
    const owner = createViewportLifetime();
    const attempts: string[] = [];
    let fail = true;
    owner.register('images', () => { attempts.push('images'); if (fail) throw new Error('decode cleanup'); });
    owner.register('events', () => { attempts.push('events'); });
    owner.register('gpu', () => { attempts.push('gpu'); });
    owner.dispose();
    expect(owner.active).toBe(false);
    expect(attempts).toEqual(['images', 'events', 'gpu']);
    expect(owner.pendingCount).toBe(1);
    expect(owner.errors).toEqual(['images: decode cleanup']);
    owner.dispose();
    expect(attempts).toEqual(['images', 'events', 'gpu', 'images']);
    expect(owner.pendingCount).toBe(1);
    fail = false;
    owner.dispose(); owner.dispose();
    expect(attempts).toEqual(['images', 'events', 'gpu', 'images', 'images']);
    expect(owner.pendingCount).toBe(0);
    expect(owner.errors).toEqual([]);
  });

  it('invalidates late work before cleanup and ignores reentrant disposal', () => {
    const owner = createViewportLifetime();
    const published: string[] = [];
    let released = 0;
    const late = (): void => { if (owner.active) published.push('old owner'); };
    owner.register('listener', () => { released += 1; late(); owner.dispose(); });
    owner.dispose(); late(); owner.dispose();
    expect(released).toBe(1);
    expect(published).toEqual([]);
    expect(owner.pendingCount).toBe(0);
    expect(() => owner.register('late resource', () => undefined)).toThrow('disposed viewport owner');
  });
});
