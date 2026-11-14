import { execFile, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { summarizeProcessMemory, summarizeSampledProcessMemory } from '../../packages/test-utils/src/processMemorySamples.js';
import { windowsSampler, windowsSamplerScript, windowsNativeSource, linuxSampler, linuxFrame, linuxFrameWithRetry, linuxTerminalMeasurement, linuxAncestry, readLinuxProcess, rawFrame, readSamplerLine, staleRetrySummary, INTERVAL_MS, DISCOVERY_INTERVAL_MS, WINDOWS_SAMPLER_STAGES, type LinuxProcSource, type ResourceProcessSample, type Sampler } from './processResourceSampler.js';
import { readResidentFrames, windowsRootContextScript } from './readResidentSampler.js';
import { windowsSaveSamplerScript } from './saveResponsivenessFlow.js';
import { windowsSavePointOwnerScript } from './namedSavePointsFlow.js';

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
function startOwnedChild(scriptArguments: readonly string[] = []): { readonly pid: number; stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 30000)', ...scriptArguments], { stdio: 'ignore', windowsHide: true });
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
// explicit contract: preserve actual 100ms/200ms excursions as cadence quality; identity, counters and discovery remain valid.
for (const includeRoot of [false, true]) {
test(`process sampler records actual cadence quality through repeated discoveries (includeRoot=${String(includeRoot)})`, async () => {
  test.skip(platform() !== 'win32' && platform() !== 'linux', 'Windows and Linux samplers only');
  const owned = startOwnedChild();
  let sampler: Sampler | undefined;
  let primary: { readonly error: unknown } | undefined;
  const cleanupErrors: unknown[] = [];
  try {
    sampler = platform() === 'win32' ? windowsSampler(process.pid, includeRoot) : linuxSampler(process.pid, includeRoot, async () => undefined);
    const started = sampler;
    await expect.poll(() => started.frames.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await delay(DISCOVERY_INTERVAL_MS * 3);
  } catch (error: unknown) {
    primary = { error };
  } finally {
    // Each owned stop runs even when the sampler start, the wait or the other stop failed.
    if (sampler !== undefined) await within(sampler.stop(), 'Sampler stop').catch((error: unknown) => { cleanupErrors.push(error); });
    await owned.stop().catch((error: unknown) => { cleanupErrors.push(error); });
    // Preserve the first failing run too, including discovery stages and actual read costs.
    if (sampler !== undefined) {
      const path = test.info().outputPath('process-sampler-raw.json');
      await writeFile(path, JSON.stringify({ includeRoot, frames: sampler.frames, failures: sampler.failures,
        stages: sampler.stages ?? [], startup: sampler.describe?.() ?? null }, null, 2), { flag: 'wx' });
      await test.info().attach('process-sampler-raw', { path, contentType: 'application/json' });
    }
  }
  if (primary !== undefined) {
    throw cleanupErrors.length === 0 ? primary.error : new AggregateError([primary.error, ...cleanupErrors], 'Sampler regression and owned cleanup failed');
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Owned cleanup failed');
  if (sampler === undefined) throw new Error('Sampler was not started');
  const frames = sampler.frames.map(frame => ({ ...frame, phase: 'baseline' as const }));
  expect(sampler.failures).toEqual([]);
  expect(frames.length).toBeGreaterThanOrEqual((DISCOVERY_INTERVAL_MS * 3) / (INTERVAL_MS * 2));
  if (platform() === 'win32') {
    // The start-up stages arrive as their own lines, in order, before the first frame read; none is a frame.
    // script-start uses the framework clock (before Add-Type); every later stage uses the precise clock.
    const stages = sampler.stages ?? [];
    expect(stages.map(entry => entry.stage)).toEqual([...WINDOWS_SAMPLER_STAGES]);
    for (const [index, entry] of stages.entries()) {
      if (index > 0) expect(entry.atEpochMs).toBeGreaterThanOrEqual(stages[index - 1]?.atEpochMs ?? Number.POSITIVE_INFINITY);
    }
    expect(stages.at(-1)?.atEpochMs).toBeLessThanOrEqual(frames[0]?.readStartedAtEpochMs ?? -1);
    expect(sampler.describe?.()).toMatch(/^spawned \d+ pid \d+ exit [^;]+ \+\d+ms; stages script-start \+\d+ms \(0\.0ms\), native-ready \+\d+ms/u);
  }
  const ownedIdentities = new Set<string>();
  for (const [frameIndex, frame] of frames.entries()) {
    expect(frame.discoveryError).toBeNull();
    expect(frame.discoveredAtEpochMs).toBeLessThanOrEqual(frame.readStartedAtEpochMs);
    // A read can itself cross the age limit even if discovery was fresh when it began
    // (20261026-041057, orphan 32MiB frame 35: 1807ms read, 3130ms final age).
    expect(frame.atEpochMs).toBeGreaterThanOrEqual(frame.readStartedAtEpochMs);
    expect(frame.atEpochMs - frame.discoveredAtEpochMs).toBeLessThanOrEqual(DISCOVERY_INTERVAL_MS);
    expect(frame.processes.filter(sample => sample.pid === process.pid)).toHaveLength(includeRoot ? 1 : 0);
    if (platform() === 'win32') {
      const timing = frame.windowsTiming;
      expect(timing).toBeDefined();
      if (timing === undefined) throw new Error('Windows acquisition timing is missing');
      expect(timing.processSnapshotMethod).toBe('selected-discovery-rows');
      expect(timing.processEnumerationMs).toBeUndefined();
      expect(timing.serializerReadyAtEpochMs).toBeLessThanOrEqual(timing.discoveryStartedAtEpochMs);
      expect(timing.discoveryStartedAtEpochMs).toBeLessThanOrEqual(timing.discoveryWorkerEnteredAtEpochMs);
      expect(timing.discoveryWorkerEnteredAtEpochMs).toBeLessThanOrEqual(frame.discoveredAtEpochMs);
      expect(timing.discoveryStartedAtEpochMs).toBeLessThanOrEqual(frame.discoveredAtEpochMs);
      expect(frame.discoveredAtEpochMs).toBeLessThanOrEqual(timing.discoveryAdoptedAtEpochMs);
      expect(timing.discoveryAdoptedAtEpochMs).toBeLessThanOrEqual(frame.readStartedAtEpochMs);
      // Epoch clocks have integer milliseconds; the stage stopwatch has sub-ms precision.
      expect(Math.floor(timing.processSnapshotMs)).toBeLessThanOrEqual(frame.atEpochMs - frame.readStartedAtEpochMs);
      expect(Math.floor(timing.nativeCallMs)).toBeLessThanOrEqual(frame.atEpochMs - frame.readStartedAtEpochMs);
      expect(Math.floor(timing.readElapsedMs)).toBeLessThanOrEqual(frame.atEpochMs - frame.readStartedAtEpochMs + 1);
      expect(timing.processSnapshotMs).toBeLessThanOrEqual(timing.readElapsedMs);
      expect(timing.nativeCallMs).toBeLessThanOrEqual(timing.readElapsedMs);
      expect(timing.nativeIdentityReadMs + timing.nativeMetricsReadMs + timing.nativeHandleCloseMs).toBeLessThanOrEqual(timing.nativeCallMs);
      expect(timing.nativeHandleOpenMs + timing.nativeCreationQueryMs).toBeLessThanOrEqual(timing.nativeIdentityReadMs);
      expect(Math.floor(timing.discoveryExecutionMs)).toBeLessThanOrEqual(frame.discoveredAtEpochMs - timing.discoveryWorkerEnteredAtEpochMs + 1);
      if (frameIndex === 0) expect(timing.outputOfPreviousFrame).toBeUndefined();
      else expect(timing.outputOfPreviousFrame?.atEpochMs).toBe(frames[frameIndex - 1]?.atEpochMs);
      // The wait fields are recorded in every frame; rawFrame already rejected a missing or reversed time into failures.
      expect(timing.loopStartedAtEpochMs).toBeDefined();
      expect(timing.previousSleep === undefined).toBe(frameIndex === 0);
      // One native discovery per frame, inside the frame's own loop and before its read, as linuxFrame does:
      // it starts after this loop starts and completes after the previous frame ended.
      expect(timing.discoveryStartedAtEpochMs).toBeGreaterThanOrEqual(timing.loopStartedAtEpochMs ?? Number.POSITIVE_INFINITY);
      if (frameIndex > 0) expect(frame.discoveredAtEpochMs).toBeGreaterThanOrEqual(frames[frameIndex - 1]?.atEpochMs ?? Number.POSITIVE_INFINITY);
    }
    const rows = frame.processes.filter(sample => sample.pid === owned.pid);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.error).toBeNull();
    expect(rows[0]?.privateBytes).not.toBeNull();
    ownedIdentities.add(rows[0]?.created ?? '');
  }
  // The owned child keeps one full creation identity in every frame.
  expect([...ownedIdentities].filter(created => created !== '')).toHaveLength(1);
  // Every frame used its own completed discovery (Windows and Linux alike).
  expect(new Set(frames.map(frame => frame.discoveredAtEpochMs)).size).toBe(frames.length);
  // Without a stall no frame is acquired again, and the summary says so explicitly.
  expect(frames.filter(frame => frame.staleRetry !== undefined)).toEqual([]);
  expect(staleRetrySummary(sampler.frames)).toEqual({ count: 0, rejectedAgesMs: [], maxRejectedAgeMs: null });
  const observation = summarizeSampledProcessMemory(frames, { intervalMs: INTERVAL_MS, discoveryIntervalMs: DISCOVERY_INTERVAL_MS,
    requiredPhases: ['baseline'], rootPid: process.pid, includeRoot, windows: [{ phase: 'baseline',
      startedAtEpochMs: frames[0]?.readStartedAtEpochMs ?? NaN, endedAtEpochMs: frames.at(-1)?.atEpochMs ?? NaN }] });
  await test.info().attach('process-sampler-quality', { body: JSON.stringify(observation, null, 2), contentType: 'application/json' });
  expect(observation.problems).toEqual([]);
  expect(observation.observationValid).toBe(true);
  expect(observation.cadence.status).toBe(observation.cadence.excursions.length === 0 ? 'within-target' : 'degraded');
});
}

test('read resident frames reject reused ancestry, duplicates, disappearance and unrelated PIDs', () => {
  const row = (pid: number, parentPid: number, created: string) => ({ pid, parentPid, created, name: 'owned',
    workingSetBytes: 10, privateBytes: 8, cpuMilliseconds: 0, error: null });
  const root = row(10, 1, '200'), child = row(11, 10, '210'), grandchild = row(12, 11, '220');
  const frame = (at: number, processes: typeof root[]) => ({ atEpochMs: at, readStartedAtEpochMs: at,
    discoveredAtEpochMs: at, rootCreated: '200', discoveryError: null, processes });
  const valid = frame(1000, [root, child, grandchild]);
  expect(readResidentFrames([valid], 10, 0).samples[0]?.workingSet).toBe(30);
  expect(readResidentFrames([frame(1000, [root, child, child])], 10, 0).errors.join(' ')).toContain('invalid process identity');
  expect(readResidentFrames([valid, frame(1100, [root, { ...child, created: '211' }, grandchild])], 10, 0).errors.join(' ')).toContain('reused');
  expect(readResidentFrames([valid, frame(1100, [root, child])], 10, 0).errors.join(' ')).toContain('disappeared');
  expect(readResidentFrames([frame(1000, [root, child, row(30, 2, '250')])], 10, 0).errors.join(' ')).toContain('outside recorded root ancestry');
  expect(readResidentFrames([frame(1000, [root, row(11, 10, '199')])], 10, 0).errors.join(' ')).toContain('older than recorded parent');
  expect(readResidentFrames([frame(1000, [root, row(11, 10, 'unknown')])], 10, 0).errors.join(' ')).toContain('unknown creation ordering');
});

// CI 43483431262 (e2e windows-latest, 3) and b864f52 (2026-11-09): the sampler process stopped for over 2s inside one
// frame, so that frame was stale and the read memory could not be certified. A stalled frame is acquired once more in the
// same loop; the rejected attempt is recorded, never hidden, and a second stale attempt is still rejected.
// Registered on Windows only (the PowerShell sampler); the Linux retry is checked below on every platform.
for (const [label, attempts] of platform() === 'win32' ? [['once', [0]], ['twice', [0, 1]]] as const : []) {
  test(`windows sampler acquires a stalled frame once more and records the stall (${label})`, async () => {
    const stallMs = DISCOVERY_INTERVAL_MS + 300;
    const sampler = windowsSampler(process.pid, true, { frame: 2, attempts, ms: stallMs });
    try {
      await expect.poll(() => sampler.frames.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(5);
    } finally {
      await within(sampler.stop(), 'Sampler stop');
    }
    expect(sampler.failures).toEqual([]);
    const retried = sampler.frames.filter(frame => frame.staleRetry !== undefined);
    expect(retried).toHaveLength(1);
    const frame = retried[0], retry = frame?.staleRetry, timing = frame?.windowsTiming;
    if (frame === undefined || retry === undefined || timing === undefined) throw new Error('Retried Windows frame is missing');
    expect(sampler.frames.indexOf(frame)).toBe(2);
    // The rejected attempt: its own discovery, its read and its age past the unchanged limit.
    expect(retry.rejectedAgeMs).toBe(retry.rejectedAtEpochMs - retry.rejectedDiscoveredAtEpochMs);
    expect(retry.rejectedAgeMs).toBeGreaterThan(DISCOVERY_INTERVAL_MS);
    // The injected stall is in the rejected age; Start-Sleep may end a few ms early on the precise clock (2298 for 2300).
    expect(retry.rejectedAgeMs).toBeGreaterThan(stallMs - INTERVAL_MS);
    expect(retry.rejectedDiscoveryError).toBeNull();
    expect(retry.rejectedDiscoveredAtEpochMs).toBeLessThanOrEqual(retry.rejectedReadStartedAtEpochMs);
    expect(retry.rejectedReadStartedAtEpochMs).toBeLessThanOrEqual(retry.rejectedAtEpochMs);
    expect(retry.rejectedAtEpochMs).toBeLessThanOrEqual(retry.retryStartedAtEpochMs);
    expect(retry.retryStartedAtEpochMs).toBeLessThanOrEqual(timing.discoveryStartedAtEpochMs);
    expect(timing.loopStartedAtEpochMs).toBeLessThanOrEqual(retry.rejectedReadStartedAtEpochMs);
    // The gap stays in the actual frame times; nothing is filled in.
    expect(frame.atEpochMs - (sampler.frames[1]?.atEpochMs ?? Number.POSITIVE_INFINITY)).toBeGreaterThan(DISCOVERY_INTERVAL_MS);
    const clockErrors = readResidentFrames(sampler.frames, process.pid, 0).errors.filter(error => error.includes('frame clock'));
    if (label === 'once') {
      expect(frame.atEpochMs - frame.discoveredAtEpochMs).toBeLessThanOrEqual(DISCOVERY_INTERVAL_MS);
      expect(clockErrors).toEqual([]);
    } else {
      // Acquired again and still stale: rejected as before, with both attempts in the text.
      expect(frame.atEpochMs - frame.discoveredAtEpochMs).toBeGreaterThan(DISCOVERY_INTERVAL_MS);
      expect(clockErrors).toHaveLength(1);
      expect(clockErrors[0]).toMatch(/^frame 2: invalid or stale frame clock \(\d+: age \d+ms; read start age -?\d+ms; /u);
      expect(clockErrors[0]).toContain(`; stale retry: rejected age ${String(retry.rejectedAgeMs)}ms`);
    }
    expect(staleRetrySummary(sampler.frames)).toEqual({ count: 1, rejectedAgesMs: [retry.rejectedAgeMs], maxRejectedAgeMs: retry.rejectedAgeMs });
  });
}

test('stale retry records are validated, summarised and named in the clock failure text', () => {
  const retry = { rejectedDiscoveredAtEpochMs: 1_000, rejectedReadStartedAtEpochMs: 1_002, rejectedAtEpochMs: 3_100,
    rejectedAgeMs: 2_100, rejectedDiscoveryError: null, retryStartedAtEpochMs: 3_101 };
  const line = (staleRetry: unknown, extra: Record<string, unknown> = {}) => ({ atEpochMs: 3_120, readStartedAtEpochMs: 3_110,
    discoveredAtEpochMs: 3_105, processes: [], discoveryError: null, staleRetry, ...extra });
  expect(rawFrame(line(retry)).staleRetry).toEqual(retry);
  expect(rawFrame(line(undefined)).staleRetry).toBeUndefined();
  // An age that does not match its own times, an age within the limit, or a retry after the emitted read is malformed.
  for (const broken of [{ ...retry, rejectedAgeMs: 2_099 }, { ...retry, rejectedAtEpochMs: 2_000, rejectedAgeMs: 1_000 },
    { ...retry, retryStartedAtEpochMs: 3_111 }, { ...retry, rejectedReadStartedAtEpochMs: 3_101 }, { ...retry, rejectedDiscoveryError: 7 }]) {
    expect(() => rawFrame(line(broken))).toThrow('Malformed OS resource sample');
  }
  // The clock failure names the frame's own stages (same form as the memory high-water flow) and its retry.
  const stale = { atEpochMs: 5_200, readStartedAtEpochMs: 3_110, discoveredAtEpochMs: 3_105, rootCreated: '200', discoveryError: null,
    processes: [{ pid: 10, parentPid: 1, created: '200', name: 'owned', workingSetBytes: 10, privateBytes: 8, cpuMilliseconds: 0, error: null }],
    staleRetry: retry };
  const errors = readResidentFrames([stale], 10, 0).errors;
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBe('frame 0: invalid or stale frame clock (5200: age 2095ms; read start age 5ms; read 2090ms (native n/a); '
    + 'loop start age n/a; previous sleep n/a; discovery started n/a exec n/a adopted n/a; next frame discovery n/a; '
    + 'stale retry: rejected age 2100ms (discovered 1000, read 1002->3100), retry 3101)');
  expect(staleRetrySummary([stale, { ...stale, staleRetry: { ...retry, rejectedAgeMs: 2_500, rejectedAtEpochMs: 3_500, retryStartedAtEpochMs: 3_500 } }, rawFrame(line(undefined))]))
    .toEqual({ count: 2, rejectedAgesMs: [2_100, 2_500], maxRejectedAgeMs: 2_500 });
});

test('linux frame is acquired once more after a stale attempt and a second stale attempt stays stale', async () => {
  let clock = 10_000;
  const table = [{ pid: 10, parentPid: 1, created: '200', name: 'owned' }, { pid: 11, parentPid: 10, created: '210', name: 'owned' }];
  const slowReads: number[] = [];
  const source: LinuxProcSource = {
    list: () => Promise.resolve(table.map(entry => String(entry.pid))),
    ancestry: pid => Promise.resolve(table.find(entry => entry.pid === pid) ?? null),
    process: pid => {
      clock += slowReads.shift() ?? 1;
      const entry = table.find(candidate => candidate.pid === pid);
      if (entry === undefined) throw new Error(`unexpected full read of PID ${String(pid)}`);
      return Promise.resolve({ ...entry, workingSetBytes: 10, privateBytes: 8, cpuMilliseconds: 0, error: null });
    },
    now: () => clock,
  };
  const fresh = await linuxFrameWithRetry(10, true, source);
  expect(fresh.staleRetry).toBeUndefined();
  expect(fresh.atEpochMs - fresh.discoveredAtEpochMs).toBeLessThanOrEqual(DISCOVERY_INTERVAL_MS);

  slowReads.push(DISCOVERY_INTERVAL_MS + 100);
  const once = await linuxFrameWithRetry(10, true, source);
  expect(once.staleRetry).toMatchObject({ rejectedAgeMs: DISCOVERY_INTERVAL_MS + 101, rejectedDiscoveryError: null });
  expect(once.atEpochMs - once.discoveredAtEpochMs).toBeLessThanOrEqual(DISCOVERY_INTERVAL_MS);
  expect(once.readStartedAtEpochMs).toBeGreaterThanOrEqual(once.staleRetry?.retryStartedAtEpochMs ?? Number.POSITIVE_INFINITY);
  expect(readResidentFrames([once], 10, 0).errors).toEqual([]);

  slowReads.push(DISCOVERY_INTERVAL_MS + 100, 1, DISCOVERY_INTERVAL_MS + 200);
  const twice = await linuxFrameWithRetry(10, true, source);
  expect(twice.staleRetry?.rejectedAgeMs).toBe(DISCOVERY_INTERVAL_MS + 101);
  expect(twice.atEpochMs - twice.discoveredAtEpochMs).toBe(DISCOVERY_INTERVAL_MS + 201);
  expect(readResidentFrames([twice], 10, 0).errors.join(' ')).toContain('invalid or stale frame clock (');
});

// CI 42358862597: Linux frames read status/cmdline of every PID on the runner. Discovery still
// covers every PID in every frame; only the selected rows are read in full, and a lost PID or a
// slow read stays in the record as a failure.
test('linux frame reads selected PIDs in full and keeps a lost PID and a slow read as failures', async () => {
  let clock = 1_000;
  const table = [{ pid: 10, parentPid: 1, created: '200', name: 'owned' }, { pid: 11, parentPid: 10, created: '210', name: 'owned' },
    { pid: 30, parentPid: 2, created: '250', name: 'other' }, { pid: 12, parentPid: 11, created: '220', name: 'owned' }];
  const read: number[] = [];
  const actual = (pid: number): ResourceProcessSample => {
    const entry = table.find(candidate => candidate.pid === pid);
    if (entry === undefined) throw new Error(`unexpected full read of PID ${String(pid)}`);
    return { ...entry, workingSetBytes: 10, privateBytes: 8, cpuMilliseconds: 0, error: null };
  };
  const source = (current: (pid: number) => ResourceProcessSample, readMs = 0): LinuxProcSource => ({
    list: () => Promise.resolve(['self', ...table.map(entry => String(entry.pid))]),
    ancestry: pid => Promise.resolve(table.find(entry => entry.pid === pid) ?? null),
    process: pid => { read.push(pid); clock += readMs; return Promise.resolve(current(pid)); },
    now: () => clock,
  });
  const options = { intervalMs: INTERVAL_MS, discoveryIntervalMs: DISCOVERY_INTERVAL_MS, requiredPhases: ['baseline' as const] };

  // The unrelated PID 30 is discovered from stat only; it is never read in full or recorded.
  const withoutRoot = await linuxFrame(10, false, clock, source(actual));
  expect(withoutRoot.processes.map(sample => sample.pid)).toEqual([11, 12]);
  expect(read).toEqual([11, 12]);
  read.length = 0;
  const withRoot = await linuxFrame(10, true, clock, source(actual));
  expect(withRoot.processes.map(sample => sample.pid)).toEqual([10, 11, 12]);
  expect(read).toEqual([10, 11, 12]);
  expect(withRoot.discoveredAtEpochMs).toBe(withRoot.readStartedAtEpochMs);
  expect(readResidentFrames([withRoot], 10, 0).errors).toEqual([]);

  // Missing sample: a PID gone after discovery stays a failed row with unknown memory, not dropped or 0.
  const lost = await linuxFrame(10, true, clock, source(pid => pid === 11
    ? { pid, created: '', parentPid: 0, name: '', workingSetBytes: null, privateBytes: null, cpuMilliseconds: null, error: 'Error: ENOENT' }
    : actual(pid)));
  expect(lost.processes.map(sample => sample.pid)).toEqual([10, 11, 12]);
  expect(lost.processes[1]).toMatchObject({ pid: 11, created: '210', parentPid: 10, workingSetBytes: null, privateBytes: null, cpuMilliseconds: null });
  expect(lost.processes[1]?.error).toContain('after /proc discovery: Error: ENOENT');
  expect(readResidentFrames([lost], 10, 0).errors.join(' ')).toContain('PID 11: missing or invalid memory');
  expect(summarizeProcessMemory([{ ...lost, phase: 'baseline' }], options).complete).toBe(false);
  // PID reuse after discovery is a failure too, under the discovered identity.
  const reused = await linuxFrame(10, true, clock, source(pid => pid === 11 ? { ...actual(pid), created: '211' } : actual(pid)));
  expect(reused.processes[1]).toMatchObject({ pid: 11, created: '210', workingSetBytes: null, privateBytes: null });
  expect(reused.processes[1]?.error).toContain('after /proc discovery');

  // Slow acquisition: the actual end time is recorded, not clamped, so the 2x100ms read limit still rejects it.
  const slowStart = clock;
  const slow = await linuxFrame(10, true, slowStart, source(actual, 101));
  expect(slow.readStartedAtEpochMs).toBe(slowStart);
  expect(slow.atEpochMs - slow.readStartedAtEpochMs).toBe(303);
  expect(slow.atEpochMs - slow.readStartedAtEpochMs).toBeGreaterThan(INTERVAL_MS * 2);
  expect(summarizeProcessMemory([{ ...withRoot, phase: 'baseline' }, { ...slow, phase: 'baseline' }], options).problems)
    .toContain(`sample gap at ${String(slow.atEpochMs)}`);

  // A failed /proc listing is not an empty tree; the sampler loop records it as discoveryError.
  await expect(linuxFrame(10, true, clock, { ...source(actual), list: () => Promise.reject(new Error('EACCES /proc')) }))
    .rejects.toThrow('EACCES /proc');
});

// CI 42358862597: the Windows gaps lay outside every measured acquisition stage. Each frame also records its
// loop start and the Start-Sleep before it, so the gap from the previous frame splits into output, sleep,
// wake-up to loop, and loop to read. Records written before these fields still parse; a missing, negative
// or reversed time does not.
test('windows frame timing separates the sleep from the loop and rejects missing, negative or reversed times', () => {
  const stages = ['nativeInitializationMs', 'discoveryInitializationMs', 'discoveryWorkerEnteredAtEpochMs', 'discoveryExecutionMs',
    'nativeHandleOpenMs', 'nativeCreationQueryMs', 'nativeHandleCloseMs', 'nativeCallMs', 'readElapsedMs', 'serializerInitializationMs',
    'serializerReadyAtEpochMs', 'discoveryStartedAtEpochMs', 'discoveryAdoptedAtEpochMs', 'cimEnumerationMs', 'ancestryMs',
    'identityBindingMs', 'adoptionMs', 'processSnapshotMs', 'propertyReadMs', 'nativeIdentityReadMs', 'nativeMetricsReadMs', 'processDisposalMs'];
  const old = Object.fromEntries(stages.map(key => [key, 1]));
  const frame = (windowsTiming: Record<string, unknown>) => ({ atEpochMs: 2_000, readStartedAtEpochMs: 1_990,
    discoveredAtEpochMs: 1_500, rootCreated: '200', discoveryError: null, processes: [], windowsTiming });
  // The previous frame ended at 1400; a 98ms sleep began at 1402 and ended at 1900; the loop began at 1985.
  const output = { atEpochMs: 1_400, serializationMs: 0.5, writeMs: 0.5 };
  const sleep = { requestedMs: 98, startedAtEpochMs: 1_402, endedAtEpochMs: 1_900 };
  const later = { ...old, outputOfPreviousFrame: output, loopStartedAtEpochMs: 1_985 };

  // A record written before the wait fields parses unchanged.
  expect(rawFrame(frame(old)).windowsTiming).toEqual(old);
  // The first frame has its loop start and no previous output or sleep.
  expect(rawFrame(frame({ ...old, loopStartedAtEpochMs: 1_985 })).windowsTiming?.loopStartedAtEpochMs).toBe(1_985);
  // A later frame keeps the actual values.
  const timing = rawFrame(frame({ ...later, previousSleep: sleep })).windowsTiming;
  expect(timing?.loopStartedAtEpochMs).toBe(1_985);
  expect(timing?.previousSleep).toEqual(sleep);

  const malformed: Record<string, unknown>[] = [
    { ...old, outputOfPreviousFrame: output, previousSleep: sleep },
    { ...old, loopStartedAtEpochMs: 1_985, previousSleep: sleep },
    later,
    { ...later, previousSleep: { requestedMs: 98, startedAtEpochMs: 1_402 } },
    { ...old, loopStartedAtEpochMs: -1 },
    { ...old, loopStartedAtEpochMs: '1985' },
    { ...later, previousSleep: { ...sleep, requestedMs: -2 } },
    { ...later, previousSleep: { ...sleep, startedAtEpochMs: -1_402 } },
    { ...later, previousSleep: { ...sleep, endedAtEpochMs: 1_401 } },
    { ...later, previousSleep: { ...sleep, startedAtEpochMs: 1_399 } },
    { ...later, loopStartedAtEpochMs: 1_899, previousSleep: sleep },
    { ...old, loopStartedAtEpochMs: 1_991 },
  ];
  for (const windowsTiming of malformed) expect(() => rawFrame(frame(windowsTiming))).toThrow('Malformed OS resource sample');
});

// A sampler that never reaches its first frame still shows how far it started (run 43228617681: 0 frames, no failure).
// The start-up stage lines share stdout with the frames, so neither may be read as the other.
test('a Windows sampler start-up stage line is kept as a stage and never counted as a frame', () => {
  // The discovery runs in the sampling loop of every frame, so there is no discovery runspace stage.
  expect([...WINDOWS_SAMPLER_STAGES]).toEqual(['script-start', 'native-ready', 'first-discovery-started', 'first-discovery-complete']);
  expect(readSamplerLine('{"samplerStage":"native-ready","atEpochMs":1000,"ms":86.3}'))
    .toEqual({ stage: { stage: 'native-ready', atEpochMs: 1_000, ms: 86.3 } });
  const frameLine = JSON.stringify({ atEpochMs: 1_100, readStartedAtEpochMs: 1_090, discoveredAtEpochMs: 1_000, processes: [], discoveryError: null });
  const decoded: unknown = JSON.parse(frameLine);
  expect(readSamplerLine(frameLine)).toEqual({ frame: rawFrame(decoded) });
  // A malformed stage is a failure: it is neither a stage nor a frame.
  for (const line of ['{"samplerStage":"native-ready","atEpochMs":-1,"ms":1}', '{"samplerStage":7,"atEpochMs":1,"ms":1}',
    '{"samplerStage":"native-ready","atEpochMs":1}', '{"samplerStage":"native-ready","atEpochMs":1,"ms":"1"}']) {
    expect(() => readSamplerLine(line), line).toThrow('Malformed sampler stage');
  }
  // A frame keeps its own validation.
  expect(() => readSamplerLine('{"atEpochMs":1}')).toThrow('Malformed OS resource sample');
});

// Windows-only CI failures of this sampler (stale frames, a silent 30s start, a 3526ms discovery age in run 43306633811)
// share the WMI discovery: on the CI runner one Get-CimInstance discovery took up to 1746ms (c1a956ed artifact; 331ms locally).
// The discovery reads one native process snapshot instead. The frame format and the selected PID set stay the same.
test('the Windows sampler discovers processes without WMI', () => {
  const script = windowsSamplerScript(1234, false);
  for (const source of [script, windowsNativeSource]) {
    expect(source).not.toMatch(/Get-CimInstance|Get-WmiObject|Win32_Process|ManagementObject|System\.Management/iu);
  }
  expect(script).toContain('[SamplerNative]::Discover(');
});

interface DiscoveredRow { readonly pid: number; readonly parentPid: number; readonly name: string; readonly created: string; readonly role: string }
function discoveredRows(value: unknown): DiscoveredRow[] {
  if (!Array.isArray(value)) throw new Error('Discovery comparison rows missing');
  return value.map((row: unknown) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) throw new Error('Malformed discovery comparison row');
    const pid: unknown = Reflect.get(row, 'pid'), parentPid: unknown = Reflect.get(row, 'parentPid'), name: unknown = Reflect.get(row, 'name');
    const created: unknown = Reflect.get(row, 'created'), role: unknown = Reflect.get(row, 'role');
    if (typeof pid !== 'number' || typeof parentPid !== 'number' || typeof name !== 'string' || typeof created !== 'string'
      || !/^\d+$/u.test(created) || typeof role !== 'string') throw new Error('Malformed discovery comparison row');
    return { pid, parentPid, name, created, role };
  });
}
/** Native discovery, then an independent WMI tree with the former rules, then native discovery again (one PowerShell). */
function discoveryComparisonScript(rootPid: number): string {
  return `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
${windowsNativeSource}
'@
function Get-NativeTree { @([SamplerNative]::Discover(${String(rootPid)},$true,$PID).Known | ForEach-Object { @{pid=$_.Pid;parentPid=$_.ParentPid;name=$_.Name;created=$_.Created;role=$_.Role} }) }
$first=Get-NativeTree
$all=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name,CommandLine)
$ticks=@{}
foreach($item in $all){ if([int]$item.ProcessId -eq ${String(rootPid)}){ $ticks[${String(rootPid)}]=$item.CreationDate.ToUniversalTime().Ticks } }
$ids=New-Object 'System.Collections.Generic.HashSet[int]'
[void]$ids.Add(${String(rootPid)})
do { $added=$false; foreach($item in $all){
  $parent=[int]$item.ParentProcessId
  if($ids.Contains($parent) -and [int]$item.ProcessId -ne $PID -and $null -ne $item.CreationDate -and $item.CreationDate.ToUniversalTime().Ticks -ge $ticks[$parent]){
    if($ids.Add([int]$item.ProcessId)){ $ticks[[int]$item.ProcessId]=$item.CreationDate.ToUniversalTime().Ticks; $added=$true }
  }
}} while($added)
$cim=@(foreach($item in $all){ if($ids.Contains([int]$item.ProcessId)){
  $role='main-or-native'
  if($item.CommandLine -match '--type=([a-z-]+)'){ $role=$Matches[1] } elseif($item.CommandLine -match '-contentproc'){ $role='firefox-content' }
  @{pid=[int]$item.ProcessId;parentPid=[int]$item.ParentProcessId;name=$item.Name;created=$item.CreationDate.ToUniversalTime().Ticks.ToString();role=$role}
}})
$second=Get-NativeTree
[Console]::Out.WriteLine((@{first=$first;cim=$cim;second=$second} | ConvertTo-Json -Depth 4 -Compress))
`;
}

// The old (WMI) and new (native) enumerations are compared on this machine. WMI CreationDate keeps microseconds, the
// native creation time 100ns. A process that starts or ends between the enumerations is in only one native list.
test('the native Windows discovery returns the same process tree as an independent WMI enumeration', async () => {
  test.skip(platform() !== 'win32', 'Windows discovery only');
  const plain = startOwnedChild();
  const roled = startOwnedChild(['--', '--type=sampler-check']);
  try {
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', discoveryComparisonScript(process.pid)],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    // Kept as a file too: a CI failure artifact then shows both enumerations.
    const comparisonPath = test.info().outputPath('discovery-comparison.json');
    await writeFile(comparisonPath, stdout, { flag: 'wx' });
    await test.info().attach('discovery-comparison', { path: comparisonPath, contentType: 'application/json' });
    const decoded: unknown = JSON.parse(stdout);
    if (typeof decoded !== 'object' || decoded === null) throw new Error('Discovery comparison output missing');
    const first = discoveredRows(Reflect.get(decoded, 'first')), second = discoveredRows(Reflect.get(decoded, 'second'));
    const cim = discoveredRows(Reflect.get(decoded, 'cim'));
    const exact = (row: DiscoveredRow): string => `${String(row.pid)}:${row.created}`;
    const micro = (row: DiscoveredRow): string => `${String(row.pid)}:${String(BigInt(row.created) / 10n)}`;
    const secondKeys = new Set(second.map(exact));
    const stable = first.filter(row => secondKeys.has(exact(row)));
    const cimByKey = new Map(cim.map(row => [micro(row), row]));
    for (const row of stable) {
      const old = cimByKey.get(micro(row));
      expect(old, `WMI tree misses stable native row ${exact(row)} ${row.name}`).toBeDefined();
      expect({ parentPid: old?.parentPid, name: old?.name, role: old?.role }).toEqual({ parentPid: row.parentPid, name: row.name, role: row.role });
    }
    const nativeKeys = new Set([...first, ...second].map(micro));
    for (const row of cim) expect(nativeKeys.has(micro(row)), `native discovery misses WMI row ${micro(row)} ${row.name}`).toBe(true);
    expect(stable.map(row => row.pid)).toEqual(expect.arrayContaining([process.pid, plain.pid, roled.pid]));
    expect(stable.find(row => row.pid === plain.pid)?.role).toBe('main-or-native');
    expect(stable.find(row => row.pid === roled.pid)?.role).toBe('sampler-check');
  } finally {
    await plain.stop();
    await roled.stop();
  }
});

// The read measurement records its root (and parent) once before the sampler starts; that probe used WMI too.
test('the read resident root evidence is read without WMI', () => {
  const script = windowsRootContextScript(4321);
  expect(script).not.toMatch(/Get-CimInstance|Get-WmiObject|Win32_|ManagementObject|System\.Management/iu);
  expect(script).toContain('[SamplerNative]::RootContext(4321)');
});

/** Ticks (100ns since 0001-01-01 UTC) of a .NET round-trip UTC time such as 2026-11-13T07:10:41.4057169Z. */
function roundTripTicks(text: string): bigint {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{7})Z$/u.exec(text);
  if (match === null) throw new Error(`Not a round-trip UTC time: ${text}`);
  const [year, month, day, hour, minute, second, fraction] = match.slice(1).map(Number);
  if ([year, month, day, hour, minute, second, fraction].some(value => value === undefined)) throw new Error(`Incomplete time: ${text}`);
  const epochMs = Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0, second ?? 0);
  return BigInt(epochMs) * 10_000n + BigInt(fraction ?? 0) + 621_355_968_000_000_000n;
}

test('the native read resident root evidence keeps the root, its parent and one creation time per process', async () => {
  test.skip(platform() !== 'win32', 'Windows root evidence only');
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsRootContextScript(process.pid)],
    { windowsHide: true, maxBuffer: 1024 * 1024 });
  const decoded: unknown = JSON.parse(stdout);
  const rows: unknown[] = Array.isArray(decoded) ? decoded.map((row: unknown) => row) : [decoded];
  const field = (row: unknown, key: string): unknown => typeof row === 'object' && row !== null ? Reflect.get(row, key) : undefined;
  expect(rows.map(row => field(row, 'ProcessId'))).toEqual([process.pid, process.ppid]);
  expect(field(rows[0], 'ParentProcessId')).toBe(process.ppid);
  for (const row of rows) {
    const name = field(row, 'Name'), command = field(row, 'CommandLine');
    const snapshot = field(row, 'CimCreatedUtc'), handle = field(row, 'NativeCreatedTicks');
    expect(typeof name === 'string' && name.length > 0, 'process name').toBe(true);
    expect(typeof command === 'string' && command.length > 0, 'command line').toBe(true);
    if (typeof snapshot !== 'string' || typeof handle !== 'string' || !/^\d+$/u.test(handle)) throw new Error(`Creation evidence missing: ${stdout}`);
    // The process list and the handle report the same 100ns creation time for the same process.
    expect(roundTripTicks(snapshot)).toBe(BigInt(handle));
  }
});

function fieldOf(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

// The save responsiveness sampler (a second Windows sampler) and the save point owner probe read processes natively too.
test('the save responsiveness sampler and the save point owner probe read processes without WMI', () => {
  for (const script of [windowsSaveSamplerScript(), windowsSavePointOwnerScript('C:/profile', 0), windowsSavePointOwnerScript('C:/profile', 4321)]) {
    expect(script).not.toMatch(/Get-CimInstance|Get-WmiObject|Win32_|ManagementObject|System\.Management/iu);
    expect(script).toContain('[SamplerNative]::');
  }
});

test('the native save point owner probe finds the owned process by its command line and by its PID', async () => {
  test.skip(platform() !== 'win32', 'Windows owner probe only');
  const marker = `pcad-owner-probe-${String(process.pid)}-${String(Date.now())}`;
  const owned = startOwnedChild(['--', marker]);
  try {
    const read = async (pid: number): Promise<unknown> => {
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsSavePointOwnerScript(marker, pid)],
        { windowsHide: true, maxBuffer: 1024 * 1024 });
      const decoded: unknown = JSON.parse(stdout);
      return decoded;
    };
    const created = new Set<unknown>();
    for (const rows of [await read(0), await read(owned.pid)]) {
      expect(Array.isArray(rows) ? rows.length : -1, JSON.stringify(rows)).toBe(1);
      const row: unknown = Array.isArray(rows) ? rows.map((entry: unknown) => entry)[0] : undefined;
      expect(fieldOf(row, 'pid')).toBe(owned.pid);
      expect(String(fieldOf(row, 'created'))).toMatch(/^\d+$/u);
      created.add(fieldOf(row, 'created'));
    }
    // The command-line query and the exact PID query name the same process instance.
    expect(created.size).toBe(1);
  } finally {
    await owned.stop();
  }
});

test('the native save responsiveness sampler reads the owned descendants and never itself', async () => {
  test.skip(platform() !== 'win32', 'Windows save sampler only');
  const owned = startOwnedChild();
  const scriptFile = test.info().outputPath('save-sampler.ps1'), stopFile = test.info().outputPath('save-sampler.stop');
  await writeFile(scriptFile, windowsSaveSamplerScript());
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, String(process.pid), stopFile],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise<number | null>(resolve => { child.once('close', code => { resolve(code); }); });
  const lines: string[] = [];
  let pending = '', errors = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (text: string) => {
    pending += text;
    const parts = pending.split(/\r?\n/u); pending = parts.pop() ?? '';
    lines.push(...parts.filter(line => line.length > 0));
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text: string) => { errors += text; });
  try {
    await expect.poll(() => lines.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
  } finally {
    await writeFile(stopFile, 'stop');
    await within(closed, 'Save sampler close');
    await owned.stop();
  }
  expect(errors).toBe('');
  for (const line of lines.slice(0, 3)) {
    const frame: unknown = JSON.parse(line);
    expect(fieldOf(frame, 'discoveryError')).toBeNull();
    const ids = fieldOf(frame, 'expectedPids');
    expect(Array.isArray(ids) && ids.includes(owned.pid), line).toBe(true);
    expect(Array.isArray(ids) && ids.includes(child.pid), line).toBe(false);
  }
});

test('Linux actual stat/status readers retain state and distinguish disappearance, reuse and denied discovery', async () => {
  const stat = (pid: number, parent: number, created: string, state = 'S'): string => {
    const fields = Array.from({ length: 20 }, () => '0');
    fields[0] = state; fields[1] = String(parent); fields[19] = created;
    return `${String(pid)} (electron) ${fields.join(' ')}`;
  };
  const read = async (_pid: number, file: 'stat' | 'status' | 'cmdline'): Promise<string> =>
    file === 'stat' ? stat(11, 10, '210') : file === 'status' ? 'VmRSS: 2 kB\nRssAnon: 1 kB\n' : 'electron';
  const good = await readLinuxProcess(11, 100, read);
  expect(good).toMatchObject({ workingSetBytes: 2048, privateBytes: 1024, error: null });
  const zombie = await readLinuxProcess(11, 100, async (_pid, file) =>
    file === 'stat' ? stat(11, 10, '210', 'Z') : file === 'status' ? 'State: Z (zombie)\n' : '');
  expect(zombie).toMatchObject({ workingSetBytes: null, privateBytes: null, error: 'Missing Linux memory counters in actual status',
    linuxReading: { stateBefore: 'Z', stateAfter: 'Z', stage: 'complete', status: 'State: Z (zombie)\n' } });
  expect(summarizeProcessMemory([{ atEpochMs: 1000, discoveredAtEpochMs: 1000, phase: 'baseline',
    discoveryError: null, processes: [zombie] }], { intervalMs: 100, discoveryIntervalMs: 2000, requiredPhases: ['baseline'] }).complete).toBe(false);
  for (const code of ['ENOENT', 'ESRCH', 'EACCES', 'EIO']) {
    const failed = await readLinuxProcess(11, 100, async () => { throw Object.assign(new Error(code), { code }); });
    expect(failed).toMatchObject({ workingSetBytes: null, privateBytes: null, linuxReading: { stage: 'stat-before', errorCode: code } });
    const source: LinuxProcSource = { list: () => Promise.resolve(['10', '11']), now: () => 1000,
      ancestry: pid => linuxAncestry(pid, async () => {
        if (pid === 11) throw Object.assign(new Error(code), { code });
        return stat(10, 1, '200');
      }), process: pid => Promise.resolve({ ...good, pid }) };
    const frame = await linuxFrame(10, true, 990, source);
    expect(frame.linuxDiscovery?.[0]).toMatchObject({ pid: 11, errorCode: code, rawStat: null });
    expect(frame.discoveryError === null).toBe(code === 'ENOENT' || code === 'ESRCH');
  }
  let count = 0;
  const reused = await readLinuxProcess(11, 100, async (pid, file) =>
    file === 'stat' ? stat(pid, 10, ++count === 1 ? '210' : '211') : read(pid, file));
  expect(reused).toMatchObject({ workingSetBytes: null, linuxReading: { stage: 'identity', errorCode: null } });
  expect(reused.error).toContain('PID reused during read');
  const invalid = await linuxAncestry(11, async () => 'invalid stat');
  expect(invalid).toMatchObject({ rawStat: 'invalid stat', errorCode: null });
  expect(invalid).toHaveProperty('error');
});

test('actual CI stale discovery rows remain rejected despite fresh acquisition starts', () => {
  for (const [end, start, discovery] of [[1794311175838, 1794311175133, 1794311173583],
    [1794311305135, 1794311304463, 1794311302826]]) {
    if (end === undefined || start === undefined || discovery === undefined) throw new Error('Missing actual CI timestamp');
    const row = { atEpochMs: end, readStartedAtEpochMs: start, discoveredAtEpochMs: discovery,
      phase: 'baseline' as const, discoveryError: null, rootCreated: '200',
      processes: [{ pid: 10, parentPid: 1, created: '200', name: 'owned', workingSetBytes: 20, privateBytes: 10, error: null }] };
    const observed = summarizeSampledProcessMemory([row], { intervalMs: 100, discoveryIntervalMs: 2000,
      rootPid: 10, includeRoot: true, requiredPhases: ['baseline'], windows: [
        { phase: 'baseline', startedAtEpochMs: start, endedAtEpochMs: end }] });
    expect(start - discovery).toBeLessThan(2000);
    expect(observed.observationValid).toBe(false);
    expect(observed.problems).toContain(`${String(end)}: stale process discovery`);
    expect(row.atEpochMs).toBe(end);
    expect(row.discoveredAtEpochMs).toBe(discovery);
  }
});

test('complete actual Z/RSS0 discovery stat is measured once and only its verified identity may disappear', async () => {
  // Root-owned WNOWAIT child: raw SHA 1f0c9eb441d0d779b3592dce268e245cf09beeebe0209b1581e0692fe8744363.
  const stat = "11 (python3) Z 10 10 10 34816 10 4227148 2480 0 1 0 0 1 0 0 20 0 1 0 242 0 0 18446744073709551615 0 0 0 0 0 0 0 16781312 2 1 0 0 17 10 0 0 0 0 0 0 0 0 0 0 0 0 0\n";
  const root = { pid: 10, parentPid: 1, created: '200', name: 'owned', workingSetBytes: 20, privateBytes: 10, cpuMilliseconds: 1, error: null };
  const entry = await linuxAncestry(11, async () => stat, () => 1000);
  if ('error' in entry) throw new Error(entry.error);
  let childReads = 0;
  const source: LinuxProcSource = { list: () => Promise.resolve(['10', '11']), now: () => 1010, ticksPerSecond: () => Promise.resolve(100),
    ancestry: pid => Promise.resolve(pid === 11 ? entry : { pid: 10, parentPid: 1, created: '200', name: 'owned' }),
    process: pid => { if (pid === 11) childReads++; return Promise.resolve(root); } };
  const frame = await linuxFrame(10, true, 990, source), terminal = frame.processes.find(row => row.pid === 11);
  expect(childReads).toBe(0);
  expect(terminal).toMatchObject({ pid: 11, parentPid: 10, created: '242', name: 'python3', workingSetBytes: 0,
    privateBytes: 0, cpuMilliseconds: 10, priority: 'nice=0', error: null,
    linuxTerminal: { rawStat: stat, readStartedAtEpochMs: 1000, readEndedAtEpochMs: 1000, privateSource: 'subset-of-zero-rss' } });
  expect(terminal?.role).toBeUndefined();
  const next = await linuxFrame(10, true, 1090, { ...source, list: () => Promise.resolve(['10']), now: () => 1100 });
  const read = readResidentFrames([frame, next], 10, 0);
  expect(read.errors).toEqual([]); expect(next.processes).toEqual([root]);
  expect(read.samples[1]?.workingSet).toBe(20); expect(read.samples[1]?.processes).toHaveLength(1);
  if (terminal === undefined || terminal.linuxTerminal === undefined) throw new Error('Terminal evidence missing');
  for (const evidence of [{ terminal: true }, { ...terminal.linuxTerminal, ticksPerSecond: NaN },
    { ...terminal.linuxTerminal, readStartedAtEpochMs: 989 }, { ...terminal.linuxTerminal, frameReadStartedAtEpochMs: 989 },
    { ...terminal.linuxTerminal, rawStat: stat.replace(') Z ', ') S ') },
    { ...terminal.linuxTerminal, rawStat: '11 (python3) Z 10' }]) {
    expect(linuxTerminalMeasurement(entry, evidence, frame)).toBeNull();
    const forged = { ...terminal }; Reflect.set(forged, 'linuxTerminal', evidence);
    expect(readResidentFrames([{ ...frame, processes: [root, forged] }, next], 10, 0).errors.join(' ')).toContain('terminal');
  }
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
  for (const [index, value] of [[21, '1'], [21, '-1'], [11, '-1'], [12, 'NaN']] as const) {
    const bad = [...fields]; bad[index] = value;
    expect(linuxTerminalMeasurement(entry, { ...terminal.linuxTerminal, rawStat: `11 (python3) ${bad.join(' ')}` }, frame)).toBeNull();
  }
  expect(linuxTerminalMeasurement({ ...entry, pid: 12 }, terminal.linuxTerminal, frame)).toBeNull();
  expect(linuxTerminalMeasurement({ ...entry, created: '243' }, terminal.linuxTerminal, frame)).toBeNull();
  expect(linuxTerminalMeasurement({ ...entry, parentPid: 9 }, terminal.linuxTerminal, frame)).toBeNull();
  expect(linuxTerminalMeasurement({ ...entry, name: 'other' }, terminal.linuxTerminal, frame)).toBeNull();
  expect(readResidentFrames([frame, { ...next, linuxDiscoveryComplete: false }], 10, 0).errors.join(' ')).toContain('disappeared');
  expect(readResidentFrames([frame, { ...next, processes: [] }], 10, 0).errors.join(' ')).toContain('root PID');
  expect(readResidentFrames([frame, { ...next, processes: [root, { ...terminal, created: '243' }] }], 10, 0).errors.join(' ')).toContain('reused');
});
