import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { summarizeProcessMemory } from '../../packages/test-utils/src/processMemorySamples.js';
import { windowsSampler, linuxSampler, INTERVAL_MS, DISCOVERY_INTERVAL_MS, type Sampler } from './processResourceSampler.js';

/** Bound for each owned stop; an owned process still open after this is a failure, not ignored. */
const OWNED_STOP_MS = 10_000;

async function within<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error(`${label} did not finish within ${String(OWNED_STOP_MS)}ms`)); }, OWNED_STOP_MS);
    })]);
  } finally { clearTimeout(timer); }
}

/** The one child this test owns. The close listener exists before any termination, as in processResourceSampler.stop(). */
function startOwnedChild(): { readonly pid: number; stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 30000)'], { stdio: 'ignore', windowsHide: true });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('close', (code, signal) => { resolve({ code, signal }); });
    child.once('error', reject);
  });
  // A spawn error is still reported through stop() or the missing PID below, never as an unhandled rejection.
  void closed.catch(() => undefined);
  const pid = child.pid;
  if (pid === undefined) throw new Error('Owned child process did not start');
  return { pid, async stop() {
    // Only this child's own PID; it has no descendants. Wait for its actual close, bounded.
    if (child.exitCode === null && child.signalCode === null) child.kill();
    const exit = await within(closed, 'Owned child close');
    if (child.exitCode === null && child.signalCode === null) throw new Error('Owned child has no actual exit');
    return exit;
  } };
}

// task227: on Windows the synchronous CIM discovery stopped the 100ms reads for about 360ms
// every 2.2s (20261021-124241, 24 sample gaps). Several discoveries must pass under the
// unchanged criterion: no gap over 2x100ms, no discovery older than 2000ms, actual times.
test('process sampler keeps the 100ms cadence through repeated discoveries', async () => {
  test.skip(platform() !== 'win32' && platform() !== 'linux', 'Windows and Linux samplers only');
  const owned = startOwnedChild();
  let sampler: Sampler | undefined;
  let primary: { readonly error: unknown } | undefined;
  const cleanupErrors: unknown[] = [];
  try {
    sampler = platform() === 'win32' ? windowsSampler(process.pid, false) : linuxSampler(process.pid, false, async () => undefined);
    const started = sampler;
    await expect.poll(() => started.frames.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await delay(DISCOVERY_INTERVAL_MS * 3);
  } catch (error: unknown) {
    primary = { error };
  } finally {
    // Each owned stop runs even when the sampler start, the wait or the other stop failed.
    if (sampler !== undefined) await within(sampler.stop(), 'Sampler stop').catch((error: unknown) => { cleanupErrors.push(error); });
    await owned.stop().catch((error: unknown) => { cleanupErrors.push(error); });
  }
  if (primary !== undefined) {
    throw cleanupErrors.length === 0 ? primary.error : new AggregateError([primary.error, ...cleanupErrors], 'Sampler regression and owned cleanup failed');
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Owned cleanup failed');
  if (sampler === undefined) throw new Error('Sampler was not started');
  const frames = sampler.frames.map(frame => ({ ...frame, phase: 'baseline' as const }));
  expect(sampler.failures).toEqual([]);
  expect(frames.length).toBeGreaterThanOrEqual((DISCOVERY_INTERVAL_MS * 3) / (INTERVAL_MS * 2));
  const ownedIdentities = new Set<string>();
  for (const frame of frames) {
    expect(frame.discoveryError).toBeNull();
    expect(frame.discoveredAtEpochMs).toBeLessThanOrEqual(frame.readStartedAtEpochMs);
    const rows = frame.processes.filter(sample => sample.pid === owned.pid);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.error).toBeNull();
    expect(rows[0]?.privateBytes).not.toBeNull();
    ownedIdentities.add(rows[0]?.created ?? '');
  }
  // The owned child keeps one full creation identity in every frame.
  expect([...ownedIdentities].filter(created => created !== '')).toHaveLength(1);
  // At least three completed discoveries were used, so the gaps around each are covered.
  expect(new Set(frames.map(frame => frame.discoveredAtEpochMs)).size).toBeGreaterThanOrEqual(platform() === 'win32' ? 3 : frames.length);
  const summary = summarizeProcessMemory(frames, { intervalMs: INTERVAL_MS, discoveryIntervalMs: DISCOVERY_INTERVAL_MS, requiredPhases: ['baseline'] });
  expect(summary.problems).toEqual([]);
});
