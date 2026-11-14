import { execFile, spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { linuxProcessTreeDiscovery, type ProcessMemoryFrame, type ProcessMemorySample } from '../../packages/test-utils/src/processMemorySamples.js';

export const INTERVAL_MS = 100;
/**
 * The age limit of the PID set a frame reads (frame end minus its discovery). Both samplers discover in every
 * frame, so the age is that frame's discovery and read time; a longer stall of one frame is rejected as stale.
 */
export const DISCOVERY_INTERVAL_MS = 2_000;
export interface LinuxReading {
  readonly statBefore: string | null; readonly status: string | null; readonly statAfter: string | null;
  readonly stateBefore: string | null; readonly stateAfter: string | null;
  readonly errorCode: string | null; readonly stage: 'stat-before' | 'status' | 'cmdline' | 'stat-after' | 'identity' | 'complete';
}
export interface LinuxTerminalEvidence {
  readonly kind: 'linux-discovery-stat-z-rss-zero';
  readonly rawStat: string;
  readonly frameReadStartedAtEpochMs: number;
  readonly readStartedAtEpochMs: number;
  readonly readEndedAtEpochMs: number;
  readonly ticksPerSecond: number;
  readonly workingSetSource: 'stat-rss-zero';
  readonly privateSource: 'subset-of-zero-rss';
}
export interface ResourceProcessSample extends ProcessMemorySample {
  readonly cpuMilliseconds: number | null; readonly linuxReading?: LinuxReading; readonly linuxTerminal?: LinuxTerminalEvidence;
}
interface WindowsTiming {
  readonly nativeInitializationMs: number;
  readonly discoveryInitializationMs: number;
  readonly discoveryWorkerEnteredAtEpochMs: number;
  readonly discoveryExecutionMs: number;
  readonly nativeHandleOpenMs: number;
  readonly nativeCreationQueryMs: number;
  readonly nativeHandleCloseMs: number;
  readonly nativeCallMs: number;
  readonly readElapsedMs: number;
  readonly serializerInitializationMs: number;
  readonly serializerReadyAtEpochMs: number;
  readonly discoveryStartedAtEpochMs: number;
  readonly discoveryAdoptedAtEpochMs: number;
  /** The process enumeration of the discovery (the native snapshot; the field name is kept for the record format). */
  readonly cimEnumerationMs: number;
  readonly ancestryMs: number;
  readonly identityBindingMs: number;
  readonly adoptionMs: number;
  readonly processSnapshotMs: number;
  readonly processEnumerationMs?: number;
  readonly processSnapshotMethod?: 'selected-discovery-rows';
  readonly propertyReadMs: number;
  readonly nativeIdentityReadMs: number;
  readonly nativeMetricsReadMs: number;
  readonly processDisposalMs: number;
  readonly outputOfPreviousFrame?: { readonly atEpochMs: number; readonly serializationMs: number; readonly writeMs: number };
  /** Actual start of this frame's loop iteration. Absent only in records written before the wait fields. */
  readonly loopStartedAtEpochMs?: number;
  /** The Start-Sleep between the previous frame's output and this loop start: requested length and actual bounds. */
  readonly previousSleep?: { readonly requestedMs: number; readonly startedAtEpochMs: number; readonly endedAtEpochMs: number };
}
/**
 * A frame whose first acquisition ended past the age limit (its read ended more than DISCOVERY_INTERVAL_MS after its
 * discovery) is acquired once more in the same loop. The rejected attempt is kept here, never hidden: its discovery,
 * read and age, and when the second acquisition started. The emitted frame is the second acquisition only; if that one
 * is stale too, it is emitted and rejected as before.
 */
export interface StaleRetry {
  readonly rejectedDiscoveredAtEpochMs: number;
  readonly rejectedReadStartedAtEpochMs: number;
  readonly rejectedAtEpochMs: number;
  readonly rejectedAgeMs: number;
  readonly rejectedDiscoveryError: string | null;
  readonly retryStartedAtEpochMs: number;
  /** Windows only: the rejected attempt's stage costs (Stopwatch). */
  readonly rejectedReadElapsedMs?: number;
  readonly rejectedNativeCallMs?: number;
  readonly rejectedDiscoveryExecutionMs?: number;
}
export type RawFrame = Omit<ProcessMemoryFrame, 'phase' | 'processes'> & { readonly processes: readonly ResourceProcessSample[]; readonly readStartedAtEpochMs: number; readonly windowsTiming?: WindowsTiming; readonly linuxDiscoveryComplete?: boolean; readonly linuxDiscovery?: readonly (LinuxAncestry | LinuxAncestryFailure | null)[]; readonly staleRetry?: StaleRetry };
/** One start-up stage of the Windows sampler, written as its own stdout line before the first frame. */
export interface SamplerStage { readonly stage: string; readonly atEpochMs: number; readonly ms: number }
/** The Windows sampler's start-up stages, in the order its PowerShell script reaches them (the first frame's discovery last). */
export const WINDOWS_SAMPLER_STAGES = ['script-start', 'native-ready', 'first-discovery-started', 'first-discovery-complete'] as const;
export interface Sampler {
  readonly frames: RawFrame[]; readonly failures: string[];
  /** Start-up stages seen so far (Windows only). They are never frames. */
  readonly stages?: readonly SamplerStage[];
  /** Spawn time, pid, exit and start-up stages for a failure text. Never part of a judgment. */
  readonly describe?: () => string;
  stop(): Promise<void>;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}
function windowsTiming(value: unknown): value is WindowsTiming {
  return isRecord(value) && ['nativeInitializationMs', 'discoveryInitializationMs',
    'discoveryWorkerEnteredAtEpochMs', 'discoveryExecutionMs', 'nativeHandleOpenMs',
    'nativeCreationQueryMs', 'nativeHandleCloseMs', 'nativeCallMs', 'readElapsedMs', 'serializerInitializationMs', 'serializerReadyAtEpochMs',
    'discoveryStartedAtEpochMs', 'discoveryAdoptedAtEpochMs', 'cimEnumerationMs',
    'ancestryMs', 'identityBindingMs', 'adoptionMs', 'processSnapshotMs',
    'propertyReadMs', 'nativeIdentityReadMs', 'nativeMetricsReadMs', 'processDisposalMs'].every(key =>
    typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0) &&
    (value.processSnapshotMethod === undefined || value.processSnapshotMethod === 'selected-discovery-rows') &&
    (value.processEnumerationMs === undefined || (typeof value.processEnumerationMs === 'number' &&
      Number.isFinite(value.processEnumerationMs) && value.processEnumerationMs >= 0)) &&
    (value.outputOfPreviousFrame === undefined || (isRecord(value.outputOfPreviousFrame) &&
      ['atEpochMs', 'serializationMs', 'writeMs'].every(key => isRecord(value.outputOfPreviousFrame) &&
        typeof value.outputOfPreviousFrame[key] === 'number' && Number.isFinite(value.outputOfPreviousFrame[key]) && value.outputOfPreviousFrame[key] >= 0))) &&
    waitTiming(value);
}
function actualTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
/**
 * Records written before the wait fields have neither. Otherwise every frame has its loop start, a previous
 * sleep exists exactly when the previous frame's output is reported, and the previous frame's end, the sleep
 * and this loop start never run backwards. A missing, negative or reversed time is rejected, never read as no wait.
 */
function waitTiming(value: Record<string, unknown>): boolean {
  const loop = value.loopStartedAtEpochMs, sleep = value.previousSleep, output = value.outputOfPreviousFrame;
  if (loop === undefined) return sleep === undefined;
  if (!actualTime(loop)) return false;
  if (sleep === undefined) return output === undefined;
  if (!isRecord(sleep) || !isRecord(output) || !actualTime(sleep.requestedMs) || !actualTime(sleep.startedAtEpochMs) ||
      !actualTime(sleep.endedAtEpochMs) || !actualTime(output.atEpochMs)) return false;
  return output.atEpochMs <= sleep.startedAtEpochMs && sleep.startedAtEpochMs <= sleep.endedAtEpochMs && sleep.endedAtEpochMs <= loop;
}
/** The rejected attempt's own times agree with its age, the age is past the limit, and it precedes the emitted read. */
function staleRetry(value: unknown, readStartedAtEpochMs: number): value is StaleRetry {
  if (!isRecord(value)) return false;
  const times = ['rejectedDiscoveredAtEpochMs', 'rejectedReadStartedAtEpochMs', 'rejectedAtEpochMs', 'rejectedAgeMs', 'retryStartedAtEpochMs'];
  if (!times.every(key => actualTime(value[key]))) return false;
  const discovered = Number(value.rejectedDiscoveredAtEpochMs), readStarted = Number(value.rejectedReadStartedAtEpochMs);
  const ended = Number(value.rejectedAtEpochMs), retry = Number(value.retryStartedAtEpochMs);
  return Number(value.rejectedAgeMs) === ended - discovered && ended - discovered > DISCOVERY_INTERVAL_MS
    && readStarted <= ended && ended <= retry && retry <= readStartedAtEpochMs
    && (value.rejectedDiscoveryError === null || typeof value.rejectedDiscoveryError === 'string')
    && ['rejectedReadElapsedMs', 'rejectedNativeCallMs', 'rejectedDiscoveryExecutionMs'].every(key => value[key] === undefined || actualTime(value[key]));
}
function processSample(value: unknown): value is ResourceProcessSample {
  return isRecord(value) && typeof value.pid === 'number' && typeof value.created === 'string' &&
    typeof value.parentPid === 'number' && typeof value.name === 'string' &&
    (value.priority === undefined || value.priority === null || typeof value.priority === 'string') &&
    (value.role === undefined || typeof value.role === 'string') &&
    nullableNumber(value.workingSetBytes) && nullableNumber(value.privateBytes) && nullableNumber(value.cpuMilliseconds) &&
    (value.error === null || typeof value.error === 'string');
}
export function rawFrame(value: unknown): RawFrame {
  if (!isRecord(value) || typeof value.atEpochMs !== 'number' || typeof value.discoveredAtEpochMs !== 'number' ||
      typeof value.readStartedAtEpochMs !== 'number' || !Number.isFinite(value.readStartedAtEpochMs) ||
      !Number.isFinite(value.atEpochMs) || value.readStartedAtEpochMs > value.atEpochMs ||
      (value.linuxDiscoveryComplete !== undefined && typeof value.linuxDiscoveryComplete !== 'boolean') ||
      !Array.isArray(value.processes) || !value.processes.every(processSample) ||
      (value.windowsTiming !== undefined && !windowsTiming(value.windowsTiming)) ||
      (windowsTiming(value.windowsTiming) && value.windowsTiming.loopStartedAtEpochMs !== undefined &&
        value.windowsTiming.loopStartedAtEpochMs > value.readStartedAtEpochMs) ||
      (value.discoveryError !== null && typeof value.discoveryError !== 'string') ||
      (value.rootCreated !== undefined && value.rootCreated !== null && typeof value.rootCreated !== 'string') ||
      (value.staleRetry !== undefined && !staleRetry(value.staleRetry, value.readStartedAtEpochMs))) {
    throw new Error('Malformed OS resource sample');
  }
  return { atEpochMs: value.atEpochMs, discoveredAtEpochMs: value.discoveredAtEpochMs,
    readStartedAtEpochMs: value.readStartedAtEpochMs, processes: value.processes,
    discoveryError: value.discoveryError, ...(typeof value.rootCreated === 'string' ? { rootCreated: value.rootCreated } : {}),
    ...(typeof value.linuxDiscoveryComplete === 'boolean' ? { linuxDiscoveryComplete: value.linuxDiscoveryComplete } : {}),
    ...(windowsTiming(value.windowsTiming) ? { windowsTiming: value.windowsTiming } : {}),
    ...(staleRetry(value.staleRetry, value.readStartedAtEpochMs) ? { staleRetry: value.staleRetry } : {}) };
}

/**
 * The acquisition stages of one frame for a failure text: the CI log carries no attachment, so a stale or reversed
 * frame clock names its own discovery, read, loop start, previous sleep and next discovery, and its retry if it had one.
 * Only a text; no judgment uses it.
 */
export function frameClockStages(frame: RawFrame, next?: Pick<RawFrame, 'discoveredAtEpochMs'>): string {
  const timing = frame.windowsTiming, sleep = timing?.previousSleep, retry = frame.staleRetry;
  const stages = `${String(frame.atEpochMs)}: age ${String(frame.atEpochMs - frame.discoveredAtEpochMs)}ms; `
    + `read start age ${String(frame.readStartedAtEpochMs - frame.discoveredAtEpochMs)}ms; `
    + `read ${String(frame.atEpochMs - frame.readStartedAtEpochMs)}ms (native ${timing === undefined ? 'n/a' : `${timing.nativeCallMs.toFixed(1)}ms`}); `
    + `loop start age ${timing?.loopStartedAtEpochMs === undefined ? 'n/a' : `${String(timing.loopStartedAtEpochMs - frame.discoveredAtEpochMs)}ms`}; `
    + `previous sleep ${sleep === undefined ? 'n/a' : `${String(sleep.requestedMs)}->${String(sleep.endedAtEpochMs - sleep.startedAtEpochMs)}ms`}; `
    + `discovery started ${timing === undefined ? 'n/a' : String(timing.discoveryStartedAtEpochMs)} `
    + `exec ${timing === undefined ? 'n/a' : `${timing.discoveryExecutionMs.toFixed(1)}ms`} `
    + `adopted ${timing === undefined ? 'n/a' : String(timing.discoveryAdoptedAtEpochMs)}; `
    + `next frame discovery ${String(next?.discoveredAtEpochMs ?? 'n/a')}`;
  if (retry === undefined) return stages;
  const costs = retry.rejectedReadElapsedMs === undefined ? '' : ` read ${retry.rejectedReadElapsedMs.toFixed(1)}ms`
    + ` native ${(retry.rejectedNativeCallMs ?? 0).toFixed(1)}ms discovery exec ${(retry.rejectedDiscoveryExecutionMs ?? 0).toFixed(1)}ms;`;
  return `${stages}; stale retry: rejected age ${String(retry.rejectedAgeMs)}ms (discovered ${String(retry.rejectedDiscoveredAtEpochMs)}, `
    + `read ${String(retry.rejectedReadStartedAtEpochMs)}->${String(retry.rejectedAtEpochMs)})${costs}, retry ${String(retry.retryStartedAtEpochMs)}`
    + `${retry.rejectedDiscoveryError === null ? '' : `, rejected discovery error ${retry.rejectedDiscoveryError}`}`;
}

/** How often frames were acquired again because the first acquisition was stale, and the rejected ages (for the record). */
export function staleRetrySummary(frames: readonly Pick<RawFrame, 'staleRetry'>[]): {
  readonly count: number; readonly rejectedAgesMs: readonly number[]; readonly maxRejectedAgeMs: number | null;
} {
  const rejectedAgesMs = frames.flatMap(frame => frame.staleRetry === undefined ? [] : [frame.staleRetry.rejectedAgeMs]);
  return { count: rejectedAgesMs.length, rejectedAgesMs, maxRejectedAgeMs: rejectedAgesMs.length === 0 ? null : Math.max(...rejectedAgesMs) };
}
/**
 * One stdout line of the Windows sampler: a start-up stage line (it has `samplerStage`) or a frame.
 * A malformed line of either kind throws and is kept as a failure; a stage is never counted as a frame.
 */
export function readSamplerLine(line: string): { readonly stage: SamplerStage } | { readonly frame: RawFrame } {
  const decoded: unknown = JSON.parse(line);
  if (!isRecord(decoded) || !('samplerStage' in decoded)) return { frame: rawFrame(decoded) };
  if (typeof decoded.samplerStage !== 'string' || !actualTime(decoded.atEpochMs) || !actualTime(decoded.ms)) {
    throw new Error('Malformed sampler stage');
  }
  return { stage: { stage: decoded.samplerStage, atEpochMs: decoded.atEpochMs, ms: decoded.ms } };
}
let ticks: Promise<number> | undefined;
function clockTicks(): Promise<number> {
  ticks ??= promisify(execFile)('getconf', ['CLK_TCK']).then(({ stdout }) => {
    const value = Number(stdout.trim());
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Actual Linux clock tick rate is unavailable');
    return value;
  });
  return ticks;
}

// One fresh handle per read: identity, liveness and metrics refer to the same
// process object. No native handle or dynamic value is cached between frames.
export const windowsNativeSource = `
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;
public static class SamplerNative {
  [DllImport("kernel32.dll")]
  static extern void GetSystemTimePreciseAsFileTime(out long time);
  public static long EpochMilliseconds() {
    long time;
    GetSystemTimePreciseAsFileTime(out time);
    return new DateTimeOffset(DateTime.FromFileTimeUtc(time)).ToUnixTimeMilliseconds();
  }
  [StructLayout(LayoutKind.Sequential)]
  struct MemoryCounters {
    public uint cb, PageFaultCount;
    public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage,
      QuotaPagedPoolUsage, QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage,
      PagefileUsage, PeakPagefileUsage, PrivateUsage;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern SafeProcessHandle OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetProcessTimes(SafeProcessHandle process, out long created,
    out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern uint GetPriorityClass(SafeProcessHandle process);
  [DllImport("psapi.dll", SetLastError=true)]
  static extern bool GetProcessMemoryInfo(SafeProcessHandle process, ref MemoryCounters counters, uint size);
  static Exception Failure(string api) {
    int code = Marshal.GetLastWin32Error();
    return new Win32Exception(code, api + " failed: " + code);
  }
  static SafeProcessHandle Open(int pid) {
    // QUERY_LIMITED_INFORMATION | SYNCHRONIZE, no write/terminate rights.
    SafeProcessHandle handle = OpenProcess(0x00101000, false, pid);
    if (handle.IsInvalid) {
      Exception error = Failure("OpenProcess");
      handle.Dispose();
      throw error;
    }
    return handle;
  }
  static void Alive(SafeProcessHandle handle) {
    uint status = WaitForSingleObject(handle, 0);
    if (status == 0x102) return;
    if (status == 0xffffffff) throw Failure("WaitForSingleObject");
    throw new InvalidOperationException("Process exited during native read");
  }
  static long Times(SafeProcessHandle handle, out double cpu) {
    long created, exited, kernel, user;
    if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw Failure("GetProcessTimes");
    cpu = ((double)kernel + user) / 10000.0;
    return DateTime.FromFileTimeUtc(created).Ticks;
  }
  public static long Identity(int pid) {
    using (SafeProcessHandle handle = Open(pid)) {
      Alive(handle);
      double cpu;
      long ticks = Times(handle, out cpu);
      Alive(handle);
      return ticks;
    }
  }
  public sealed class Sample {
    public ulong WorkingSet, PrivateBytes;
    public double CpuMilliseconds, IdentityMs, MetricsMs, OpenMs, CreationMs, CloseMs;
    public string Priority, Error;
  }
  public static Sample Read(int pid, long expected) {
    Sample sample = new Sample();
    SafeProcessHandle handle = null;
    Stopwatch identity = Stopwatch.StartNew();
    Stopwatch stage = Stopwatch.StartNew();
    try {
      try { handle = Open(pid); }
      finally { sample.OpenMs = stage.Elapsed.TotalMilliseconds; }
      Alive(handle);
      stage.Restart();
      long created;
      double cpu;
      try { created = Times(handle, out cpu); }
      finally { sample.CreationMs = stage.Elapsed.TotalMilliseconds; }
      if (created != expected) throw new InvalidOperationException("PID reused since discovery");
      sample.IdentityMs = identity.Elapsed.TotalMilliseconds;
      identity.Stop();
      stage.Restart();
      try {
        uint priority = GetPriorityClass(handle);
        if (priority == 0) throw Failure("GetPriorityClass");
        if (!Enum.IsDefined(typeof(ProcessPriorityClass), (int)priority)) throw new InvalidOperationException("Unknown priority class");
        sample.Priority = ((ProcessPriorityClass)priority).ToString();
        MemoryCounters memory = new MemoryCounters();
        memory.cb = (uint)Marshal.SizeOf(typeof(MemoryCounters));
        if (!GetProcessMemoryInfo(handle, ref memory, memory.cb)) throw Failure("GetProcessMemoryInfo");
        sample.WorkingSet = memory.WorkingSetSize.ToUInt64();
        sample.PrivateBytes = memory.PrivateUsage.ToUInt64();
        if (Times(handle, out cpu) != expected) throw new InvalidOperationException("Native handle identity changed");
        sample.CpuMilliseconds = cpu;
        Alive(handle);
      } finally { sample.MetricsMs = stage.Elapsed.TotalMilliseconds; }
    } catch (Exception error) {
      sample.Error = error.GetType().FullName + ": " + error.Message;
    } finally {
      if (identity.IsRunning) sample.IdentityMs = identity.Elapsed.TotalMilliseconds;
      stage.Restart();
      if (handle != null) handle.Dispose();
      sample.CloseMs = stage.Elapsed.TotalMilliseconds;
    }
    return sample;
  }

  // Discovery without WMI. One NtQuerySystemInformation snapshot gives every PID, parent PID, creation time
  // (100 ns, the same value GetProcessTimes reports for that process) and image name at one instant. Only the
  // selected PIDs are opened: their creation time is checked on the handle and their command line is read
  // through NtQueryInformationProcess on that same handle (the role comes from it, as before).
  [StructLayout(LayoutKind.Sequential)]
  struct UnicodeString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)]
  struct SystemProcessInformation {
    public uint NextEntryOffset;
    public uint NumberOfThreads;
    public long WorkingSetPrivateSize;
    public uint HardFaultCount;
    public uint NumberOfThreadsHighWatermark;
    public ulong CycleTime;
    public long CreateTime;
    public long UserTime;
    public long KernelTime;
    public UnicodeString ImageName;
    public int BasePriority;
    public IntPtr UniqueProcessId;
    public IntPtr InheritedFromUniqueProcessId;
  }
  [DllImport("ntdll.dll")]
  static extern int NtQuerySystemInformation(int informationClass, IntPtr information, int length, out int returnLength);
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(SafeProcessHandle process, int informationClass, IntPtr information, int length, out int returnLength);
  const int SystemProcessInformationClass = 5;
  const int ProcessCommandLineInformationClass = 60;
  const int StatusInfoLengthMismatch = unchecked((int)0xC0000004);
  const int StatusBufferOverflow = unchecked((int)0x80000005);
  const int StatusBufferTooSmall = unchecked((int)0xC0000023);
  static bool BufferTooSmall(int status) {
    return status == StatusInfoLengthMismatch || status == StatusBufferOverflow || status == StatusBufferTooSmall;
  }
  public sealed class ProcessRow {
    public int ProcessId, ParentProcessId;
    public long CreatedTicks;
    public string Name;
  }
  public static ProcessRow[] Processes() {
    int length = 1 << 20;
    for (int attempt = 0; attempt < 8; attempt++) {
      IntPtr buffer = Marshal.AllocHGlobal(length);
      try {
        int needed;
        int status = NtQuerySystemInformation(SystemProcessInformationClass, buffer, length, out needed);
        if (BufferTooSmall(status)) { length = Math.Max(needed, length) * 2; continue; }
        if (status != 0) throw new InvalidOperationException("NtQuerySystemInformation failed: 0x" + status.ToString("X8", CultureInfo.InvariantCulture));
        List<ProcessRow> rows = new List<ProcessRow>();
        long offset = 0;
        while (true) {
          SystemProcessInformation entry = (SystemProcessInformation)Marshal.PtrToStructure(
            new IntPtr(buffer.ToInt64() + offset), typeof(SystemProcessInformation));
          ProcessRow row = new ProcessRow();
          row.ProcessId = entry.UniqueProcessId.ToInt32();
          row.ParentProcessId = entry.InheritedFromUniqueProcessId.ToInt32();
          row.CreatedTicks = DateTime.FromFileTimeUtc(entry.CreateTime).Ticks;
          row.Name = entry.ImageName.Buffer == IntPtr.Zero ? "" : Marshal.PtrToStringUni(entry.ImageName.Buffer, entry.ImageName.Length / 2);
          rows.Add(row);
          if (entry.NextEntryOffset == 0) break;
          offset += entry.NextEntryOffset;
        }
        return rows.ToArray();
      } finally { Marshal.FreeHGlobal(buffer); }
    }
    throw new InvalidOperationException("NtQuerySystemInformation buffer size did not settle");
  }
  // A command line that cannot be read stays null, as the former WMI enumeration reported an unreadable one.
  static string CommandLine(SafeProcessHandle handle) {
    int length = 4096;
    for (int attempt = 0; attempt < 6; attempt++) {
      IntPtr buffer = Marshal.AllocHGlobal(length);
      try {
        int needed;
        int status = NtQueryInformationProcess(handle, ProcessCommandLineInformationClass, buffer, length, out needed);
        if (BufferTooSmall(status)) { length = Math.Max(needed, length * 2); continue; }
        if (status != 0) return null;
        UnicodeString text = (UnicodeString)Marshal.PtrToStructure(buffer, typeof(UnicodeString));
        return text.Buffer == IntPtr.Zero ? "" : Marshal.PtrToStringUni(text.Buffer, text.Length / 2);
      } finally { Marshal.FreeHGlobal(buffer); }
    }
    return null;
  }
  static string Role(string commandLine) {
    if (commandLine == null) return "main-or-native";
    Match type = Regex.Match(commandLine, "--type=([a-z-]+)", RegexOptions.IgnoreCase);
    if (type.Success) return type.Groups[1].Value;
    if (commandLine.IndexOf("-contentproc", StringComparison.OrdinalIgnoreCase) >= 0) return "firefox-content";
    return "main-or-native";
  }
  public sealed class KnownProcess {
    public int Pid, ParentPid;
    public string Created, Name, Role;
  }
  public sealed class Discovery {
    public KnownProcess[] Known;
    public string RootCreated;
    public double EnumerationMs, AncestryMs, IdentityBindingMs;
  }
  /** The failing stage and the snapshot row that could not be bound. */
  public sealed class DiscoveryFailure : Exception {
    public readonly string Stage;
    public readonly ProcessRow Row;
    public DiscoveryFailure(string stage, ProcessRow row, string message, Exception inner) : base(message, inner) {
      Stage = stage;
      Row = row;
    }
  }
  // The same handle gives the creation time compared with the snapshot and, when asked, the command line.
  static long Bind(ProcessRow row, bool readCommandLine, out string commandLine) {
    commandLine = null;
    using (SafeProcessHandle handle = Open(row.ProcessId)) {
      Alive(handle);
      double cpu;
      long ticks = Times(handle, out cpu);
      if (ticks != row.CreatedTicks) throw new InvalidOperationException("PID reused during discovery");
      if (readCommandLine) commandLine = CommandLine(handle);
      Alive(handle);
      return ticks;
    }
  }
  public static Discovery Discover(int rootPid, bool includeRoot, int samplerPid) {
    string stageName = "process-enumeration";
    ProcessRow current = null;
    try {
      Discovery result = new Discovery();
      Stopwatch stage = Stopwatch.StartNew();
      ProcessRow[] all = Processes();
      result.EnumerationMs = stage.Elapsed.TotalMilliseconds;
      stage.Restart();
      stageName = "root-selection";
      ProcessRow root = null;
      int rootRows = 0;
      foreach (ProcessRow row in all) if (row.ProcessId == rootPid) { root = row; rootRows++; }
      if (rootRows != 1) throw new InvalidOperationException("Root process creation identity missing");
      stageName = "descendant-enumeration";
      HashSet<int> ids = new HashSet<int>();
      ids.Add(rootPid);
      Dictionary<int, ProcessRow> ancestry = new Dictionary<int, ProcessRow>();
      ancestry[rootPid] = root;
      bool added;
      do {
        added = false;
        foreach (ProcessRow row in all) {
          if (!ids.Contains(row.ParentProcessId) || row.ProcessId == samplerPid) continue;
          // ParentProcessId can refer to a recycled PID. An older child cannot
          // belong to this parent instance; do not open or follow that process.
          if (row.CreatedTicks < ancestry[row.ParentProcessId].CreatedTicks) continue;
          if (ids.Add(row.ProcessId)) { ancestry[row.ProcessId] = row; added = true; }
        }
      } while (added);
      result.AncestryMs = stage.Elapsed.TotalMilliseconds;
      stage.Restart();
      stageName = "root-native-binding";
      current = root;
      string ignored;
      result.RootCreated = Bind(root, false, out ignored).ToString(CultureInfo.InvariantCulture);
      Dictionary<int, string> nativeIdentities = new Dictionary<int, string>();
      nativeIdentities[rootPid] = result.RootCreated;
      List<KnownProcess> known = new List<KnownProcess>();
      List<ProcessRow> knownRows = new List<ProcessRow>();
      stageName = "descendant-native-binding";
      foreach (ProcessRow row in all) {
        if (!ids.Contains(row.ProcessId) || (!includeRoot && row.ProcessId == rootPid)) continue;
        current = row;
        string commandLine;
        KnownProcess entry = new KnownProcess();
        entry.Created = Bind(row, true, out commandLine).ToString(CultureInfo.InvariantCulture);
        entry.Pid = row.ProcessId;
        entry.ParentPid = row.ParentProcessId;
        entry.Name = row.Name;
        entry.Role = Role(commandLine);
        nativeIdentities[row.ProcessId] = entry.Created;
        known.Add(entry);
        knownRows.Add(row);
      }
      stageName = "native-parent-child-order";
      for (int index = 0; index < known.Count; index++) {
        if (known[index].Pid == rootPid) continue;
        current = knownRows[index];
        string parentIdentity;
        if (!nativeIdentities.TryGetValue(known[index].ParentPid, out parentIdentity)
          || long.Parse(known[index].Created, CultureInfo.InvariantCulture) < long.Parse(parentIdentity, CultureInfo.InvariantCulture)) {
          throw new InvalidOperationException("Native parent-child creation order invalid");
        }
      }
      stageName = "root-native-recheck";
      current = root;
      if (Identity(rootPid).ToString(CultureInfo.InvariantCulture) != result.RootCreated) throw new InvalidOperationException("Root PID reused during discovery");
      result.IdentityBindingMs = stage.Elapsed.TotalMilliseconds;
      result.Known = known.ToArray();
      return result;
    } catch (Exception error) {
      throw new DiscoveryFailure(stageName, current, error.Message, error);
    }
  }
  // One-off evidence of a root and its immediate parent for a measurement record (readResidentSampler).
  // Property names are those of the former evidence rows; the creation time of the process list is
  // CimCreatedUtc and the handle creation time is NativeCreatedTicks.
  public sealed class ProcessEvidence {
    public int ProcessId, ParentProcessId;
    public long CreatedTicks;
    public string CommandLine, Name, CimCreatedUtc, NativeCreatedTicks;
  }
  static ProcessEvidence Evidence(ProcessRow row) {
    ProcessEvidence evidence = new ProcessEvidence();
    evidence.ProcessId = row.ProcessId;
    evidence.ParentProcessId = row.ParentProcessId;
    evidence.CreatedTicks = row.CreatedTicks;
    evidence.Name = row.Name;
    evidence.CimCreatedUtc = new DateTime(row.CreatedTicks, DateTimeKind.Utc).ToString("o", CultureInfo.InvariantCulture);
    try {
      using (SafeProcessHandle handle = Open(row.ProcessId)) {
        double cpu;
        evidence.NativeCreatedTicks = Times(handle, out cpu).ToString(CultureInfo.InvariantCulture);
        evidence.CommandLine = CommandLine(handle);
      }
    } catch (Exception) {
      // A process that cannot be opened keeps null handle values, as the former evidence did.
    }
    return evidence;
  }
  public static ProcessEvidence[] RootContext(int rootPid) {
    ProcessRow[] all = Processes();
    ProcessRow root = null;
    foreach (ProcessRow row in all) if (row.ProcessId == rootPid) root = row;
    if (root == null) throw new InvalidOperationException("Root CIM identity missing");
    List<ProcessEvidence> rows = new List<ProcessEvidence>();
    rows.Add(Evidence(root));
    foreach (ProcessRow row in all) if (row.ProcessId == root.ParentProcessId) { rows.Add(Evidence(row)); break; }
    return rows.ToArray();
  }
  // One-off evidence of one exact PID, or of every process when pid is 0 (a command-line search; namedSavePointsFlow).
  public static ProcessEvidence[] ProcessesWithEvidence(int pid) {
    List<ProcessEvidence> rows = new List<ProcessEvidence>();
    foreach (ProcessRow row in Processes()) if (pid == 0 || row.ProcessId == pid) rows.Add(Evidence(row));
    return rows.ToArray();
  }
}
`;

/**
 * 根からの全子孫の探索。個別PID/生成時刻と読取失敗を保持する。探索は native のプロセス一覧
 * (SamplerNative.Discover、WMI を使わない。外部検査の Windows で WMI の探索 1 回が最大 1746ms かかり、
 * 古い探索・起動の停止で落ちたため)で、Linux の linuxFrame と同じく frame ごとに読取りの直前に同期で行う
 * (手元で数 ms)。frame はその frame の探索の組だけを読み、探索の時刻は実際の完了時刻のまま記録する。
 * 外部検査で採取のプロセスが 0.3〜0.8 秒止まっても、古さは探索と読取りの所要だけになる。
 */
export function windowsSampler(rootPid: number, includeRoot: boolean, stall?: SamplerStall): Sampler {
  const script = windowsSamplerScript(rootPid, includeRoot, stall);
  const spawnedAt = Date.now();
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const frames: RawFrame[] = [], failures: string[] = [], stages: SamplerStage[] = [];
  let exited: string | null = null;
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1);
      try {
        const read = readSamplerLine(line);
        if ('frame' in read) frames.push(read.frame);
        else stages.push(read.stage);
      } catch (error: unknown) { failures.push(`invalid sampler JSON: ${String(error)}`); }
      newline = pending.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { failures.push(chunk); });
  child.on('error', (error: Error) => { failures.push(error.message); });
  let stopping = false;
  const closed = new Promise<void>(resolve => { child.on('close', (code, signal) => {
    exited = `${String(code)}/${String(signal)} +${String(Date.now() - spawnedAt)}ms`;
    if (!stopping) failures.push(`sampler exited unexpectedly: ${String(code)}`);
    resolve();
  }); });
  const describe = (): string => `spawned ${String(spawnedAt)} pid ${String(child.pid ?? 'none')} exit ${exited ?? 'running'}; stages ${
    stages.length === 0 ? 'none' : stages.map(entry => `${entry.stage} +${String(entry.atEpochMs - spawnedAt)}ms (${entry.ms.toFixed(1)}ms)`).join(', ')}`;
  return { frames, failures, stages, describe, async stop() { stopping = true; child.kill(); await closed; } };
}

/**
 * Sampler self-test only (process-resource-sampler.spec.ts): stop the sampler process for `ms` right after the discovery of
 * frame `frame` (0-based), in the listed acquisition attempts (0 first, 1 the one retry). Measurement flows never pass it,
 * and without it the program has no such line.
 */
export interface SamplerStall { readonly frame: number; readonly attempts: readonly number[]; readonly ms: number }
function samplerStallLine(stall: SamplerStall | undefined): string {
  if (stall === undefined) return '';
  for (const value of [stall.frame, stall.ms, ...stall.attempts]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Sampler stall needs non-negative integers');
  }
  return `if($frameIndex -eq ${String(stall.frame)} -and @(${stall.attempts.map(String).join(',')}) -contains $attempt){Start-Sleep -Milliseconds ${String(stall.ms)}}`;
}

/** The PowerShell program of the Windows sampler (one JSON line per start-up stage and per frame on stdout). */
export function windowsSamplerScript(rootPid: number, includeRoot: boolean, stall?: SamplerStall): string {
  return `
$ErrorActionPreference='Stop'
# Node decodes both redirected streams as UTF-8; do not emit the host OEM code page.
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$OutputEncoding=[Console]::OutputEncoding
# Each start-up stage is its own JSON line (samplerStage), never a frame: a sampler that never reaches its
# first frame still shows how far it started. Built without ConvertTo-Json, whose set-up is timed below.
function Write-SamplerStage([string]$stage,[long]$atEpochMs,[double]$ms){
  [Console]::Out.WriteLine('{"samplerStage":"'+$stage+'","atEpochMs":'+$atEpochMs+',"ms":'+$ms.ToString('0.0',[Globalization.CultureInfo]::InvariantCulture)+'}')
}
# Before Add-Type only the framework clock exists; every later stage uses the precise clock.
Write-SamplerStage 'script-start' ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) 0
# Compile API declarations only. No process/PID is read during initialization.
$nativeSetupClock=[System.Diagnostics.Stopwatch]::StartNew()
Add-Type -TypeDefinition @'
${windowsNativeSource}
'@
$nativeInitializationMs=$nativeSetupClock.Elapsed.TotalMilliseconds
Write-SamplerStage 'native-ready' ([SamplerNative]::EpochMilliseconds()) $nativeInitializationMs
# Initialize JSON code/metadata with constants, before discovery or any real
# sample. This is not a process read, and no measured frame is discarded.
$serializerClock=[System.Diagnostics.Stopwatch]::StartNew()
[void](@{setup='json-output';processes=@();text=''} | ConvertTo-Json -Depth 5 -Compress)
$serializerInitializationMs=$serializerClock.Elapsed.TotalMilliseconds
$serializerReadyAt=[SamplerNative]::EpochMilliseconds()
$rootProcessId=${rootPid}
$includeRoot=$${includeRoot ? 'true' : 'false'}
$samplerProcessId=$PID
$known=@()
$discoveredAt=0L
$discoveryError=$null
$rootCreated=$null
$initialRootCreated=$null
$discoveryTiming=$null
# The discovery runs in the sampling loop of every frame (no discovery runspace); the field stays for the record format.
$discoveryInitializationMs=0.0
# One native discovery per frame, as linuxFrame does: the frame reads the PID set found in its own loop,
# so its age is that discovery and the read only. SamplerNative.Discover keeps the root tree, sampler
# exclusion, creation order rule, native identity binding and command-line role. A failed discovery keeps
# the previous set and reports the failure in this frame (the age of the previous set keeps growing).
function Invoke-FrameDiscovery([long]$startedAt){
  $executionClock=[System.Diagnostics.Stopwatch]::StartNew()
  try{
    $found=[SamplerNative]::Discover([int]$rootProcessId,[bool]$includeRoot,[int]$samplerProcessId)
    $completedAt=[SamplerNative]::EpochMilliseconds()
    $executionMs=$executionClock.Elapsed.TotalMilliseconds
    $adoptionClock=[System.Diagnostics.Stopwatch]::StartNew()
    if($null -eq $script:initialRootCreated){$script:initialRootCreated=$found.RootCreated}
    if($script:initialRootCreated -ne $found.RootCreated){
      $script:discoveryError=@{message='Root PID reused after sampler start';exceptionType=$null;errorId=$null;
        context=@{stage='root-identity'}} | ConvertTo-Json -Depth 4 -Compress
      return
    }
    $script:known=@(foreach($entry in $found.Known){
      @{pid=$entry.Pid;created=$entry.Created;parentPid=$entry.ParentPid;name=$entry.Name;role=$entry.Role}
    })
    $script:rootCreated=$found.RootCreated
    $script:discoveredAt=$completedAt
    $script:discoveryError=$null
    $adoptedAt=[SamplerNative]::EpochMilliseconds()
    # cimEnumerationMs keeps its frame field name; it is the time of the native process snapshot.
    $script:discoveryTiming=@{discoveryStartedAtEpochMs=$startedAt;discoveryAdoptedAtEpochMs=$adoptedAt;
      cimEnumerationMs=$found.EnumerationMs;ancestryMs=$found.AncestryMs;discoveryWorkerEnteredAtEpochMs=$startedAt;
      discoveryExecutionMs=$executionMs;identityBindingMs=$found.IdentityBindingMs;adoptionMs=$adoptionClock.Elapsed.TotalMilliseconds}
  }catch{
    # Preserve the failure as a failing discoveryError, with the snapshot row that
    # could not be bound. A missing PID is not evidence of a normal exit.
    $failure=$_.Exception
    if($null -ne $failure.InnerException -and $failure.InnerException -is [SamplerNative+DiscoveryFailure]){$failure=$failure.InnerException}
    $context=@{stage='discovery';pid=$null;name=$null;parentPid=$null;cimCreatedUtc=$null;cimCreatedTicks=$null;commandLine=$null}
    if($failure -is [SamplerNative+DiscoveryFailure]){
      $context.stage=$failure.Stage
      if($null -ne $failure.Row){
        # The context keys are kept; the creation time is the native snapshot value.
        $context.pid=$failure.Row.ProcessId;$context.name=$failure.Row.Name;$context.parentPid=$failure.Row.ParentProcessId
        $context.cimCreatedUtc=(New-Object DateTime($failure.Row.CreatedTicks,[DateTimeKind]::Utc)).ToString('o')
        $context.cimCreatedTicks=$failure.Row.CreatedTicks.ToString()
      }
    }
    $script:discoveryError=@{message=$failure.Message;exceptionType=$failure.GetType().FullName;
      errorId=$_.FullyQualifiedErrorId;context=$context} | ConvertTo-Json -Depth 4 -Compress
  }
}
$previousOutput=$null
$previousSleep=$null
$firstFrame=$true
$frameIndex=0
while($true){
  $loopStartedAt=[SamplerNative]::EpochMilliseconds()
  # A frame whose first acquisition ends past the age limit is acquired once more in this same loop (the sampler process
  # stopped for seconds inside one frame on CI). The rejected attempt is written into the frame as staleRetry, never hidden;
  # a second stale acquisition is emitted and rejected as before. Nothing is filled in: the gap stays in the frame times.
  $staleRetry=$null
  for($attempt=0;$attempt -lt 2;$attempt++){
  $discoveryStartedAt=[SamplerNative]::EpochMilliseconds()
  if($firstFrame){Write-SamplerStage 'first-discovery-started' $discoveryStartedAt 0}
  Invoke-FrameDiscovery $discoveryStartedAt
  if($firstFrame){
    $firstDiscoveryCompletedAt=[SamplerNative]::EpochMilliseconds()
    Write-SamplerStage 'first-discovery-complete' $firstDiscoveryCompletedAt ($firstDiscoveryCompletedAt-$discoveryStartedAt)
    $firstFrame=$false
  }
  ${samplerStallLine(stall)}
  # Precise actual UTC at the original acquisition boundary. Framework UtcNow
  # has coarser resolution than Stopwatch; never infer UTC from elapsed time.
  $readStartedAt=[SamplerNative]::EpochMilliseconds()
  $readClock=[System.Diagnostics.Stopwatch]::StartNew()
  $snapshotClock=[System.Diagnostics.Stopwatch]::StartNew()
  # Discovery already fixed the ancestry and creation identities. Do not enumerate all OS wrappers again.
  # SamplerNative.Read opens only the selected PID and checks liveness/creation on that same handle.
  $selected=@($known)
  $processEnumerationMs=$null
  $processSnapshotMs=$snapshotClock.Elapsed.TotalMilliseconds
  $propertyClock=[System.Diagnostics.Stopwatch]::StartNew()
  $nativeIdentityReadMs=0.0
  $nativeMetricsReadMs=0.0
  $nativeHandleOpenMs=0.0
  $nativeCreationQueryMs=0.0
  $nativeHandleCloseMs=0.0
  $nativeCallMs=0.0
  $rows=@(foreach($entry in $selected){
    $identity=$entry.created
    try{
      $nativeCallClock=[System.Diagnostics.Stopwatch]::StartNew()
      try{$native=[SamplerNative]::Read([int]$entry.pid,[long]$identity)}
      finally{$nativeCallMs+=$nativeCallClock.Elapsed.TotalMilliseconds}
      $nativeIdentityReadMs+=$native.IdentityMs
      $nativeMetricsReadMs+=$native.MetricsMs
      $nativeHandleOpenMs+=$native.OpenMs
      $nativeCreationQueryMs+=$native.CreationMs
      $nativeHandleCloseMs+=$native.CloseMs
      if($null -ne $native.Error){throw $native.Error}
      @{pid=[int]$entry.pid;created=$identity;parentPid=[int]$entry.parentPid;name=$entry.name;
        priority=$native.Priority;role=$entry.role;workingSetBytes=$native.WorkingSet;privateBytes=$native.PrivateBytes;
        cpuMilliseconds=$native.CpuMilliseconds;error=$null}
    }catch{
      @{pid=[int]$entry.pid;created=$identity;parentPid=[int]$entry.parentPid;name=$entry.name;
        priority=$null;role='unknown';workingSetBytes=$null;privateBytes=$null;cpuMilliseconds=$null;error=$_.Exception.Message}
    }
  })
  $propertyReadMs=$propertyClock.Elapsed.TotalMilliseconds
  $disposalClock=[System.Diagnostics.Stopwatch]::StartNew()
  # No System.Diagnostics.Process wrappers are owned by this direct-handle path.
  $processDisposalMs=$disposalClock.Elapsed.TotalMilliseconds
  $timing=if($null -ne $discoveryTiming){$discoveryTiming.Clone()}else{$null}
  if($null -ne $timing){
    $timing.nativeInitializationMs=$nativeInitializationMs
    $timing.discoveryInitializationMs=$discoveryInitializationMs
    $timing.serializerInitializationMs=$serializerInitializationMs
    $timing.serializerReadyAtEpochMs=$serializerReadyAt
    $timing.processSnapshotMethod='selected-discovery-rows'
    $timing.processSnapshotMs=$processSnapshotMs
    if($null -ne $processEnumerationMs){$timing.processEnumerationMs=$processEnumerationMs}
    $timing.propertyReadMs=$propertyReadMs
    $timing.nativeIdentityReadMs=$nativeIdentityReadMs
    $timing.nativeMetricsReadMs=$nativeMetricsReadMs
    $timing.nativeHandleOpenMs=$nativeHandleOpenMs
    $timing.nativeCreationQueryMs=$nativeCreationQueryMs
    $timing.nativeHandleCloseMs=$nativeHandleCloseMs
    $timing.nativeCallMs=$nativeCallMs
    $timing.processDisposalMs=$processDisposalMs
    if($null -ne $previousOutput){$timing.outputOfPreviousFrame=$previousOutput}
    $timing.loopStartedAtEpochMs=$loopStartedAt
    if($null -ne $previousSleep){$timing.previousSleep=$previousSleep}
    $timing.readElapsedMs=$readClock.Elapsed.TotalMilliseconds
  }
  $frame=@{atEpochMs=[SamplerNative]::EpochMilliseconds();readStartedAtEpochMs=$readStartedAt;discoveredAtEpochMs=$discoveredAt;
    processes=$rows;discoveryError=$discoveryError;rootCreated=$rootCreated}
  if($null -ne $timing){$frame.windowsTiming=$timing}
  if($attempt -eq 0 -and ($frame.atEpochMs-$discoveredAt) -gt ${DISCOVERY_INTERVAL_MS}){
    $staleRetry=@{rejectedDiscoveredAtEpochMs=$discoveredAt;rejectedReadStartedAtEpochMs=$readStartedAt;rejectedAtEpochMs=$frame.atEpochMs;
      rejectedAgeMs=$frame.atEpochMs-$discoveredAt;rejectedDiscoveryError=$discoveryError;
      rejectedReadElapsedMs=$readClock.Elapsed.TotalMilliseconds;rejectedNativeCallMs=$nativeCallMs;
      rejectedDiscoveryExecutionMs=$(if($null -ne $discoveryTiming){$discoveryTiming.discoveryExecutionMs}else{0.0});
      retryStartedAtEpochMs=[SamplerNative]::EpochMilliseconds()}
    continue
  }
  break
  }
  if($null -ne $staleRetry){$frame.staleRetry=$staleRetry}
  # Serialization/output can delay the next frame. Report their actual costs in
  # that next frame, explicitly keyed to this frame, without serializing twice.
  $outputClock=[System.Diagnostics.Stopwatch]::StartNew()
  $serialized=$frame | ConvertTo-Json -Depth 5 -Compress
  $serializationMs=$outputClock.Elapsed.TotalMilliseconds
  $outputClock.Restart()
  # Bypass ConsoleHost/Out-Default formatting of a PowerShell pipeline string.
  # Write the same complete UTF-8 JSON line; pipe backpressure is still timed.
  [Console]::Out.WriteLine($serialized)
  $previousOutput=@{atEpochMs=$frame.atEpochMs;serializationMs=$serializationMs;writeMs=$outputClock.Elapsed.TotalMilliseconds}
  $frameIndex++
  # The same deadline rule as linuxSampler: the read time is part of the 100ms period.
  # One clock read gives the deadline and the recorded sleep start. The next frame reports the requested and
  # the actual sleep, so a gap is placed in the sleep or between the wake-up and the loop by records, not inference.
  $sleepStartedAt=[SamplerNative]::EpochMilliseconds()
  $sleepRequestedMs=[Math]::Max(1,${INTERVAL_MS}-($sleepStartedAt-$loopStartedAt))
  Start-Sleep -Milliseconds $sleepRequestedMs
  $previousSleep=@{requestedMs=$sleepRequestedMs;startedAtEpochMs=$sleepStartedAt;endedAtEpochMs=[SamplerNative]::EpochMilliseconds()}
}`;
}

export type LinuxFileReader = (pid: number, file: 'stat' | 'status' | 'cmdline') => Promise<string>;
const linuxRead: LinuxFileReader = (pid, file) => readFile(`/proc/${pid}/${file}`, 'utf8');
function linuxErrorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === 'string' ? error.code : null;
}
export interface LinuxAncestry {
  readonly pid: number; readonly parentPid: number; readonly created: string; readonly name: string;
  readonly state?: string; readonly rawStat?: string;
  readonly statReadStartedAtEpochMs?: number; readonly statReadEndedAtEpochMs?: number;
}
export interface LinuxAncestryFailure {
  readonly pid: number; readonly errorCode: string | null; readonly error: string; readonly rawStat: string | null;
}
/** The real stat parser is shared by discovery and the selected-PID reader. */
export function linuxAncestryFromStat(pid: number, stat: string): LinuxAncestry {
  const parsed = linuxProcessTreeDiscovery(pid, [{ pid, stat, errorCode: null, error: null }]);
  if (parsed.discoveryError !== null) throw new Error(parsed.discoveryError);
  const end = stat.lastIndexOf(') '), fields = stat.slice(end + 2).trim().split(/\s+/u);
  return { pid, parentPid: Number(fields[1]), created: fields[19] ?? '',
    name: stat.slice(stat.indexOf('(') + 1, end), state: fields[0] ?? '', rawStat: stat };
}

/** One validator for acquisition and downstream disappearance handling. A flag alone is never evidence. */
export function linuxTerminalMeasurement(entry: LinuxAncestry, evidence: unknown,
  frame: Pick<RawFrame, 'readStartedAtEpochMs' | 'atEpochMs'>): ResourceProcessSample | null {
  if (!isRecord(evidence) || evidence.kind !== 'linux-discovery-stat-z-rss-zero'
    || typeof evidence.rawStat !== 'string' || evidence.workingSetSource !== 'stat-rss-zero'
    || evidence.privateSource !== 'subset-of-zero-rss' || typeof evidence.ticksPerSecond !== 'number'
    || !Number.isSafeInteger(evidence.ticksPerSecond) || evidence.ticksPerSecond <= 0
    || !Number.isSafeInteger(entry.pid) || entry.pid <= 0 || !Number.isSafeInteger(entry.parentPid) || entry.parentPid < 0) return null;
  const start = evidence.readStartedAtEpochMs, end = evidence.readEndedAtEpochMs;
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || !Number.isSafeInteger(frame.readStartedAtEpochMs) || !Number.isSafeInteger(frame.atEpochMs)
    || evidence.frameReadStartedAtEpochMs !== frame.readStartedAtEpochMs || frame.readStartedAtEpochMs <= 0
    || start < frame.readStartedAtEpochMs || end < start || end > frame.atEpochMs) return null;
  let parsed: LinuxAncestry;
  try { parsed = linuxAncestryFromStat(entry.pid, evidence.rawStat); } catch { return null; }
  const fields = evidence.rawStat.slice(evidence.rawStat.lastIndexOf(') ') + 2).trim().split(/\s+/u);
  // Modern /proc stat has fields 1..52; the former 20-token fixture has no RSS and is insufficient.
  if (fields.length < 50 || fields[0] !== 'Z' || fields[21] !== '0'
    || fields.slice(1).some(value => !/^-?\d+$/u.test(value))
    || !/^\d+$/u.test(fields[11] ?? '') || !/^\d+$/u.test(fields[12] ?? '')
    || parsed.created !== entry.created || parsed.parentPid !== entry.parentPid || parsed.name !== entry.name) return null;
  const userTicks = Number(fields[11]), systemTicks = Number(fields[12]), nice = Number(fields[16]);
  const totalTicks = userTicks + systemTicks;
  const cpuMilliseconds = totalTicks * 1000 / evidence.ticksPerSecond;
  if (!Number.isSafeInteger(userTicks) || !Number.isSafeInteger(systemTicks) || !Number.isSafeInteger(totalTicks)
    || !Number.isSafeInteger(nice) || !Number.isFinite(cpuMilliseconds) || cpuMilliseconds < 0) return null;
  const linuxTerminal: LinuxTerminalEvidence = { kind: 'linux-discovery-stat-z-rss-zero', rawStat: evidence.rawStat,
    frameReadStartedAtEpochMs: frame.readStartedAtEpochMs, readStartedAtEpochMs: start, readEndedAtEpochMs: end,
    ticksPerSecond: evidence.ticksPerSecond, workingSetSource: 'stat-rss-zero', privateSource: 'subset-of-zero-rss' };
  return { pid: entry.pid, parentPid: entry.parentPid, created: entry.created, name: entry.name,
    priority: `nice=${String(nice)}`, workingSetBytes: 0, privateBytes: 0, cpuMilliseconds, error: null, linuxTerminal };
}

/** Keep missing counters unknown, including a possible zombie; state alone never supplies bytes. */
export async function readLinuxProcess(pid: number, ticksPerSecond: number, read: LinuxFileReader = linuxRead): Promise<ResourceProcessSample> {
  let created = '', parentPid = 0;
  let statBefore: string | null = null, status: string | null = null, statAfter: string | null = null;
  let stateBefore: string | null = null, stateAfter: string | null = null;
  let stage: LinuxReading['stage'] = 'stat-before';
  const reading = (errorCode: string | null): LinuxReading => ({ statBefore, status, statAfter, stateBefore, stateAfter, stage, errorCode });
  try {
    if (!Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0) throw new Error('Invalid actual Linux clock tick rate');
    statBefore = await read(pid, 'stat');
    const entry = linuxAncestryFromStat(pid, statBefore);
    created = entry.created; parentPid = entry.parentPid; stateBefore = entry.state ?? null;
    const fields = statBefore.slice(statBefore.lastIndexOf(') ') + 2).trim().split(/\s+/u);
    stage = 'status'; status = await read(pid, 'status');
    stage = 'cmdline'; const command = await read(pid, 'cmdline');
    const role = /--type=([a-z-]+)/.exec(command)?.[1] ?? (command.includes('-contentproc') ? 'firefox-content' : 'main-or-native');
    const bytes = (key: string): number | null => {
      const raw = new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(status ?? '')?.[1];
      return raw === undefined ? null : Number(raw) * 1024;
    };
    stage = 'stat-after'; statAfter = await read(pid, 'stat');
    const after = linuxAncestryFromStat(pid, statAfter); stateAfter = after.state ?? null;
    stage = 'identity';
    if (after.created !== created) throw new Error('PID reused during read');
    stage = 'complete';
    return { pid, created, parentPid, name: entry.name,
      priority: fields[16] === undefined ? null : `nice=${fields[16]}`, role,
      workingSetBytes: bytes('VmRSS'), privateBytes: bytes('RssAnon'),
      cpuMilliseconds: (Number(fields[11]) + Number(fields[12])) * 1000 / ticksPerSecond,
      error: bytes('VmRSS') === null || bytes('RssAnon') === null ? 'Missing Linux memory counters in actual status' : null, linuxReading: reading(null) };
  } catch (error: unknown) {
    return { pid, created, parentPid, name: '', workingSetBytes: null, privateBytes: null, cpuMilliseconds: null,
      error: String(error), linuxReading: reading(linuxErrorCode(error)) };
  }
}
export async function linuxProcess(pid: number): Promise<ResourceProcessSample> {
  try { return await readLinuxProcess(pid, await clockTicks()); }
  catch (error: unknown) {
    return { pid, created: '', parentPid: 0, name: '', workingSetBytes: null, privateBytes: null, cpuMilliseconds: null, error: String(error) };
  }
}

export async function linuxAncestry(pid: number, read: LinuxFileReader = linuxRead, now: () => number = () => Date.now()): Promise<LinuxAncestry | LinuxAncestryFailure> {
  let stat: string | null = null;
  const readStartedAtMs = now();
  try { stat = await read(pid, 'stat'); return { ...linuxAncestryFromStat(pid, stat), statReadStartedAtEpochMs: readStartedAtMs, statReadEndedAtEpochMs: now() }; }
  catch (error: unknown) { return { pid, rawStat: stat, errorCode: linuxErrorCode(error), error: String(error) }; }
}

/** A selected PID keeps its discovered identity: an exit or PID reuse after discovery is a failed row, never dropped or 0. */
export function linuxRowSinceDiscovery(entry: LinuxAncestry, sample: ResourceProcessSample): ResourceProcessSample {
  if (sample.created === entry.created) return sample;
  return { pid: entry.pid, created: entry.created, parentPid: entry.parentPid, name: entry.name,
    workingSetBytes: null, privateBytes: null, cpuMilliseconds: null,
    error: `${sample.created === '' ? 'PID unavailable' : 'PID reused'} after /proc discovery${sample.error === null ? '' : `: ${sample.error}`}`,
    ...(sample.linuxReading === undefined ? {} : { linuxReading: sample.linuxReading }) };
}

export interface LinuxProcSource {
  readonly list: () => Promise<readonly string[]>;
  readonly ancestry: (pid: number) => Promise<LinuxAncestry | LinuxAncestryFailure | null>;
  readonly process: (pid: number) => Promise<ResourceProcessSample>;
  readonly now: () => number;
  readonly ticksPerSecond?: () => Promise<number>;
}
const linuxProc: LinuxProcSource = { list: () => readdir('/proc'), ancestry: linuxAncestry, process: linuxProcess, now: () => Date.now(), ticksPerSecond: clockTicks };

/**
 * One Linux frame. Discovery still runs in every frame over every /proc entry, but from its stat
 * file only; status, cmdline and the identity recheck are read for the selected rows alone.
 * Reading all four files of every PID on the machine made one frame take 201/265ms on the shared
 * CI runner (run 42358862597), although only the root's descendants are recorded.
 */
export async function linuxFrame(rootPid: number, includeRoot: boolean, started: number, source: LinuxProcSource = linuxProc): Promise<RawFrame> {
  const names = await source.list();
  const linuxDiscovery = await Promise.all(names.filter(name => /^\d+$/.test(name)).map(name => source.ancestry(Number(name))));
  const failures = linuxDiscovery.flatMap(entry => entry === null ? ['stat discovery returned no status']
    : 'error' in entry && !(entry.rawStat === null && (entry.errorCode === 'ENOENT' || entry.errorCode === 'ESRCH')) ? [entry.error] : []);
  const discovered = linuxDiscovery.filter((entry): entry is LinuxAncestry => entry !== null && !('error' in entry));
  const ids = new Set([rootPid]);
  let previousSize = 0;
  while (previousSize !== ids.size) {
    previousSize = ids.size;
    for (const entry of discovered) if (ids.has(entry.parentPid)) ids.add(entry.pid);
  }
  const selected = discovered.filter(entry => ids.has(entry.pid) && (includeRoot || entry.pid !== rootPid));
  const ticksPerSecond = selected.some(entry => entry.state === 'Z') ? await source.ticksPerSecond?.() : undefined;
  const processes = await Promise.all(selected.map(async entry => {
    if (entry.state !== 'Z') return linuxRowSinceDiscovery(entry, await source.process(entry.pid));
    const evidence = { kind: 'linux-discovery-stat-z-rss-zero', rawStat: entry.rawStat,
      frameReadStartedAtEpochMs: started, readStartedAtEpochMs: entry.statReadStartedAtEpochMs,
      readEndedAtEpochMs: entry.statReadEndedAtEpochMs, ticksPerSecond,
      workingSetSource: 'stat-rss-zero', privateSource: 'subset-of-zero-rss' };
    return linuxTerminalMeasurement(entry, evidence, { readStartedAtEpochMs: started, atEpochMs: source.now() })
      ?? { pid: entry.pid, parentPid: entry.parentPid, created: entry.created, name: entry.name,
        workingSetBytes: null, privateBytes: null, cpuMilliseconds: null, error: 'Invalid complete terminal discovery stat',
        linuxReading: { statBefore: entry.rawStat ?? null, status: null, statAfter: null,
          stateBefore: entry.state ?? null, stateAfter: null, stage: 'stat-before' as const, errorCode: null } };
  }));
  return { atEpochMs: source.now(), readStartedAtEpochMs: started, discoveredAtEpochMs: started, rootCreated: discovered.find(entry => entry.pid === rootPid)?.created ?? null, processes, linuxDiscoveryComplete: failures.length === 0 && discovered.some(entry => entry.pid === rootPid), discoveryError: failures.length === 0 ? null : failures.join('; '), linuxDiscovery: linuxDiscovery.filter(entry => entry === null || 'error' in entry) };
}

/**
 * One Linux frame, acquired once more when the first acquisition ended past the age limit (as the Windows sampler does).
 * The rejected attempt is kept as staleRetry; a second stale acquisition is returned as it is and rejected by its readers.
 */
export async function linuxFrameWithRetry(rootPid: number, includeRoot: boolean, source: LinuxProcSource = linuxProc): Promise<RawFrame> {
  const first = await linuxFrame(rootPid, includeRoot, source.now(), source);
  if (first.atEpochMs - first.discoveredAtEpochMs <= DISCOVERY_INTERVAL_MS) return first;
  const retryStartedAtEpochMs = source.now();
  const second = await linuxFrame(rootPid, includeRoot, retryStartedAtEpochMs, source);
  return { ...second, staleRetry: { rejectedDiscoveredAtEpochMs: first.discoveredAtEpochMs, rejectedReadStartedAtEpochMs: first.readStartedAtEpochMs,
    rejectedAtEpochMs: first.atEpochMs, rejectedAgeMs: first.atEpochMs - first.discoveredAtEpochMs, rejectedDiscoveryError: first.discoveryError,
    retryStartedAtEpochMs } };
}

export function linuxSampler(rootPid: number, includeRoot: boolean, observe: (frame: RawFrame) => Promise<void>): Sampler {
  const frames: RawFrame[] = [], failures: string[] = [];
  let stopping = false;
  const running = (async () => {
    // The tick rate is read once per worker from a getconf child. Resolve it before the first frame,
    // as the Windows sampler compiles its declarations before any sample: in run 42358862597 that spawn
    // fell inside frame 0 of each new worker (201/265ms; later frames median 73/71ms). A failure is not
    // dropped: every full row read awaits the same rejected promise and records it as the row error.
    await clockTicks().catch(() => undefined);
    while (!stopping) {
      const started = Date.now();
      try {
        const frame = await linuxFrameWithRetry(rootPid, includeRoot);
        frames.push(frame);
        await observe(frame);
      } catch (error: unknown) {
        frames.push({ atEpochMs: Date.now(), readStartedAtEpochMs: started, discoveredAtEpochMs: started, processes: [], discoveryError: String(error) });
      }
      await delay(Math.max(1, INTERVAL_MS - (Date.now() - started)));
    }
  })();
  return { frames, failures, async stop() { stopping = true; await running; } };
}

