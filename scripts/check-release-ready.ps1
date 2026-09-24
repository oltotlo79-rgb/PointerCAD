# PointerCAD 公開前の整合検査の入口(rules/05-リリース.md §11.2、計画 P12-20・P13-15)。
# 組み立て済みの配布候補(dist/<名前>/)を scripts/release/releaseReadiness.mjs で判定し、人が読める一覧を出す。
# 1件でも外れたら0以外で終わる。pnpm・npm・npx・yarn は呼ばず node を直接起動する(統括が実行できるように)。
# scripts/check.ps1 の段には入れない(rules/03-品質ゲート.md §7.1)。候補の組み立て・公開・書き換えはしない。
#
# 公開前モード(既定)。5つの名前は dist/ 直下のフォルダー名(配布CI release.yml の combine と同じ並び):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-release-ready.ps1 `
#     -Windows desktop-stage-windows -Linux desktop-stage-linux -Web web-candidate -Release release-output -Sbom sbom-output
# 公開後モード(P13-20 で実装する。今は「未実装」で終了コード3):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-release-ready.ps1 -Mode PostRelease `
#     -Release release-output -WebUrl https://<公開先>/ -DownloadUrl https://github.com/<所有者>/<リポジトリ>/releases/download/v<版>/
# -ReportPath <プロジェクトの根からの相対パス> を付けると、同じ結果を JSON でも保存する(既存のファイルと dist/ の中は不可)。
#
# 終了コード: 0 合格 / 1 不合格 / 2 保留(未接続の条件がある) / 3 公開後モードは未実装 / 64 引数の誤り / 70 内部の誤り

[CmdletBinding()]
param(
    [ValidateSet('PreRelease', 'PostRelease')]
    [string]$Mode = 'PreRelease',
    [string]$Windows = '',
    [string]$Linux = '',
    [string]$Web = '',
    [string]$Release = '',
    [string]$Sbom = '',
    [string]$WebUrl = '',
    [string]$DownloadUrl = '',
    [string]$ReportPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$entry = Join-Path $repositoryRoot 'scripts/release/releaseReadiness.mjs'
$node = Get-Command -Name node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $node) {
    Write-Host 'check-release-ready: node が見つかりません。Node.js を PATH に入れてから実行してください。(終了コード 64)'
    exit 64
}

# 組み合わせの検査は判定処理の1か所(parseReleaseReadinessArguments)に任せ、ここでは空でない引数だけを渡す。
$nodeArguments = New-Object System.Collections.Generic.List[string]
$nodeArguments.Add($entry)
$nodeArguments.Add('--mode')
if ($Mode -eq 'PreRelease') { $nodeArguments.Add('pre-release') } else { $nodeArguments.Add('post-release') }
$pairs = @(
    @('--windows', $Windows), @('--linux', $Linux), @('--web', $Web), @('--release', $Release), @('--sbom', $Sbom),
    @('--web-url', $WebUrl), @('--download-url', $DownloadUrl), @('--report', $ReportPath)
)
foreach ($pair in $pairs) {
    if ($pair[1] -ne '') {
        $nodeArguments.Add($pair[0])
        $nodeArguments.Add($pair[1])
    }
}

# node は UTF-8 で書く。出力を受け取る側(リダイレクト・別プロセス)でも日本語が崩れないよう、実行中だけ UTF-8 にする。
$previousEncoding = $null
try {
    $previousEncoding = [Console]::OutputEncoding
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false
} catch {
    $previousEncoding = $null
}
$exitCode = 70
try {
    # Windows PowerShell 5.1 は外部コマンドの標準エラー出力を誤りとして扱うことがあるため、起動の間だけ止めずに続ける。
    $ErrorActionPreference = 'Continue'
    & $node.Path $nodeArguments.ToArray()
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    $meaning = switch ($exitCode) {
        0 { '合格: 公開前の全項目を満たしています。' }
        1 { '不合格: 一覧の[不合格]の項目を直し、候補を作り直してから再検査してください。' }
        2 { '保留: 未接続の条件(一覧の[保留])があるため、公開できるとは判定できません。' }
        3 { '未実装: 公開後モードは P13-20 で実装します。' }
        64 { '引数の誤り: 上の使い方を確認してください。' }
        default { '内部の誤り: 上の出力を確認してください。' }
    }
    Write-Host "check-release-ready: $meaning (終了コード $exitCode)"
} finally {
    if ($null -ne $previousEncoding) {
        try { [Console]::OutputEncoding = $previousEncoding } catch { $previousEncoding = $null }
    }
}
exit $exitCode
