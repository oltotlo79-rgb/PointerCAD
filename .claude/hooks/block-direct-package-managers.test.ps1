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
        [string]$EventName = 'PreToolUse'
    )

    $payload = @{
        hook_event_name = $EventName
        tool_name       = $ToolName
        tool_input      = @{ command = $Command }
    } | ConvertTo-Json -Compress -Depth 4

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

Write-Host ''
if ($failures -gt 0) {
    Write-Host "[NG] 自己試験に $failures 件の失敗があります" -ForegroundColor Red
    exit 1
}
Write-Host '[OK] フックの自己試験に全て合格しました' -ForegroundColor Green
exit 0
