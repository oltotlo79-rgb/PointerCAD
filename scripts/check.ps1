# PointerCAD 一括検査スクリプト(Windows PowerShell 5.1 / pwsh 対応)
# rules/03-品質ゲート.md §7.1 の検査を順に実行し、いずれかが失敗したら非0で終了する。
#   (0) 作業ツリーの状態記録(検査前後で比較し、テストによる書換を検出。-Level Push だけ。
#       -Level Commit は「stage 済みの差分だけを写した別の作業ツリー」で検査するため、
#       本物の作業ツリー・indexには一切触れず前後比較は不要。理由: scripts/lib/gitTreeGuard.ps1、
#       rules/06-過去の失敗と対策.md 10.7)
#   (1) pnpm run typecheck      -Level Commit / Push の両方
#   (2) pnpm run lint           -Level Commit / Push の両方
#   (3) pnpm run test           -Level Commit / Push の両方
#   (4) pnpm run build          -Level Commit / Push の両方
#   (5) pnpm run test:e2e       -Level Push のときだけ(スクリプトが定義されている場合)
# -Level Commit は `git worktree add --detach HEAD` で写しを作り、`git diff --cached` を
# `git apply` で載せ、node_modules だけジャンクションで元へ向けてから写しの中で検査する
# (並列作業中の他担当の未 stage な書きかけに影響されないため)。-Level Push は従来どおり
# 作業ツリー全体を対象にする(並列編集が無い前提)。
# 既定は -Level Push(全部)。pre-commit だけが -Level Commit を渡す。
# ルート package.json が無い間(P0未着手)は検査対象なしとして合格扱い。
# typecheck / lint / test / build のスクリプト欠落は失敗(fail-closed)。
# 検査の単一正本: CI(.github/workflows/ci.yml)とgitフックもこのスクリプトを実行する。
# 検査を増減するときは本スクリプトと rules/03-品質ゲート.md §7.1 を同じコミットで更新する。

[CmdletBinding()]
param(
    [string]$RepositoryRoot = "",
    [switch]$Install,
    # Commit: 型検査・書き方・ユニットテスト・組み立ての4つ(pre-commit 用)
    # Push  : 上記に E2E を足した5つ(pre-push、CI、統括の手動実行の既定)
    [ValidateSet("Commit", "Push")]
    [string]$Level = "Push",
    # 診断用: 性能検査の判定モード(厳密/参考)の表示だけを行って終了する(pnpmは一切実行しない)。
    # 統括の動作確認、および scripts/check.selftest.ps1 からの検証に使う。
    [switch]$ShowPerfModeOnly
)

$scriptDirectory = [string]$PSScriptRoot
if ([string]::IsNullOrWhiteSpace($scriptDirectory)) {
    $invocationPath = [string]$MyInvocation.MyCommand.Path
    if (-not [string]::IsNullOrWhiteSpace($invocationPath)) {
        $scriptDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($invocationPath))
    }
}
if ([string]::IsNullOrWhiteSpace($scriptDirectory)) {
    throw "スクリプトの場所を特定できません。"
}
if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
    $RepositoryRoot = Split-Path -Parent $scriptDirectory
}
$root = [IO.Path]::GetFullPath($RepositoryRoot).TrimEnd([char[]]"\\/")

# (0) の前後比較で使う関数群(scripts/check.selftest.ps1 と共有する単一正本)
. (Join-Path $scriptDirectory "lib\gitTreeGuard.ps1")

function Invoke-Check {
    param([string]$Name, [string]$Command, [string[]]$CommandArgs)
    Write-Host ""
    Write-Host "=== $Name ===" -ForegroundColor Cyan
    # 直前のコマンドの終了コードが残って偽の合格にならないよう必ずリセットする
    $global:LASTEXITCODE = 0
    # コマンド不在などの起動失敗はここでcatchして確実に失敗終了させる
    try {
        & $Command @CommandArgs
    } catch {
        Write-Host "[NG] $Name を起動できませんでした: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "[NG] $Name が失敗しました(終了コード: $LASTEXITCODE)" -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

Push-Location $root
try {
    # 性能検査(NFR-PF-2/PF-3、packages/kernel/src/worker/solidPerformance.test.ts、および
    # packages/model/src/sketch/constraints の solve.test.ts / diagnose.test.ts が同じ流儀で読む)の
    # 上限判定を厳密にするか参考にとどめるかの切替。並列作業中の CPU 競合で境界値の検査が
    # 落ちる問題への対策(rules/06-過去の失敗と対策.md 10.3)。上限の数値は変えない。
    # -Level Push(pre-push・統括の手動実行)は厳密、-Level Commit(pre-commit)は明示的に空にして参考とする。
    # ただし -Level Push であっても CI(共有ランナー)上では厳密判定をしない。共有ランナーは基準の
    # 機械より遅く、実行のたびの速さも揃わないため、ミリ秒単位の上限判定がCPU競合と無関係に揺れて
    # 落ちる(実測: GitHub Actions run 33972658785。rules/06-過去の失敗と対策.md 10.12)。CIでは実測を
    # ログに残すだけにとどめ、厳密な合否判定は基準の機械で行う手元のpre-push(-Level Push、CI以外)に
    # 委ねる。`CI` 環境変数はGitHub Actionsが自動で `true` を設定する(ci.ymlでの追加設定は不要)。
    $isRunningOnCI = $env:CI -eq 'true'
    if ($Level -eq "Push" -and -not $isRunningOnCI) {
        $env:POINTERCAD_PERF_STRICT = '1'
        Write-Host "性能検査: 厳密(-Level Push)" -ForegroundColor Cyan
    } elseif ($Level -eq "Push" -and $isRunningOnCI) {
        $env:POINTERCAD_PERF_STRICT = ''
        Write-Host "性能検査: 参考(CI)" -ForegroundColor Cyan
    } else {
        $env:POINTERCAD_PERF_STRICT = ''
        Write-Host "性能検査: 参考(-Level Commit)" -ForegroundColor Cyan
    }

    if ($ShowPerfModeOnly) {
        Write-Host "[診断] -ShowPerfModeOnly のため、性能検査の判定モード表示だけで終了します(pnpmは実行していません)" -ForegroundColor Yellow
        exit 0
    }

    $packageJsonPath = Join-Path $root "package.json"
    if (-not (Test-Path -LiteralPath $packageJsonPath -PathType Leaf)) {
        Write-Host "[SKIP] package.json が無いため検査対象がありません(P0未着手)。合格扱いとします。" -ForegroundColor Yellow
        exit 0
    }

    # 必須スクリプトの欠落検出(fail-closed)
    $package = Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $definedScripts = @()
    if ($null -ne $package.scripts) {
        $definedScripts = @($package.scripts.PSObject.Properties.Name)
    }
    $requiredScripts = @("typecheck", "lint", "test", "build")
    $missingScripts = @($requiredScripts | Where-Object { $definedScripts -notcontains $_ })
    if ($missingScripts.Count -gt 0) {
        Write-Host "[NG] ルート package.json に必須スクリプトがありません: $($missingScripts -join ', ')" -ForegroundColor Red
        Write-Host "     rules/03-品質ゲート.md §7.1 により、欠落は失敗として扱います。" -ForegroundColor Red
        exit 1
    }
    $hasE2E = $definedScripts -contains "test:e2e"

    if ($Install) {
        Invoke-Check "(0) pnpm install --frozen-lockfile" pnpm @("install", "--frozen-lockfile")
    }

    if ($Level -eq "Commit") {
        # -Level Commit: stage 済みの差分だけを写した別の作業ツリーで検査する(rules/06 10.7)。
        # 本物の作業ツリー・indexには一切触れないため、前後の追跡対象比較(#0)は不要。
        Write-Host "作業ツリーの状態記録: 写しの中で検査するため省略します(-Level Commit、rules/03-品質ゲート.md §7.1 #0)" -ForegroundColor Cyan

        $totalChecks = 4
        # New-StagedTreeWorktree は Ok=$false でも Path が worktree add 済みのことがある
        # (例: diff の適用に失敗)。後片付け漏れを防ぐため、写しの用意から検査までを
        # 1つの try/finally で必ず包む(Ok=$false での早期 exit も finally を経由させる)。
        $copy = New-StagedTreeWorktree -Root $root
        $junctions = @()
        try {
            if (-not $copy.Ok) {
                Write-Host "[NG] コミット前検査用の写し(git worktree)を用意できませんでした: $($copy.Reason)" -ForegroundColor Red
                exit 1
            }
            $junctions = New-NodeModulesJunctions -Root $root -WorktreePath $copy.Path
            Push-Location $copy.Path
            # 写しの中で pnpm を実行する間も、pre-commit フックから継承した GIT_DIR /
            # GIT_INDEX_FILE 等(相対パス)を一時的に消す。pnpm/vite/vitest 等が内部で
            # git を呼ぶ場合にも、写しではなく主リポジトリ側を指してしまうことを防ぐ
            # (New-StagedTreeWorktree 冒頭のコメント、rules/06-過去の失敗と対策.md 10.7)。
            $savedGitEnvForChecks = Clear-InheritedGitEnv
            try {
                Invoke-Check "(1/$totalChecks) pnpm run typecheck" pnpm @("run", "typecheck")
                Invoke-Check "(2/$totalChecks) pnpm run lint" pnpm @("run", "lint")
                Invoke-Check "(3/$totalChecks) pnpm run test" pnpm @("run", "test")
                Invoke-Check "(4/$totalChecks) pnpm run build" pnpm @("run", "build")
            }
            finally {
                Restore-InheritedGitEnv -Saved $savedGitEnvForChecks
                Pop-Location
            }
        }
        finally {
            Remove-StagedTreeWorktree -Root $root -WorktreePath $copy.Path -JunctionPaths $junctions
        }
    }
    else {
        # -Level Push: 従来どおり作業ツリー全体を対象にする(並列編集が無い前提)。
        # (0) 検査がコミット対象のファイルを書き換えていないかを、実行の前後で比べる。
        $beforeSnapshot = Get-TrackedTreeSnapshot -Root $root -Level $Level
        if (-not $beforeSnapshot.Ok) {
            Write-Host "[NG] 追跡対象変更ガードの git 呼び出しが失敗しました" -ForegroundColor Red
            exit 1
        }
        $skipTreeCompare = ($beforeSnapshot.Mode -eq "Staged") -and ($beforeSnapshot.Paths.Count -eq 0)
        if ($skipTreeCompare) {
            Write-Host "[警告] stage 済みのファイルが無いため、検査前後の比較を省略します" -ForegroundColor Yellow
        }

        $runE2E = $hasE2E
        $totalChecks = 4
        if ($runE2E) { $totalChecks = 5 }
        Invoke-Check "(1/$totalChecks) pnpm run typecheck" pnpm @("run", "typecheck")
        Invoke-Check "(2/$totalChecks) pnpm run lint" pnpm @("run", "lint")
        Invoke-Check "(3/$totalChecks) pnpm run test" pnpm @("run", "test")
        Invoke-Check "(4/$totalChecks) pnpm run build" pnpm @("run", "build")
        if ($runE2E) {
            # Playwright のブラウザは初回だけ取得され、2回目以降は即座に終わる。
            # ここで面倒を見ることで .github/workflows/ci.yml を変えずに済み、
            # 検査の単一正本(rules/03-品質ゲート.md §7.2)を保てる。
            Invoke-Check "(準備) Playwright のブラウザ確認" pnpm @("exec", "playwright", "install", "chromium")
            Invoke-Check "(5/$totalChecks) pnpm run test:e2e" pnpm @("run", "test:e2e")
        }

        $afterSnapshot = Get-TrackedTreeSnapshot -Root $root -Level $Level
        if (-not $afterSnapshot.Ok) {
            Write-Host "[NG] 追跡対象変更ガードの git 呼び出しが失敗しました" -ForegroundColor Red
            exit 1
        }
        if (-not $skipTreeCompare) {
            $comparison = Compare-TrackedTreeSnapshot -Before $beforeSnapshot -After $afterSnapshot
            if (-not $comparison.Unchanged) {
                Write-Host ""
                Write-Host "[NG] 検査が追跡対象のファイルを書き換えました" -ForegroundColor Red
                Write-Host "実行前:" -ForegroundColor Yellow
                Write-Host $beforeSnapshot.Status
                Write-Host "実行後:" -ForegroundColor Yellow
                Write-Host $afterSnapshot.Status
                exit 1
            }
        }
    }

    Write-Host ""
    Write-Host "[OK] 全ての検査に合格しました" -ForegroundColor Green
}
finally {
    Pop-Location
}
exit 0
