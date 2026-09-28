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
# -Scope Local(2026-09-27 利用者の決定「CIに任せてよい」)は手元の軽い検査で、画面検査は起動の
# 3 projectと変更したe2eが届くspecだけ。成功記録(B3とは別)を直後の同じコミット・pushのフックが
# 一度ずつ共用する。-Full・CIは全件のまま。リリース前の最終確認は、手元の軽い全体検査と同じSHAの
# 両OS CIの全件の成功で行う(2026-09-28 利用者の決定。-Fullは明示したときの全件として残す)。
# 2026-09-28 19:5x 利用者の決定「３」: -Scope Local で判定できない変更・設定の変更が全体へ広がる場合も、
# 単体は全件・両ビルド・自己試験だけを全体にし、画面検査は起動の3 project(と変更したe2eが届くspec)
# までにとどめ、画面検査の全件は送信後の同じSHAの両OS CIに任せる(成功記録は軽い検査の記録。B3ではない)。
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
    # 2026-09-13: local checks follow the complete change scope; CI remains full (2026-09-28: the
    # release check is the light local check plus the same SHA's complete CI on both OSes).
    [switch]$Full,
    # pre-push passes the actual remote commit, never an inferred branch tip.
    [string]$ComparisonBase = '',
    [ValidateRange(1, 10)]
    [int]$E2ERepeats = 1,
    # CIだけで画面操作を3台へ分配する。全3組×両OSの成功が全体合格の条件。
    [string]$E2EShard = '',
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
    [switch]$ShowPerfModeOnly,
    # 2026-09-27 利用者の決定「CIに任せてよい」: 手元の軽い検査。型・lint・変更に関わる単体・
    # 両ビルド・品質ゲートの自己試験・起動の3 projectと、変更したe2eが届くspecの画面検査だけを行う。
    # 画面検査の全件はpush後の両OS CI、-Fullは従来どおり全件。リリース前は軽い全体検査と同じSHAの
    # 両OS CIの全件の成功(2026-09-28 利用者の決定)。成功記録はB3と別。全体へ広がる変更でも手元の
    # 画面検査は起動の3 project(と関係するspec)まで(2026-09-28 19:5x 利用者の決定「３」)。
    [ValidateSet('', 'Local')]
    [string]$Scope = '',
    # 2026-09-28(レビュー §6.3「検査の待ち時間を減らす」): CIだけで、1つのOSの検査を別々の実行機へ
    # 分けて同時に流す段。Front=自己試験・型・lint・単体の残り・ビルド、UnitLead=単体の先行分
    # (ルートのtestの「先行分 && 残り」を分けたもの)、E2E=画面検査の1組(-E2EShard)、Verify=両OSの
    # 全段の記録の照合(集約のchecksだけ)。どの段も単独では合格にならない。
    [ValidateSet('', 'Front', 'UnitLead', 'E2E', 'Verify')]
    [string]$CIStage = '',
    # -CIStage のときだけ: 段の記録を書く(Verifyは読む)フォルダー。scripts/lib/ci_stage_evidence.py が扱う。
    [string]$StageEvidence = '',
    # 2026-09-28(w96a の提案): 手元の全体検査の道具(統括の deliver.py gate)が、画面検査(ポート4173・
    # CPU)の排他を画面検査の段の直前にだけ取るための合図のフォルダー。指定したときだけ、画面検査の段の
    # 直前に e2e-request.json(毎回新しい合言葉)を書き、同じ合言葉の e2e-go.json を待つ。CI・フック・
    # 診断では使えない。指定しなければ従来どおり待たない。
    [string]$E2EStartSignal = '',
    # -E2EStartSignal の待ちの上限(秒)。既定の200分は、道具が待つ担当の画面検査の上限
    # (diag.py の E2E_GLOBAL_TIMEOUT_MS 3時間)に20分を足した値。
    [ValidateRange(1, 12000)]
    [int]$E2EStartSignalTimeoutSeconds = 12000
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
    # 全ての子検査を現在の検査場所へ限定する。PushでもフックのGit保存先を
    # 渡すと、検査内のgit init/addが呼出元の設定・indexを変更してしまう。
    $savedCommandGitEnvironment = Clear-InheritedGitEnv
    # コマンド不在などの起動失敗はここでcatchして確実に失敗終了させる
    try {
        & $Command @CommandArgs
        $checkExitCode = $LASTEXITCODE
    } catch {
        Write-Host "[NG] $Name を起動できませんでした: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    } finally {
        Restore-InheritedGitEnv -Saved $savedCommandGitEnvironment
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

# 軽い検査の関係する画面検査のspec名を、Playwrightへ渡すファイルの絞込みとして確かめる。
# 形の違う名前が1つでもあれば例外にする(呼出し元は起動の3 projectだけへ戻す)。
function ConvertTo-LocalE2EFilter {
    param([object[]]$Specs)
    $filters = @()
    foreach ($spec in @($Specs)) {
        if ($spec -isnot [string] -or $spec -cnotmatch '^e2e/tests/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.spec\.ts$') {
            throw 'Invalid related E2E spec'
        }
        # Playwright treats a plain string filter as a glob (createFileMatcher in
        # playwright/lib/util.js), never as a regular expression, unless it is
        # already a RegExp object (CLI arguments never are). A backslash-escaped
        # "\." plus a trailing "$" is matched literally by minimatch, so the
        # trailing "$" never matches any real file path and the run reports
        # "No tests found." (observed 2026-09-28, gate 20260928-065436). Pass the
        # plain relative path instead; createFileMatcher prefixes it with "**/" and
        # matches it against the path on both Windows and POSIX.
        $filters += $spec
    }
    return , $filters
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

# 軽い検査の成功記録(local-light-receipt.json)。B3と同じ内容の指紋・封印・期限・一度だけの
# 消費を local_change_scope.py --receipt が行う。欠落・不一致・期限切れは通常の検査へ戻る。
function Invoke-LocalLightReceipt {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][ValidateSet('start', 'finish', 'reuse', 'invalidate')][string]$Action,
        [ValidateSet('Manual', 'Commit', 'Push', 'Disabled')][string]$Phase = 'Manual',
        [string]$Token = '',
        [string]$Base = ''
    )
    try {
        $selectedTools = @{}
        if ($Action -ne 'invalidate') {
            # validationReceipt.ps1 と同じ実行環境の特定(B3と同じ入力を比べるため)。
            foreach ($tool in @('node', 'pnpm', 'git')) {
                $selectedTools[$tool] = (Get-Command $tool -ErrorAction Stop).Source
            }
            $selectedTools['shell'] = (Get-Process -Id $PID).Path
            Push-Location -LiteralPath $Root
            try {
                $runtimeOutput = & pnpm --silent run validation:runtime
                if ($LASTEXITCODE -ne 0) { throw 'The actual validation runtime could not be identified' }
                $runtime = ($runtimeOutput -join "`n") | ConvertFrom-Json -ErrorAction Stop
                foreach ($name in @('node_runtime', 'pnpm_runtime')) {
                    if ([string]::IsNullOrWhiteSpace($runtime.$name)) { throw "The runtime path $name is missing" }
                    $selectedTools[$name] = [string]$runtime.$name
                }
            } finally { Pop-Location }
        }
        $encodedTools = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($selectedTools | ConvertTo-Json -Compress)))
        $python = Get-Command python -ErrorAction Stop
        $arguments = @('-B', '-X', 'utf8', (Join-Path $scriptDirectory 'lib/local_change_scope.py'), '--receipt', $Action,
            '--root', $Root, '--tools', $encodedTools, '--phase', $Phase)
        if (-not [string]::IsNullOrWhiteSpace($Token)) { $arguments += @('--token', $Token) }
        if (-not [string]::IsNullOrWhiteSpace($Base)) { $arguments += @('--base', $Base) }
        $raw = & $python.Source @arguments
        $resultCode = $LASTEXITCODE
        $result = ($raw -join "`n") | ConvertFrom-Json -ErrorAction Stop
        if ($resultCode -eq 0 -and $result.ok) { return $result }
        return [pscustomobject]@{ ok = $false; reason = [string]$result.reason }
    } catch {
        return [pscustomobject]@{ ok = $false; reason = $_.Exception.Message }
    }
}

# 画面検査の段の直前の合図(-E2EStartSignal)。要求に毎回新しい合言葉を書き、同じ合言葉の答えだけを
# 受け取る(前の検査の答えの残りでは進まない)。go が true なら進み、false(道具が排他を取れない等)と
# 上限切れは画面検査を始めずに失敗にする。答えが書きかけで読めない間は待ち続ける。
function Wait-E2EStartSignal {
    param(
        [Parameter(Mandatory)][string]$Folder,
        [Parameter(Mandatory)][int]$TimeoutSeconds,
        [Parameter(Mandatory)][string]$StageName
    )
    $token = [guid]::NewGuid().ToString('N')
    $requestPath = Join-Path $Folder 'e2e-request.json'
    $answerPath = Join-Path $Folder 'e2e-go.json'
    $request = [ordered]@{
        version = 1
        token = $token
        pid = $PID
        stage = $StageName
        requestedAt = ('{0:yyyy-MM-ddTHH:mm:ss.fffzzz}' -f [DateTimeOffset]::Now)
    } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($requestPath, $request, (New-Object Text.UTF8Encoding($false)))
    Write-Host ''
    Write-Host ("[合図] {0:yyyy-MM-ddTHH:mm:ss.fffzzz} 画面検査の段の前で、全体検査の道具の開始の合図を待ちます(上限 {1} 秒、合言葉 {2})" -f `
        [DateTimeOffset]::Now, $TimeoutSeconds, $token) -ForegroundColor Cyan
    $waitTimer = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        if (Test-Path -LiteralPath $answerPath -PathType Leaf) {
            $answer = $null
            try { $answer = Get-Content -LiteralPath $answerPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop }
            catch { $answer = $null }
            if ($null -ne $answer -and [string]$answer.token -ceq $token) {
                if ($answer.go -is [bool] -and $answer.go) {
                    Write-Host ("[合図] {0:yyyy-MM-ddTHH:mm:ss.fffzzz} 開始の合図を受けました(待ち {1:F1} 秒)。画面検査を始めます" -f `
                        [DateTimeOffset]::Now, $waitTimer.Elapsed.TotalSeconds) -ForegroundColor Cyan
                    return
                }
                Write-Host "[NG] 全体検査の道具が画面検査の開始を断りました: $([string]$answer.reason)。画面検査は実行していません。" -ForegroundColor Red
                exit 1
            }
        }
        if ($waitTimer.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
            Write-Host "[NG] 画面検査の段の開始の合図が $TimeoutSeconds 秒以内に来ませんでした(合図のフォルダー: $Folder)。全体検査の道具が画面検査の排他を取れないまま止まったか終了しています。画面検査は実行していません。" -ForegroundColor Red
            exit 1
        }
        Start-Sleep -Milliseconds 1000
    }
}

$validationQos = $null
$receiptToken = ''
$receiptCompleted = $false
$lightReceiptToken = ''
$lightReceiptCompleted = $false
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
    if (-not [string]::IsNullOrWhiteSpace($E2EShard) -and (
        $E2EShard -notmatch '^[1-3]/3$' -or -not $isRunningOnCI -or $Level -ne 'Push' -or
        $ReceiptPhase -ne 'Manual' -or $E2ERepeats -ne 1 -or $StaticOnly -or $unitDiagnostic -or
        $E2EOnly -or $E2ENoDependencies -or -not [string]::IsNullOrWhiteSpace($E2EGrep))) {
        Write-Host '[NG] E2Eの3分割はCIの通常Push検査だけで使用できます。診断・フック・連続検査とは併用できません。' -ForegroundColor Red
        exit 1
    }
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
    $lightRequested = $Scope -eq 'Local'
    if ($lightRequested -and ($Full -or $Install -or $isRunningOnCI -or $Level -ne 'Push' -or $ReceiptPhase -ne 'Manual' -or
        $E2ERepeats -ne 1 -or $StaticOnly -or $unitDiagnostic -or $E2EOnly -or $E2ENoDependencies -or
        -not [string]::IsNullOrWhiteSpace($E2EGrep) -or -not [string]::IsNullOrWhiteSpace($E2EShard))) {
        Write-Host '[NG] -Scope Local は手元の通常の手動検査(-Level Push)だけに使用できます。-Full・CI・導入・フック・診断・連続検査とは併用できません。' -ForegroundColor Red
        exit 1
    }
    # CIの段(2026-09-28): CIの通常Push検査だけ。画面検査の段は組の指定が必須、他の段は組を付けない。
    # 照合(Verify)は依存を使わないため導入と併用しない。不正な組合せは検査を始める前に拒否する。
    $ciStageRequested = -not [string]::IsNullOrWhiteSpace($CIStage)
    if (-not $ciStageRequested -and -not [string]::IsNullOrWhiteSpace($StageEvidence)) {
        Write-Host '[NG] -StageEvidence は -CIStage と一緒に指定してください。' -ForegroundColor Red
        exit 1
    }
    if ($ciStageRequested) {
        $stageShardValid = if ($CIStage -eq 'E2E') { $E2EShard -match '^[1-3]/3$' } else { [string]::IsNullOrWhiteSpace($E2EShard) }
        if (-not $isRunningOnCI -or $Level -ne 'Push' -or $ReceiptPhase -ne 'Manual' -or $E2ERepeats -ne 1 -or $Full -or
            $StaticOnly -or $unitDiagnostic -or $E2EOnly -or $E2ENoDependencies -or $lightRequested -or
            -not [string]::IsNullOrWhiteSpace($E2EGrep) -or [string]::IsNullOrWhiteSpace($StageEvidence) -or
            -not $stageShardValid -or ($CIStage -eq 'Verify' -and $Install)) {
            Write-Host '[NG] CIの段(-CIStage)はCIの通常Push検査だけで、記録先(-StageEvidence)を付けて使用できます。画面検査の段(E2E)だけが組(-E2EShard)を持ち、照合(Verify)は導入と併用できません。診断・フック・連続検査・-Full・-Scope Localとも併用できません。' -ForegroundColor Red
            exit 1
        }
    }
    $ciStageEvidenceScript = Join-Path $scriptDirectory 'lib/ci_stage_evidence.py'
    # 画面検査の段の直前の合図(2026-09-28): 手元の通常の手動検査(-Level Push)の全体検査だけ。
    # CI・導入・フック・診断・連続検査・CIの段とは併用せず、合図のフォルダーは実在するものに限る。
    $e2eStartSignalRequested = -not [string]::IsNullOrWhiteSpace($E2EStartSignal)
    if (-not $e2eStartSignalRequested -and $PSBoundParameters.ContainsKey('E2EStartSignalTimeoutSeconds')) {
        Write-Host '[NG] -E2EStartSignalTimeoutSeconds は -E2EStartSignal と一緒に指定してください。' -ForegroundColor Red
        exit 1
    }
    if ($e2eStartSignalRequested) {
        if ($isRunningOnCI -or $Install -or $Level -ne 'Push' -or $ReceiptPhase -ne 'Manual' -or $E2ERepeats -ne 1 -or
            $StaticOnly -or $unitDiagnostic -or $E2EOnly -or $E2ENoDependencies -or $ciStageRequested -or
            -not [string]::IsNullOrWhiteSpace($E2EGrep) -or -not [string]::IsNullOrWhiteSpace($E2EShard)) {
            Write-Host '[NG] -E2EStartSignal は手元の通常の手動検査(-Level Push)の全体検査だけで使用できます。CI・導入・フック・診断・連続検査・CIの段とは併用できません。' -ForegroundColor Red
            exit 1
        }
        if (-not (Test-Path -LiteralPath $E2EStartSignal -PathType Container)) {
            Write-Host "[NG] -E2EStartSignal のフォルダーがありません: $E2EStartSignal" -ForegroundColor Red
            exit 1
        }
        $E2EStartSignal = (Resolve-Path -LiteralPath $E2EStartSignal).ProviderPath
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
    if (-not [string]::IsNullOrWhiteSpace($E2EShard) -and -not $hasE2E) { throw 'CIの3分割にはtest:e2eが必要です。' }
    if ($CIStage -eq 'Verify') {
        # 集約(checks)だけ: 両OSの全段(前段・単体の先行分・画面検査3組)の記録がそろい、全てが
        # 同じ版・同じlock・OSごとに同じnode/pnpmで成功したことを確かめる。pnpmは実行しない。
        Invoke-Check "(照合) 両OSの全段の記録" python @('-B', '-X', 'utf8', $ciStageEvidenceScript, 'verify', '--root', $root, '--dir', $StageEvidence)
        Write-Host ''
        Write-Host '[OK] 両OSの前段・単体の先行分・画面検査の全3組が、同じ版で全て成功したことを照合しました。' -ForegroundColor Green
        exit 0
    }
    $ciStageUnitSplit = $null
    $ciStageSteps = [Collections.Generic.List[string]]::new()
    if ($CIStage -in @('Front', 'UnitLead')) {
        # ルートのtest「先行分 && 残り」をそのまま2つに分ける(つなぐと元と一致しなければ止める)。
        $splitOutput = & python -B -X utf8 $ciStageEvidenceScript unit-split --root $root
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[NG] 単体の分け方を決められません: $($splitOutput -join ' ')" -ForegroundColor Red
            exit 1
        }
        $ciStageUnitSplit = ($splitOutput -join "`n") | ConvertFrom-Json
    }

    $ordinaryGate = -not $StaticOnly -and -not $E2EOnly -and -not $unitDiagnostic -and -not $Install
    $localScope = $null
    $localRuntimeChecks = $false
    $localAllE2EChecks = $false
    $localLight = $false
    $localE2EFilters = @()
    # 軽い検査の比較の基点(成功記録に残す)・全体へ広がった軽い検査・CIへ任せた画面検査の印。
    $localLightBase = ''
    $localLightFull = $false
    $localE2EDeferred = $false
    $lightFullScope = $null
    if ($ordinaryGate -and -not $Full -and -not $isRunningOnCI -and $E2ERepeats -eq 1 -and $ReceiptPhase -ne 'Disabled') {
        $scopeScript = Join-Path $scriptDirectory 'lib/local_change_scope.py'
        if (Test-Path -LiteralPath $scopeScript -PathType Leaf) {
            try {
                $scopeArgs = @('-B', $scopeScript, '--root', $root, '--level', $Level, '--phase', $ReceiptPhase)
                if (-not [string]::IsNullOrWhiteSpace($ComparisonBase)) { $scopeArgs += @('--base', $ComparisonBase) }
                if ($lightRequested) { $scopeArgs += '--light' }
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
                    if ($candidateScope.PSObject.Properties.Name -contains 'light') {
                        # A light result is accepted only when it was requested and is complete.
                        if (-not $lightRequested -or $candidateScope.light -isnot [bool] -or -not $candidateScope.light -or
                            -not $localRuntimeChecks -or $candidateScope.PSObject.Properties.Name -notcontains 'e2eSpecs') {
                            throw 'Invalid light scope'
                        }
                        # A light check never runs every operation locally (owner decision "3").
                        if ($localAllE2EChecks) { throw 'A light scope must not require every operation locally' }
                        if ($candidateScope.PSObject.Properties.Name -contains 'e2eDeferredToCI') {
                            if ($candidateScope.e2eDeferredToCI -isnot [bool]) { throw 'Invalid deferred E2E flag' }
                            $localE2EDeferred = $candidateScope.e2eDeferredToCI
                        }
                        $localE2EFilters = ConvertTo-LocalE2EFilter -Specs @($candidateScope.e2eSpecs)
                        $localLightBase = [string]$candidateScope.base
                        $localLight = $true
                    } elseif ($lightRequested) { throw 'The light scope was not established' }
                    if ($localLight) {
                        $relatedLabel = "$($localE2EFilters.Count) spec"
                        if ($localE2EDeferred) { $relatedLabel += '(影響を特定できない変更したe2eの画面検査は両OS CIの全件で確かめます)' }
                        Write-Host "[検査範囲] 手元の軽い検査: $($localScope.reason) / 単体 $($localScope.packages -join ', ') / 起動の3 project / 関係する画面検査 $relatedLabel。画面検査の全件はpush後の両OS CIで実施します。" -ForegroundColor Cyan
                    } else {
                        Write-Host "[検査範囲] 変更箇所別: $($localScope.reason) / $($localScope.packages -join ', ')。全検査は両OS CIで実施します。" -ForegroundColor Cyan
                    }
                } else {
                    Write-Host "[検査範囲] 全体: $($candidateScope.reason)"
                    if ($lightRequested) { $lightFullScope = $candidateScope }
                }
            } catch {
                $localScope = $null
                $localRuntimeChecks = $false
                $localAllE2EChecks = $false
                $localLight = $false
                $localE2EFilters = @()
                $localLightBase = ''
                $localE2EDeferred = $false
                $lightFullScope = $null
                Write-Host "[検査範囲] 判定できないため全体検査へ戻します: $($_.Exception.Message)"
            }
        } else { Write-Host '[検査範囲] 判定処理が無いため全体検査へ戻します' }
    }
    if ($lightRequested -and -not $localLight) {
        # [local-light-full-e2e-deferred] 2026-09-28 19:5x 利用者の決定「３」: -Scope Local で全体へ広がる
        # (判定できない・設定の変更・判定の失敗)場合も、単体は全件(pnpm run test)・両ビルド・品質ゲートの
        # 自己試験は全体のまま、画面検査は起動の3 projectと、判定が示した関係するspecだけにする。画面検査の
        # 全件は送信後の同じSHAの両OS CIに任せる。成功記録は軽い検査の記録で、B3の全体検査の記録にしない。
        # (scratchpad/claude/tools/deliver.py は独立コピーの check.ps1 にこの印があるかで予告を変える。)
        $localScope = $null
        $localLight = $true
        $localLightFull = $true
        $localRuntimeChecks = $true
        $localAllE2EChecks = $false
        $localE2EDeferred = $true
        $localE2EFilters = @()
        $lightFullReason = '判定できない変更'
        if ($null -ne $lightFullScope) {
            $lightFullReason = [string]$lightFullScope.reason
            $lightFullNames = @($lightFullScope.PSObject.Properties.Name)
            if ($lightFullNames -contains 'light' -and $lightFullScope.light -is [bool] -and $lightFullScope.light -and
                $lightFullNames -contains 'e2eSpecs') {
                try { $localE2EFilters = ConvertTo-LocalE2EFilter -Specs @($lightFullScope.e2eSpecs) }
                catch {
                    $localE2EFilters = @()
                    Write-Host "[検査範囲] 関係する画面検査の名前を使えないため、起動の3 projectだけにします: $($_.Exception.Message)"
                }
            }
            if ([string]$lightFullScope.base -cmatch '^[0-9a-f]{40}$') { $localLightBase = [string]$lightFullScope.base }
        }
        if ([string]::IsNullOrWhiteSpace($localLightBase)) { $localLightBase = $ComparisonBase }
        Write-Host "[検査範囲] 手元の軽い検査(全体へ広がる変更: $lightFullReason) / 単体は全件・両ビルド・自己試験 / 起動の3 project / 関係する画面検査 $($localE2EFilters.Count) spec。画面検査の全件は送信後の同じSHAの両OS CIで実施します(利用者の決定 2026-09-28「３」)。" -ForegroundColor Cyan
    }
    if ($localLight -and -not $hasE2E) { throw 'The light local check requires the test:e2e script' }
    if ($localAllE2EChecks -and -not $hasE2E) { throw 'Changed E2E tests require the test:e2e script' }
    $receiptPhaseMatches = ($ReceiptPhase -eq 'Commit' -and $Level -eq 'Commit') -or
        ($ReceiptPhase -eq 'Push' -and $Level -eq 'Push')
    if ($ordinaryGate -and $receiptPhaseMatches -and -not $isRunningOnCI) {
        $shared = Invoke-ValidationReceipt -Root $root -Action reuse -Phase $ReceiptPhase -Repeats $E2ERepeats
        if ($shared.ok) {
            Write-Host "[OK] B3: 同一内容の厳密な全体検査を共用しました($ReceiptPhase / $($shared.tree))" -ForegroundColor Green
            exit 0
        }
        Write-Host "[検査] B3の共用条件が揃わないため、手元の軽い検査の記録を確かめます: $($shared.reason)"
        # 2026-09-27: 同じ内容の軽い検査(-Scope Local)の成功を、直後の同じコミット・pushで一度ずつ共用する。
        # pushは軽い検査が比べた基点(-ComparisonBase)と実際の送信先の古いコミットが一致する場合だけ。
        $light = Invoke-LocalLightReceipt -Root $root -Action reuse -Phase $ReceiptPhase -Base $ComparisonBase
        if ($light.ok) {
            Write-Host "[OK] 同一内容の手元の軽い検査(型・lint・関係する単体・両ビルド・自己試験・起動・関係する画面検査)を共用しました($ReceiptPhase / $($light.tree))。画面検査の全件はpush後の両OS CIで確かめます。" -ForegroundColor Green
            exit 0
        }
        Write-Host "[検査] 軽い検査の共用条件も揃わないため、通常検査を実行します: $($light.reason)"
    }
    # A failed/new/partial check cannot leave an earlier success available for a later push.
    $null = Invoke-ValidationReceipt -Root $root -Action invalidate
    $null = Invoke-LocalLightReceipt -Root $root -Action invalidate

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

        # CIの段 Front・UnitLead は画面検査を別の実行機(段 E2E)へ任せる。
        $runE2E = $hasE2E -and -not $unitDiagnostic -and -not $StaticOnly -and ($null -eq $localScope -or $localRuntimeChecks -or $localAllE2EChecks) -and
            $CIStage -notin @('Front', 'UnitLead')
        if ($E2EOnly -and -not $runE2E) {
            Write-Host "[NG] -E2EOnly を指定しましたが test:e2e スクリプトがありません" -ForegroundColor Red
            exit 1
        }
        if ($CIStage -eq 'E2E' -and -not $runE2E) { throw 'CIの画面検査の段にはtest:e2eが必要です。' }
        $totalChecks = if ($StaticOnly) { 2 } elseif ($E2EOnly) { 1 } elseif ($runE2E -or $ciStageRequested) { 5 } else { 4 }
        # 自己試験はCIでは前段(Front)で1回だけ行う。単体の先行分・画面検査の段は同じ版の前段に任せる。
        if (-not $StaticOnly -and -not $E2EOnly -and -not $unitDiagnostic -and $CIStage -in @('', 'Front')) {
            Invoke-Check "(0) 品質ゲート自身の自己試験" (Get-Process -Id $PID).Path @(
                "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $root "scripts/check.selftest.ps1"))
            $ciStageSteps.Add('selftest')
        }
        if ($runE2E) {
            # Initial downloads change the dependencies/browsers protected by B3.
            # Complete them before recording inputs, including Electron's lazy install.
            $browserInstallArgs = @("exec", "playwright", "install", "chromium", "firefox")
            if ([Environment]::OSVersion.Platform -eq [PlatformID]::Unix) {
                $browserInstallArgs = @("exec", "playwright", "install", "--with-deps", "chromium", "firefox")
            }
            Invoke-Check "(準備) Playwright のブラウザ確認" pnpm $browserInstallArgs
            $ciStageSteps.Add('browsers')
            if (Test-Path -LiteralPath (Join-Path $root 'apps/desktop/package.json') -PathType Leaf) {
                Invoke-Check "(準備) Electron の実行ファイル確認" pnpm @('--filter', '@pointercad/desktop', 'exec', 'install-electron')
                $ciStageSteps.Add('electron')
            }
        }
        # Self-tests launch deliberately invalid diagnostics in this repository.
        # They must finish before recording the inputs of the five product stages.
        # The original source snapshot still guards the entire check, including (0).
        # A pre-push fallback never issues a reusable success for a failed send.
        # A light check (also one widened to every unit suite) never issues the B3 full-check receipt.
        if ($ReceiptPhase -eq 'Manual' -and -not $isRunningOnCI -and -not $StaticOnly -and -not $E2EOnly -and -not $unitDiagnostic -and $hasE2E -and $null -eq $localScope -and -not $localLight) {
            $receiptStart = Invoke-ValidationReceipt -Root $root -Action start -Repeats $E2ERepeats
            if ($receiptStart.ok) { $receiptToken = $receiptStart.token }
            else { Write-Host "[検査] B3の開始記録を作成できませんでした: $($receiptStart.reason)" }
        }
        if ($localLight -and $ReceiptPhase -eq 'Manual' -and -not $isRunningOnCI) {
            # The base is the one the scope compared: the explicit one, otherwise origin/main.
            $lightStart = Invoke-LocalLightReceipt -Root $root -Action start -Base $localLightBase
            if ($lightStart.ok) { $lightReceiptToken = $lightStart.token }
            else { Write-Host "[検査] 軽い検査の開始記録を作成できませんでした(フックは通常検査を行います): $($lightStart.reason)" }
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
        elseif ($CIStage -eq 'E2E') {
            Write-Host "[CIの段] 画面検査の組 $E2EShard だけを行います。自己試験・型・lint・単体・ビルドは同じ版の前段と単体の先行分の段が行い、集約(checks)が全段の記録を照合します。" -ForegroundColor Cyan
        }
        elseif ($CIStage -eq 'UnitLead') {
            Write-Host "[CIの段] 単体の先行分だけを行います(ルートのtestの前半。後半は前段が行います)。" -ForegroundColor Cyan
            Invoke-Check "(3/$totalChecks) 単体の先行分: $($ciStageUnitSplit.leadCommand)" pnpm @($ciStageUnitSplit.lead)
            $ciStageSteps.Add('unit-lead')
        }
        elseif ($CIStage -eq 'Front') {
            Write-Host "[CIの段] 前段: 型・lint・単体の残り(ルートのtestの後半。前半は単体の先行分の段)・ビルドを行います。画面検査は別の段です。" -ForegroundColor Cyan
            Invoke-Check "(1/$totalChecks) pnpm run typecheck" pnpm @("run", "typecheck")
            $ciStageSteps.Add('typecheck')
            Invoke-Check "(2/$totalChecks) pnpm run lint" pnpm @("run", "lint")
            $ciStageSteps.Add('lint')
            Invoke-Check "(3/$totalChecks) 単体の残り: $($ciStageUnitSplit.restCommand)" pnpm @($ciStageUnitSplit.rest)
            $ciStageSteps.Add('unit-rest')
            Invoke-Check "(4/$totalChecks) pnpm run build" pnpm @("run", "build")
            $ciStageSteps.Add('build')
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
        if ($e2eStartSignalRequested -and -not $runE2E) {
            Write-Host '[合図] この検査には画面検査の段が無いため、開始の合図は使いません。' -ForegroundColor Cyan
        }
        if ($runE2E) {
            if ($e2eStartSignalRequested) {
                # 型・lint・単体・ビルドの間は担当の画面検査を妨げず、ここで道具が排他を取るのを待つ。
                Wait-E2EStartSignal -Folder $E2EStartSignal -TimeoutSeconds $E2EStartSignalTimeoutSeconds -StageName "(5/$totalChecks) pnpm run test:e2e"
            }
            for ($e2eRun = 1; $e2eRun -le $E2ERepeats; $e2eRun++) {
                $repeatLabel = ""
                if ($E2ERepeats -gt 1) { $repeatLabel = " ($e2eRun/$E2ERepeats)" }
                $e2eArgs = @("run", "test:e2e")
                if (-not [string]::IsNullOrWhiteSpace($E2EShard)) {
                    # Playwrightが同じ設定から分配し、各組でも性能・起動の前提を保持する。
                    $e2eArgs += "--shard=$E2EShard"
                }
                if ($localRuntimeChecks -and -not $localAllE2EChecks -and $localE2EFilters.Count -gt 0) {
                    # Light local check with changed operations: the specs that reach a changed
                    # e2e/tests file run in functional (Chromium) and, for Electron-only specs,
                    # electron. The startup specs are named explicitly so the same single run keeps
                    # startup-firefox and startup-electron; viewport-performance is their shared
                    # dependency, which Playwright runs completely (file filters never narrow a
                    # dependency project). The extra Chromium smoke spec is the only addition.
                    # These are plain relative paths, not regular expressions: Playwright's
                    # createFileMatcher (playwright/lib/util.js) treats a plain string filter as a
                    # glob via minimatch unless it is already a RegExp object, which CLI arguments
                    # never are. A backslash-escaped "\." plus trailing "$" used to be matched
                    # literally, so the "$" never matched any real path and the run reported
                    # "No tests found." (observed 2026-09-28, gate 20260928-065436).
                    $e2eArgs += @('--project=startup-firefox', '--project=startup-electron', '--project=functional', '--project=electron',
                        'e2e/tests/smoke.spec.ts', 'e2e/tests/firefox-graphics.spec.ts', 'e2e/tests/electron-startup.spec.ts') + $localE2EFilters
                } elseif ($localRuntimeChecks -and -not $localAllE2EChecks) {
                    # All unit tests of changed packages and their consumers ran above.
                    # Retain strict rendering and actual Firefox/Electron startup locally;
                    # the same commit's CI on both OSes (the release check) and an explicit -Full run
                    # every existing operation. A light check widened to every unit suite (owner
                    # decision "3") also ends here or in the branch above, never with every operation.
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
            $ciStageSteps.Add('e2e')
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
        if ($ciStageRequested) {
            # 成功した段だけ、同じ版・lock・道具と通した手順を記録する。集約(Verify)が両OSの全段を照合する。
            $recordArgs = @('-B', '-X', 'utf8', $ciStageEvidenceScript, 'write', '--root', $root, '--dir', $StageEvidence,
                '--stage', $CIStage, '--node', ((& node --version) -join '').Trim(), '--pnpm', ((& pnpm --version) -join '').Trim())
            if ($CIStage -eq 'E2E') { $recordArgs += @('--shard', $E2EShard) }
            foreach ($step in $ciStageSteps) { $recordArgs += @('--step', $step) }
            Invoke-Check "(記録) CIの段 $CIStage $E2EShard" python $recordArgs
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
    elseif ($localLightFull) {
        Write-Host '[OK] 手元の軽い検査(全体へ広がる変更のため単体は全件)に合格しました。画面検査は起動の3 projectと関係するspecだけで、全件はpush後の両OS CIで確かめます。完成確定とリリース前の最終確認には、同一SHAの両OS CIの全件の成功が必要です。' -ForegroundColor Green
    }
    elseif ($localLight) {
        Write-Host '[OK] 手元の軽い検査に合格しました。画面検査の全件はpush後の両OS CIで確かめます。完成確定とリリース前の最終確認には、同一SHAの両OS CIの全件の成功が必要です。' -ForegroundColor Green
    }
    elseif ($null -ne $localScope) {
        Write-Host '[OK] 変更箇所別のローカル検査に合格しました。完成確定には同一SHAの両OS CI全検査が必要です。' -ForegroundColor Green
    }
    elseif ($ciStageRequested) {
        Write-Host "[OK] CIの段 $CIStage $E2EShard が成功し、記録しました。全体合格には、集約(checks)が両OSの全段の記録を照合して成功することが必要です。" -ForegroundColor Green
    }
    elseif (-not [string]::IsNullOrWhiteSpace($E2EShard)) {
        Write-Host "[OK] CIの全単体・型・lint・ビルドと画面操作の分割 $E2EShard が成功しました。全体合格には両OSの全3組の成功が必要です。" -ForegroundColor Green
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
    if (-not [string]::IsNullOrWhiteSpace($lightReceiptToken)) {
        $lightFinish = Invoke-LocalLightReceipt -Root $root -Action finish -Token $lightReceiptToken
        $lightReceiptCompleted = [bool]$lightFinish.ok
        if ($lightReceiptCompleted) { Write-Host '[OK] 直後の同一コミット・pushに使う軽い検査の記録を保存しました(B3の全体検査の記録ではありません)' -ForegroundColor Green }
        else { Write-Host "[検査] 軽い検査の共用記録は作成しませんでした: $($lightFinish.reason)" }
    }
}
finally {
    try {
        if (-not [string]::IsNullOrWhiteSpace($receiptToken) -and -not $receiptCompleted) {
            $null = Invoke-ValidationReceipt -Root $root -Action invalidate
        }
        if (-not [string]::IsNullOrWhiteSpace($lightReceiptToken) -and -not $lightReceiptCompleted) {
            $null = Invoke-LocalLightReceipt -Root $root -Action invalidate
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
