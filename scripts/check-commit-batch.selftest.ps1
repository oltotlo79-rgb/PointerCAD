$ErrorActionPreference = 'Stop'

$libraryPath = Join-Path $PSScriptRoot 'lib\commitBatchGuard.ps1'
if (-not (Test-Path -LiteralPath $libraryPath -PathType Leaf)) {
    Write-Host "[NG] 一括コミット検査のライブラリが見つかりません: $libraryPath" -ForegroundColor Red
    exit 1
}
. $libraryPath

$failures = 0
function Assert-CommitBatch {
    param([bool]$Condition, [string]$Label)
    if ($Condition) {
        Write-Host "[OK] $Label" -ForegroundColor Green
    }
    else {
        Write-Host "[NG] $Label" -ForegroundColor Red
        $script:failures++
    }
}

function Write-ProgressFixture {
    param([string]$Root, [int]$Completed)

    $planned = @(1..12 | ForEach-Object { "P0-$_" })
    $done = if ($Completed -gt 0) { @($planned[0..($Completed - 1)]) } else { @() }
    $value = [ordered]@{
        schemaVersion = 1
        totalTasks = 12
        futureEstimateTasks = 0
        completedBeforeTrackedPhases = 0
        reportedCompleted = $Completed
        phases = @([ordered]@{
            id = 'P0'
            plannedTaskCount = 12
            plannedTaskIds = $planned
            completedTaskIds = $done
        })
    }
    $json = $value | ConvertTo-Json -Depth 10
    [IO.File]::WriteAllText(
        (Join-Path $Root 'docs\progress.json'),
        $json,
        (New-Object Text.UTF8Encoding($false))
    )
}

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRoot = Join-Path $tempBase ("pointercad-batchguard-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $tempRoot 'docs') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $tempRoot 'packages\demo') -Force | Out-Null

try {
    & git -C $tempRoot init --quiet | Out-Null
    & git -C $tempRoot config user.email 'batchguard@example.invalid' | Out-Null
    & git -C $tempRoot config user.name 'commit batch guard selftest' | Out-Null
    & git -C $tempRoot checkout --quiet -b main | Out-Null
    Write-ProgressFixture -Root $tempRoot -Completed 0
    [IO.File]::WriteAllText((Join-Path $tempRoot 'docs\note.md'), 'base', (New-Object Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText((Join-Path $tempRoot 'packages\demo\index.ts'), 'export const value = 0;', (New-Object Text.UTF8Encoding($false)))
    & git -C $tempRoot add . | Out-Null
    & git -C $tempRoot commit --quiet -m 'base' | Out-Null

    [IO.File]::WriteAllText((Join-Path $tempRoot 'docs\note.md'), 'docs only', (New-Object Text.UTF8Encoding($false)))
    & git -C $tempRoot add docs/note.md | Out-Null
    $docsOnly = Test-CommitBatchRepository -RepositoryRoot $tempRoot
    Assert-CommitBatch $docsOnly.Ok 'main上の文書だけのコミットは通す'
    & git -C $tempRoot reset --quiet --hard HEAD | Out-Null

    Write-ProgressFixture -Root $tempRoot -Completed 9
    [IO.File]::WriteAllText((Join-Path $tempRoot 'packages\demo\index.ts'), 'export const value = 9;', (New-Object Text.UTF8Encoding($false)))
    & git -C $tempRoot add docs/progress.json packages/demo/index.ts | Out-Null
    $nine = Test-CommitBatchRepository -RepositoryRoot $tempRoot
    Assert-CommitBatch (-not $nine.Ok -and $nine.AddedTaskIds.Count -eq 9) '実装9件を拒否する'
    & git -C $tempRoot reset --quiet --hard HEAD | Out-Null

    Write-ProgressFixture -Root $tempRoot -Completed 10
    [IO.File]::WriteAllText((Join-Path $tempRoot 'packages\demo\index.ts'), 'export const value = 10;', (New-Object Text.UTF8Encoding($false)))
    & git -C $tempRoot add docs/progress.json packages/demo/index.ts | Out-Null
    $ten = Test-CommitBatchRepository -RepositoryRoot $tempRoot
    Assert-CommitBatch ($ten.Ok -and $ten.AddedTaskIds.Count -eq 10) '実装10件を通す'

    & git -C $tempRoot checkout --quiet -b feature | Out-Null
    $wrongBranch = Test-CommitBatchRepository -RepositoryRoot $tempRoot
    Assert-CommitBatch (-not $wrongBranch.Ok -and $wrongBranch.Message -match 'main') 'main以外のブランチを拒否する'
}
finally {
    $resolvedRoot = [IO.Path]::GetFullPath($tempRoot)
    if ($resolvedRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $resolvedRoot) -like 'pointercad-batchguard-*') {
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
    }
}

if ($failures -gt 0) {
    Write-Host "[NG] 一括コミット検査の自己試験: $failures 件失敗" -ForegroundColor Red
    exit 1
}
Write-Host '[OK] 一括コミット検査の自己試験に合格しました' -ForegroundColor Green
exit 0
