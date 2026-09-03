# PointerCAD 一括検査スクリプト(Windows PowerShell 5.1 / pwsh 対応)
# rules/03-品質ゲート.md §7.1 の検査を順に実行し、いずれかが失敗したら非0で終了する。
#   (0) 作業ツリーの状態記録(検査前後で比較し、テストによる書換を検出。
#       -Level Commit は stage 済みファイルのみ、-Level Push は作業ツリー全体。理由: scripts/lib/gitTreeGuard.ps1)
#   (1) pnpm run typecheck      -Level Commit / Push の両方
#   (2) pnpm run lint           -Level Commit / Push の両方
#   (3) pnpm run test           -Level Commit / Push の両方
#   (4) pnpm run build          -Level Commit / Push の両方
#   (5) pnpm run test:e2e       -Level Push のときだけ(スクリプトが定義されている場合)
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
    [string]$Level = "Push"
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

    # (0) 検査がコミット対象のファイルを書き換えていないかを、実行の前後で比べる。
    #     -Level Commit は stage 済みファイルだけ(並列作業中の他担当の未 stage な変化に影響されない)、
    #     -Level Push は作業ツリー全体(従来どおり)。
    $beforeSnapshot = Get-TrackedTreeSnapshot -Root $root -Level $Level
    if (-not $beforeSnapshot.Ok) {
        Write-Host "[NG] 追跡対象変更ガードの git 呼び出しが失敗しました" -ForegroundColor Red
        exit 1
    }
    $skipTreeCompare = ($beforeSnapshot.Mode -eq "Staged") -and ($beforeSnapshot.Paths.Count -eq 0)
    if ($skipTreeCompare) {
        Write-Host "[警告] stage 済みのファイルが無いため、検査前後の比較を省略します" -ForegroundColor Yellow
    }

    if ($Install) {
        Invoke-Check "(0) pnpm install --frozen-lockfile" pnpm @("install", "--frozen-lockfile")
    }

    $runE2E = ($Level -eq "Push") -and $hasE2E
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
            if ($beforeSnapshot.Mode -eq "Staged") {
                Write-Host "[NG] 検査中にコミット対象のファイルが変わりました: $($comparison.ChangedPaths -join ', ')" -ForegroundColor Red
            }
            else {
                Write-Host "[NG] 検査が追跡対象のファイルを書き換えました" -ForegroundColor Red
                Write-Host "実行前:" -ForegroundColor Yellow
                Write-Host $beforeSnapshot.Status
                Write-Host "実行後:" -ForegroundColor Yellow
                Write-Host $afterSnapshot.Status
            }
            exit 1
        }
    }

    Write-Host ""
    Write-Host "[OK] 全ての検査に合格しました" -ForegroundColor Green
}
finally {
    Pop-Location
}
exit 0
