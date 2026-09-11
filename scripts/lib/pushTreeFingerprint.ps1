# Push検査前後の実内容・HEAD・indexを比較する（R13）。関数定義のみ。
# 引数はshellへ渡さずProcessへ直接渡す。NUL区切り出力をPowerShellの行配列へ変換しない。
function Read-GitSnapshotMetadata {
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string[]]$Arguments)
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = 'git'
    $start.WorkingDirectory = $Root
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false, $true)
    $start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false, $true)
    foreach ($name in $script:PointerCadInheritedGitEnvNames) { $start.EnvironmentVariables.Remove($name) }
    $allArguments = @('-C', $Root, '-c', 'core.quotepath=false') + $Arguments
    if ($null -ne $start.PSObject.Properties['ArgumentList']) {
        foreach ($argument in $allArguments) { $start.ArgumentList.Add($argument) }
    } else {
        # Windows PowerShell 5.1。埋込み引用符と引数末尾のbackslashをWindows規則で保護する。
        $quoted = foreach ($argument in $allArguments) {
            '"' + ([regex]::Replace([regex]::Replace($argument, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1')) + '"'
        }
        $start.Arguments = $quoted -join ' '
    }
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'git process did not start' }
        $errors = $process.StandardError.ReadToEndAsync()
        $output = $process.StandardOutput.ReadToEnd()
        $process.WaitForExit()
        $errorOutput = $errors.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw "git metadata failed: $errorOutput" }
        return $output
    } finally { $process.Dispose() }
}

function Get-PushContentSnapshot {
    param([Parameter(Mandatory)][string]$Root)
    $fingerprints = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    try {
        $head = Read-GitSnapshotMetadata -Root $Root -Arguments @('rev-parse', '--verify', 'HEAD')
        $index = Read-GitSnapshotMetadata -Root $Root -Arguments @('ls-files', '--stage', '-z')
        if (@($index -split "`0" | Where-Object { $_ -cmatch '^160000 ' }).Count -gt 0) {
            throw 'Submodule content fingerprint is not supported; do not certify an uninspected working tree'
        }
        $names = Read-GitSnapshotMetadata -Root $Root -Arguments @('ls-files', '--cached', '--others', '--exclude-standard', '-z')
        foreach ($name in ($names -split "`0")) {
            if ($name.Length -eq 0 -or $fingerprints.ContainsKey($name)) { continue }
            $fullPath = Join-Path $Root $name
            $inspectionErrors = @()
            $info = Get-Item -LiteralPath $fullPath -Force -ErrorAction SilentlyContinue -ErrorVariable inspectionErrors
            foreach ($inspectionError in $inspectionErrors) {
                if ($inspectionError.CategoryInfo.Category -ne [Management.Automation.ErrorCategory]::ObjectNotFound) {
                    throw "Cannot inspect ${name}: $($inspectionError.Exception.Message)"
                }
            }
            if ($null -eq $info) {
                # パスの欠落だけを許容。読取不能の内容を空として比較しない。
                if (Test-Path -LiteralPath $fullPath -ErrorAction Stop) { throw "Cannot inspect $name" }
                $fingerprints.Add($name, '<absent>'); continue
            }
            if (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                # symlinkの先へ出ない。リンクそのものの行先変更を指紋へ含める。
                if ($null -eq $info.PSObject.Properties['Target']) { throw "Cannot inspect symlink $name" }
                $target = @($info.Target) -join "`0"
                if ([string]::IsNullOrEmpty($target)) { throw "Cannot read symlink destination $name" }
                $fingerprints.Add($name, '<link>' + $target); continue
            }
            if ($info.PSIsContainer) { $fingerprints.Add($name, '<directory>'); continue }
            $lengthBefore = $info.Length
            $writeTimeBefore = $info.LastWriteTimeUtc.Ticks
            $hash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256 -ErrorAction Stop).Hash
            $info.Refresh()
            if (-not $info.Exists -or $lengthBefore -ne $info.Length -or $writeTimeBefore -ne $info.LastWriteTimeUtc.Ticks) {
                throw "File changed while hashing: $name"
            }
            $fingerprints.Add($name, $hash)
        }
        # 読取り中のindex/HEAD変化はスナップショット自体を失敗させる。
        if ($head -cne (Read-GitSnapshotMetadata -Root $Root -Arguments @('rev-parse', '--verify', 'HEAD')) -or
            $index -cne (Read-GitSnapshotMetadata -Root $Root -Arguments @('ls-files', '--stage', '-z')) -or
            $names -cne (Read-GitSnapshotMetadata -Root $Root -Arguments @('ls-files', '--cached', '--others', '--exclude-standard', '-z'))) {
            throw 'Metadata changed during snapshot'
        }
        return [pscustomobject]@{ Ok=$true; Mode='Full'; Head=$head; Index=$index; Paths=@($fingerprints.Keys); Fingerprints=$fingerprints }
    } catch {
        return [pscustomobject]@{ Ok=$false; Mode='Full'; Reason=$_.Exception.Message; Paths=@(); Fingerprints=$fingerprints }
    }
}

function Compare-PushContentSnapshot {
    param([Parameter(Mandatory)]$Before, [Parameter(Mandatory)]$After)
    if (-not $Before.Ok -or -not $After.Ok) { return [pscustomobject]@{ Unchanged=$false; GitFailed=$true; ChangedPaths=@(); MetadataChanged=$true } }
    $paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($name in $Before.Paths) { $null=$paths.Add($name) }
    foreach ($name in $After.Paths) { $null=$paths.Add($name) }
    $changed = @($paths | Where-Object { -not $Before.Fingerprints.ContainsKey($_) -or -not $After.Fingerprints.ContainsKey($_) -or $Before.Fingerprints[$_] -cne $After.Fingerprints[$_] })
    $metadataChanged = $Before.Head -cne $After.Head -or $Before.Index -cne $After.Index
    return [pscustomobject]@{ Unchanged=($changed.Count -eq 0 -and -not $metadataChanged); GitFailed=$false; ChangedPaths=$changed; MetadataChanged=$metadataChanged }
}
