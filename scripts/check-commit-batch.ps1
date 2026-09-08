param(
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
    [int]$MinimumCompletedTasks = 10
)

$ErrorActionPreference = 'Stop'
$libraryPath = Join-Path $PSScriptRoot 'lib\commitBatchGuard.ps1'
if (-not (Test-Path -LiteralPath $libraryPath -PathType Leaf)) {
    Write-Host "[NG] 一括コミット検査のライブラリが見つかりません: $libraryPath" -ForegroundColor Red
    exit 1
}
. $libraryPath

try {
    $root = [IO.Path]::GetFullPath($RepositoryRoot)
    $result = Test-CommitBatchRepository -RepositoryRoot $root -MinimumCompletedTasks $MinimumCompletedTasks
}
catch {
    Write-Host "[NG] 一括コミット検査を実行できませんでした: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

if (-not $result.Ok) {
    Write-Host "[NG] $($result.Message)" -ForegroundColor Red
    if ($result.AddedTaskIds.Count -gt 0) {
        Write-Host "     新規完了ID: $($result.AddedTaskIds -join ', ')" -ForegroundColor Red
    }
    exit 1
}

Write-Host "[OK] $($result.Message)" -ForegroundColor Green
if ($result.AddedTaskIds.Count -gt 0) {
    Write-Host "     新規完了ID: $($result.AddedTaskIds -join ', ')"
}
exit 0
