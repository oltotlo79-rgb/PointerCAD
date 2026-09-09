# scripts/lib/gitTreeGuard.ps1、および scripts/check.ps1 の性能検査モード判定(-ShowPerfModeOnly)の
# 自己試験(Pester不使用の最小試験)。
# `check.ps1` の (0) 前後比較や性能検査モードの判定を変更したら必ず実行する(rules/00-施行の仕組み.md)。
# 本リポジトリには一切書き込まず、一時ディレクトリに専用のgitリポジトリを作って試験する
# (シナリオ12だけは本物の scripts/check.ps1 を `-ShowPerfModeOnly` で子プロセス起動するが、
#  読み取りと表示だけで終了し、本リポジトリへは一切書き込まない)。
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

        # === シナリオ6(-Level Commit): 日本語名ファイルもスナップショットに含まれ、内容変化を検出する ===
        # 実測の再発防止試験: core.quotepath の既定(true)のままだと `git diff --cached --name-only` が
        # 日本語名を二重引用符+8進エスケープ(例 "記\346\255\...md")で返し、そのままファイルパスとして
        # 使うと Test-Path が「パスに無効な文字が含まれています」で例外になり、日本語名ファイルが
        # 比較から漏れていた(gitTreeGuard.ps1 の Invoke-GitUtf8Output と -c core.quotepath=false / -z で対処)。
        $japaneseFileName = "記録.md"
        $japaneseFilePath = Join-Path $tempRoot $japaneseFileName
        Set-Content -LiteralPath $japaneseFilePath -Value "最初の内容" -NoNewline -Encoding UTF8
        & git add -- $japaneseFileName | Out-Null
        $before6 = Get-TrackedTreeSnapshot -Root $tempRoot -Level "Commit"
        Assert-True ($before6.Ok) "シナリオ6 前提: 日本語名ファイルの stage 取得で例外にならない"
        Assert-True (@($before6.Paths) -contains $japaneseFileName) `
            "シナリオ6: 日本語名ファイル($japaneseFileName)がスナップショットに含まれる"

        Set-Content -LiteralPath $japaneseFilePath -Value "書き換え後の内容" -NoNewline -Encoding UTF8
        $after6 = Get-TrackedTreeSnapshot -Root $tempRoot -Level "Commit"
        Assert-True ($after6.Ok) "シナリオ6: 変化後の再取得でも例外にならない"
        $result6 = Compare-TrackedTreeSnapshot -Before $before6 -After $after6
        Assert-True (-not $result6.Unchanged) "シナリオ6: 日本語名ファイルの内容変化を検出して失敗とする"
        Assert-True (@($result6.ChangedPaths) -contains $japaneseFileName) `
            "シナリオ6: 変化したファイル名(日本語名)を正しく報告する"

        # === シナリオ7(a): -Level Commit の写し(git worktree)には stage 済みの差分だけが載る ===
        # 実運用の再現: 追加・変更・削除に加え、写しに含めてはいけない「未 stage の壊れたファイル」を
        # 作業ツリーに置く(他担当の書きかけを模す)。写しにはそれが一切現れないことを確認する。
        Set-Content -LiteralPath (Join-Path $tempRoot "a.txt") -Value "staged-change" -NoNewline -Encoding UTF8
        Set-Content -LiteralPath (Join-Path $tempRoot "new7.txt") -Value "new file for scenario7" -NoNewline -Encoding UTF8
        Remove-Item -LiteralPath (Join-Path $tempRoot "c.txt") -Force
        & git add -A -- a.txt new7.txt c.txt | Out-Null
        # 未 stage の壊れたファイル(他担当の書きかけ相当)。写しに載れば検査失敗の原因になるはずのもの。
        Set-Content -LiteralPath (Join-Path $tempRoot "broken-unstaged.ts") -Value "this is not valid ts (((" -NoNewline -Encoding UTF8

        $copy7 = New-StagedTreeWorktree -Root $tempRoot
        try {
            Assert-True ($copy7.Ok) "シナリオ7 前提: 写し(git worktree)の用意と stage 済み差分の適用に成功する"
            if ($copy7.Ok) {
                Assert-True ((Get-Content -LiteralPath (Join-Path $copy7.Path "a.txt") -Raw) -eq "staged-change") `
                    "シナリオ7: 変更した stage 済みファイル(a.txt)の内容が写しに反映される"
                Assert-True ((Get-Content -LiteralPath (Join-Path $copy7.Path "new7.txt") -Raw) -eq "new file for scenario7") `
                    "シナリオ7: 新規の stage 済みファイル(new7.txt)が写しに現れる"
                Assert-True (-not (Test-Path -LiteralPath (Join-Path $copy7.Path "c.txt"))) `
                    "シナリオ7: stage 済みの削除(c.txt)が写しへ反映される"
                Assert-True (-not (Test-Path -LiteralPath (Join-Path $copy7.Path "broken-unstaged.ts"))) `
                    "シナリオ7: 未 stage の壊れたファイル(broken-unstaged.ts)は写しに現れない(他担当の書きかけに影響されない)"
            }
        }
        finally {
            Remove-StagedTreeWorktree -Root $tempRoot -WorktreePath $copy7.Path -JunctionPaths @()
        }

        # 後片付け: シナリオ8・9のために不要なファイルを片付ける(コミットはしない、作業ツリーのみ)
        Remove-Item -LiteralPath (Join-Path $tempRoot "broken-unstaged.ts") -Force -ErrorAction SilentlyContinue
        & git reset --quiet | Out-Null
        Set-Content -LiteralPath (Join-Path $tempRoot "c.txt") -Value "base" -NoNewline -Encoding UTF8
        Remove-Item -LiteralPath (Join-Path $tempRoot "new7.txt") -Force -ErrorAction SilentlyContinue
        & git add -A | Out-Null
        & git commit --quiet -m "scenario7 base sync" | Out-Null

        # === シナリオ8(b): 片付けで worktree の一覧に残らず、ジャンクションも消える(実体は無事) ===
        Set-Content -LiteralPath (Join-Path $tempRoot "a.txt") -Value "for-scenario8" -NoNewline -Encoding UTF8
        & git add a.txt | Out-Null

        $realNodeModules = Join-Path $tempRoot "node_modules_real8"
        New-Item -ItemType Directory -Path $realNodeModules | Out-Null
        Set-Content -LiteralPath (Join-Path $realNodeModules "precious.txt") -Value "precious-data" -NoNewline -Encoding UTF8

        $copy8 = New-StagedTreeWorktree -Root $tempRoot
        Assert-True ($copy8.Ok) "シナリオ8 前提: 写しの用意に成功する"
        $junctionPath8 = Join-Path $copy8.Path "node_modules"
        New-Item -ItemType Junction -Path $junctionPath8 -Target $realNodeModules | Out-Null
        Assert-True (Test-Path -LiteralPath (Join-Path $junctionPath8 "precious.txt")) `
            "シナリオ8 前提: ジャンクション越しに実体(precious.txt)が見える"

        Remove-StagedTreeWorktree -Root $tempRoot -WorktreePath $copy8.Path -JunctionPaths @($junctionPath8)

        Assert-True (-not (Test-Path -LiteralPath $copy8.Path)) "シナリオ8: 写しのディレクトリが消える"
        $worktreeListing8 = (& git -C $tempRoot worktree list) -join "`n"
        Assert-True (-not ($worktreeListing8 -match [regex]::Escape($copy8.Path))) `
            "シナリオ8: git worktree list に写しが残らない"
        Assert-True ((Test-Path -LiteralPath $realNodeModules) -and (Test-Path -LiteralPath (Join-Path $realNodeModules "precious.txt"))) `
            "シナリオ8: ジャンクションの実体(node_modules_real8/precious.txt)は消えずに残る"

        Remove-Item -LiteralPath $realNodeModules -Recurse -Force -ErrorAction SilentlyContinue
        & git reset --quiet | Out-Null
        Set-Content -LiteralPath (Join-Path $tempRoot "a.txt") -Value "base-restored" -NoNewline -Encoding UTF8
        & git add a.txt | Out-Null
        & git commit --quiet -m "scenario8 base sync" | Out-Null

        # === シナリオ9(c): 適用できない patch は理由を出して Ok=$false になる ===
        Set-Content -LiteralPath (Join-Path $tempRoot "a.txt") -Value "for-scenario9" -NoNewline -Encoding UTF8
        & git add a.txt | Out-Null

        $badPatchPath = Join-Path $tempRoot "bad9.patch"
        # 存在しないファイルへの、文脈が一致しようがない patch(意図的に壊す)
        @(
            "diff --git a/does-not-exist-anywhere.txt b/does-not-exist-anywhere.txt",
            "index 0000000..1111111 100644",
            "--- a/does-not-exist-anywhere.txt",
            "+++ b/does-not-exist-anywhere.txt",
            "@@ -1,1 +1,1 @@",
            "-this context line cannot possibly match",
            "+replacement"
        ) | Set-Content -LiteralPath $badPatchPath -Encoding UTF8

        $copy9 = New-StagedTreeWorktree -Root $tempRoot -PatchFileOverride $badPatchPath
        try {
            Assert-True (-not $copy9.Ok) "シナリオ9: 適用できない patch は Ok=\$false になる"
            Assert-True (-not [string]::IsNullOrWhiteSpace($copy9.Reason)) "シナリオ9: 失敗の理由が空でない"
        }
        finally {
            Remove-StagedTreeWorktree -Root $tempRoot -WorktreePath $copy9.Path -JunctionPaths @()
            Remove-Item -LiteralPath $badPatchPath -Force -ErrorAction SilentlyContinue
        }
        Assert-True (-not (Test-Path -LiteralPath $copy9.Path)) `
            "シナリオ9: 適用が失敗しても写し(git worktree)は後片付けされる(後片付け漏れが無い)"

        & git reset --quiet | Out-Null
        Set-Content -LiteralPath (Join-Path $tempRoot "a.txt") -Value "base-restored" -NoNewline -Encoding UTF8

        # === シナリオ10: pre-commit フックの環境(GIT_DIR / GIT_INDEX_FILE の継承)を模しても
        #     写しが作れて検査が通り、片付けも漏れない ===
        # 実測(2026-09-05、統括の実運用での報告): 実際の pre-commit の子プロセスには
        # `GIT_INDEX_FILE=.git/index`(相対パス)が継承されており、これを写しに対する
        # git 呼び出し(`worktree add` 等)がそのまま使うと、`-C` で写し側へ実効カレント
        # ディレクトリが移った時点でこの相対パスが写し基準で解決され、写しの `.git`
        # (linked worktree のためファイルでありディレクトリではない)の下に index.lock を
        # 作ろうとして `fatal: Unable to create '.../.git/index.lock': No such file or directory`
        # で失敗した(自己試験はフックの外(この変数が無い状態)で走るため、この追加まで
        # 再現しなかった)。対策: New-StagedTreeWorktree / Remove-StagedTreeWorktree が
        # Clear-InheritedGitEnv / Restore-InheritedGitEnv で一時的に消す(rules/06 10.7)。
        Set-Content -LiteralPath (Join-Path $tempRoot "a.txt") -Value "for-scenario10" -NoNewline -Encoding UTF8
        & git add a.txt | Out-Null

        $originalGitDir = $env:GIT_DIR
        $originalGitIndexFile = $env:GIT_INDEX_FILE
        # git が実際に pre-commit へ渡す値を模す(相対パス。フックは通常リポジトリ直下で動く)。
        $env:GIT_DIR = ".git"
        $env:GIT_INDEX_FILE = ".git/index"
        try {
            $copy10 = New-StagedTreeWorktree -Root $tempRoot
            Assert-True ($copy10.Ok) "シナリオ10: フックの環境(GIT_DIR/GIT_INDEX_FILE 継承)を模しても写しが作れる($($copy10.Reason))"
            if ($copy10.Ok) {
                Assert-True ((Get-Content -LiteralPath (Join-Path $copy10.Path "a.txt") -Raw) -eq "for-scenario10") `
                    "シナリオ10: フックの環境下でも stage 済み差分が写しへ正しく適用される"
            }
            Remove-StagedTreeWorktree -Root $tempRoot -WorktreePath $copy10.Path -JunctionPaths @()
            Assert-True (-not (Test-Path -LiteralPath $copy10.Path)) "シナリオ10: フックの環境下でも写しの片付けが漏れない"
            $worktreeListing10 = (& git -C $tempRoot worktree list) -join "`n"
            Assert-True (-not ($worktreeListing10 -match [regex]::Escape($copy10.Path))) `
                "シナリオ10: フックの環境下でも git worktree list に写しが残らない"
        }
        finally {
            if ($null -eq $originalGitDir) { Remove-Item Env:GIT_DIR -ErrorAction SilentlyContinue } else { $env:GIT_DIR = $originalGitDir }
            if ($null -eq $originalGitIndexFile) { Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue } else { $env:GIT_INDEX_FILE = $originalGitIndexFile }
        }

        & git reset --quiet | Out-Null
        Set-Content -LiteralPath (Join-Path $tempRoot "a.txt") -Value "base-restored" -NoNewline -Encoding UTF8

        # === シナリオ11: workspace 内パッケージ間の node_modules リンクは、写しの対応する
        #     パッケージへ差し替わり、本物の作業ツリーの未 stage な変更を見ない ===
        # 実測(2026-09-05、統括の実運用での報告): HEAD + stage 済み(scripts と rules だけ)の
        # 写しで typecheck が4件落ちた。原因は `packages/io/node_modules/@pointercad/model` の
        # ような pnpm のワークスペース内リンクが**絶対パスで本物の packages/model を指す
        # ジャンクション**であり、`packages/*/node_modules` を丸ごとジャンクションにすると
        # このリンク経由で本物の作業ツリー(未 stage の `packages/model/src/sketch/types.ts` の
        # 変更を含む)を読んでしまうため。ここでは io→model の関係を模した2パッケージの
        # 疑似ワークスペースを作り、同じ形(絶対パスのジャンクション)で再現する。
        New-Item -ItemType Directory -Path (Join-Path $tempRoot "packages\pkgConsumer") -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $tempRoot "packages\pkgDependency") -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $tempRoot "packages\pkgConsumer\index.ts") -Value "// consumer" -NoNewline -Encoding UTF8
        Set-Content -LiteralPath (Join-Path $tempRoot "packages\pkgDependency\index.ts") -Value "export const kind = 'HEAD-5-kinds';" -NoNewline -Encoding UTF8
        & git add -- packages/pkgConsumer/index.ts packages/pkgDependency/index.ts | Out-Null
        & git commit --quiet -m "scenario11 base: 2 packages" | Out-Null

        # pnpm と同じ形: 絶対パスでワークスペース内の実パッケージを指すジャンクション
        $consumerNodeModules = Join-Path $tempRoot "packages\pkgConsumer\node_modules"
        New-Item -ItemType Directory -Path (Join-Path $consumerNodeModules "@scope") -Force | Out-Null
        $workspaceLinkPath = Join-Path $consumerNodeModules "@scope\pkgDependency"
        New-Item -ItemType Junction -Path $workspaceLinkPath -Target (Join-Path $tempRoot "packages\pkgDependency") | Out-Null

        # 本物の作業ツリーだけに、未 stage の変更を置く(コミットの queue が扱う実際の状況を模す:
        # scripts/rules だけ stage 済み、packages/model は未 stage で書きかけ中)。
        Set-Content -LiteralPath (Join-Path $tempRoot "packages\pkgDependency\index.ts") -Value "export const kind = 'UNSTAGED-6-kinds (sphereGrid 相当)';" -NoNewline -Encoding UTF8
        # stage 済みの差分(scripts/rules 相当)を1件だけ用意する。
        Set-Content -LiteralPath (Join-Path $tempRoot "packages\pkgConsumer\index.ts") -Value "// consumer (staged change)" -NoNewline -Encoding UTF8
        & git add -- packages/pkgConsumer/index.ts | Out-Null

        $copy11 = New-StagedTreeWorktree -Root $tempRoot
        $junctions11 = @()
        try {
            Assert-True ($copy11.Ok) "シナリオ11 前提: 写しの用意に成功する($($copy11.Reason))"
            if ($copy11.Ok) {
                $junctions11 = New-NodeModulesJunctions -Root $tempRoot -WorktreePath $copy11.Path
                $copyLinkPath = Join-Path $copy11.Path "packages\pkgConsumer\node_modules\@scope\pkgDependency"
                Assert-True (Test-Path -LiteralPath $copyLinkPath) "シナリオ11: 写しの中に workspace 内リンクが用意される"
                if (Test-Path -LiteralPath $copyLinkPath) {
                    $linkItem = Get-Item -LiteralPath $copyLinkPath
                    $linkTargetValue = if ($linkItem.Target -is [array]) { $linkItem.Target[0] } else { $linkItem.Target }
                    $expectedInsideCopy = ([IO.Path]::GetFullPath((Join-Path $copy11.Path "packages\pkgDependency"))).TrimEnd([char[]]"\/")
                    $actualTargetFull = ([IO.Path]::GetFullPath($linkTargetValue)).TrimEnd([char[]]"\/")
                    Assert-True ($actualTargetFull -eq $expectedInsideCopy) `
                        "シナリオ11: workspace 内リンクの向き先が写しの中の対応パッケージになる(本物ではない)"

                    $seenContent = Get-Content -LiteralPath (Join-Path $copyLinkPath "index.ts") -Raw
                    Assert-True ($seenContent -eq "export const kind = 'HEAD-5-kinds';") `
                        "シナリオ11: workspace 内リンク経由で読める内容が HEAD の状態(本物の作業ツリーの未 stage な変更を見ない)"
                }
            }
        }
        finally {
            Remove-StagedTreeWorktree -Root $tempRoot -WorktreePath $copy11.Path -JunctionPaths $junctions11
        }
        Assert-True (-not (Test-Path -LiteralPath $copy11.Path)) "シナリオ11: 写しの片付けが漏れない"
        Assert-True ((Get-Content -LiteralPath (Join-Path $tempRoot "packages\pkgDependency\index.ts") -Raw) -eq "export const kind = 'UNSTAGED-6-kinds (sphereGrid 相当)';") `
            "シナリオ11: 本物の作業ツリーの未 stage な変更(pkgDependency)は片付け後も無事"

        & git reset --quiet | Out-Null

        # 実際の入口を空indexで呼び、未stage実装を検査済みと誤認する経路を閉じる。
        $guardCheckPath = Join-Path $scriptDirectory "check.ps1"
        $guardShell = if (Get-Command powershell.exe -ErrorAction SilentlyContinue) { "powershell.exe" } else { "pwsh" }
        Set-Content -LiteralPath (Join-Path $tempRoot "package.json") -Encoding UTF8 -Value '{"scripts":{"typecheck":"unused","lint":"unused","test":"unused","build":"unused"}}'
        $emptyIndexOutput = & $guardShell -NoProfile -ExecutionPolicy Bypass -File $guardCheckPath -RepositoryRoot $tempRoot -Level Commit | Out-String
        Assert-True ($LASTEXITCODE -eq 1 -and $emptyIndexOutput.Contains("stage 済みの変更がありません")) "空indexのCommit検査はpnpm起動前に拒否する"
        foreach ($badArgs in @(
            @('-UnitPackage', 'kernel'),
            @('-UnitPackage', 'kernel', '-UnitTests', 'src/../escape.test.ts'),
            @('-UnitTests', 'src/example.test.ts'),
            @('-UnitPackage', 'kernel', '-UnitTests', 'src/example.test.ts', '-E2EOnly')
        )) {
            $invalidOutput = & $guardShell -NoProfile -ExecutionPolicy Bypass -File $guardCheckPath -RepositoryRoot $tempRoot -Level Push @badArgs | Out-String
            Assert-True ($LASTEXITCODE -eq 1 -and $invalidOutput.Contains("[NG]")) "不正なユニット診断指定はpnpm起動前に拒否する: $($badArgs -join ' ')"
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    # .git 内部のファイルは Windows で読み取り専用属性が付くことがあり、
    # 単純な Remove-Item -Force だけでは消しきれない場合がある。属性を外してから再試行する。
    if (Test-Path -LiteralPath $tempRoot) {
        $verifiedTempRoot = [IO.Path]::GetFullPath($tempRoot)
        $expectedTempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([char[]]"\/")
        if ((Split-Path -Parent $verifiedTempRoot).TrimEnd([char[]]"\/") -ne $expectedTempParent -or
            (Split-Path -Leaf $verifiedTempRoot) -notmatch '^pointercad-checkselftest-[a-f0-9]{32}$') {
            throw "自己試験の削除対象が専用一時ディレクトリ外です: $verifiedTempRoot"
        }
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

# === シナリオ12: scripts/check.ps1 の性能検査モード表示が $env:CI の値に応じて切り替わる ===
# (rules/06-過去の失敗と対策.md 10.12: 共有CIランナーの速さは制御できないため、CI上では
#  性能検査の上限判定を参考にとどめ、厳密な判定は手元のpre-push(-Level Push、CI以外)だけで行う)
# 実際の scripts/check.ps1 を子プロセスとして `-ShowPerfModeOnly` で起動し(pnpmは一切実行せず、
# 判定モードの表示だけで終了する)、表示メッセージで切替の実装を直接確認する。本リポジトリの
# 作業ツリー・indexには一切書き込まない(読み取りと表示だけ)。
$checkScriptPath = Join-Path $scriptDirectory "check.ps1"
Assert-True (Test-Path -LiteralPath $checkScriptPath -PathType Leaf) "シナリオ12 前提: scripts/check.ps1 が存在する"

$perfModeShellCommand = $null
if (Get-Command powershell.exe -ErrorAction SilentlyContinue) {
    $perfModeShellCommand = "powershell.exe"
} elseif (Get-Command pwsh -ErrorAction SilentlyContinue) {
    $perfModeShellCommand = "pwsh"
}
Assert-True ($null -ne $perfModeShellCommand) "シナリオ12 前提: powershell.exe または pwsh が見つかる"

if ($null -ne $perfModeShellCommand) {
    $originalCIEnvValue = $env:CI
    try {
        # 12a: CI 未設定 + -Level Push は従来どおり厳密
        Remove-Item Env:CI -ErrorAction SilentlyContinue
        # 2>&1 は使わない(Windows PowerShell 5.1 でネイティブコマンドのstderrをリダイレクトすると
        # $ErrorActionPreference='Stop' 下で終端エラー扱いになる実測がある。rules/06 10.7)。
        $output12a = & $perfModeShellCommand -NoProfile -ExecutionPolicy Bypass -File $checkScriptPath -Level Push -ShowPerfModeOnly | Out-String
        Assert-True ($output12a -match [regex]::Escape("性能検査: 厳密(-Level Push)")) `
            "シナリオ12a: CI未設定 + -Level Push は「性能検査: 厳密(-Level Push)」と表示する"

        # 12b: CI=true + -Level Push は参考(CI)に切り替わる(上限の数値・段は変えない)
        $env:CI = 'true'
        $output12b = & $perfModeShellCommand -NoProfile -ExecutionPolicy Bypass -File $checkScriptPath -Level Push -ShowPerfModeOnly | Out-String
        Assert-True ($output12b -match [regex]::Escape("性能検査: 参考(CI)")) `
            "シナリオ12b: CI=true + -Level Push は「性能検査: 参考(CI)」と表示する"

        # 12c: CI=true でも -Level Commit の表示は変わらない(pre-commitは元々参考のまま)
        $output12c = & $perfModeShellCommand -NoProfile -ExecutionPolicy Bypass -File $checkScriptPath -Level Commit -ShowPerfModeOnly | Out-String
        Assert-True ($output12c -match [regex]::Escape("性能検査: 参考(-Level Commit)")) `
            "シナリオ12c: CI=true でも -Level Commit は従来どおり「性能検査: 参考(-Level Commit)」と表示する"
    }
    finally {
        if ($null -eq $originalCIEnvValue) { Remove-Item Env:CI -ErrorAction SilentlyContinue } else { $env:CI = $originalCIEnvValue }
    }
}

Write-Host ""
# 指定ファイルの一部だけが実在していても、存在しない検査を黙って省略しない。
if ($null -ne $perfModeShellCommand) {
    $missingUnitOutput = & $perfModeShellCommand -NoProfile -ExecutionPolicy Bypass -File $checkScriptPath `
        -Level Push -UnitPackage ui -UnitTests src/this-test-must-not-exist.test.ts | Out-String
    Assert-True ($LASTEXITCODE -ne 0) "存在しない対象ユニットテストを指定すると非0で終了する"
    Assert-True ($missingUnitOutput.Contains("指定したユニットテストが見つかりません")) "存在しない対象の名前を検査実行前に知らせる"
    Assert-True (-not $missingUnitOutput.Contains("=== ユニット診断")) "存在しない対象があればpnpmを実行しない"
}
# 診断を通常ゲートと混ぜたり、一部を黙って省略したりしない。
if ($null -ne $perfModeShellCommand) {
    foreach ($arguments in @(
        @('-Level', 'Commit', '-StaticOnly'),
        @('-Level', 'Push', '-StaticOnly', '-E2EOnly'),
        @('-Level', 'Push', '-StaticOnly', '-UnitPackage', 'ui', '-UnitTests', 'src/i18n/jaMessages.test.ts')
    )) {
        $staticOutput = & $perfModeShellCommand -NoProfile -ExecutionPolicy Bypass -File $checkScriptPath @arguments | Out-String
        Assert-True ($LASTEXITCODE -ne 0) "StaticOnlyと他のゲート/診断の混在を非0で断る: $arguments"
        Assert-True ($staticOutput.Contains('-StaticOnly は -Level Push')) "StaticOnlyの不正な組合せの理由を表示する"
        Assert-True (-not $staticOutput.Contains('=== (1/')) "不正な組合せでは検査コマンドを開始しない"
    }
}

if ($failures -gt 0) {
    Write-Host "[NG] 自己試験に $failures 件の失敗があります" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] gitTreeGuard / check.ps1 性能検査モード判定の自己試験に全て合格しました" -ForegroundColor Green
exit 0
