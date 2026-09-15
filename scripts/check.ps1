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
#   (5) pnpm run test:e2e       -Level Push のときだけ(スクリプトが定義されている場合)。
#       -E2ERepeats で、ほかの4段を重複させず同じE2Eを連続実行できる。
# -Level Commit は `git worktree add --detach HEAD` で写しを作り、`git diff --cached` を
# `git apply` で載せ、node_modules だけジャンクションで元へ向けてから写しの中で検査する
# (並列作業中の他担当の未 stage な書きかけに影響されないため)。-Level Push は従来どおり
# 作業ツリー全体を対象にする(並列編集が無い前提)。
# 既定は -Level Push。承認済みの変更範囲から関係先を選び、CI/Full/判定不能では全部を検査する。
# pre-commit だけが -Level Commit を渡す。
# 修正中の短いフィードバックには -E2EOnly と -E2EGrep を使えるが、最終合格の代用にはしない。
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
    # B3: hooks can consume a completed full-check receipt. Manual checks always execute.
    [ValidateSet('Manual', 'Commit', 'Push', 'Disabled')]
    [string]$ReceiptPhase = 'Manual',
    # 2026-09-13: local checks follow the complete change scope; CI/release remain full.
    [switch]$Full,
    # pre-push passes the actual remote commit, never an inferred branch tip.
    [string]$ComparisonBase = '',
    [ValidateRange(1, 10)]
    [int]$E2ERepeats = 1,
    # 診断用: 1〜4段を省きE2Eだけを実行する。最終のPushゲートは必ずこの指定なしで通す。
    [switch]$E2EOnly,
    # -E2EOnly のときだけPlaywrightの--grepへ渡す。空なら全E2Eを実行する。
    [string]$E2EGrep = "",
    # 対象原因の調査専用。前提projectを省いた結果を通常ゲート・CIへ使用しない。
    [switch]$E2ENoDependencies,
    # 診断用: 指定パッケージの指定ユニットテストだけを実行する。最終ゲートの代用にはしない。
    [ValidateSet("", "desktop", "web", "drawing", "kernel", "model", "io", "ui", "test-utils", "help-content", "expression")]
    [string]$UnitPackage = "",
    [string[]]$UnitTests = @(),
    # 実装途中の診断専用。既定・pre-commit・pre-pushの必須段数は変えない。
    [switch]$StaticOnly,
    # 診断用: 正確性優先の性能判定と実行場所の表示だけを行って終了する(pnpmは一切実行しない)。
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
. (Join-Path $scriptDirectory "lib\validationReceipt.ps1")

function Invoke-Check {
    param([string]$Name, [string]$Command, [string[]]$CommandArgs)
    Write-Host ""
    Write-Host "=== $Name ===" -ForegroundColor Cyan
    Write-Host ("[開始] {0:yyyy-MM-ddTHH:mm:ss.fffzzz}" -f [DateTimeOffset]::Now)
    $checkTimer = [Diagnostics.Stopwatch]::StartNew()
    $checkExitCode = 1
    # 直前のコマンドの終了コードが残って偽の合格にならないよう必ずリセットする
    $global:LASTEXITCODE = 0
    # コマンド不在などの起動失敗はここでcatchして確実に失敗終了させる
    try {
        & $Command @CommandArgs
        $checkExitCode = $LASTEXITCODE
    } catch {
        Write-Host "[NG] $Name を起動できませんでした: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    } finally {
        $checkTimer.Stop()
        Write-Host ("[終了] {0:yyyy-MM-ddTHH:mm:ss.fffzzz} / {1} / 所要 {2:F3} 秒 / 終了コード {3}" -f `
            [DateTimeOffset]::Now, $Name, $checkTimer.Elapsed.TotalSeconds, $checkExitCode)
    }
    if ($checkExitCode -ne 0) {
        Write-Host ""
        Write-Host "[NG] $Name が失敗しました(終了コード: $checkExitCode)" -ForegroundColor Red
        exit $checkExitCode
    }
}

function Invoke-LocalPackageChecks {
    param([string[]]$Packages)
    foreach ($packageName in $Packages) {
        $folder = if ($packageName -in @('desktop', 'web')) { "apps/$packageName" } else { "packages/$packageName" }
        $packageFile = Join-Path (Get-Location).Path "$folder/package.json"
        if (-not (Test-Path -LiteralPath $packageFile -PathType Leaf)) { throw "Required local package is missing: $packageName" }
        $packageInfo = Get-Content -LiteralPath $packageFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]::IsNullOrWhiteSpace([string]$packageInfo.scripts.test)) { throw "Required local test command is missing: $packageName" }
        Invoke-Check "変更箇所の全ユニット検査: $packageName" pnpm @('--filter', "@pointercad/$packageName", 'run', 'test')
    }
}

$validationQos = $null
$receiptToken = ''
$receiptCompleted = $false
$savedTemporaryEnvironment = @{}
Push-Location $root
try {
    # Keep this project's own check output and child-process temporary files in
    # the project. The helper rejects an external path or an escaping junction.
    $temporaryRootOutput = & python -B -X utf8 (Join-Path $scriptDirectory 'lib/task_workspace.py') --repository $root --temp-root
    if ($LASTEXITCODE -ne 0) { throw 'プロジェクト内の一時保存先を用意できませんでした。' }
    $temporaryRoot = ($temporaryRootOutput -join "`n").Trim()
    if (-not (Test-Path -LiteralPath $temporaryRoot -PathType Container)) { throw '一時保存先が存在しません。' }
    foreach ($temporaryVariable in @('TEMP', 'TMP', 'TMPDIR')) {
        $savedTemporaryEnvironment[$temporaryVariable] = [Environment]::GetEnvironmentVariable($temporaryVariable, 'Process')
        [Environment]::SetEnvironmentVariable($temporaryVariable, $temporaryRoot, 'Process')
    }
    # 2026-09-14利用者指示: 正確性を優先し、元の速度目標は改善用に記録する。
    # 全環境で共通の実用性の境界を使う(releasePerformance.ts)。
    # 旧PERF_STRICTの値は測定順・HighQoS・B3の実行条件識別に残す。
    # 速度目標そのものの合否を環境変数で切り替える用途には使わない。
    $isRunningOnCI = $env:CI -eq 'true'
    if ($Level -eq "Push" -and -not $isRunningOnCI) {
        $env:POINTERCAD_PERF_STRICT = '1'
        Write-Host "性能検査: 正確性優先(-Level Push)" -ForegroundColor Cyan
    } elseif ($Level -eq "Push" -and $isRunningOnCI) {
        $env:POINTERCAD_PERF_STRICT = ''
        Write-Host "性能検査: 正確性優先(CI)" -ForegroundColor Cyan
    } else {
        $env:POINTERCAD_PERF_STRICT = ''
        Write-Host "性能検査: 正確性優先(-Level Commit)" -ForegroundColor Cyan
    }

    if ($ShowPerfModeOnly) {
        Write-Host "[診断] -ShowPerfModeOnly のため、性能検査の判定モード表示だけで終了します(pnpmは実行していません)" -ForegroundColor Yellow
        exit 0
    }
    if ($E2EOnly -and $Level -ne "Push") {
        Write-Host "[NG] -E2EOnly は -Level Push の診断でだけ使えます" -ForegroundColor Red
        exit 1
    }
    $unitDiagnostic = -not [string]::IsNullOrWhiteSpace($UnitPackage)
    if ($StaticOnly -and ($Level -ne "Push" -or $E2EOnly -or $unitDiagnostic -or $UnitTests.Count -gt 0)) {
        Write-Host "[NG] -StaticOnly は -Level Push で他の診断指定と分けてください" -ForegroundColor Red
        exit 1
    }
    if (($unitDiagnostic -and ($Level -ne "Push" -or $E2EOnly -or $UnitTests.Count -eq 0)) -or
        (-not $unitDiagnostic -and $UnitTests.Count -gt 0)) {
        Write-Host "[NG] ユニット診断は -Level Push -UnitPackage と -UnitTests を指定し、E2E診断とは分けてください" -ForegroundColor Red
        exit 1
    }
    foreach ($unitTest in $UnitTests) {
        if ($unitTest -notmatch '^src/[A-Za-z0-9_./-]+\.test\.tsx?$' -or $unitTest.Contains('..')) {
            Write-Host "[NG] ユニット診断には src/ 配下のテストファイルを指定してください" -ForegroundColor Red
            exit 1
        }
        $unitFolder = if ($UnitPackage -in @("desktop", "web")) { "apps/$UnitPackage" } else { "packages/$UnitPackage" }
        $unitTestPath = Join-Path (Join-Path $root $unitFolder) $unitTest
        if (-not (Test-Path -LiteralPath $unitTestPath -PathType Leaf)) {
            Write-Host "[NG] 指定したユニットテストが見つかりません: $unitFolder/$unitTest" -ForegroundColor Red
            exit 1
        }
    }
    if (-not $E2EOnly -and -not [string]::IsNullOrWhiteSpace($E2EGrep)) {
        Write-Host "[NG] -E2EGrep は -E2EOnly と一緒に指定してください" -ForegroundColor Red
        exit 1
    }
    if ($E2ENoDependencies -and (-not $E2EOnly -or [string]::IsNullOrWhiteSpace($E2EGrep) -or
        $Full -or $Install -or $isRunningOnCI -or $ReceiptPhase -ne 'Manual' -or $E2ERepeats -ne 1)) {
        Write-Host '[NG] -E2ENoDependencies は対象名付きの手動E2E診断だけに使用できます。全体検査・CI・フック・連続検査には使用できません。' -ForegroundColor Red
        exit 1
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

    $ordinaryGate = -not $StaticOnly -and -not $E2EOnly -and -not $unitDiagnostic -and -not $Install
    $localScope = $null
    $localRuntimeChecks = $false
    $localAllE2EChecks = $false
    if ($ordinaryGate -and -not $Full -and -not $isRunningOnCI -and $E2ERepeats -eq 1 -and $ReceiptPhase -ne 'Disabled') {
        $scopeScript = Join-Path $scriptDirectory 'lib/local_change_scope.py'
        if (Test-Path -LiteralPath $scopeScript -PathType Leaf) {
            try {
                $scopeArgs = @('-B', $scopeScript, '--root', $root, '--level', $Level, '--phase', $ReceiptPhase)
                if (-not [string]::IsNullOrWhiteSpace($ComparisonBase)) { $scopeArgs += @('--base', $ComparisonBase) }
                $scopeJson = & python @scopeArgs
                if ($LASTEXITCODE -ne 0) { throw 'Local scope inspection failed' }
                $candidateScope = ($scopeJson -join "`n") | ConvertFrom-Json
                $allowedPackages = @('desktop', 'web', 'drawing', 'kernel', 'model', 'io', 'ui', 'test-utils', 'help-content', 'expression')
                if ($candidateScope.mode -eq 'targeted' -and @($candidateScope.packages).Count -gt 0 -and
                    @($candidateScope.packages | Where-Object { $allowedPackages -notcontains $_ }).Count -eq 0) {
                    $localScope = $candidateScope
                    if ($candidateScope.PSObject.Properties.Name -contains 'runtimeChecks') {
                        if ($candidateScope.runtimeChecks -isnot [bool]) { throw 'Invalid runtime scope flag' }
                        $localRuntimeChecks = $candidateScope.runtimeChecks
                    }
                    if ($candidateScope.PSObject.Properties.Name -contains 'allE2EChecks') {
                        if ($candidateScope.allE2EChecks -isnot [bool]) { throw 'Invalid complete E2E scope flag' }
                        $localAllE2EChecks = $candidateScope.allE2EChecks
                    }
                    Write-Host "[検査範囲] 変更箇所別: $($localScope.reason) / $($localScope.packages -join ', ')。全検査は両OS CIで実施します。" -ForegroundColor Cyan
                } else { Write-Host "[検査範囲] 全体: $($candidateScope.reason)" }
            } catch {
                $localScope = $null
                $localRuntimeChecks = $false
                $localAllE2EChecks = $false
                Write-Host "[検査範囲] 判定できないため全体検査へ戻します: $($_.Exception.Message)"
            }
        } else { Write-Host '[検査範囲] 判定処理が無いため全体検査へ戻します' }
    }
    if ($localAllE2EChecks -and -not $hasE2E) { throw 'Changed E2E tests require the test:e2e script' }
    $receiptPhaseMatches = ($ReceiptPhase -eq 'Commit' -and $Level -eq 'Commit') -or
        ($ReceiptPhase -eq 'Push' -and $Level -eq 'Push')
    if ($ordinaryGate -and $receiptPhaseMatches -and -not $isRunningOnCI) {
        $shared = Invoke-ValidationReceipt -Root $root -Action reuse -Phase $ReceiptPhase -Repeats $E2ERepeats
        if ($shared.ok) {
            Write-Host "[OK] B3: 同一内容の厳密な全体検査を共用しました($ReceiptPhase / $($shared.tree))" -ForegroundColor Green
            exit 0
        }
        Write-Host "[検査] B3の共用条件が揃わないため、通常検査を実行します: $($shared.reason)"
    }
    # A failed/new/partial check cannot leave an earlier success available for a later push.
    $null = Invoke-ValidationReceipt -Root $root -Action invalidate

    # Windowsの自動バックグラウンド省電力で基準機の実測が約1.7倍になった(06 §10.54)。
    # 厳密検査の新しい子プロセスだけHighQoSにし、最後に元へ戻す。PC全体は変更しない。
    if ($env:POINTERCAD_PERF_STRICT -eq '1' -and [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
        if (-not ('PointerCad.WindowsValidationQos' -as [type])) {
            Add-Type -Path (Join-Path $scriptDirectory 'lib\WindowsValidationQos.cs')
        }
        $validationQos = New-Object PointerCad.WindowsValidationQos
        Write-Host "性能検査: この検査と新しい子プロセスをHighQoSで実行します" -ForegroundColor Cyan
    }

    if ($Install) {
        Invoke-Check "(0) pnpm install --frozen-lockfile" pnpm @("install", "--frozen-lockfile")
    }

    if ($Level -eq "Commit") {
        & git diff --cached --quiet --exit-code
        $stagedDiffExitCode = $LASTEXITCODE
        if ($stagedDiffExitCode -eq 0) {
            Write-Host "[NG] stage 済みの変更がありません。Commit検査は未stageの変更を検査しません。作業ツリーの検査には -Level Push を使ってください。" -ForegroundColor Red
            exit 1
        }
        if ($stagedDiffExitCode -ne 1) {
            Write-Host "[NG] stage 済み差分を確認できませんでした。" -ForegroundColor Red
            exit $stagedDiffExitCode
        }
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
                Invoke-Check "(0) 品質ゲート自身の自己試験" (Get-Process -Id $PID).Path @(
                    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $copy.Path "scripts/check.selftest.ps1"))
                Invoke-Check "(1/$totalChecks) pnpm run typecheck" pnpm @("run", "typecheck")
                Invoke-Check "(2/$totalChecks) pnpm run lint" pnpm @("run", "lint")
                if ($null -ne $localScope) { Invoke-LocalPackageChecks -Packages @($localScope.packages) }
                else { Invoke-Check "(3/$totalChecks) pnpm run test" pnpm @("run", "test") }
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
            Write-Host "[NG] 検査前のファイル状態を取得できません: $($beforeSnapshot.Reason)" -ForegroundColor Red
            exit 1
        }
        $skipTreeCompare = ($beforeSnapshot.Mode -eq "Staged") -and ($beforeSnapshot.Paths.Count -eq 0)
        if ($skipTreeCompare) {
            Write-Host "[警告] stage 済みのファイルが無いため、検査前後の比較を省略します" -ForegroundColor Yellow
        }

        $runE2E = $hasE2E -and -not $unitDiagnostic -and -not $StaticOnly -and ($null -eq $localScope -or $localRuntimeChecks -or $localAllE2EChecks)
        if ($E2EOnly -and -not $runE2E) {
            Write-Host "[NG] -E2EOnly を指定しましたが test:e2e スクリプトがありません" -ForegroundColor Red
            exit 1
        }
        $totalChecks = if ($StaticOnly) { 2 } elseif ($E2EOnly) { 1 } elseif ($runE2E) { 5 } else { 4 }
        if (-not $StaticOnly -and -not $E2EOnly -and -not $unitDiagnostic) {
            Invoke-Check "(0) 品質ゲート自身の自己試験" (Get-Process -Id $PID).Path @(
                "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $root "scripts/check.selftest.ps1"))
        }
        if ($runE2E) {
            # Initial downloads change the dependencies/browsers protected by B3.
            # Complete them before recording inputs, including Electron's lazy install.
            $browserInstallArgs = @("exec", "playwright", "install", "chromium", "firefox")
            if ([Environment]::OSVersion.Platform -eq [PlatformID]::Unix) {
                $browserInstallArgs = @("exec", "playwright", "install", "--with-deps", "chromium", "firefox")
            }
            Invoke-Check "(準備) Playwright のブラウザ確認" pnpm $browserInstallArgs
            if (Test-Path -LiteralPath (Join-Path $root 'apps/desktop/package.json') -PathType Leaf) {
                Invoke-Check "(準備) Electron の実行ファイル確認" pnpm @('--filter', '@pointercad/desktop', 'exec', 'install-electron')
            }
        }
        # Self-tests launch deliberately invalid diagnostics in this repository.
        # They must finish before recording the inputs of the five product stages.
        # The original source snapshot still guards the entire check, including (0).
        # A pre-push fallback never issues a reusable success for a failed send.
        if ($ReceiptPhase -eq 'Manual' -and -not $isRunningOnCI -and -not $StaticOnly -and -not $E2EOnly -and -not $unitDiagnostic -and $hasE2E -and $null -eq $localScope) {
            $receiptStart = Invoke-ValidationReceipt -Root $root -Action start -Repeats $E2ERepeats
            if ($receiptStart.ok) { $receiptToken = $receiptStart.token }
            else { Write-Host "[検査] B3の開始記録を作成できませんでした: $($receiptStart.reason)" }
        }
        if ($unitDiagnostic) {
            Write-Host "[診断] 指定ユニットテストだけを実行します。最終のPushゲート合格には数えません。" -ForegroundColor Yellow
            # 公開の形式・旧版移行・UI文言は個別機能の診断でも一緒に検査する(06 10.83、10.132、10.133)。
            $requiredUnitTests = @(switch ($UnitPackage) {
                "io" { "src/schemaVersion.test.ts"; "src/pcad/loftSurfaceJson.test.ts"; "src/pcad/mathExpressionJson.test.ts" }
                "model" { "src/exchange/exportPart.test.ts"; "src/part/createPartDocument.test.ts" }
                "ui" { "src/i18n/i18n.test.ts"; "src/i18n/jaMessages.test.ts" }
            })
            foreach ($requiredUnitTest in $requiredUnitTests) {
                if (-not (Test-Path -LiteralPath (Join-Path $root "packages/$UnitPackage/$requiredUnitTest") -PathType Leaf)) {
                    throw "必須の契約テストがありません: $requiredUnitTest"
                }
                if ($UnitTests -notcontains $requiredUnitTest) {
                    $UnitTests += $requiredUnitTest
                }
            }
            $unitArgs = @("--filter", "@pointercad/$UnitPackage", "exec", "vitest", "run") + $UnitTests
            Invoke-Check "ユニット診断: $UnitPackage" pnpm $unitArgs
        }
        elseif ($E2EOnly) {
            Write-Host "[診断] E2Eだけを実行します。最終のPushゲート合格には数えません。" -ForegroundColor Yellow
        }
        else {
            Invoke-Check "(1/$totalChecks) pnpm run typecheck" pnpm @("run", "typecheck")
            Invoke-Check "(2/$totalChecks) pnpm run lint" pnpm @("run", "lint")
            if (-not $StaticOnly) {
                if ($null -ne $localScope) { Invoke-LocalPackageChecks -Packages @($localScope.packages) }
                else { Invoke-Check "(3/$totalChecks) pnpm run test" pnpm @("run", "test") }
                Invoke-Check "(4/$totalChecks) pnpm run build" pnpm @("run", "build")
            }
        }
        if ($runE2E) {
            for ($e2eRun = 1; $e2eRun -le $E2ERepeats; $e2eRun++) {
                $repeatLabel = ""
                if ($E2ERepeats -gt 1) { $repeatLabel = " ($e2eRun/$E2ERepeats)" }
                $e2eArgs = @("run", "test:e2e")
                if ($localRuntimeChecks -and -not $localAllE2EChecks) {
                    # All unit tests of changed packages and their consumers ran above.
                    # Retain strict rendering and actual Firefox/Electron startup locally;
                    # the same commit's CI and release -Full run every existing operation.
                    $e2eArgs += @('--project=viewport-performance', '--project=startup-firefox', '--project=startup-electron')
                }
                if ($E2EOnly -and -not [string]::IsNullOrWhiteSpace($E2EGrep)) {
                    # pnpm run はスクリプト名より後ろを直接転送する。ここに区切りの -- を足すと、
                    # Playwright側で「以後はオプションではない」と解釈されgrepが効かなくなる。
                    $e2eArgs += @("--grep", $E2EGrep)
                }
                if ($E2ENoDependencies) {
                    Write-Host '[診断] 前提projectを省いて対象操作へ直接進みます。全体検査の合格には数えません。' -ForegroundColor Yellow
                    $e2eArgs += '--no-deps'
                }
                $e2eStep = if ($E2EOnly) { 1 } else { 5 }
                # Linuxの実Electronに必要な画面だけを用意する。ブラウザーのsandboxは変更しない。
                # https://playwright.dev/docs/ci#running-headed
                if ([Environment]::OSVersion.Platform -eq [PlatformID]::Unix -and [string]::IsNullOrWhiteSpace($env:DISPLAY)) {
                    if ($null -eq (Get-Command xvfb-run -ErrorAction SilentlyContinue)) { throw '実Electronの検査にはxvfb-runが必要です' }
                    Invoke-Check "($e2eStep/$totalChecks) pnpm run test:e2e$repeatLabel" xvfb-run (@("-a", "pnpm") + $e2eArgs)
                } else {
                    Invoke-Check "($e2eStep/$totalChecks) pnpm run test:e2e$repeatLabel" pnpm $e2eArgs
                }
            }
        }

        $afterSnapshot = Get-TrackedTreeSnapshot -Root $root -Level $Level
        if (-not $afterSnapshot.Ok) {
            Write-Host "[NG] 検査後のファイル状態を取得できません: $($afterSnapshot.Reason)" -ForegroundColor Red
            exit 1
        }
        if (-not $skipTreeCompare) {
            $comparison = Compare-TrackedTreeSnapshot -Before $beforeSnapshot -After $afterSnapshot
            if (-not $comparison.Unchanged) {
                Write-Host ""
                Write-Host "[NG] 検査が追跡対象のファイルを書き換えました" -ForegroundColor Red
                foreach ($changedPath in $comparison.ChangedPaths) { Write-Host ($changedPath | ConvertTo-Json -Compress) }
                if ($comparison.MetadataChanged) { Write-Host "HEADまたはindexが変わりました" -ForegroundColor Yellow }
                exit 1
            }
        }
    }

    Write-Host ""
    if ($StaticOnly) {
        Write-Host "[OK] 型・lint診断に合格しました(最終のPushゲートには数えません)" -ForegroundColor Green
    }
    elseif ($unitDiagnostic) {
        Write-Host "[OK] 指定ユニット診断に合格しました(最終のPushゲートには数えません)" -ForegroundColor Green
    }
    elseif ($E2EOnly) {
        Write-Host "[OK] 指定したE2E診断に合格しました(最終のPushゲートには数えません)" -ForegroundColor Green
    }
    elseif ($null -ne $localScope) {
        Write-Host '[OK] 変更箇所別のローカル検査に合格しました。完成確定には同一SHAの両OS CI全検査が必要です。' -ForegroundColor Green
    }
    else {
        Write-Host "[OK] 全ての検査に合格しました" -ForegroundColor Green
    }
    if (-not [string]::IsNullOrWhiteSpace($receiptToken)) {
        $receiptFinish = Invoke-ValidationReceipt -Root $root -Action finish -Token $receiptToken -Repeats $E2ERepeats
        $receiptCompleted = [bool]$receiptFinish.ok
        if ($receiptCompleted) { Write-Host '[OK] B3: 直後の同一コミット・pushに使う全体検査の記録を保存しました' -ForegroundColor Green }
        else { Write-Host "[検査] B3の共用記録は作成しませんでした: $($receiptFinish.reason)" }
    }
}
finally {
    try {
        if (-not [string]::IsNullOrWhiteSpace($receiptToken) -and -not $receiptCompleted) {
            $null = Invoke-ValidationReceipt -Root $root -Action invalidate
        }
        if ($null -ne $validationQos) {
            $validationQos.Dispose()
            Write-Host "性能検査: HighQoS対象 $($validationQos.ObservedCount) プロセスの後片付けを完了しました" -ForegroundColor Cyan
        }
    }
    finally {
        foreach ($temporaryVariable in $savedTemporaryEnvironment.Keys) {
            [Environment]::SetEnvironmentVariable($temporaryVariable, $savedTemporaryEnvironment[$temporaryVariable], 'Process')
        }
        Pop-Location
    }
}
exit 0
