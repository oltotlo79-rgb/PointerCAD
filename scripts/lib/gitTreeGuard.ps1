# 検査前後で「コミット対象のファイルが書き換わっていないか」を確かめるための関数群。
# rules/03-品質ゲート.md §7.1 #0 と rules/00-施行の仕組み.md の該当行が参照する単一正本。
# `scripts/check.ps1` と `scripts/check.selftest.ps1` の両方がこのファイルを dot-source する。
# 関数定義のみを置き、トップレベルの実行は行わない(dot-source しても副作用が起きない)。
#
# -Level Commit: 比較対象を `git diff --cached --name-only`(stage 済みのパス)に限定する。
#   並列で動く他の作業担当の未追跡・未 stage の変化に影響されず、統括がコミットできるようにするため。
# -Level Push  : 従来どおり `git status --porcelain --untracked-files=no` で作業ツリー全体を比較する。

function Get-StagedTrackedPaths {
    param([Parameter(Mandatory)][string]$Root)
    # 戻り値を配列そのものにすると、要素数が1件のときにPowerShellのパイプラインが
    # 単一要素のコレクションをスカラーへ展開してしまう(呼び出し側の $x = Get-Foo で
    # 配列が文字列1個に化ける既知の罠)。pscustomobjectで包んで境界を越えさせない。
    $global:LASTEXITCODE = 0
    $rawPaths = @(& git -C $Root diff --cached --name-only)
    if ($LASTEXITCODE -ne 0) {
        return [pscustomobject]@{ Ok = $false; Paths = @() }
    }
    $paths = @($rawPaths | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
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
    $status = (& git -C $Root status --porcelain --untracked-files=no) -join "`n"
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
