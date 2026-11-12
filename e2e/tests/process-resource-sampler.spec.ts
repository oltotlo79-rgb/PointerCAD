import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { summarizeProcessMemory, summarizeSampledProcessMemory } from '../../packages/test-utils/src/processMemorySamples.js';
import { windowsSampler, linuxSampler, linuxFrame, linuxTerminalMeasurement, linuxAncestry, readLinuxProcess, rawFrame, readSamplerLine, INTERVAL_MS, DISCOVERY_INTERVAL_MS, WINDOWS_SAMPLER_STAGES, type LinuxProcSource, type ResourceProcessSample, type Sampler } from './processResourceSampler.js';
import { readResidentFrames } from './readResidentSampler.js';

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
    // The five start-up stages arrive as their own lines, in order, before the first frame read; none is a frame.
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
    }
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
