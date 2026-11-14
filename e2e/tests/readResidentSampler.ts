import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, type TestInfo } from '@playwright/test';
import { DISCOVERY_INTERVAL_MS, INTERVAL_MS, frameClockStages, linuxSampler, staleRetrySummary, windowsSampler, windowsNativeSource, linuxTerminalMeasurement, type RawFrame, type Sampler } from './processResourceSampler.js';

type ReadPlatform = 'win32' | 'linux';
export interface ResidentSample {
  readonly at: number;
  readonly workingSet: number;
  /** Windows PrivateBytes or Linux RssAnon, identified separately in coverage. */
  readonly secondaryBytes: number;
  readonly processes: RawFrame['processes'];
}

/** Validate public sampler rows without filling gaps or relabelling RssAnon as PrivateBytes. */
export function readResidentFrames(frames: readonly RawFrame[], rootPid: number, timeOrigin: number) {
  const samples: ResidentSample[] = [], errors: string[] = [];
  const identities = new Map<number, string>();
  let previous = new Map<number, string>();
  const terminalIdentities = new Set<string>();
  for (const [index, frame] of frames.entries()) {
    const issues: string[] = [];
    if (!Number.isFinite(frame.atEpochMs) || !Number.isFinite(frame.readStartedAtEpochMs)
      || !Number.isFinite(frame.discoveredAtEpochMs) || frame.readStartedAtEpochMs > frame.atEpochMs
      || frame.discoveredAtEpochMs > frame.atEpochMs || frame.discoveredAtEpochMs <= 0
      || frame.atEpochMs - frame.discoveredAtEpochMs > DISCOVERY_INTERVAL_MS) {
      // The CI log carries no attachment: name the frame's own stages, so a stalled sampler and a reversed clock differ.
      issues.push(`invalid or stale frame clock (${frameClockStages(frame, frames[index + 1])})`);
    }
    if (frame.discoveryError !== null) issues.push(`discovery: ${frame.discoveryError}`);
    const ids = new Set<number>();
    const verifiedTerminals: string[] = [];
    let workingSet = 0, secondaryBytes = 0;
    for (const row of frame.processes) {
      if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || ids.has(row.pid)
        || !Number.isSafeInteger(row.parentPid) || row.parentPid < 0 || !row.created || !row.name) issues.push(`invalid process identity: ${row.pid}`);
      ids.add(row.pid);
      const identity = `${String(row.pid)}:${row.created}`;
      if (row.linuxTerminal !== undefined) {
        const measured = linuxTerminalMeasurement(row, row.linuxTerminal, frame);
        if (measured === null || row.error !== null || row.workingSetBytes !== 0 || row.privateBytes !== 0
          || row.cpuMilliseconds !== measured.cpuMilliseconds || row.priority !== measured.priority || row.role !== undefined) {
          issues.push(`PID ${String(row.pid)}: invalid terminal evidence`);
        } else verifiedTerminals.push(identity);
      } else if (terminalIdentities.has(identity)) issues.push(`PID ${String(row.pid)}: terminal identity became live`);
      if (row.error !== null) issues.push(`PID ${row.pid}: ${row.error}`);
      if (identities.has(row.pid) && identities.get(row.pid) !== row.created) issues.push(`PID ${row.pid} reused`);
      identities.set(row.pid, row.created);
      if (row.workingSetBytes === null || !Number.isSafeInteger(row.workingSetBytes) || row.workingSetBytes < 0
        || row.privateBytes === null || !Number.isSafeInteger(row.privateBytes) || row.privateBytes < 0) {
        issues.push(`PID ${row.pid}: missing or invalid memory`);
      } else { workingSet += row.workingSetBytes; secondaryBytes += row.privateBytes; }
    }
    const root = frame.processes.find(row => row.pid === rootPid);
    if (root === undefined || !/^\d+$/u.test(root.created)) issues.push('root PID/creation identity missing');
    if (frame.rootCreated !== undefined && frame.rootCreated !== root?.created) issues.push('root identity disagrees with discovery');
    for (const row of frame.processes) {
      let current = row;
      const visited = new Set<number>();
      while (current.pid !== rootPid) {
        if (visited.has(current.pid)) { issues.push(`PID ${row.pid}: ancestry cycle`); break; }
        visited.add(current.pid);
        const parent = frame.processes.find(candidate => candidate.pid === current.parentPid);
        if (parent === undefined) { issues.push(`PID ${row.pid}: outside recorded root ancestry`); break; }
        // Native creation ticks are in one clock domain per frame (Windows ticks or Linux start ticks).
        // A child older than its apparent parent points at a recycled PID, not this owner's child.
        if (!/^\d+$/u.test(current.created) || !/^\d+$/u.test(parent.created)) {
          issues.push(`PID ${current.pid}: unknown creation ordering`); break;
        }
        if (BigInt(current.created) < BigInt(parent.created)) {
          issues.push(`PID ${current.pid}: older than recorded parent ${parent.pid}`); break;
        }
        current = parent;
      }
    }
    for (const [pid, created] of previous) if (!ids.has(pid)
      && (pid === rootPid || frame.linuxDiscoveryComplete !== true || frame.discoveryError !== null
        || !terminalIdentities.has(`${String(pid)}:${created}`))) issues.push(`PID ${pid} disappeared between frames; memory release unmeasured`);
    previous = new Map(frame.processes.map(row => [row.pid, row.created]));
    if (!Number.isSafeInteger(workingSet) || !Number.isSafeInteger(secondaryBytes)) issues.push('invalid memory total');
    if (issues.length === 0) for (const identity of verifiedTerminals) terminalIdentities.add(identity);
    if (issues.length === 0) samples.push({ at: frame.atEpochMs - timeOrigin, workingSet, secondaryBytes, processes: frame.processes });
    else errors.push(...issues.map(issue => `frame ${index}: ${issue}`));
  }
  if (frames.length === 0) errors.push('no OS resource frames');
  return { samples, errors };
}

/** Thin adapter; OS acquisition, PID creation binding and raw failures belong to the shared sampler. */
export function readResidentAdapter(info: Pick<TestInfo, 'outputPath' | 'attach'>, root: number,
  platform: ReadPlatform, sampler: Sampler, rootContext: unknown = null) {
  const snapshot = () => readResidentFrames(sampler.frames, root, performance.timeOrigin);
  const coverage = {
    status: 'partial-observed-PID-set', platform, includeRoot: true,
    rootContext,
    workingSetMetric: platform === 'win32' ? 'Windows WorkingSet64' : 'Linux VmRSS; verified terminal stat RSS0 at its row read window',
    secondaryMetric: platform === 'win32' ? 'Windows PrivateMemorySize64 (PrivateBytes)' : 'Linux RssAnon (anonymous resident; not Windows PrivateBytes)',
    rawPrivateBytesField: platform === 'win32' ? 'Windows PrivateBytes' : 'Linux RssAnon; terminal zero derived as a subset of measured RSS0',
    requestedSampleIntervalMs: INTERVAL_MS,
    discovery: platform === 'win32' ? { maximumAgeMs: DISCOVERY_INTERVAL_MS } : { method: '/proc discovery every frame' },
    unmeasured: ['short peaks between actual samples', 'processes outside the recorded ancestry',
      'processes born and gone between discoveries', 'GPU dedicated/shared allocation outside process resident'],
  };
  let stopping: Promise<ResidentSample[]> | undefined;
  return { root, coverage, get samples() { return snapshot().samples; },
    get errors() { return [...sampler.failures, ...snapshot().errors]; },
    /** Frames acquired once more because their first acquisition was stale (count and rejected ages; for the record). */
    get staleRetries() { return staleRetrySummary(sampler.frames); },
    waitAfter: async (at: number) => {
      await expect.poll(() => {
        const current = snapshot();
        if (sampler.failures.length || (sampler.frames.length && current.errors.length)) {
          throw new Error(`Read resident measurement unavailable: ${[...sampler.failures, ...current.errors].join('; ')}`);
        }
        return current.samples.filter(sample => sample.at > at).length;
      }, { timeout: 30_000, intervals: [20] }).toBeGreaterThanOrEqual(5);
    },
    stop: () => {
      stopping ??= (async () => {
        let stopError: string | null = null;
        try { await sampler.stop(); } catch (error: unknown) { stopError = String(error); }
        const current = snapshot(), failures = [...sampler.failures, ...current.errors, ...(stopError === null ? [] : [stopError])];
        const path = info.outputPath('read-resident-raw.json');
        await writeFile(path, JSON.stringify({ rootPid: root, ...coverage,
          measurementStatus: failures.length ? 'unavailable-or-incomplete' : 'measured-partial-set',
          failures, staleRetries: staleRetrySummary(sampler.frames), frames: sampler.frames, samples: current.samples }, null, 2));
        await info.attach('read-resident-raw', { contentType: 'application/json', path });
        if (stopError !== null) throw new Error(stopError);
        return current.samples;
      })();
      return stopping;
    },
  };
}

/**
 * The one-off Windows evidence of the root and its immediate parent (PID, parent, command line, name, creation).
 * It uses the sampler's own native process list (windowsNativeSource, one definition in processResourceSampler.ts,
 * which this module already depends on), so the read measurement starts without any WMI query.
 */
export function windowsRootContextScript(root: number): string {
  return `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
${windowsNativeSource}
'@
@([SamplerNative]::RootContext(${String(root)})) | Select-Object ProcessId,ParentProcessId,CommandLine,Name,CimCreatedUtc,NativeCreatedTicks | ConvertTo-Json -Compress`;
}

export async function startReadResidentSampler(info: TestInfo, root: number) {
  const platform = process.platform;
  if (platform !== 'win32' && platform !== 'linux') throw new Error(`Unsupported resource sampler platform: ${platform}`);
  const rootContext = { selection: root === process.pid ? 'own-Playwright-worker-process.pid' : 'Electron-app.process().pid',
    workerPid: process.pid, workerParentPid: process.ppid, execPath: process.execPath, argv: process.argv,
    observedRoot: root, rawIdentityAndCommand: null as unknown, error: null as string | null };
  try {
    if (platform === 'win32') {
      // Query only this anchor and its immediate parent, never measure a PC-wide set.
      const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsRootContextScript(root)], { windowsHide: true });
      rootContext.rawIdentityAndCommand = JSON.parse(result.stdout) as unknown;
    } else {
      const stat = await readFile(`/proc/${root}/stat`, 'utf8');
      const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      rootContext.rawIdentityAndCommand = await Promise.all([root, parent].map(async pid => ({ pid,
        stat: await readFile(`/proc/${pid}/stat`, 'utf8'), command: await readFile(`/proc/${pid}/cmdline`, 'utf8') })));
    }
  } catch (error: unknown) {
    rootContext.error = String(error);
  }
  // The awaited identity probe is our own short-lived child (and conhost on Windows).
  // Finish it before discovery, so its exit cannot be mistaken for missing product memory.
  const sampler = platform === 'win32' ? windowsSampler(root, true) : linuxSampler(root, true, async () => undefined);
  if (rootContext.error !== null) sampler.failures.push(`root ancestry/command evidence unavailable: ${rootContext.error}`);
  return readResidentAdapter(info, root, platform, sampler, rootContext);
}
