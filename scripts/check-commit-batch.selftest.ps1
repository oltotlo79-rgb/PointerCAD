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

    & git -C $tempRoot reset --quiet --hard HEAD | Out-Null
    & git -C $tempRoot checkout --quiet -b feature | Out-Null
    [IO.File]::WriteAllText((Join-Path $tempRoot 'packages\demo\index.ts'), 'export const value = 1;')
    & git -C $tempRoot add packages/demo/index.ts | Out-Null
    $workBranch = Test-CommitBatchRepository -RepositoryRoot $tempRoot
    Assert-CommitBatch ($workBranch.Ok -and $workBranch.AddedTaskIds.Count -eq 0) 'A1: 作業ブランチでの小さな保存を認め、完了IDを加算しない'
    & git -C $tempRoot checkout --quiet main | Out-Null
    $mainAgain = Test-CommitBatchRepository -RepositoryRoot $tempRoot
    Assert-CommitBatch (-not $mainAgain.Ok) 'A1: 同じ小さな変更でもmainへの通常統合は拒否する'

    $approvedBase = (& git -C $tempRoot rev-parse HEAD).Trim()
    $approvedTree = (& git -C $tempRoot write-tree).Trim()
    $approvalPath = Join-Path $tempRoot '.git/pointercad-commit-batch-approval.json'
    $approval = @{ approvedBy = 'user'; reason = '利用者がCI修正の先行を承認'; base = $approvedBase; tree = $approvedTree }
    [IO.File]::WriteAllText($approvalPath, ($approval | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    Assert-CommitBatch (Test-CommitBatchRepository -RepositoryRoot $tempRoot).Ok '明示承認の親とstage全体が一致する場合だけ例外を認める'

    [IO.File]::WriteAllText((Join-Path $tempRoot 'docs/note.md'), 'unapproved addition')
    & git -C $tempRoot add docs/note.md | Out-Null
    Assert-CommitBatch (-not (Test-CommitBatchRepository -RepositoryRoot $tempRoot).Ok) '承認後に文書だけを追加しても別のstageとして拒否する'
    & git -C $tempRoot restore --source=HEAD --staged --worktree -- docs/note.md | Out-Null
    $approval.base = ('0' * 40)
    [IO.File]::WriteAllText($approvalPath, ($approval | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    Assert-CommitBatch (-not (Test-CommitBatchRepository -RepositoryRoot $tempRoot).Ok) '親コミットが違う承認を使い回さない'
    $approval.base = $approvedBase
    $approval.reason = ''
    [IO.File]::WriteAllText($approvalPath, ($approval | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    Assert-CommitBatch (-not (Test-CommitBatchRepository -RepositoryRoot $tempRoot).Ok) '理由のない例外記録を拒否する'
    [IO.File]::WriteAllText($approvalPath, '{ invalid json')
    Assert-CommitBatch (-not (Test-CommitBatchRepository -RepositoryRoot $tempRoot).Ok) '壊れた例外記録を拒否する'
    Remove-Item -LiteralPath $approvalPath -Force

    & git -C $tempRoot reset --quiet --hard HEAD | Out-Null
    & git -C $tempRoot rm --quiet packages/demo/index.ts | Out-Null
    Assert-CommitBatch (-not (Test-CommitBatchRepository -RepositoryRoot $tempRoot).Ok) '実装ファイルの削除だけでも10件条件を適用する'
    & git -C $tempRoot reset --quiet --hard HEAD | Out-Null
    & git -C $tempRoot checkout --quiet --detach HEAD | Out-Null
    Assert-CommitBatch (-not (Test-CommitBatchRepository -RepositoryRoot $tempRoot).Ok) 'detached HEADへの保存は拒否する'
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
