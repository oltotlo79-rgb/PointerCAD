import { describe, expect, it, vi } from 'vitest';
import { createInterferenceCheckpointPacing } from './interferenceCheckpointPacing.js';

describe('candidate-only checkpoint delivery policy (pure; no native execution)', () => {
  it('delivers the first candidate and the exact 100ms boundary', () => {
    let now = 0; const p = createInterferenceCheckpointPacing(() => now);
    expect(p.shouldDeliver('candidates')).toBe(true);
    now = 99; expect(p.shouldDeliver('candidates')).toBe(false);
    now = 100; expect(p.shouldDeliver('candidates')).toBe(true);
    // The next 100ms interval starts at that delivery (100), so 199 is still inside it.
    now = 199; expect(p.shouldDeliver('candidates')).toBe(false);
  });
  it('does not postpone delivery by the duration of a slow callback', async () => {
    let now = 10; const p = createInterferenceCheckpointPacing(() => now);
    expect(p.shouldDeliver('candidates')).toBe(true);
    await Promise.resolve(); now = 150;
    expect(p.shouldDeliver('candidates')).toBe(true);
    now = 249; expect(p.shouldDeliver('candidates')).toBe(false);
  });
  it('bounds a stalled clock by 16 existing boundaries (1024 pairs)', () => {
    const p = createInterferenceCheckpointPacing(() => 0);
    expect(p.shouldDeliver('candidates')).toBe(true);
    for (let i = 0; i < 15; i++) expect(p.shouldDeliver('candidates')).toBe(false);
    expect(p.shouldDeliver('candidates')).toBe(true);
    expect(p.shouldDeliver('candidates')).toBe(false);
  });
  it('forces first/final scan notifications even inside the interval', () => {
    const p = createInterferenceCheckpointPacing(() => 5);
    expect(p.shouldDeliver('candidates', true)).toBe(true);
    expect(p.shouldDeliver('candidates')).toBe(false);
    expect(p.shouldDeliver('candidates', true)).toBe(true);
    expect(p.shouldDeliver('mesh')).toBe(true);
  });
  it('never suppresses preparation, native boundaries, phase changes or final mesh', () => {
    let now = 0; const p = createInterferenceCheckpointPacing(() => now);
    for (const phase of ['prepare','prepare','candidates','common','common','mesh','mesh','candidates'] as const) {
      expect(p.shouldDeliver(phase)).toBe(true);
    }
    expect(p.shouldDeliver('candidates')).toBe(false);
    now = 5000; expect(p.shouldDeliver('mesh', true)).toBe(true);
    expect(p.shouldDeliver('candidates')).toBe(true);
  });
  it.each([NaN, Infinity, -Infinity, -1])('disables suppression permanently for invalid clock %s', bad => {
    let now = 1; const clock = vi.fn(() => now), p = createInterferenceCheckpointPacing(clock);
    expect(p.shouldDeliver('candidates')).toBe(true);
    now = bad; expect(p.shouldDeliver('candidates')).toBe(true);
    now = 2; expect(p.shouldDeliver('candidates')).toBe(true);
    expect(clock).toHaveBeenCalledTimes(2);
  });
  it('detects reversal relative to every sample, not only the last delivery', () => {
    let now = 0; const p = createInterferenceCheckpointPacing(() => now);
    expect(p.shouldDeliver('candidates')).toBe(true);
    now = 90; expect(p.shouldDeliver('candidates')).toBe(false);
    now = 89; expect(p.shouldDeliver('candidates')).toBe(true);
    now = 91; expect(p.shouldDeliver('candidates')).toBe(true);
  });
  it('a throwing clock restores delivery instead of manufacturing elapsed zero', () => {
    const clock = vi.fn((): number => { throw new Error('clock'); });
    const p = createInterferenceCheckpointPacing(clock);
    expect(p.shouldDeliver('candidates')).toBe(true); expect(p.shouldDeliver('candidates')).toBe(true);
    expect(clock).toHaveBeenCalledTimes(1);
  });
  it('does not allocate a timer or task and keeps jobs independent', () => {
    const clock = vi.fn(() => 0), a = createInterferenceCheckpointPacing(clock), b = createInterferenceCheckpointPacing(clock);
    expect(clock).not.toHaveBeenCalled();
    expect(a.shouldDeliver('candidates')).toBe(true); expect(a.shouldDeliver('candidates')).toBe(false);
    expect(b.shouldDeliver('candidates')).toBe(true);
  });
  it('pure callback harness stops at cancellation; an elapsed gate never substitutes the callback', async () => {
    let now = 0, work = 0, cancelled = false;
    const p = createInterferenceCheckpointPacing(() => now), callback = vi.fn(() => Promise.resolve(now >= 100));
    for (now = 0; now <= 200; now += 25) {
      if (p.shouldDeliver('candidates') && await callback()) { cancelled = true; break; }
      work++;
    }
    expect(cancelled).toBe(true); expect(work).toBe(4); expect(callback).toHaveBeenCalledTimes(2);
  });
  it('pure callback harness preserves rejection identity and finally without retry', async () => {
    const p = createInterferenceCheckpointPacing(() => 0), failure = new Error('callback');
    const callback = vi.fn(() => Promise.reject(failure)), cleanup = vi.fn();
    const run = async () => { try { if (p.shouldDeliver('candidates')) await callback(); } finally { cleanup(); } };
    await expect(run()).rejects.toBe(failure); expect(callback).toHaveBeenCalledTimes(1); expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
