$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\gitTreeGuard.ps1')
$isolatedEntry = Start-IsolatedGitSelftest -ScriptPath $MyInvocation.MyCommand.Path
if ($isolatedEntry.Restarted) { exit $isolatedEntry.ExitCode }

$projectTemp = & python -B -X utf8 (Join-Path $PSScriptRoot 'lib/task_workspace.py') --temp-root
if ($LASTEXITCODE -ne 0) { throw 'プロジェクト内の自己試験保存先を用意できませんでした。' }
foreach ($tempVariable in @('TEMP', 'TMP', 'TMPDIR')) {
    [Environment]::SetEnvironmentVariable($tempVariable, ($projectTemp -join "`n").Trim(), 'Process')
}

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
    param([string]$Root, [int]$Completed, [int]$Reported = -1)

    if ($Reported -lt 0) { $Reported = $Completed }
    $planned = @(1..12 | ForEach-Object { "P0-$_" })
    $done = if ($Completed -gt 0) { @($planned[0..($Completed - 1)]) } else { @() }
    $value = [ordered]@{
        schemaVersion = 1
        totalTasks = 12
        futureEstimateTasks = 0
        completedBeforeTrackedPhases = 0
        reportedCompleted = $Reported
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
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $tempRoot '.git') -PathType Container)) {
        throw '一括コミット検査の自己試験用リポジトリを初期化できませんでした'
    }
    $initialRoot = (Read-GitSnapshotMetadata -Root $tempRoot -Arguments @('rev-parse', '--show-toplevel')).Trim()
    if ([IO.Path]::GetFullPath($initialRoot) -ne [IO.Path]::GetFullPath($tempRoot)) {
        throw '一括コミット検査の自己試験の変更先が専用リポジトリと一致しません'
    }
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
    Assert-CommitBatch ($nine.Ok -and $nine.AddedTaskIds.Count -eq 9) '新規完了9件の実装もmainへ通す(完了件数の下限は無い)'
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
    Assert-CommitBatch ($mainAgain.Ok -and $mainAgain.AddedTaskIds.Count -eq 0) 'A1: 同じ小さな変更(新規完了0件)もmainへ通す'

    Write-ProgressFixture -Root $tempRoot -Completed 2 -Reported 3
    & git -C $tempRoot add docs/progress.json | Out-Null
    $mismatch = Test-CommitBatchRepository -RepositoryRoot $tempRoot
    Assert-CommitBatch (-not $mismatch.Ok -and $mismatch.AddedTaskIds.Count -eq 2 -and $mismatch.Message.Contains('reportedCompleted')) 'reportedCompletedの増分と新規完了IDの数が違えば拒否する'
    # 2026-11-12に廃止した件数の例外の記録が.gitに残っていても、完了記録の照合を飛ばさない。
    $staleExceptionPath = Join-Path $tempRoot '.git/pointercad-commit-batch-approval.json'
    $staleException = @{ approvedBy = 'user'; reason = '廃止した件数の例外の記録'; base = (& git -C $tempRoot rev-parse HEAD).Trim(); tree = (& git -C $tempRoot write-tree).Trim() }
    [IO.File]::WriteAllText($staleExceptionPath, ($staleException | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    $staleResult = Test-CommitBatchRepository -RepositoryRoot $tempRoot
    Assert-CommitBatch (-not $staleResult.Ok -and $staleResult.Message.Contains('reportedCompleted')) '廃止した件数の例外の記録が残っていても完了記録の不一致を拒否する'
    Remove-Item -LiteralPath $staleExceptionPath -Force

    & git -C $tempRoot reset --quiet --hard HEAD | Out-Null
    Write-ProgressFixture -Root $tempRoot -Completed 10
    [IO.File]::WriteAllText((Join-Path $tempRoot 'packages\demo\index.ts'), 'export const value = 10;', (New-Object Text.UTF8Encoding($false)))
    & git -C $tempRoot add docs/progress.json packages/demo/index.ts | Out-Null
    & git -C $tempRoot commit --quiet -m 'ten completed' | Out-Null
    Write-ProgressFixture -Root $tempRoot -Completed 9
    [IO.File]::WriteAllText((Join-Path $tempRoot 'packages\demo\index.ts'), 'export const value = 11;', (New-Object Text.UTF8Encoding($false)))
    & git -C $tempRoot add docs/progress.json packages/demo/index.ts | Out-Null
    $removed = Test-CommitBatchRepository -RepositoryRoot $tempRoot
    Assert-CommitBatch (-not $removed.Ok -and $removed.Message.Contains('P0-10')) '完了済みタスクIDの削除を拒否する'

    & git -C $tempRoot reset --quiet --hard HEAD | Out-Null
    & git -C $tempRoot rm --quiet docs/progress.json | Out-Null
    [IO.File]::WriteAllText((Join-Path $tempRoot 'packages\demo\index.ts'), 'export const value = 12;', (New-Object Text.UTF8Encoding($false)))
    & git -C $tempRoot add packages/demo/index.ts | Out-Null
    # Windows PowerShell 5.1では失敗したgitの標準エラーが例外になる。入口(check-commit-batch.ps1)と同じく例外も拒否として数える。
    try {
        $missing = Test-CommitBatchRepository -RepositoryRoot $tempRoot
        $missingRefused = -not $missing.Ok
        $missingMessage = $missing.Message
    }
    catch {
        $missingRefused = $true
        $missingMessage = $_.Exception.Message
    }
    Assert-CommitBatch ($missingRefused -and $missingMessage.Contains('docs/progress.json')) '実装の変更でstageにdocs/progress.jsonが無ければ拒否する'

    & git -C $tempRoot reset --quiet --hard HEAD | Out-Null
    [IO.File]::WriteAllText((Join-Path $tempRoot 'docs\progress.json'), '{ invalid json', (New-Object Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText((Join-Path $tempRoot 'packages\demo\index.ts'), 'export const value = 13;', (New-Object Text.UTF8Encoding($false)))
    & git -C $tempRoot add docs/progress.json packages/demo/index.ts | Out-Null
    $broken = Test-CommitBatchRepository -RepositoryRoot $tempRoot
    Assert-CommitBatch (-not $broken.Ok -and $broken.Message.Contains('JSON')) 'stageのdocs/progress.jsonをJSONとして読めなければ拒否する'

    & git -C $tempRoot reset --quiet --hard HEAD | Out-Null
    & git -C $tempRoot rm --quiet packages/demo/index.ts | Out-Null
    $deletion = Test-CommitBatchRepository -RepositoryRoot $tempRoot
    Assert-CommitBatch ($deletion.Ok -and (@($deletion.ImplementationPaths) -contains 'packages/demo/index.ts')) '実装ファイルの削除も実装の変更として完了記録を照合する'
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
