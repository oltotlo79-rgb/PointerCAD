import { execFile, spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { linuxProcessTreeDiscovery, type ProcessMemoryFrame, type ProcessMemorySample } from '../../packages/test-utils/src/processMemorySamples.js';

export const INTERVAL_MS = 100;
export const DISCOVERY_INTERVAL_MS = 2_000;
/** A discovery starts this long after the previous start, so a normal one completes inside the 2000ms age limit. */
export const DISCOVERY_START_MS = DISCOVERY_INTERVAL_MS / 2;
/**
 * Part of the 2000ms age limit kept for the frame itself (wake-up after its sleep, native reads, timing record).
 * One period (100ms) was not enough on CI: the Windows sampler stalled 657-747ms (2026-11-10 frames 15/1069: a 90ms
 * sleep took 747ms, reads took 672-705ms). Locally loop start to read end was at most 36ms and a 1200ms wait
 * threshold caused 0 waits. With less than this left, a frame first binds to the running discovery.
 */
export const DISCOVERY_READ_RESERVE_MS = 800;
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
export type RawFrame = Omit<ProcessMemoryFrame, 'phase' | 'processes'> & { readonly processes: readonly ResourceProcessSample[]; readonly readStartedAtEpochMs: number; readonly windowsTiming?: WindowsTiming; readonly linuxDiscoveryComplete?: boolean; readonly linuxDiscovery?: readonly (LinuxAncestry | LinuxAncestryFailure | null)[] };
export interface Sampler { readonly frames: RawFrame[]; readonly failures: string[]; stop(): Promise<void> }
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
      (value.rootCreated !== undefined && value.rootCreated !== null && typeof value.rootCreated !== 'string')) {
    throw new Error('Malformed OS resource sample');
  }
  return { atEpochMs: value.atEpochMs, discoveredAtEpochMs: value.discoveredAtEpochMs,
    readStartedAtEpochMs: value.readStartedAtEpochMs, processes: value.processes,
    discoveryError: value.discoveryError, ...(typeof value.rootCreated === 'string' ? { rootCreated: value.rootCreated } : {}),
    ...(typeof value.linuxDiscoveryComplete === 'boolean' ? { linuxDiscoveryComplete: value.linuxDiscoveryComplete } : {}),
    ...(windowsTiming(value.windowsTiming) ? { windowsTiming: value.windowsTiming } : {}) };
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
const windowsNativeSource = `
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
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
}
`;

/**
 * 保存実測と同じ全子孫CIM探索。個別PID/CreationDateと読取失敗を保持する。
 * CIM探索は同じPowerShellプロセスの別runspaceで行い、100msの読取りを止めない(task227、
 * 探索の約360msが毎回の抜けになった)。読取りは最後に完了した探索の組だけを使い、
 * 探索の時刻は実際の完了時刻のまま記録する。
 */
export function windowsSampler(rootPid: number, includeRoot: boolean): Sampler {
  const script = `
$ErrorActionPreference='Stop'
# Node decodes both redirected streams as UTF-8; do not emit the host OEM code page.
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$OutputEncoding=[Console]::OutputEncoding
# Compile API declarations only. No process/PID is read during initialization.
$nativeSetupClock=[System.Diagnostics.Stopwatch]::StartNew()
Add-Type -TypeDefinition @'
${windowsNativeSource}
'@
$nativeInitializationMs=$nativeSetupClock.Elapsed.TotalMilliseconds
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
$knownProcessIds=New-Object 'System.Collections.Generic.HashSet[int]'
$discoveredAt=0L
$discoveryError=$null
$rootCreated=$null
$initialRootCreated=$null
$discoveryTiming=$null
$adoptedAt=0L
$discovery={
param($rootProcessId,$includeRoot,$samplerProcessId)
$workerEnteredAt=[SamplerNative]::EpochMilliseconds()
$executionClock=[System.Diagnostics.Stopwatch]::StartNew()
$ErrorActionPreference='Stop'
function Get-DiscoveryContext($stage,$item){
  if($null -eq $item){return @{stage=$stage;pid=$null;name=$null;parentPid=$null;cimCreatedUtc=$null;cimCreatedTicks=$null;commandLine=$null}}
  return @{stage=$stage;pid=[int]$item.ProcessId;name=$item.Name;parentPid=[int]$item.ParentProcessId;
    cimCreatedUtc=$item.CreationDate.ToUniversalTime().ToString('o');cimCreatedTicks=$item.CreationDate.ToUniversalTime().Ticks.ToString();commandLine=$item.CommandLine}
}
function Get-NativeCreationIdentity($item){
  [long]$nativeTicks=[SamplerNative]::Identity([int]$item.ProcessId)
  [long]$cimTicks=$item.CreationDate.ToUniversalTime().Ticks
  [long]$nativeRemainder=0
  [long]$cimRemainder=0
  # CIM_DATETIME has six fractional digits; native DateTime ticks retain 100 ns.
  $nativeMicroseconds=[Math]::DivRem($nativeTicks,[long]10,[ref]$nativeRemainder)
  $cimMicroseconds=[Math]::DivRem($cimTicks,[long]10,[ref]$cimRemainder)
  if($cimRemainder -ne 0 -or $nativeMicroseconds -ne $cimMicroseconds){throw 'PID reused during CIM discovery'}
  return $nativeTicks.ToString()
}
$discoveryContext=Get-DiscoveryContext 'cim-enumeration' $null
try{
  $stageClock=[System.Diagnostics.Stopwatch]::StartNew()
  # Enumerate every process, but request only the five fields used for ancestry,
  # identity and role. Unused Win32_Process metrics are not part of discovery.
  $all=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name,CommandLine)
  $cimEnumerationMs=$stageClock.Elapsed.TotalMilliseconds
  $stageClock.Restart()
  $discoveryContext=Get-DiscoveryContext 'root-cim-selection' $null
  $rootRows=@($all | Where-Object {[int]$_.ProcessId -eq $rootProcessId})
  if($rootRows.Count -ne 1){throw 'Root process creation identity missing'}
  $discoveryContext=Get-DiscoveryContext 'cim-descendant-enumeration' $null
  $ids=New-Object 'System.Collections.Generic.HashSet[int]'
  [void]$ids.Add($rootProcessId)
  $ancestry=@{}
  $ancestry[$rootProcessId]=$rootRows[0]
  do { $added=$false; foreach($item in $all){
    if($ids.Contains([int]$item.ParentProcessId) -and [int]$item.ProcessId -ne $samplerProcessId){
      $parent=$ancestry[[int]$item.ParentProcessId]
      if($null -eq $item.CreationDate -or $null -eq $parent.CreationDate){throw 'CIM ancestry creation identity missing'}
      # ParentProcessId can refer to a recycled PID. An older child cannot
      # belong to this parent instance; do not open or follow that process.
      if($item.CreationDate.ToUniversalTime().Ticks -lt $parent.CreationDate.ToUniversalTime().Ticks){continue}
      if($ids.Add([int]$item.ProcessId)){$ancestry[[int]$item.ProcessId]=$item;$added=$true}
    }
  }}while($added)
  $ancestryMs=$stageClock.Elapsed.TotalMilliseconds
  $stageClock.Restart()
  # Open only CIM-owned PIDs. The native call rejects missing/exited processes
  # and closes its own handle; no handle crosses the runspace boundary.
  $discoveryContext=Get-DiscoveryContext 'root-native-binding' $rootRows[0]
  $rootCreated=Get-NativeCreationIdentity $rootRows[0]
  $nativeIdentities=@{}
  $nativeIdentities[$rootProcessId]=$rootCreated
  $discovered=@(foreach($item in $all){
    if($ids.Contains([int]$item.ProcessId) -and ($includeRoot -or [int]$item.ProcessId -ne $rootProcessId)){
      # Bind the CIM ancestry row to a full native identity before retaining it.
      $discoveryContext=Get-DiscoveryContext 'descendant-native-binding' $item
      $identity=Get-NativeCreationIdentity $item
      $nativeIdentities[[int]$item.ProcessId]=$identity
      @{cim=$item;created=$identity}
    }
  })
  foreach($entry in $discovered){
    if([int]$entry.cim.ProcessId -eq $rootProcessId){continue}
    $discoveryContext=Get-DiscoveryContext 'native-parent-child-order' $entry.cim
    $parentIdentity=$nativeIdentities[[int]$entry.cim.ParentProcessId]
    if($null -eq $parentIdentity -or [long]$entry.created -lt [long]$parentIdentity){throw 'Native parent-child creation order invalid'}
  }
  # Resolve immutable CIM metadata here, rather than invoking the CIM adapter
  # in the timed read loop (including on the first frame after each adoption).
  $known=@(foreach($entry in $discovered){
    $item=$entry.cim
    $role='main-or-native'
    if($item.CommandLine -match '--type=([a-z-]+)'){$role=$Matches[1]}
    elseif($item.CommandLine -match '-contentproc'){$role='firefox-content'}
    @{pid=[int]$item.ProcessId;created=$entry.created;parentPid=[int]$item.ParentProcessId;name=$item.Name;role=$role}
  })
  $discoveryContext=Get-DiscoveryContext 'root-native-recheck' $rootRows[0]
  if([SamplerNative]::Identity($rootProcessId).ToString() -ne $rootCreated){throw 'Root PID reused during discovery'}
  $identityBindingMs=$stageClock.Elapsed.TotalMilliseconds
  $completed=@{ok=$true;known=$known;rootCreated=$rootCreated;
    timing=@{cimEnumerationMs=$cimEnumerationMs;ancestryMs=$ancestryMs;identityBindingMs=$identityBindingMs;
      discoveryWorkerEnteredAtEpochMs=$workerEnteredAt;discoveryExecutionMs=$executionClock.Elapsed.TotalMilliseconds}}
  $completed.discoveredAt=[SamplerNative]::EpochMilliseconds()
  return $completed
}catch{
  # Preserve the failure as a failing discoveryError, with the CIM candidate
  # that could not be bound. A missing PID is not evidence of a normal exit.
  return @{ok=$false;error=(@{message=$_.Exception.Message;exceptionType=$_.Exception.GetType().FullName;
    errorId=$_.FullyQualifiedErrorId;context=$discoveryContext} | ConvertTo-Json -Depth 4 -Compress)}
}
}.ToString()
# Keep one runspace and one thread for discovery. Installing its function does
# not invoke it or read any PID. Repeated starts do not reinitialize PowerShell,
# import CIM metadata anew or dispose a runspace in the sampling loop.
$discoverySetupClock=[System.Diagnostics.Stopwatch]::StartNew()
$discoveryRunspace=[runspacefactory]::CreateRunspace()
$discoveryRunspace.ThreadOptions='ReuseThread'
$discoveryRunspace.Open()
$discoveryShell=[powershell]::Create()
$discoveryShell.Runspace=$discoveryRunspace
[void]$discoveryShell.AddScript('function Invoke-SamplerDiscovery {'+$discovery+'}')
[void]$discoveryShell.Invoke()
if($discoveryShell.HadErrors){throw ($discoveryShell.Streams.Error | Out-String)}
$discoveryInitializationMs=$discoverySetupClock.Elapsed.TotalMilliseconds
function Start-Discovery{
  $discoveryShell.Commands.Clear()
  $discoveryShell.Streams.Error.Clear()
  [void]$discoveryShell.AddCommand('Invoke-SamplerDiscovery').AddArgument($rootProcessId).AddArgument($includeRoot).AddArgument($samplerProcessId)
  $startedAt=[SamplerNative]::EpochMilliseconds()
  return @{handle=$discoveryShell.BeginInvoke();startedAt=$startedAt}
}
# The first set is complete before the first frame, as before.
try{
$pending=Start-Discovery
[void]$pending.handle.AsyncWaitHandle.WaitOne()
$discoveryStartedAt=$pending.startedAt
$previousOutput=$null
$previousSleep=$null
while($true){
  $loopStartedAt=[SamplerNative]::EpochMilliseconds()
  # The adopted set must stay inside the discovery age limit for the whole read. When less than the
  # read reserve of that limit remains (a late discovery or a delayed loop), bind this frame to a running
  # discovery instead of reading the old PID set: start one if none is running, then wait for it,
  # bounded by the age limit. The wait lies between loopStartedAt and readStartedAt of this frame.
  # A discovery that is still late leaves the frame stale, and it is rejected as before.
  if($discoveredAt -gt 0 -and $loopStartedAt-$discoveredAt -ge ${DISCOVERY_INTERVAL_MS - DISCOVERY_READ_RESERVE_MS}){
    if($null -eq $pending){
      $pending=Start-Discovery
      $discoveryStartedAt=$pending.startedAt
    }
    [void]$pending.handle.AsyncWaitHandle.WaitOne(${DISCOVERY_INTERVAL_MS})
  }
  if($null -ne $pending -and $pending.handle.IsCompleted){
    $adoptionClock=[System.Diagnostics.Stopwatch]::StartNew()
    $completedStartedAt=$pending.startedAt
    $result=$null
    try{
      $output=$discoveryShell.EndInvoke($pending.handle)
      if($discoveryShell.HadErrors){throw ($discoveryShell.Streams.Error | Out-String)}
      if($output.Count -ne 1){throw 'Discovery returned no single result'}
      $result=$output[0]
    }catch{
      $discoveryError=@{message=$_.Exception.Message;exceptionType=$_.Exception.GetType().FullName;
        errorId=$_.FullyQualifiedErrorId;context=@{stage='discovery-runspace'}} | ConvertTo-Json -Depth 4 -Compress
    }finally{
      $pending.handle.AsyncWaitHandle.Close()
      $pending=$null
    }
    if($null -ne $result){
      if(-not $result.ok){$discoveryError=$result.error}
      else{
        if($null -eq $initialRootCreated){$initialRootCreated=$result.rootCreated}
        if($initialRootCreated -ne $result.rootCreated){
          $discoveryError=@{message='Root PID reused after sampler start';exceptionType=$null;errorId=$null;
            context=@{stage='root-identity'}} | ConvertTo-Json -Depth 4 -Compress
        }else{
          $known=@($result.known)
          $knownProcessIds.Clear()
          foreach($entry in $known){[void]$knownProcessIds.Add([int]$entry.pid)}
          $rootCreated=$result.rootCreated
          $discoveredAt=[long]$result.discoveredAt
          $adoptedAt=[SamplerNative]::EpochMilliseconds()
          $discoveryTiming=@{discoveryStartedAtEpochMs=$completedStartedAt;discoveryAdoptedAtEpochMs=$adoptedAt;
            cimEnumerationMs=$result.timing.cimEnumerationMs;ancestryMs=$result.timing.ancestryMs;
            discoveryWorkerEnteredAtEpochMs=$result.timing.discoveryWorkerEnteredAtEpochMs;
            discoveryExecutionMs=$result.timing.discoveryExecutionMs;
            identityBindingMs=$result.timing.identityBindingMs;adoptionMs=$adoptionClock.Elapsed.TotalMilliseconds}
          $discoveryError=$null
        }
      }
    }
  }
  if($null -eq $pending -and $loopStartedAt-$discoveryStartedAt -ge ${DISCOVERY_START_MS}){
    $pending=Start-Discovery
    $discoveryStartedAt=$pending.startedAt
  }
  # Precise actual UTC at the original acquisition boundary. Framework UtcNow
  # has coarser resolution than Stopwatch; never infer UTC from elapsed time.
  $readStartedAt=[SamplerNative]::EpochMilliseconds()
  $readClock=[System.Diagnostics.Stopwatch]::StartNew()
  $snapshotClock=[System.Diagnostics.Stopwatch]::StartNew()
  # CIM already fixed the ancestry and creation identities. Do not enumerate all OS wrappers again.
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
  # The same deadline rule as linuxSampler: the read time is part of the 100ms period.
  # One clock read gives the deadline and the recorded sleep start. The next frame reports the requested and
  # the actual sleep, so a gap is placed in the sleep or between the wake-up and the loop by records, not inference.
  $sleepStartedAt=[SamplerNative]::EpochMilliseconds()
  $sleepRequestedMs=[Math]::Max(1,${INTERVAL_MS}-($sleepStartedAt-$loopStartedAt))
  Start-Sleep -Milliseconds $sleepRequestedMs
  $previousSleep=@{requestedMs=$sleepRequestedMs;startedAtEpochMs=$sleepStartedAt;endedAtEpochMs=[SamplerNative]::EpochMilliseconds()}
}
}finally{
  $discoveryShell.Dispose()
  $discoveryRunspace.Dispose()
}`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const frames: RawFrame[] = [], failures: string[] = [];
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1);
      try { const decoded: unknown = JSON.parse(line); frames.push(rawFrame(decoded)); }
      catch (error: unknown) { failures.push(`invalid sampler JSON: ${String(error)}`); }
      newline = pending.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { failures.push(chunk); });
  child.on('error', (error: Error) => { failures.push(error.message); });
  let stopping = false;
  const closed = new Promise<void>(resolve => { child.on('close', code => {
    if (!stopping) failures.push(`sampler exited unexpectedly: ${String(code)}`);
    resolve();
  }); });
  return { frames, failures, async stop() { stopping = true; child.kill(); await closed; } };
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
        const frame = await linuxFrame(rootPid, includeRoot, started);
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

