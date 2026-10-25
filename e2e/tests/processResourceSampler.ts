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
export type RawFrame = Omit<ProcessMemoryFrame, 'phase' | 'processes'> & { readonly processes: readonly ResourceProcessSample[]; readonly readStartedAtEpochMs: number };
export interface Sampler { readonly frames: RawFrame[]; readonly failures: string[]; stop(): Promise<void> }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
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
      (value.discoveryError !== null && typeof value.discoveryError !== 'string') ||
      (value.rootCreated !== undefined && value.rootCreated !== null && typeof value.rootCreated !== 'string')) {
    throw new Error('Malformed OS resource sample');
  }
  return { atEpochMs: value.atEpochMs, discoveredAtEpochMs: value.discoveredAtEpochMs,
    readStartedAtEpochMs: value.readStartedAtEpochMs, processes: value.processes,
    discoveryError: value.discoveryError, ...(typeof value.rootCreated === 'string' ? { rootCreated: value.rootCreated } : {}) };
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

/**
 * 保存実測と同じ全子孫Get-Process方式。個別PID/CreationDateと読取失敗を追加する。
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
$rootProcessId=${rootPid}
$includeRoot=$${includeRoot ? 'true' : 'false'}
$samplerProcessId=$PID
$known=@()
$discoveredAt=0L
$discoveryError=$null
$rootCreated=$null
$initialRootCreated=$null
$discovery={
param($rootProcessId,$includeRoot,$samplerProcessId)
$ErrorActionPreference='Stop'
function Get-DiscoveryContext($stage,$item){
  if($null -eq $item){return @{stage=$stage;pid=$null;name=$null;parentPid=$null;cimCreatedUtc=$null;cimCreatedTicks=$null;commandLine=$null}}
  return @{stage=$stage;pid=[int]$item.ProcessId;name=$item.Name;parentPid=[int]$item.ParentProcessId;
    cimCreatedUtc=$item.CreationDate.ToUniversalTime().ToString('o');cimCreatedTicks=$item.CreationDate.ToUniversalTime().Ticks.ToString();commandLine=$item.CommandLine}
}
function Get-NativeCreationIdentity($item){
  [long]$nativeTicks=(Get-Process -Id $item.ProcessId).StartTime.ToUniversalTime().Ticks
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
  $all=@(Get-CimInstance Win32_Process)
  $discoveryContext=Get-DiscoveryContext 'root-cim-selection' $null
  $rootRows=@($all | Where-Object {[int]$_.ProcessId -eq $rootProcessId})
  if($rootRows.Count -ne 1){throw 'Root process creation identity missing'}
  $discoveryContext=Get-DiscoveryContext 'root-native-binding' $rootRows[0]
  $rootCreated=Get-NativeCreationIdentity $rootRows[0]
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
  $discoveryContext=Get-DiscoveryContext 'root-native-recheck' $rootRows[0]
  if((Get-Process -Id $rootProcessId).StartTime.ToUniversalTime().Ticks.ToString() -ne $rootCreated){throw 'Root PID reused during discovery'}
  return @{ok=$true;known=$discovered;rootCreated=$rootCreated;discoveredAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
}catch{
  # Preserve the failure as a failing discoveryError, with the CIM candidate
  # that could not be bound. A missing PID is not evidence of a normal exit.
  return @{ok=$false;error=(@{message=$_.Exception.Message;exceptionType=$_.Exception.GetType().FullName;
    errorId=$_.FullyQualifiedErrorId;context=$discoveryContext} | ConvertTo-Json -Depth 4 -Compress)}
}
}.ToString()
function Start-Discovery{
  # Another runspace of this same process (no new OS process); it ends when the sampler process is stopped.
  $shell=[powershell]::Create()
  [void]$shell.AddScript($discovery).AddArgument($rootProcessId).AddArgument($includeRoot).AddArgument($samplerProcessId)
  return @{shell=$shell;handle=$shell.BeginInvoke();startedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
}
# The first set is complete before the first frame, as before.
$pending=Start-Discovery
[void]$pending.handle.AsyncWaitHandle.WaitOne()
$discoveryStartedAt=$pending.startedAt
while($true){
  $loopStartedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if($null -ne $pending -and $pending.handle.IsCompleted){
    $result=$null
    try{
      $output=$pending.shell.EndInvoke($pending.handle)
      if($output.Count -ne 1){throw 'Discovery returned no single result'}
      $result=$output[0]
    }catch{
      $discoveryError=@{message=$_.Exception.Message;exceptionType=$_.Exception.GetType().FullName;
        errorId=$_.FullyQualifiedErrorId;context=@{stage='discovery-runspace'}} | ConvertTo-Json -Depth 4 -Compress
    }finally{
      $pending.shell.Dispose()
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
          $rootCreated=$result.rootCreated
          $discoveredAt=[long]$result.discoveredAt
          $discoveryError=$null
        }
      }
    }
  }
  if($null -eq $pending -and $loopStartedAt-$discoveryStartedAt -ge ${DISCOVERY_START_MS}){
    $pending=Start-Discovery
    $discoveryStartedAt=$pending.startedAt
  }
  $readStartedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $rows=@(foreach($entry in $known){
    $item=$entry.cim
    $identity=$entry.created
    try{
      $p=Get-Process -Id $item.ProcessId
      if($p.StartTime.ToUniversalTime().Ticks.ToString() -ne $identity){throw 'PID reused since discovery'}
      $role='main-or-native'
      if($item.CommandLine -match '--type=([a-z-]+)'){$role=$Matches[1]}
      elseif($item.CommandLine -match '-contentproc'){$role='firefox-content'}
      @{pid=[int]$item.ProcessId;created=$identity;parentPid=[int]$item.ParentProcessId;name=$item.Name;
        priority=$p.PriorityClass.ToString();role=$role;workingSetBytes=$p.WorkingSet64;privateBytes=$p.PrivateMemorySize64;cpuMilliseconds=$p.TotalProcessorTime.TotalMilliseconds;error=$null}
    }catch{
      @{pid=[int]$item.ProcessId;created=$identity;parentPid=[int]$item.ParentProcessId;name=$item.Name;
        priority=$null;role='unknown';workingSetBytes=$null;privateBytes=$null;cpuMilliseconds=$null;error=$_.Exception.Message}
    }
  })
  @{atEpochMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();readStartedAtEpochMs=$readStartedAt;discoveredAtEpochMs=$discoveredAt;
    processes=$rows;discoveryError=$discoveryError;rootCreated=$rootCreated} | ConvertTo-Json -Depth 5 -Compress
  # The same deadline rule as linuxSampler: the read time is part of the 100ms period.
  Start-Sleep -Milliseconds ([Math]::Max(1,${INTERVAL_MS}-([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-$loopStartedAt)))
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

