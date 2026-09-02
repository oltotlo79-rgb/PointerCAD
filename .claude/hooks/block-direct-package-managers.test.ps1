# block-direct-package-managers.ps1 の自己試験。
# フックを変更したら必ず実行する(rules/00-施行の仕組み.md)。
# 実行: powershell -NoProfile -ExecutionPolicy Bypass -File .claude/hooks/block-direct-package-managers.test.ps1
$ErrorActionPreference = 'Stop'

$hookPath = Join-Path $PSScriptRoot 'block-direct-package-managers.ps1'
if (-not (Test-Path -LiteralPath $hookPath -PathType Leaf)) {
    Write-Host "[NG] フックが見つかりません: $hookPath" -ForegroundColor Red
    exit 1
}

function Invoke-HookCase {
    param(
        [string]$Command,
        [string]$ToolName = 'PowerShell',
        [string]$EventName = 'PreToolUse',
        [switch]$IncludeAgentId,
        [object]$AgentId = 'a71238ef5128e805a'
    )

    $payloadMap = [ordered]@{
        hook_event_name = $EventName
        tool_name       = $ToolName
        tool_input      = @{ command = $Command }
    }
    # -IncludeAgentId を付けたときだけ agent_id を入力へ含める(サブエージェント発の模擬)
    if ($IncludeAgentId) {
        $payloadMap['agent_id'] = $AgentId
    }
    $payload = $payloadMap | ConvertTo-Json -Compress -Depth 4

    $output = $payload | & powershell.exe -NoLogo -NoProfile -NonInteractive `
        -ExecutionPolicy Bypass -File $hookPath 2>$null
    $text = ($output | Out-String)
    return $text -match '"permissionDecision":"deny"'
}

$denyCases = @(
    'pnpm install',
    'npm test',
    'npx vitest run',
    'yarn build',
    'pnpm.cmd run build',
    'cmd /c pnpm install',
    'cmd /c "npm run build"',
    'powershell -c "npm run build"',
    'pwsh -Command "pnpm test"',
    'bash -c "npm ci"',
    'sh -lc "pnpm -r test"',
    'iex "npm install"',
    'Start-Process -FilePath pnpm -ArgumentList install',
    'corepack pnpm install',
    'git status; pnpm test',
    '& ''C:\Program Files\nodejs\npm.cmd'' run lint'
)

$allowCases = @(
    'git status',
    'git commit -m "pnpm対応の記録"',
    'scripts/check.ps1',
    'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check.ps1',
    'Get-Process node',
    'Get-Date -Format ''yyyy-MM-dd HH:mm''',
    'Write-Host "npm is prohibited"',
    'git log --oneline -5'
)

$failures = 0

foreach ($case in $denyCases) {
    $denied = Invoke-HookCase -Command $case
    if ($denied) {
        Write-Host "[OK] 拒否: $case" -ForegroundColor Green
    }
    else {
        Write-Host "[NG] 拒否されるべきコマンドが通りました: $case" -ForegroundColor Red
        $failures++
    }
}

foreach ($case in $allowCases) {
    $denied = Invoke-HookCase -Command $case
    if (-not $denied) {
        Write-Host "[OK] 許可: $case" -ForegroundColor Green
    }
    else {
        Write-Host "[NG] 許可されるべきコマンドが拒否されました: $case" -ForegroundColor Red
        $failures++
    }
}

# 対象外イベント・対象外ツールは常に通す
if (-not (Invoke-HookCase -Command 'pnpm install' -EventName 'PostToolUse')) {
    Write-Host '[OK] 対象外イベントは通す' -ForegroundColor Green
}
else {
    Write-Host '[NG] 対象外イベントを拒否しました' -ForegroundColor Red
    $failures++
}
if (-not (Invoke-HookCase -Command 'pnpm install' -ToolName 'Read')) {
    Write-Host '[OK] 対象外ツールは通す' -ForegroundColor Green
}
else {
    Write-Host '[NG] 対象外ツールを拒否しました' -ForegroundColor Red
    $failures++
}

# 作業担当(サブエージェント)発だけを通す判別の試験。
# agent_id はサブエージェント発の呼出にだけ付く。存在し、かつ空でないときだけ通す。
$agentCases = @(
    [pscustomobject]@{
        Label = 'agent_id が非空(作業担当発)は通す'
        Include = $true; Value = 'a71238ef5128e805a'
        Tool = 'PowerShell'; Command = 'pnpm install'; ShouldDeny = $false
    },
    [pscustomobject]@{
        Label = 'agent_id が非空(作業担当発・Bashツール)は通す'
        Include = $true; Value = 'a71238ef5128e805a'
        Tool = 'Bash'; Command = 'npm ci'; ShouldDeny = $false
    },
    [pscustomobject]@{
        Label = 'agent_id が無い(統括発)は拒否する'
        Include = $false; Value = $null
        Tool = 'PowerShell'; Command = 'pnpm install'; ShouldDeny = $true
    },
    [pscustomobject]@{
        Label = 'agent_id が空文字なら拒否する'
        Include = $true; Value = ''
        Tool = 'PowerShell'; Command = 'pnpm install'; ShouldDeny = $true
    },
    [pscustomobject]@{
        Label = 'agent_id が null なら拒否する'
        Include = $true; Value = $null
        Tool = 'PowerShell'; Command = 'pnpm install'; ShouldDeny = $true
    },
    [pscustomobject]@{
        Label = 'agent_id が空白だけなら拒否する'
        Include = $true; Value = '   '
        Tool = 'PowerShell'; Command = 'pnpm install'; ShouldDeny = $true
    }
)

foreach ($case in $agentCases) {
    $denied = [bool](Invoke-HookCase -Command $case.Command -ToolName $case.Tool `
            -IncludeAgentId:$case.Include -AgentId $case.Value)
    if ($denied -eq $case.ShouldDeny) {
        Write-Host ('[OK] {0}: {1}' -f $case.Label, $case.Command) -ForegroundColor Green
    }
    else {
        Write-Host ('[NG] {0}: {1}' -f $case.Label, $case.Command) -ForegroundColor Red
        $failures++
    }
}

Write-Host ''
if ($failures -gt 0) {
    Write-Host "[NG] 自己試験に $failures 件の失敗があります" -ForegroundColor Red
    exit 1
}
Write-Host '[OK] フックの自己試験に全て合格しました' -ForegroundColor Green
exit 0
