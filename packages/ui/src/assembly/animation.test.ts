import { describe, expect, it, vi } from 'vitest';
import * as animation from './animation.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5foAAAAASUVORK5CYII=';

describe('P7-22 assembly animation', () => {
  it.each([[0, 0, 0], [0, 1000, 0.5], [0.25, 1000, 0.625], [0, 3000, 1]])(
    'maps from=%s elapsed=%s to %s', (from, elapsed, expected) => {
      expect(animation.normalizedAnimationTime(from, elapsed)).toBe(expected);
    });

  it.each([[NaN, 0, 2000], [0, -1, 2000], [0, 1, 0], [1.1, 0, 2000]])(
    'rejects invalid timing %s/%s/%s', (from, elapsed, duration) => {
      expect(animation.normalizedAnimationTime(from, elapsed, duration)).toBeNull();
    });

  it('plays to one and releases its frame handle', () => {
    const scheduled: { callback?: (now: number) => void } = {};
    const cancelFrame = vi.fn();
    const values: number[] = [];
    const stopped = vi.fn();
    const player = animation.createAnimationPlayer({ onFrame: (t) => values.push(t), onStopped: stopped,
      clock: { now: () => 100, requestFrame: (next) => { scheduled.callback = next; return 7; }, cancelFrame } });
    player.start();
    expect(values).toEqual([0]);
    scheduled.callback?.(1100);
    scheduled.callback?.(2100);
    expect(values).toEqual([0, 0.5, 1]);
    expect(player.running()).toBe(false);
    expect(stopped).toHaveBeenLastCalledWith('completed');
    expect(cancelFrame).not.toHaveBeenCalled();
  });

  it('cancels exactly the outstanding handle', () => {
    const cancelFrame = vi.fn();
    const stopped = vi.fn();
    const player = animation.createAnimationPlayer({ onFrame: vi.fn(), onStopped: stopped,
      clock: { now: () => 0, requestFrame: () => 19, cancelFrame } });
    player.start(); player.stop(); player.stop();
    expect(cancelFrame).toHaveBeenCalledTimes(1);
    expect(cancelFrame).toHaveBeenCalledWith(19);
    expect(stopped).toHaveBeenCalledOnce();
    expect(stopped).toHaveBeenCalledWith('cancelled');
  });

  it('restarting cancels the old playback before making a new one', () => {
    const cancelled: number[] = [];
    let next = 1;
    const player = animation.createAnimationPlayer({ onFrame: vi.fn(),
      clock: { now: () => 0, requestFrame: () => next++, cancelFrame: (id) => cancelled.push(id) } });
    player.start(); player.start();
    expect(cancelled).toEqual([1]);
    expect(player.running()).toBe(true);
  });

  it('captures 31 frames serially from t=0 through t=1 and restores before saving', async () => {
    const events: string[] = [];
    const result = await animation.exportAnimationPngSequence({
      renderFrame: (t) => { events.push(`render:${String(t)}`); },
      captureFrame: () => { events.push('capture'); return PNG; },
      restoreFrame: () => { events.push('restore'); },
      save: (bytes) => { events.push(`save:${String(bytes.length)}`); return true; },
    });
    expect(result.ok).toBe(true);
    expect(events.filter((event) => event === 'capture')).toHaveLength(31);
    expect(events[0]).toBe('render:0');
    expect(events.at(-2)).toBe('restore');
    expect(events.at(-1)?.startsWith('save:')).toBe(true);
    if (result.ok) expect(result.bytes.byteLength).toBeGreaterThan(0);
  });

  it('renders all 31 evenly spaced normalized times in order', async () => {
    const times: number[] = [];
    const result = await animation.exportAnimationPngSequence({ renderFrame: (t) => { times.push(t); }, captureFrame: () => PNG,
      restoreFrame: vi.fn(), save: () => true });
    expect(result.ok).toBe(true);
    expect(times).toHaveLength(31);
    expect(times).toEqual(Array.from({ length: 31 }, (_, frame) => frame / 30));
  });

  it('stops cleanly when the initial frame callback throws', () => {
    const stopped = vi.fn();
    const player = animation.createAnimationPlayer({
      onFrame: () => { throw new Error('draw'); },
      onStopped: stopped,
      clock: { now: () => 0, requestFrame: vi.fn(() => 1), cancelFrame: vi.fn() },
    });
    expect(() => player.start()).toThrow('draw');
    expect(player.running()).toBe(false);
    expect(stopped).toHaveBeenCalledWith('failed');
  });

  it('produces byte-identical archives from the same captures', async () => {
    const run = () => animation.exportAnimationPngSequence({ renderFrame: vi.fn(), captureFrame: () => PNG,
      restoreFrame: vi.fn(), save: () => true });
    const first = await run(), second = await run();
    expect(first.ok && second.ok ? first.bytes : null).toEqual(first.ok && second.ok ? second.bytes : null);
  });

  it('restores and never saves after a capture failure', async () => {
    let count = 0;
    const restore = vi.fn(), save = vi.fn();
    const result = await animation.exportAnimationPngSequence({ renderFrame: vi.fn(),
      captureFrame: () => ++count === 12 ? null : PNG, restoreFrame: restore, save });
    expect(result).toEqual({ ok: false, reason: 'captureFailed' });
    expect(restore).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });

  it('restores and never saves after rendering rejects', async () => {
    const restore = vi.fn(), save = vi.fn();
    const result = await animation.exportAnimationPngSequence({
      renderFrame: (t) => { if (t > 0.2) throw new Error('draw'); },
      captureFrame: () => PNG, restoreFrame: restore, save });
    expect(result).toEqual({ ok: false, reason: 'renderFailed' });
    expect(restore).toHaveBeenCalledOnce(); expect(save).not.toHaveBeenCalled();
  });

  it('reports cancellation without changing the generated bytes', async () => {
    const result = await animation.exportAnimationPngSequence({ renderFrame: vi.fn(), captureFrame: () => PNG,
      restoreFrame: vi.fn(), save: () => false });
    expect(result).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('reports a save error after restoring', async () => {
    const events: string[] = [];
    const result = await animation.exportAnimationPngSequence({ renderFrame: vi.fn(), captureFrame: () => PNG,
      restoreFrame: () => { events.push('restore'); }, save: () => { events.push('save'); throw new Error('disk'); } });
    expect(result).toEqual({ ok: false, reason: 'saveFailed' });
    expect(events).toEqual(['restore', 'save']);
  });
});
