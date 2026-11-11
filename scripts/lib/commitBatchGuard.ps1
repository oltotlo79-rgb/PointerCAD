$ErrorActionPreference = 'Stop'

function Invoke-CommitBatchGit {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $safeDirectory = @('-c', ('safe.directory=' + ([IO.Path]::GetFullPath($RepositoryRoot).Replace('\', '/'))))
    $lines = @(& git -C $RepositoryRoot @safeDirectory @Arguments 2>$null)
    $exitCode = $LASTEXITCODE
    [PSCustomObject]@{
        Ok = ($exitCode -eq 0)
        ExitCode = $exitCode
        Text = ($lines -join "`n")
        Lines = $lines
    }
}

function Get-CommitBatchCompletedIds {
    param([Parameter(Mandatory = $true)]$Progress)

    $ids = @{}
    foreach ($phase in @($Progress.phases)) {
        foreach ($taskId in @($phase.completedTaskIds)) {
            if (-not [string]::IsNullOrWhiteSpace([string]$taskId)) {
                $ids[[string]$taskId] = $true
            }
        }
    }
    return $ids
}

function New-CommitBatchGuardResult {
    param(
        [Parameter(Mandatory = $true)][bool]$Ok,
        [Parameter(Mandatory = $true)][string]$Message,
        [string[]]$AddedTaskIds = @(),
        [string[]]$ImplementationPaths = @()
    )

    [PSCustomObject]@{
        Ok = $Ok
        Message = $Message
        AddedTaskIds = @($AddedTaskIds)
        ImplementationPaths = @($ImplementationPaths)
    }
}

function Test-CommitBatchRepository {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [string]$RequiredBranch = 'main',
        [string]$ProgressPath = 'docs/progress.json'
    )

    # 2026-11-12 の利用者の指示により、mainへの送信に完了件数の下限は無い。
    # 完了記録の整合(削除0件・reportedCompletedの増分の一致)だけを確かめる。
    $branchResult = Invoke-CommitBatchGit -RepositoryRoot $RepositoryRoot -Arguments @('branch', '--show-current')
    if (-not $branchResult.Ok) {
        return New-CommitBatchGuardResult -Ok $false -Message '現在のブランチを取得できませんでした。'
    }
    $branch = $branchResult.Text.Trim()
    if ([string]::IsNullOrWhiteSpace($branch)) {
        return New-CommitBatchGuardResult -Ok $false -Message '作業を保存するブランチが必要です。detached HEADではコミットできません。'
    }

    $pathsResult = Invoke-CommitBatchGit -RepositoryRoot $RepositoryRoot -Arguments @(
        '-c', 'core.quotepath=false', 'diff', '--cached', '--name-only', '--diff-filter=ACMRD'
    )
    if (-not $pathsResult.Ok) {
        return New-CommitBatchGuardResult -Ok $false -Message 'stage済みファイルの一覧を取得できませんでした。'
    }
    if ($branch -ne $RequiredBranch) {
        return New-CommitBatchGuardResult -Ok $true -Message "作業ブランチ $branch へ保存します。この保存で完成度を増やしません。"
    }

    $implementationPaths = @($pathsResult.Lines | Where-Object {
        $_ -match '^(apps|packages|e2e|scripts|\.github)/' -or
        $_ -match '^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|eslint\.config\.[^/]+|tsconfig[^/]*\.json)$'
    })
    if ($implementationPaths.Count -eq 0) {
        return New-CommitBatchGuardResult -Ok $true -Message "文書だけのコミットです。ブランチ $RequiredBranch を確認しました。"
    }

    $stagedProgressResult = Invoke-CommitBatchGit -RepositoryRoot $RepositoryRoot -Arguments @('show', ":$ProgressPath")
    if (-not $stagedProgressResult.Ok) {
        return New-CommitBatchGuardResult -Ok $false `
            -Message "実装コミットにはstage済みの $ProgressPath が必要です。" `
            -ImplementationPaths $implementationPaths
    }
    $headProgressResult = Invoke-CommitBatchGit -RepositoryRoot $RepositoryRoot -Arguments @('show', "HEAD:$ProgressPath")
    if (-not $headProgressResult.Ok) {
        return New-CommitBatchGuardResult -Ok $false `
            -Message "HEADの $ProgressPath を取得できませんでした。" `
            -ImplementationPaths $implementationPaths
    }

    try {
        $stagedProgress = $stagedProgressResult.Text | ConvertFrom-Json
        $headProgress = $headProgressResult.Text | ConvertFrom-Json
    }
    catch {
        return New-CommitBatchGuardResult -Ok $false `
            -Message "$ProgressPath をJSONとして読めませんでした: $($_.Exception.Message)" `
            -ImplementationPaths $implementationPaths
    }

    $stagedIds = Get-CommitBatchCompletedIds -Progress $stagedProgress
    $headIds = Get-CommitBatchCompletedIds -Progress $headProgress
    $addedTaskIds = @($stagedIds.Keys | Where-Object { -not $headIds.ContainsKey($_) } | Sort-Object)
    $removedTaskIds = @($headIds.Keys | Where-Object { -not $stagedIds.ContainsKey($_) } | Sort-Object)

    if ($removedTaskIds.Count -gt 0) {
        return New-CommitBatchGuardResult -Ok $false `
            -Message "完了済みタスクIDを削除できません: $($removedTaskIds -join ', ')" `
            -AddedTaskIds $addedTaskIds `
            -ImplementationPaths $implementationPaths
    }
    $reportedDelta = [int]$stagedProgress.reportedCompleted - [int]$headProgress.reportedCompleted
    if ($reportedDelta -ne $addedTaskIds.Count) {
        return New-CommitBatchGuardResult -Ok $false `
            -Message "reportedCompleted の増分($reportedDelta)と新規完了ID数($($addedTaskIds.Count))が一致しません。" `
            -AddedTaskIds $addedTaskIds `
            -ImplementationPaths $implementationPaths
    }

    return New-CommitBatchGuardResult -Ok $true `
        -Message "ブランチ $RequiredBranch、新規完了 $($addedTaskIds.Count) 件を確認しました。" `
        -AddedTaskIds $addedTaskIds `
        -ImplementationPaths $implementationPaths
}
