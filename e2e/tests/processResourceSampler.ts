import { execFile, spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { ProcessMemoryFrame, ProcessMemorySample } from '../../packages/test-utils/src/processMemorySamples.js';

export const INTERVAL_MS = 100;
export const DISCOVERY_INTERVAL_MS = 2_000;
/** A discovery starts this long after the previous start, so a normal one completes inside the 2000ms age limit. */
const DISCOVERY_START_MS = DISCOVERY_INTERVAL_MS / 2;
export interface ResourceProcessSample extends ProcessMemorySample { readonly cpuMilliseconds: number | null }
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
  readonly propertyReadMs: number;
  readonly nativeIdentityReadMs: number;
  readonly nativeMetricsReadMs: number;
  readonly processDisposalMs: number;
  readonly outputOfPreviousFrame?: { readonly atEpochMs: number; readonly serializationMs: number; readonly writeMs: number };
}
export type RawFrame = Omit<ProcessMemoryFrame, 'phase' | 'processes'> & { readonly processes: readonly ResourceProcessSample[]; readonly readStartedAtEpochMs: number; readonly windowsTiming?: WindowsTiming };
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
    (value.processEnumerationMs === undefined || (typeof value.processEnumerationMs === 'number' &&
      Number.isFinite(value.processEnumerationMs) && value.processEnumerationMs >= 0)) &&
    (value.outputOfPreviousFrame === undefined || (isRecord(value.outputOfPreviousFrame) &&
      ['atEpochMs', 'serializationMs', 'writeMs'].every(key => isRecord(value.outputOfPreviousFrame) &&
        typeof value.outputOfPreviousFrame[key] === 'number' && Number.isFinite(value.outputOfPreviousFrame[key]) && value.outputOfPreviousFrame[key] >= 0)));
}
function processSample(value: unknown): value is ResourceProcessSample {
  return isRecord(value) && typeof value.pid === 'number' && typeof value.created === 'string' &&
    typeof value.parentPid === 'number' && typeof value.name === 'string' &&
    (value.priority === undefined || value.priority === null || typeof value.priority === 'string') &&
    (value.role === undefined || typeof value.role === 'string') &&
    nullableNumber(value.workingSetBytes) && nullableNumber(value.privateBytes) && nullableNumber(value.cpuMilliseconds) &&
    (value.error === null || typeof value.error === 'string');
}
function rawFrame(value: unknown): RawFrame {
  if (!isRecord(value) || typeof value.atEpochMs !== 'number' || typeof value.discoveredAtEpochMs !== 'number' ||
      typeof value.readStartedAtEpochMs !== 'number' || !Number.isFinite(value.readStartedAtEpochMs) ||
      !Number.isFinite(value.atEpochMs) || value.readStartedAtEpochMs > value.atEpochMs ||
      !Array.isArray(value.processes) || !value.processes.every(processSample) ||
      (value.windowsTiming !== undefined && !windowsTiming(value.windowsTiming)) ||
      (value.discoveryError !== null && typeof value.discoveryError !== 'string') ||
      (value.rootCreated !== undefined && value.rootCreated !== null && typeof value.rootCreated !== 'string')) {
    throw new Error('Malformed OS resource sample');
  }
  return { atEpochMs: value.atEpochMs, discoveredAtEpochMs: value.discoveredAtEpochMs,
    readStartedAtEpochMs: value.readStartedAtEpochMs, processes: value.processes,
    discoveryError: value.discoveryError, ...(typeof value.rootCreated === 'string' ? { rootCreated: value.rootCreated } : {}),
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
while($true){
  $loopStartedAt=[SamplerNative]::EpochMilliseconds()
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
  $processes=@{}
  $snapshot=@()
  $processEnumerationMs=$null
  $snapshotError=$null
  try{
    $snapshot=[System.Diagnostics.Process]::GetProcesses()
    $processEnumerationMs=$snapshotClock.Elapsed.TotalMilliseconds
    foreach($p in $snapshot){
      # Index once, rather than repeat the system process lookup for every row.
      if($knownProcessIds.Contains($p.Id)){$processes[$p.Id]=$p}
    }
  }catch{$snapshotError=$_.Exception.Message}
  $processSnapshotMs=$snapshotClock.Elapsed.TotalMilliseconds
  $propertyClock=[System.Diagnostics.Stopwatch]::StartNew()
  $nativeIdentityReadMs=0.0
  $nativeMetricsReadMs=0.0
  $nativeHandleOpenMs=0.0
  $nativeCreationQueryMs=0.0
  $nativeHandleCloseMs=0.0
  $nativeCallMs=0.0
  $rows=@(foreach($entry in $known){
    $identity=$entry.created
    try{
      if($null -ne $snapshotError){throw $snapshotError}
      $p=$processes[[int]$entry.pid]
      if($null -eq $p){throw 'PID missing from native process snapshot'}
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
  foreach($p in $processes.Values){$p.Dispose()}
  $processDisposalMs=$disposalClock.Elapsed.TotalMilliseconds
  $timing=if($null -ne $discoveryTiming){$discoveryTiming.Clone()}else{$null}
  if($null -ne $timing){
    $timing.nativeInitializationMs=$nativeInitializationMs
    $timing.discoveryInitializationMs=$discoveryInitializationMs
    $timing.serializerInitializationMs=$serializerInitializationMs
    $timing.serializerReadyAtEpochMs=$serializerReadyAt
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
  Start-Sleep -Milliseconds ([Math]::Max(1,${INTERVAL_MS}-([SamplerNative]::EpochMilliseconds()-$loopStartedAt)))
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

export async function linuxProcess(pid: number): Promise<ResourceProcessSample> {
  let created = '', parentPid = 0;
  try {
    const ticksPerSecond = await clockTicks();
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    const fields = stat.slice(end + 2).split(' ');
    created = fields[19] ?? ''; parentPid = Number(fields[1]);
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const command = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    const role = /--type=([a-z-]+)/.exec(command)?.[1] ?? (command.includes('-contentproc') ? 'firefox-content' : 'main-or-native');
    const bytes = (key: string): number | null => {
      const raw = new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(status)?.[1];
      return raw === undefined ? null : Number(raw) * 1024;
    };
    const after = await readFile(`/proc/${pid}/stat`, 'utf8');
    if (after.slice(after.lastIndexOf(')') + 2).split(' ')[19] !== created) throw new Error('PID reused during read');
    return { pid, created, parentPid, name: stat.slice(stat.indexOf('(') + 1, end),
      priority: fields[16] === undefined ? null : `nice=${fields[16]}`, role,
      workingSetBytes: bytes('VmRSS'), privateBytes: bytes('RssAnon'),
      cpuMilliseconds: (Number(fields[11]) + Number(fields[12])) * 1000 / ticksPerSecond, error: null };
  } catch (error: unknown) {
    return { pid, created, parentPid, name: '', workingSetBytes: null, privateBytes: null, cpuMilliseconds: null, error: String(error) };
  }
}

export function linuxSampler(rootPid: number, includeRoot: boolean, observe: (frame: RawFrame) => Promise<void>): Sampler {
  const frames: RawFrame[] = [], failures: string[] = [];
  let stopping = false;
  const running = (async () => {
    while (!stopping) {
      const started = Date.now();
      try {
        const names = await readdir('/proc');
        const all = await Promise.all(names.filter(name => /^\d+$/.test(name)).map(name => linuxProcess(Number(name))));
        const ids = new Set([rootPid]);
        let previousSize = 0;
        while (previousSize !== ids.size) {
          previousSize = ids.size;
          for (const process of all) if (ids.has(process.parentPid)) ids.add(process.pid);
        }
        const frame = { atEpochMs: Date.now(), readStartedAtEpochMs: started, discoveredAtEpochMs: started,
          processes: all.filter(process => ids.has(process.pid) && (includeRoot || process.pid !== rootPid)), discoveryError: null };
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

