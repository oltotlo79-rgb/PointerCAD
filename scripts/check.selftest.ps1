# scripts/lib/gitTreeGuard.ps1 の自己試験(Pester不使用の最小試験)。
# `check.ps1` の (0) 前後比較を変更したら必ず実行する(rules/00-施行の仕組み.md)。
# 本リポジトリには一切書き込まず、一時ディレクトリに専用のgitリポジトリを作って試験する。
# 実行: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check.selftest.ps1
$ErrorActionPreference = 'Stop'

$scriptDirectory = [string]$PSScriptRoot
if ([string]::IsNullOrWhiteSpace($scriptDirectory)) {
    $scriptDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($MyInvocation.MyCommand.Path))
}
$libPath = Join-Path $scriptDirectory "lib\gitTreeGuard.ps1"
if (-not (Test-Path -LiteralPath $libPath -PathType Leaf)) {
    Write-Host "[NG] 比較関数のライブラリが見つかりません: $libPath" -ForegroundColor Red
    exit 1
}
. $libPath

$failures = 0

function Assert-True {
    param([bool]$Condition, [string]$Label)
    if ($Condition) {
        Write-Host "[OK] $Label" -ForegroundColor Green
    }
    else {
        Write-Host "[NG] $Label" -ForegroundColor Red
        $script:failures++
    }
}

# 一時ディレクトリに、この試験専用のgitリポジトリを作る(本リポジトリには一切触れない)
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("pointercad-checkselftest-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot | Out-Null

try {
    Push-Location $tempRoot
    try {
        & git init --quiet . 2>$null | Out-Null
        & git config user.email "selftest@example.invalid" | Out-Null
        & git config user.name "check.selftest" | Out-Null
        & git config core.autocrlf false | Out-Null

        # ベースコミット: a.txt(後で stage 済みの変化に使う)、c.txt(後で Push 全体比較に使う)
        Set-Content -LiteralPath (Join-Path $tempRoot "a.txt") -Value "one" -NoNewline -Encoding UTF8
        Set-Content -LiteralPath (Join-Path $tempRoot "c.txt") -Value "base" -NoNewline -Encoding UTF8
        & git add a.txt c.txt | Out-Null
        & git commit --quiet -m "base" | Out-Null

        # === シナリオ1(-Level Commit): stage 済みファイルの内容が検査中に変わる → 失敗として検出 ===
        Set-Content -LiteralPath (Join-Path $tempRoot "a.txt") -Value "two" -NoNewline -Encoding UTF8
        & git add a.txt | Out-Null
        $before1 = Get-TrackedTreeSnapshot -Root $tempRoot -Level "Commit"
        Assert-True ($before1.Ok -and $before1.Paths.Count -eq 1 -and $before1.Paths[0] -eq "a.txt") `
            "シナリオ1 前提: a.txt だけが stage 済み"

        # 「検査中」に、他プロセスが stage 済みファイルの作業ツリー側を書き換えた状況を模す
        Set-Content -LiteralPath (Join-Path $tempRoot "a.txt") -Value "two-mutated" -NoNewline -Encoding UTF8
        $after1 = Get-TrackedTreeSnapshot -Root $tempRoot -Level "Commit"
        $result1 = Compare-TrackedTreeSnapshot -Before $before1 -After $after1
        Assert-True (-not $result1.Unchanged) "stage 済みファイル(a.txt)の変化を検出して失敗とする"
        Assert-True (@($result1.ChangedPaths) -contains "a.txt") "変化したファイル名(a.txt)を報告する"

        # 元へ戻す(次のシナリオへ影響しないように)
        Set-Content -LiteralPath (Join-Path $tempRoot "a.txt") -Value "two" -NoNewline -Encoding UTF8

        # === シナリオ2(-Level Commit): stage していないファイルの変化は無視する → 成功 ===
        Set-Content -LiteralPath (Join-Path $tempRoot "b.txt") -Value "untracked" -NoNewline -Encoding UTF8
        $before2 = Get-TrackedTreeSnapshot -Root $tempRoot -Level "Commit"
        Assert-True ($before2.Ok -and $before2.Paths.Count -eq 1 -and $before2.Paths[0] -eq "a.txt") `
            "シナリオ2 前提: b.txt は未追跡・未 stage のため比較対象に含まれない"

        # 「検査中」に、未 stage の b.txt(他担当の書きかけを模す)が書き換わる
        Set-Content -LiteralPath (Join-Path $tempRoot "b.txt") -Value "untracked-mutated" -NoNewline -Encoding UTF8
        $after2 = Get-TrackedTreeSnapshot -Root $tempRoot -Level "Commit"
        $result2 = Compare-TrackedTreeSnapshot -Before $before2 -After $after2
        Assert-True ($result2.Unchanged) "未 stage のファイル(b.txt)の変化は無視して成功とする"

        # === シナリオ3(-Level Commit): stage 済みファイルが0件のとき、比較対象0件で例外を投げない ===
        & git reset --quiet | Out-Null
        $before3 = Get-TrackedTreeSnapshot -Root $tempRoot -Level "Commit"
        Assert-True ($before3.Ok -and $before3.Paths.Count -eq 0) "stage 済みが0件のときは Paths が空になる(呼び出し側が警告して比較を省略する)"

        # ベースを stage 済みに戻す(以降のシナリオ用)
        & git add a.txt | Out-Null

        # === シナリオ4(-Level Push): 従来どおり作業ツリー全体を比較する。追跡ファイルの変化を検出 ===
        $before4 = Get-TrackedTreeSnapshot -Root $tempRoot -Level "Push"
        Assert-True ($before4.Ok -and $before4.Mode -eq "Full") "-Level Push は Full モードになる"
        Set-Content -LiteralPath (Join-Path $tempRoot "c.txt") -Value "base-mutated" -NoNewline -Encoding UTF8
        $after4 = Get-TrackedTreeSnapshot -Root $tempRoot -Level "Push"
        $result4 = Compare-TrackedTreeSnapshot -Before $before4 -After $after4
        Assert-True (-not $result4.Unchanged) "-Level Push は追跡ファイル(c.txt)の変化(git status の差)を検出して失敗とする"

        # 元へ戻す
        Set-Content -LiteralPath (Join-Path $tempRoot "c.txt") -Value "base" -NoNewline -Encoding UTF8

        # === シナリオ5(-Level Push): 何も変わらなければ成功 ===
        $before5 = Get-TrackedTreeSnapshot -Root $tempRoot -Level "Push"
        $after5 = Get-TrackedTreeSnapshot -Root $tempRoot -Level "Push"
        $result5 = Compare-TrackedTreeSnapshot -Before $before5 -After $after5
        Assert-True ($result5.Unchanged) "-Level Push で何も変わらなければ成功とする"
    }
    finally {
        Pop-Location
    }
}
finally {
    # .git 内部のファイルは Windows で読み取り専用属性が付くことがあり、
    # 単純な Remove-Item -Force だけでは消しきれない場合がある。属性を外してから再試行する。
    if (Test-Path -LiteralPath $tempRoot) {
        try {
            Get-ChildItem -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue |
                ForEach-Object { $_.Attributes = 'Normal' }
        } catch {}
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $tempRoot) {
            Write-Host "[警告] 一時リポジトリを削除できませんでした(手動確認要): $tempRoot" -ForegroundColor Yellow
        }
    }
}

Write-Host ""
if ($failures -gt 0) {
    Write-Host "[NG] 自己試験に $failures 件の失敗があります" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] gitTreeGuard の自己試験に全て合格しました" -ForegroundColor Green
exit 0
