# 段が始まってすぐ(5 秒未満)に、Windows の異常終了の終了コード(0xC0000000 台。例 0xC0000409＝-1073740791)で終わった時だけ、
# 原因を 1 回で決めるための記録を、失敗の文の後ろへ書く(rules/06 §10.504)。合否と終了コードは変えない。
# 2026-11-13 の 8 回目の全体検査(配達 20261113-101911)は、組み立ての段が開始 0.704 秒・終了コード -1073740791 で落ち、
# イベントログにも記録が無く、落ちたプロセスを決められなかった(scratchpad/claude/agents/cl-v103-gate-build-crash-1113/final.md)。
# scripts/check.ps1 の Invoke-Check と scripts/check.selftest.ps1 が共有する単一正本。測る道具は引数で差し替えられる(自己試験は
# pnpm も node も起動しない)。

$script:QuickCrashSeconds = 5

function Test-QuickCrash {
    param([long]$ExitCode, [double]$ElapsedSeconds)
    if ($ElapsedSeconds -ge $script:QuickCrashSeconds -or $ExitCode -ge 0 -or $ExitCode -lt [int32]::MinValue) { return $false }
    $unsigned = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$ExitCode), 0)
    return ($unsigned -ge [uint32]3221225472 -and $unsigned -le [uint32]3489660927)
}

function Get-QuickCrashMemory {
    # commit の上限・空き(Win32_OperatingSystem の TotalVirtualMemorySize・FreeVirtualMemory)と空きの物理メモリー。単位は MB。
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    $limit = [math]::Round($os.TotalVirtualMemorySize / 1024)
    $free = [math]::Round($os.FreeVirtualMemory / 1024)
    return @{ CommitUsedMB = $limit - $free; CommitLimitMB = $limit; CommitFreeMB = $free; PhysicalFreeMB = [math]::Round($os.FreePhysicalMemory / 1024) }
}

function Get-QuickCrashEvents {
    param([string]$LogName, [datetime]$From, [datetime]$To)
    try {
        return @(Get-WinEvent -FilterHashtable @{ LogName = $LogName; StartTime = $From; EndTime = $To } -ErrorAction Stop)
    } catch {
        if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { return @() }
        throw
    }
}

function Measure-QuickCrashProbe {
    param([string]$Command, [string[]]$CommandArgs)
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $global:LASTEXITCODE = 0
    & $Command @CommandArgs *> $null
    $code = $LASTEXITCODE
    $timer.Stop()
    return [pscustomobject]@{ ExitCode = $code; Seconds = $timer.Elapsed.TotalSeconds }
}

function Write-QuickCrashDiagnostics {
    param(
        [string]$Name, [string]$Command, [string[]]$CommandArgs, [DateTimeOffset]$Start, [DateTimeOffset]$End, [long]$ExitCode,
        [scriptblock]$Resolve = { param($CommandName) $found = Get-Command $CommandName -ErrorAction SilentlyContinue | Select-Object -First 1; if ($found) { $found.Source } else { $null } },
        [scriptblock]$Memory = { Get-QuickCrashMemory },
        [scriptblock]$Events = { param($LogName, $From, $To) Get-QuickCrashEvents -LogName $LogName -From $From -To $To },
        [scriptblock]$Probe = { param($ProbeCommand, $ProbeArgs) Measure-QuickCrashProbe -Command $ProbeCommand -CommandArgs $ProbeArgs },
        [scriptblock]$Out = { param($Line) Write-Host $Line -ForegroundColor Yellow }
    )
    $unsigned = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$ExitCode), 0)
    $seconds = ($End - $Start).TotalSeconds
    & $Out ("[診断] 段「{0}」は開始から {1:F3} 秒で異常終了の終了コード {2}(0x{3:X8})で終わった。原因を決めるための記録(合否に数えない。rules/06 §10.504):" -f $Name, $seconds, $ExitCode, $unsigned)
    try {
        $path = & $Resolve $Command
        & $Out ("[診断] 起動した命令: {0} {1}(実パス: {2})" -f $Command, ($CommandArgs -join ' '), $(if ($path) { $path } else { '見つからない' }))
    } catch { & $Out ("[診断] 起動した命令の実パスを取れなかった: {0}" -f $_.Exception.Message) }
    try {
        $memoryValues = & $Memory
        & $Out ("[診断] commit の使用 {0}MB・上限 {1}MB・空き {2}MB、空きの物理メモリー {3}MB" -f $memoryValues.CommitUsedMB, $memoryValues.CommitLimitMB, $memoryValues.CommitFreeMB, $memoryValues.PhysicalFreeMB)
    } catch { & $Out ("[診断] メモリーの値を取れなかった: {0}" -f $_.Exception.Message) }
    $from = $Start.DateTime.AddSeconds(-5)
    $to = $End.DateTime.AddSeconds(10)
    foreach ($logName in @('Application', 'System')) {
        try {
            $records = @(& $Events $logName $from $to)
            & $Out ("[診断] イベントログ {0}({1:HH:mm:ss}〜{2:HH:mm:ss}): {3} 件" -f $logName, $from, $to, $records.Count)
            foreach ($record in $records) {
                $message = if ($record.Message) { (($record.Message -replace '\s+', ' ').Trim()) } else { '' }
                if ($message.Length -gt 200) { $message = $message.Substring(0, 200) }
                & $Out ("[診断]   {0:HH:mm:ss.fff} {1} {2} {3}: {4}" -f $record.TimeCreated, $record.ProviderName, $record.Id, $record.LevelDisplayName, $message)
            }
        } catch { & $Out ("[診断] イベントログ {0} を読めなかった: {1}" -f $logName, $_.Exception.Message) }
    }
    foreach ($probeSpec in @(@('node', @('-e', '0')), @('pnpm', @('--version')))) {
        try {
            $measured = & $Probe $probeSpec[0] $probeSpec[1]
            & $Out ("[診断] {0} {1}: 終了コード {2}、所要 {3:F3} 秒(合否に数えない)" -f $probeSpec[0], ($probeSpec[1] -join ' '), $measured.ExitCode, $measured.Seconds)
        } catch { & $Out ("[診断] {0} {1} を起動できなかった: {2}(合否に数えない)" -f $probeSpec[0], ($probeSpec[1] -join ' '), $_.Exception.Message) }
    }
}
