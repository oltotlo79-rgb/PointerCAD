# B3: completed strict checks may be shared only with the identical immediate commit/push.
# Missing Python, unsupported state, or changed inputs fall back to the ordinary gate.
function Invoke-ValidationReceipt {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][ValidateSet('start','finish','reuse','invalidate')][string]$Action,
        [ValidateSet('Manual','Commit','Push','Disabled')][string]$Phase = 'Manual',
        [string]$Token = '',
        [int]$Repeats = 1
    )
    try {
        if ($Action -eq 'invalidate') {
            $gitDirectory = (Read-GitSnapshotMetadata -Root $Root -Arguments @('rev-parse', '--absolute-git-dir')).Trim()
            foreach ($name in @('validation-receipt.json', 'validation-running.json')) {
                $target = Join-Path $gitDirectory $name
                if (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target -Force -ErrorAction Stop }
            }
            return [pscustomobject]@{ ok = $true }
        }
        $selectedTools = @{}
        foreach ($tool in @('node', 'pnpm', 'git')) {
            $selectedTools[$tool] = (Get-Command $tool -ErrorAction Stop).Source
        }
        $selectedTools['shell'] = (Get-Process -Id $PID).Path
        # Resolve the executable behind Corepack/global shims through the same pnpm
        # lifecycle used by the checks. This command prints paths only, no environment values.
        Push-Location -LiteralPath $Root
        try {
            $runtimeOutput = & pnpm --silent run validation:runtime
            if ($LASTEXITCODE -ne 0) { throw 'The actual validation runtime could not be identified' }
            $runtime = ($runtimeOutput -join "`n") | ConvertFrom-Json -ErrorAction Stop
            foreach ($name in @('node_runtime', 'pnpm_runtime')) {
                if ([string]::IsNullOrWhiteSpace($runtime.$name)) { throw "The runtime path $name is missing" }
                $selectedTools[$name] = [string]$runtime.$name
            }
        } finally { Pop-Location }
        $toolsJson = $selectedTools | ConvertTo-Json -Compress
        $encodedTools = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($toolsJson))
        $python = Get-Command python -ErrorAction Stop
        $arguments = @('-B', '-X', 'utf8', (Join-Path $PSScriptRoot 'validation_receipt.py'), $Action,
            '--root', $Root, '--tools', $encodedTools, '--phase', $Phase, '--repeats', [string]$Repeats)
        if (-not [string]::IsNullOrWhiteSpace($Token)) { $arguments += @('--token', $Token) }
        $raw = & $python.Source @arguments
        $resultCode = $LASTEXITCODE
        $result = ($raw -join "`n") | ConvertFrom-Json -ErrorAction Stop
        if ($resultCode -eq 0 -and $result.ok) { return $result }
        return [pscustomobject]@{ ok = $false; reason = [string]$result.reason }
    } catch {
        return [pscustomobject]@{ ok = $false; reason = $_.Exception.Message }
    }
}
