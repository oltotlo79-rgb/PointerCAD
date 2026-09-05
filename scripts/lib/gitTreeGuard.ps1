# 検査前後で「コミット対象のファイルが書き換わっていないか」を確かめるための関数群、および
# -Level Commit の検査を「stage 済みの差分だけを写した別の作業ツリー」で行うための関数群。
# rules/03-品質ゲート.md §7.1 #0・7、rules/00-施行の仕組み.md、rules/06-過去の失敗と対策.md 10.7 が
# 参照する単一正本。`scripts/check.ps1` と `scripts/check.selftest.ps1` の両方がこのファイルを dot-source する。
# 関数定義のみを置き、トップレベルの実行は行わない(dot-source しても副作用が起きない)。
#
# -Level Commit: 比較対象を `git diff --cached --name-only`(stage 済みのパス)に限定する。
#   並列で動く他の作業担当の未追跡・未 stage の変化に影響されず、統括がコミットできるようにするため。
# -Level Push  : 従来どおり `git status --porcelain --untracked-files=no` で作業ツリー全体を比較する。
#
# 日本語ファイル名などの非ASCIIパスへの対処(実測): gitの既定 core.quotepath=true は、名前欄に
# 非ASCII文字を含むパスを `"docs/\346\212\261...md"` のように二重引用符+8進エスケープで返す。
# これをそのままファイルパスとして Test-Path 等へ渡すと「パスに無効な文字が含まれています」で
# 例外になる(stage済みの日本語名ファイルが比較から漏れる原因)。対策として
# `-c core.quotepath=false` と `-z`(NUL区切り、引用そのものを発生させない)を併用する。
# さらに PowerShell 5.1 はコンソール出力符号化の既定がANSI(日本語環境ではコードページ932)であり、
# gitが返すUTF-8バイト列をそのまま解釈すると文字化けする(実測: "スケッチ" が "スケチE" 等に化ける)。
# `Invoke-GitUtf8Output` で `[Console]::OutputEncoding` を呼び出し中だけUTF-8に切り替えて対処する。
#
# pre-commit フックの子プロセスへの GIT_* 環境変数の継承(実測、rules/06-過去の失敗と対策.md 10.7):
# git はフック(pre-commit 等)を起動するとき `GIT_INDEX_FILE=.git/index` のような**相対パス**の
# 環境変数を子プロセスへ渡す。`scripts/hooks/pre-commit` → `powershell.exe` → (このライブラリの
# git呼び出し)という子プロセスの連鎖でこれがそのまま継承されると、写し(git worktree)の中で
# 実行する git 呼び出しがこの相対パスを**写し側のカレントディレクトリ基準**で解決してしまい、
# 写しの `.git`(linked worktree のためファイルでありディレクトリではない)の下に
# index.lock を作ろうとして `fatal: Unable to create '.../.git/index.lock': No such file or directory`
# で失敗する(自己試験はフックの外(この変数が無い状態)で走るため再現しなかった)。
# 写しに関わる git 呼び出し・写しの中で実行するコマンドはすべてこれらの環境変数を一時的に
# 消してから実行し、終わったら元に戻す(Clear-InheritedGitEnv / Restore-InheritedGitEnv)。
$script:PointerCadInheritedGitEnvNames = @(
    "GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_PREFIX",
    "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_QUARANTINE_PATH"
)

# 現在設定されている継承 GIT_* 環境変数を退避して消す。戻り値(退避内容)は
# Restore-InheritedGitEnv へそのまま渡すこと。何も設定されていなければ空のハッシュテーブルを返す。
function Clear-InheritedGitEnv {
    $saved = @{}
    foreach ($name in $script:PointerCadInheritedGitEnvNames) {
        $item = Get-Item -Path "Env:$name" -ErrorAction SilentlyContinue
        if ($null -ne $item) {
            $saved[$name] = $item.Value
            Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
        }
    }
    return $saved
}

# Clear-InheritedGitEnv が退避した環境変数を元に戻す。
function Restore-InheritedGitEnv {
    param([Parameter(Mandatory)][hashtable]$Saved)
    foreach ($name in $Saved.Keys) {
        Set-Item -Path "Env:$name" -Value $Saved[$name]
    }
}

# コンソール出力符号化を一時的にUTF-8へ切り替えてから $ScriptBlock(git呼び出し)を実行する。
# コンソールハンドルが無い等の環境で切替自体が失敗しても、呼び出しは続行する(fail-open)。
# quotepath=false と -z による例外回避は符号化の成否に関わらず効くため、致命的にはしない。
function Invoke-GitUtf8Output {
    param([Parameter(Mandatory)][scriptblock]$ScriptBlock)
    $previousEncoding = $null
    $encodingChanged = $false
    try {
        $previousEncoding = [Console]::OutputEncoding
        [Console]::OutputEncoding = [Text.Encoding]::UTF8
        $encodingChanged = $true
    } catch {
        Write-Host "[警告] コンソール符号化をUTF-8へ切替できません(処理は続行します): $($_.Exception.Message)" -ForegroundColor Yellow
    }
    try {
        & $ScriptBlock
    } finally {
        if ($encodingChanged) {
            [Console]::OutputEncoding = $previousEncoding
        }
    }
}

function Get-StagedTrackedPaths {
    param([Parameter(Mandatory)][string]$Root)
    # 戻り値を配列そのものにすると、要素数が1件のときにPowerShellのパイプラインが
    # 単一要素のコレクションをスカラーへ展開してしまう(呼び出し側の $x = Get-Foo で
    # 配列が文字列1個に化ける既知の罠)。pscustomobjectで包んで境界を越えさせない。
    $global:LASTEXITCODE = 0
    $rawLines = @(Invoke-GitUtf8Output { & git -C $Root -c core.quotepath=false diff --cached --name-only -z })
    if ($LASTEXITCODE -ne 0) {
        return [pscustomobject]@{ Ok = $false; Paths = @() }
    }
    # -z の出力は改行を含まないため、PowerShellのネイティブコマンド出力は1要素(または0要素)に
    # まとまる。念のため結合してからNUL区切りで割り直す。
    $joined = ($rawLines -join '')
    $paths = @($joined -split "`0" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    return [pscustomobject]@{ Ok = $true; Paths = $paths }
}

function Get-GitFileFingerprint {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$RelativePath
    )
    $fullPath = Join-Path $Root $RelativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        # stage 済みの削除など、作業ツリーに実体が無い状態を表す番人値
        return '<absent>'
    }
    $global:LASTEXITCODE = 0
    $hash = & git -C $Root hash-object -- $RelativePath 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($hash)) {
        # git hash-object が失敗した場合はファイル内容そのもののハッシュへ後退する
        return (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash
    }
    return ([string]$hash).Trim()
}

# 検査前後で比較するための「その時点の状態」を1つ取得する。
# -Level Commit は stage 済みファイルごとの内容ハッシュ、-Level Push は git status の全文。
function Get-TrackedTreeSnapshot {
    param(
        [Parameter(Mandatory)][string]$Root,
        [ValidateSet("Commit", "Push")][string]$Level = "Push"
    )
    if ($Level -eq "Commit") {
        $staged = Get-StagedTrackedPaths -Root $Root
        if (-not $staged.Ok) {
            return [pscustomobject]@{ Ok = $false; Mode = "Staged"; Paths = @(); Fingerprints = @{} }
        }
        $paths = @($staged.Paths)
        $fingerprints = @{}
        foreach ($path in $paths) {
            $fingerprints[$path] = Get-GitFileFingerprint -Root $Root -RelativePath $path
        }
        return [pscustomobject]@{ Ok = $true; Mode = "Staged"; Paths = $paths; Fingerprints = $fingerprints }
    }

    $global:LASTEXITCODE = 0
    # -Level Push はパスをTest-Pathへ渡さず全文字列比較のみなので例外は起きないが、
    # 日本語ファイル名が絡む差分をそのまま失敗時にWrite-Hostする(下の呼び出し元)ため、
    # 読める形にそろえる目的で Get-StagedTrackedPaths と同じ対処を適用する。
    $status = (Invoke-GitUtf8Output { & git -C $Root -c core.quotepath=false status --porcelain --untracked-files=no }) -join "`n"
    $ok = ($LASTEXITCODE -eq 0)
    return [pscustomobject]@{ Ok = $ok; Mode = "Full"; Status = $status }
}

# 2つのスナップショットを比較する。Unchanged が $false なら検査中の書き換えを検出したということ。
function Compare-TrackedTreeSnapshot {
    param(
        [Parameter(Mandatory)]$Before,
        [Parameter(Mandatory)]$After
    )
    if (-not $Before.Ok -or -not $After.Ok) {
        return [pscustomobject]@{ Unchanged = $false; GitFailed = $true; ChangedPaths = @() }
    }
    if ($Before.Mode -eq "Staged") {
        $changed = @($Before.Paths | Where-Object { $After.Fingerprints[$_] -ne $Before.Fingerprints[$_] })
        return [pscustomobject]@{ Unchanged = ($changed.Count -eq 0); GitFailed = $false; ChangedPaths = $changed }
    }
    $unchanged = ($Before.Status -eq $After.Status)
    return [pscustomobject]@{ Unchanged = $unchanged; GitFailed = $false; ChangedPaths = @() }
}

# ===========================================================================
# -Level Commit: stage 済みの差分だけを写した別の作業ツリーで検査するための関数群。
# rules/06-過去の失敗と対策.md 10.7。目的: pre-commit の検査が「作業ツリー全体」を対象に
# していたため、並列作業中の他担当の未 stage な書きかけの影響で緑にならない問題を防ぐ。
# 手段: `git worktree add --detach` で HEAD の写しを作り、`git diff --cached` の差分だけを
# `git apply` で載せる。写しの中でだけ typecheck/lint/test/build を実行するため、
# 前後の追跡対象比較(#0)は写しでは不要(本物の作業ツリー・indexには一切触れないため)。
# ===========================================================================

# 写しの中に置いてよい node_modules の相対パスを列挙する(実体があるものだけ)。
# 根、packages/*、apps/*、e2e の決まった位置だけを見る(新規の置き場が増えたら追記する)。
function Get-NodeModulesJunctionTargets {
    param([Parameter(Mandatory)][string]$Root)
    $candidateRelativePaths = New-Object System.Collections.Generic.List[string]
    $candidateRelativePaths.Add("node_modules")
    foreach ($groupDir in @("packages", "apps")) {
        $groupPath = Join-Path $Root $groupDir
        if (Test-Path -LiteralPath $groupPath -PathType Container) {
            Get-ChildItem -LiteralPath $groupPath -Directory | ForEach-Object {
                $candidateRelativePaths.Add((Join-Path (Join-Path $groupDir $_.Name) "node_modules"))
            }
        }
    }
    $candidateRelativePaths.Add((Join-Path "e2e" "node_modules"))

    $existing = New-Object System.Collections.Generic.List[string]
    foreach ($relative in $candidateRelativePaths) {
        if (Test-Path -LiteralPath (Join-Path $Root $relative) -PathType Container) {
            $existing.Add($relative)
        }
    }
    return @($existing)
}

# HEAD の写し(git worktree、実体は無くgitオブジェクトから復元されるだけ)を作り、
# stage 済みの差分だけを `git apply` で載せる。戻り値: Ok / Path(写しの絶対パス) / Reason。
# 差分の書き出しは `git diff --output=<file>` を使う(gitが直接UTF-8で書くため、
# PowerShellのコンソール往復による日本語ファイル名・非ASCII内容の文字化けを避けられる)。
# Ok=$false のときも Path は worktree add が成功していれば有効な写しの場所を指す
# (呼び出し側は Ok の真偽に関わらず Remove-StagedTreeWorktree で必ず後片付けすること)。
function New-StagedTreeWorktree {
    param(
        [Parameter(Mandatory)][string]$Root,
        # 自己試験専用: 指定すると `git diff --cached` の生成を省き、このパッチファイルを
        # そのまま適用する(apply 失敗時の経路を意図的に再現するため)。通常運用では渡さない。
        [string]$PatchFileOverride = ""
    )

    # 注意: 以下の git 呼び出しは意図的に stderr を `2>&1` / `2>$null` でリダイレクトしない。
    # Windows PowerShell 5.1 はネイティブコマンドの stderr をリダイレクトすると各行を
    # ErrorRecord として包み、呼び出し元が `$ErrorActionPreference = 'Stop'`(例:
    # scripts/check.selftest.ps1)のときは終了コード0でも終端エラーとして扱われ、
    # 後片付けの finally に辿り着く前に異常終了する実測がある(rules/06-過去の失敗と対策.md 10.7)。
    # stderr はリダイレクトせず素通りさせてコンソールにそのまま出し、判定は $LASTEXITCODE だけで行う。
    $worktreePath = Join-Path ([IO.Path]::GetTempPath()) ("pointercad-commitcheck-" + [Guid]::NewGuid().ToString("N"))

    # pre-commit フックから継承した GIT_DIR / GIT_INDEX_FILE 等(相対パス)が、写しに対する
    # git 呼び出しへ紛れ込まないよう一時的に消す(冒頭のコメント、rules/06-過去の失敗と対策.md 10.7)。
    $savedGitEnv = Clear-InheritedGitEnv
    try {
        $global:LASTEXITCODE = 0
        & git -C $Root worktree add --detach --quiet -- $worktreePath HEAD
        if ($LASTEXITCODE -ne 0) {
            return [pscustomobject]@{ Ok = $false; Path = $worktreePath; Reason = "git worktree add に失敗しました(終了コード: $LASTEXITCODE。詳細はコンソール出力を参照)" }
        }

        $usingOverride = -not [string]::IsNullOrWhiteSpace($PatchFileOverride)
        $patchFile = if ($usingOverride) { $PatchFileOverride } else { Join-Path ([IO.Path]::GetTempPath()) ("pointercad-staged-" + [Guid]::NewGuid().ToString("N") + ".patch") }
        try {
            if (-not $usingOverride) {
                $global:LASTEXITCODE = 0
                & git -C $Root -c core.quotepath=false diff --cached --binary --output=$patchFile
                if ($LASTEXITCODE -ne 0) {
                    return [pscustomobject]@{ Ok = $false; Path = $worktreePath; Reason = "git diff --cached の書き出しに失敗しました(終了コード: $LASTEXITCODE)" }
                }
            }

            $hasPatch = (Test-Path -LiteralPath $patchFile -PathType Leaf) -and ((Get-Item -LiteralPath $patchFile).Length -gt 0)
            if ($hasPatch) {
                $global:LASTEXITCODE = 0
                & git -C $worktreePath -c core.quotepath=false apply --binary --whitespace=nowarn -- $patchFile
                if ($LASTEXITCODE -ne 0) {
                    return [pscustomobject]@{ Ok = $false; Path = $worktreePath; Reason = "stage 済みの差分を写しへ適用できませんでした(終了コード: $LASTEXITCODE。詳細はコンソール出力を参照)" }
                }
            }
        } finally {
            if (-not $usingOverride -and (Test-Path -LiteralPath $patchFile)) {
                Remove-Item -LiteralPath $patchFile -Force -ErrorAction SilentlyContinue
            }
        }

        return [pscustomobject]@{ Ok = $true; Path = $worktreePath; Reason = $null }
    } finally {
        Restore-InheritedGitEnv -Saved $savedGitEnv
    }
}

# pnpm(11系)の recursive 実行(`pnpm --recursive run test` 等、根の package.json の
# test/build スクリプトが使う)は「実行状態の記録先」を根の node_modules 直下に置き、
# 根の node_modules 自体がシンボリックリンク/ジャンクションだと
# `ERR_PNPM_UNSAFE_TASK_RUN_STATE_PATH` で実行そのものを拒否する
# (2026-09-05 実測: 根の node_modules を丸ごとジャンクションにすると `pnpm run test` /
#  `pnpm run build` が失敗した。rules/06-過去の失敗と対策.md 10.7)。
# 実行状態ディレクトリ(下記の名前)は写しの中で毎回新しく作らせ、元とは共有しない
# (元と写しが同時に検査を走らせても互いの実行状態を壊さないため)。根の node_modules
# だけに存在する(実測済み)ため、除外対象は根の場合だけ渡す。
$script:PointerCadRootNodeModulesTaskStateDirName = ".pnpm-task-run-state-v1"

# pnpm はワークスペース内パッケージ間の依存(例: packages/io の @pointercad/model)を、
# 絶対パスで元のパッケージ実体を指すジャンクションとして node_modules に置く
# (2026-09-05 実測: `packages/io/node_modules/@pointercad/model` の LinkType は Junction、
#  Target は `<Root>\packages\model`。相対パスではなく絶対パス)。
# `packages/*`・`apps/*` 配下の node_modules を**丸ごと**ジャンクションにすると、この
# workspace 内リンクが元(本物の作業ツリー)の packages/model 等をそのまま指すため、
# 写しの中の tsc がユニット未コミットの型を読んでしまう実測がある
# (rules/06-過去の失敗と対策.md 10.7 追記)。そのためこの関数で、workspace 内(packages/*・
# apps/* を指す)ジャンクションだけを写し側の対応パスへ差し替える。それ以外(.pnpm 配下の
# 通常の依存)は元のまま(内容は並列作業の影響を受けないため差し替え不要)。
function Resolve-WorkspaceAwareJunctionTarget {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$WorktreePath,
        [Parameter(Mandatory)][string]$RealTarget
    )
    if ([string]::IsNullOrWhiteSpace($RealTarget)) { return $RealTarget }
    $rootFull = ([IO.Path]::GetFullPath($Root)).TrimEnd([char[]]"\/")
    $targetFull = ([IO.Path]::GetFullPath($RealTarget)).TrimEnd([char[]]"\/")
    $prefixBackslash = $rootFull + [IO.Path]::DirectorySeparatorChar
    $prefixSlash = $rootFull + [IO.Path]::AltDirectorySeparatorChar
    $isUnderRoot = $targetFull.StartsWith($prefixBackslash, [StringComparison]::OrdinalIgnoreCase) -or
                   $targetFull.StartsWith($prefixSlash, [StringComparison]::OrdinalIgnoreCase)
    if ($isUnderRoot) {
        $relative = $targetFull.Substring($rootFull.Length).TrimStart([char[]]"\/")
        if ($relative -match '^(packages|apps)[\\/]') {
            return (Join-Path $WorktreePath $relative)
        }
    }
    return $targetFull
}

# node_modules 直下の項目1つを写しへ用意する(ジャンクション先の決定を含む)。
# ファイルはコピー、ジャンクションは Resolve-WorkspaceAwareJunctionTarget で差し替えた先へ
# 張り直し、npm/pnpm のスコープディレクトリ(名前が "@" で始まる通常ディレクトリ、例:
# @pointercad・@types)はもう1段掘り下げて中の各パッケージを個別に扱う
# (スコープ内に workspace 内リンクと通常の依存が混在し得るため)。
# 戻り値は必ず [pscustomobject]@{ Created = @(...) } で包む。配列をそのまま返すと
# 要素数が1件のときにPowerShellの呼び出しがスカラーへ展開してしまう既知の罠があるため
# (scripts/lib/gitTreeGuard.ps1 冒頭の Get-StagedTrackedPaths と同じ対処。加えて、
#  空のコレクションをそのまま別関数のパラメータへ渡すと「空のコレクションであるためパラメーター
#  にバインドできません」で失敗する実測もあり(2026-09-05)、値渡しの引数ではなく戻り値の
#  集約で親側へ伝える設計にした)。
function New-NodeModulesShadowEntry {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$WorktreePath,
        [Parameter(Mandatory)]$Item,
        [Parameter(Mandatory)][string]$Destination
    )
    if (-not $Item.PSIsContainer) {
        # .modules.yaml 等の小さな管理ファイル。ファイルはジャンクションにできないためコピーする。
        try {
            Copy-Item -LiteralPath $Item.FullName -Destination $Destination -ErrorAction Stop
        } catch {
            Write-Host "[警告] node_modules 直下のファイルをコピーできませんでした($($Item.Name)): $($_.Exception.Message)" -ForegroundColor Yellow
        }
        return [pscustomobject]@{ Created = @() }
    }

    $isReparsePoint = ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    if ($isReparsePoint) {
        $rawTarget = $Item.Target
        $realTarget = if ($rawTarget -is [array]) { $rawTarget[0] } else { $rawTarget }
        if ([string]::IsNullOrWhiteSpace($realTarget)) { $realTarget = $Item.FullName }
        $linkTarget = Resolve-WorkspaceAwareJunctionTarget -Root $Root -WorktreePath $WorktreePath -RealTarget $realTarget
        try {
            New-Item -ItemType Junction -Path $Destination -Target $linkTarget -ErrorAction Stop | Out-Null
            return [pscustomobject]@{ Created = @($Destination) }
        } catch {
            Write-Host "[警告] node_modules 直下のジャンクションを作れませんでした($($Item.Name)): $($_.Exception.Message)" -ForegroundColor Yellow
            return [pscustomobject]@{ Created = @() }
        }
    }

    if ($Item.Name.StartsWith("@")) {
        try {
            New-Item -ItemType Directory -Path $Destination -ErrorAction Stop | Out-Null
        } catch {
            Write-Host "[警告] スコープディレクトリを作れませんでした($($Item.Name)): $($_.Exception.Message)" -ForegroundColor Yellow
            return [pscustomobject]@{ Created = @() }
        }
        $createdInScope = New-Object System.Collections.Generic.List[string]
        Get-ChildItem -LiteralPath $Item.FullName -Force | ForEach-Object {
            $scopedDestination = Join-Path $Destination $_.Name
            $childResult = New-NodeModulesShadowEntry -Root $Root -WorktreePath $WorktreePath -Item $_ -Destination $scopedDestination
            foreach ($p in @($childResult.Created)) { $createdInScope.Add($p) }
        }
        return [pscustomobject]@{ Created = @($createdInScope) }
    }

    # 通常はここに来ない(スコープ以外の非リパースポイントのディレクトリ)。安全側で丸ごとジャンクション。
    try {
        New-Item -ItemType Junction -Path $Destination -Target $Item.FullName -ErrorAction Stop | Out-Null
        return [pscustomobject]@{ Created = @($Destination) }
    } catch {
        Write-Host "[警告] node_modules 直下のジャンクションを作れませんでした($($Item.Name)): $($_.Exception.Message)" -ForegroundColor Yellow
        return [pscustomobject]@{ Created = @() }
    }
}

# node_modules の「写し」を実体ディレクトリとして作り、直下の項目を個別に
# ジャンクション/コピーする(New-NodeModulesShadowEntry を1件ずつ適用)。
# 戻り値: 作成したジャンクション(葉、実体ディレクトリ自身は含まない)の絶対パスの配列
# (Remove-JunctionSafely は非再帰削除が前提で、実体ディレクトリには使えないため)。
function New-NodeModulesShadow {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$WorktreePath,
        [Parameter(Mandatory)][string]$SourceNodeModules,
        [Parameter(Mandatory)][string]$DestinationNodeModules,
        [string[]]$ExcludeNames = @()
    )
    $created = New-Object System.Collections.Generic.List[string]
    New-Item -ItemType Directory -Path $DestinationNodeModules -ErrorAction Stop | Out-Null
    Get-ChildItem -LiteralPath $SourceNodeModules -Force | ForEach-Object {
        if ($ExcludeNames -contains $_.Name) { return }
        $destinationChild = Join-Path $DestinationNodeModules $_.Name
        $childResult = New-NodeModulesShadowEntry -Root $Root -WorktreePath $WorktreePath -Item $_ -Destination $destinationChild
        foreach ($p in @($childResult.Created)) { $created.Add($p) }
    }
    return @($created)
}

# 写しの中へ node_modules を向ける(コピーしない。管理者権限は不要)。
# **すべての node_modules(根・packages/*・apps/*・e2e)を実体ディレクトリ+直下の個別
# ジャンクションにする**(根だけの特別扱いだった旧実装は、workspace 内リンクが本物の
# 作業ツリーを指す問題があり不十分だった。rules/06-過去の失敗と対策.md 10.7 追記)。
# 個々の作成に失敗しても他は続け、作れたジャンクションだけを戻り値で返す
# (呼び出し側が後片付けの対象を漏れなく把握できるようにするため)。
function New-NodeModulesJunctions {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$WorktreePath
    )
    $created = New-Object System.Collections.Generic.List[string]
    foreach ($relative in (Get-NodeModulesJunctionTargets -Root $Root)) {
        $source = Join-Path $Root $relative
        $destination = Join-Path $WorktreePath $relative
        $destinationParent = Split-Path -Parent $destination
        if (-not (Test-Path -LiteralPath $destinationParent -PathType Container)) {
            # 写しに対応する配置(パッケージのディレクトリ)が無ければ作らない
            continue
        }
        if (Test-Path -LiteralPath $destination) {
            # node_modules は .gitignore 対象のため通常は起こらない。安全側で上書きしない。
            continue
        }

        $excludeNames = if ($relative -eq "node_modules") { @($script:PointerCadRootNodeModulesTaskStateDirName) } else { @() }
        try {
            foreach ($junction in (New-NodeModulesShadow -Root $Root -WorktreePath $WorktreePath -SourceNodeModules $source -DestinationNodeModules $destination -ExcludeNames $excludeNames)) {
                $created.Add($junction)
            }
        } catch {
            Write-Host "[警告] node_modules を用意できませんでした($relative): $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
    return @($created)
}

# ジャンクション1件だけを安全に取り除く(実体には触れない)。
# `Remove-Item -Recurse` はリパースポイントの実装によっては実体を辿って消しかねないため使わない
# (2026-09-05 実測: `git worktree remove --force` はジャンクションを辿って実体側の内容を削除した。
#  rules/06-過去の失敗と対策.md 10.7)。.NET の `Directory.Delete(path, $false)` は非再帰なので
# ジャンクション自身だけを外せる(実測済み)。失敗したら `cmd /c rmdir`(こちらも非再帰)へ後退する。
function Remove-JunctionSafely {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    try {
        [System.IO.Directory]::Delete($Path, $false)
        return -not (Test-Path -LiteralPath $Path)
    } catch {
        try {
            # stderr はリダイレクトしない(New-StagedTreeWorktree 冒頭のコメントと同じ理由)。
            & cmd.exe /c ('rmdir "' + $Path + '"') | Out-Null
        } catch {}
        return -not (Test-Path -LiteralPath $Path)
    }
}

# 写し(git worktree)を片付ける。**ジャンクションを先に外してから** `git worktree remove` する
# 順序が必須(逆にすると実体ごと消える実測がある。上の Remove-JunctionSafely のコメント参照)。
# 失敗しても例外を投げない(呼び出し側の finally から呼ばれるため、検査結果の終了コードを壊さない)。
function Remove-StagedTreeWorktree {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$WorktreePath,
        [string[]]$JunctionPaths = @()
    )
    foreach ($junction in $JunctionPaths) {
        $removed = Remove-JunctionSafely -Path $junction
        if (-not $removed) {
            Write-Host "[警告] ジャンクションを外せませんでした(手動確認要): $junction" -ForegroundColor Yellow
        }
    }

    if (-not (Test-Path -LiteralPath $WorktreePath)) { return }

    # pre-commit フックから継承した GIT_DIR / GIT_INDEX_FILE 等が worktree remove へ
    # 紛れ込まないよう一時的に消す(New-StagedTreeWorktree 冒頭のコメントと同じ理由)。
    $savedGitEnv = Clear-InheritedGitEnv
    try {
        $global:LASTEXITCODE = 0
        & git -C $Root worktree remove --force -- $WorktreePath
        if ($LASTEXITCODE -ne 0 -or (Test-Path -LiteralPath $WorktreePath)) {
            Write-Host "[警告] git worktree remove に失敗しました(終了コード: $LASTEXITCODE)。手動で片付けます。" -ForegroundColor Yellow
            # ここに来た時点でジャンクションは既に外れているため、通常の再帰削除で実体を巻き込まない。
            Remove-Item -LiteralPath $WorktreePath -Recurse -Force -ErrorAction SilentlyContinue
            & git -C $Root worktree prune | Out-Null
        }
    } finally {
        Restore-InheritedGitEnv -Saved $savedGitEnv
    }
    if (Test-Path -LiteralPath $WorktreePath) {
        Write-Host "[警告] 写しの後片付けが完了しませんでした(手動確認要): $WorktreePath" -ForegroundColor Yellow
    }
}
