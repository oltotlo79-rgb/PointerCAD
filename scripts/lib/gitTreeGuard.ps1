# 検査前後で「コミット対象のファイルが書き換わっていないか」を確かめるための関数群。
# rules/03-品質ゲート.md §7.1 #0 と rules/00-施行の仕組み.md の該当行が参照する単一正本。
# `scripts/check.ps1` と `scripts/check.selftest.ps1` の両方がこのファイルを dot-source する。
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
