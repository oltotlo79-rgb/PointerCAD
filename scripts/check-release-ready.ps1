# PointerCAD 公開前の整合検査の入口(rules/05-リリース.md §11.2、計画 P12-20・P13-15)。
# 組み立て済みの配布候補(dist/<名前>/)を scripts/release/releaseReadiness.mjs で判定し、人が読める一覧を出す。
# 1件でも外れたら0以外で終わる。pnpm・npm・npx・yarn は呼ばず node を直接起動する(統括が実行できるように)。
# scripts/check.ps1 の段には入れない(rules/03-品質ゲート.md §7.1)。候補の組み立て・公開・書き換えはしない。
#
# 公開前モード(既定)。5つの名前は dist/ 直下のフォルダー名(配布CI release.yml の combine と同じ並び):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-release-ready.ps1 `
#     -Windows desktop-stage-windows -Linux desktop-stage-linux -Web web-candidate -Release release-output -Sbom sbom-output
# 説明書モード(P12-20)。配布候補を組む前に、scripts/manual/generate.mjs が作った説明書 dist/<名前>/ だけを、
# 公開前モードと同じ説明書の5項目(①章と題名 ②操作名・ボタン名 ③機能の双方向の対応 ④今の版の画像、出力全体の一致)で判定する。
# 公開前モード(P13-15)はこの5項目を同じ判定処理で含むので、説明書の検査は二重に実装しない:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-release-ready.ps1 -Mode Manual -Manual manual-preview-20260927
# デスクトップ先行(-Scope Desktop。2026-09-27 の利用者の指示「最優先でデスクトップアプリのリリースをすること」):
# 公開前モードの全項目を同じ5つの候補で判定するが、Web 版の公開だけが要る項目(Web のファイルの大きさ・数)は[後回し]として
# 終了コードを止めない。README の Web アプリ版の行は「後日公開」を許し、説明書の導線は GitHub Release の PDF 全巻で満たす。
# -Scope を付けない(All)ときは今までどおり Web 版を含む全条件を要求する:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-release-ready.ps1 -Scope Desktop `
#     -Windows desktop-stage-windows -Linux desktop-stage-linux -Web web-candidate -Release release-output -Sbom sbom-output
# 公開後モードのデスクトップ部分(P13-20 の Desktop 側)。GitHub Release から配布物3種と説明書の PDF 全巻を取得して
# release-manifest.json と大きさ・hash を照合し、README の Desktop の導線が同じ実物に届くことを確かめる(通信する):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-release-ready.ps1 -Mode PostRelease -Scope Desktop `
#     -Release release-output -DownloadUrl https://github.com/<所有者>/<リポジトリ>/releases/download/v<版>/
# 公開後モードの全体(Web を含む。Web 版の公開時に実装する。今は「未実装」で終了コード3):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-release-ready.ps1 -Mode PostRelease `
#     -Release release-output -WebUrl https://<公開先>/ -DownloadUrl https://github.com/<所有者>/<リポジトリ>/releases/download/v<版>/
# -ReportPath <プロジェクトの根からの相対パス> を付けると、同じ結果を JSON でも保存する(既存のファイルと dist/ の中は不可)。
#
# 終了コード: 0 合格(-Scope Desktop では[後回し]を除く全項目) / 1 不合格 / 2 保留(未接続の条件がある) / 3 公開後モードの全体は未実装
#           / 64 引数の誤り / 70 内部の誤り

[CmdletBinding()]
param(
    [ValidateSet('PreRelease', 'PostRelease', 'Manual')]
    [string]$Mode = 'PreRelease',
    [ValidateSet('All', 'Desktop')]
    [string]$Scope = 'All',
    [string]$Windows = '',
    [string]$Linux = '',
    [string]$Web = '',
    [string]$Release = '',
    [string]$Sbom = '',
    [string]$WebUrl = '',
    [string]$DownloadUrl = '',
    [string]$Manual = '',
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
if ($Mode -eq 'PreRelease') { $nodeArguments.Add('pre-release') }
elseif ($Mode -eq 'Manual') { $nodeArguments.Add('manual') }
else { $nodeArguments.Add('post-release') }
# All は判定処理の既定なので渡さない(説明書モードに -Scope Desktop を付けた誤りは判定処理が 64 で止める)。
if ($Scope -eq 'Desktop') {
    $nodeArguments.Add('--scope')
    $nodeArguments.Add('desktop')
}
$pairs = @(
    @('--windows', $Windows), @('--linux', $Linux), @('--web', $Web), @('--release', $Release), @('--sbom', $Sbom),
    @('--web-url', $WebUrl), @('--download-url', $DownloadUrl), @('--manual', $Manual), @('--report', $ReportPath)
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
        0 {
            if ($Mode -eq 'Manual') { '合格: 説明書の整合4条件と出力全体の一致を満たしています。' }
            elseif ($Scope -eq 'Desktop' -and $Mode -eq 'PostRelease') { '合格: 公開した Release の配布物・説明書の PDF・README の Desktop の導線が公開一覧と一致しました(Web 版は[後回し])。' }
            elseif ($Scope -eq 'Desktop') { '合格: デスクトップ版の公開前の全項目を満たしています(Web 版の項目は[後回し]。Web 版の公開前は -Scope を付けずに再検査してください)。' }
            else { '合格: 公開前の全項目を満たしています。' }
        }
        1 {
            if ($Mode -eq 'Manual') { '不合格: 一覧の[不合格]の項目を直し、説明書を新しい名前で生成し直してから再検査してください。' }
            elseif ($Mode -eq 'PostRelease') { '不合格: 一覧の[不合格]の項目(取得できない・大きさや hash が違う配布物、README の導線)を確かめてください。' }
            else { '不合格: 一覧の[不合格]の項目を直し、候補を作り直してから再検査してください。' }
        }
        2 { '保留: 未接続の条件(一覧の[保留])があるため、公開できるとは判定できません。' }
        3 { '未実装: 公開後モードの全体(Web を含む)は Web 版の公開時に実装します。デスクトップ部分は -Scope Desktop で確かめられます。' }
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
