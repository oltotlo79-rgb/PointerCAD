# PointerCAD gitフックの有効化(rules/00-施行の仕組み.md)
# core.hooksPath を scripts/hooks に設定し、pre-commit / pre-push を有効にする。
# クローン直後に必ず1回実行する。

[CmdletBinding()]
param(
    [string]$RepositoryRoot = ""
)

$scriptDirectory = [string]$PSScriptRoot
if ([string]::IsNullOrWhiteSpace($scriptDirectory)) {
    $invocationPath = [string]$MyInvocation.MyCommand.Path
    if (-not [string]::IsNullOrWhiteSpace($invocationPath)) {
        $scriptDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($invocationPath))
    }
}
if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
    $RepositoryRoot = Split-Path -Parent $scriptDirectory
}
$root = [IO.Path]::GetFullPath($RepositoryRoot).TrimEnd([char[]]"\\/")

$hooksDirectory = Join-Path $root "scripts\hooks"
foreach ($hookName in @("pre-commit", "pre-push")) {
    $hookPath = Join-Path $hooksDirectory $hookName
    if (-not (Test-Path -LiteralPath $hookPath -PathType Leaf)) {
        Write-Host "[NG] フックが見つかりません: $hookPath" -ForegroundColor Red
        exit 1
    }
}

$global:LASTEXITCODE = 0
& git -C $root config core.hooksPath scripts/hooks
if ($LASTEXITCODE -ne 0) {
    Write-Host "[NG] core.hooksPath の設定に失敗しました" -ForegroundColor Red
    exit 1
}

$configured = (& git -C $root config core.hooksPath)
if ($configured -ne "scripts/hooks") {
    Write-Host "[NG] core.hooksPath の設定値が想定と異なります: $configured" -ForegroundColor Red
    exit 1
}

Write-Host "[OK] gitフックを有効化しました (core.hooksPath = scripts/hooks)" -ForegroundColor Green
exit 0
