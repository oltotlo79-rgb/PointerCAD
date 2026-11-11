# 準備の導入の命令(Playwright のブラウザ確認)が、通信の理由(名前解決・接続の失敗)で失敗した時だけ、
# 間隔を空けて最大3回までやり直す。通信以外の失敗はやり直さず、その場で失敗として返す。3回とも通信の
# 失敗なら、最後の終了コードのまま失敗として返す(呼出し側は今までどおり止まる)。
# 2026-11-11 の main の CI(run 43038990339、commit 888f67bf)で、Linux の画面検査の3組が同じ時刻に
# `Temporary failure resolving 'security.ubuntu.com'` で「(準備) Playwright のブラウザ確認」に落ちた
# (各組 1,800〜1,805 秒)ことへの対策。job の時間の上限と検査の内容は変えない。
# scripts/check.ps1 と scripts/check.selftest.ps1 が共有する単一正本。

# 通信の失敗とみなす出力の文(大文字・小文字は区別しない)。HTTP の 4xx・パッケージ名の誤り・実行ファイルの
# 欠落などは含めない(やり直しても直らない失敗を3回繰り返さない)。
$script:NetworkFailurePatterns = @(
    'Temporary failure resolving',
    'Could not resolve host',
    'getaddrinfo',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'socket hang up',
    'Connection timed out',
    'Network is unreachable',
    'server returned code 5[0-9][0-9]'
)
# 試行の回数の上限と、n 回目の失敗の後に待つ秒数(n=1 のあと 60 秒、n=2 のあと 120 秒)。
$script:NetworkRetryMaxAttempts = 3
$script:NetworkRetryWaitSeconds = @(60, 120)

# 出力の行に通信の失敗の文があれば、最初に一致した文(正規表現)を返す。無ければ $null。
function Find-NetworkFailure {
    param([AllowEmptyCollection()][string[]]$Lines = @())
    foreach ($line in @($Lines)) {
        foreach ($pattern in $script:NetworkFailurePatterns) {
            if ([string]$line -match $pattern) { return $pattern }
        }
    }
    return $null
}

# 外部の命令を実行し、標準出力と標準エラー出力をそのまま画面へ出しながら行として集める。
# 戻り値は ExitCode(外部の命令の終了コード)と Lines。命令が見つからない時は例外にする(偽の成功にしない)。
function Invoke-CapturedCommand {
    param(
        [Parameter(Mandatory)][string]$Command,
        [AllowEmptyCollection()][string[]]$CommandArgs = @()
    )
    # Windows PowerShell 5.1 は Stop のとき、2>&1 で受けた外部命令の標準エラー出力を例外にしてしまう。
    # 合否は終了コードで決めるので、この関数の中だけ Continue にする(Test-GateToolsChanged と同じ扱い)。
    $ErrorActionPreference = 'Continue'
    if ($null -eq (Get-Command -Name $Command -ErrorAction SilentlyContinue)) {
        throw "命令が見つかりません: $Command"
    }
    $lines = [Collections.Generic.List[string]]::new()
    $global:LASTEXITCODE = 0
    & $Command @CommandArgs 2>&1 | ForEach-Object {
        $text = if ($_ -is [Management.Automation.ErrorRecord]) { [string]$_.Exception.Message } else { [string]$_ }
        Write-Host $text
        $lines.Add($text)
    }
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) { $exitCode = 1 }
    return [pscustomobject]@{ ExitCode = [int]$exitCode; Lines = $lines.ToArray() }
}

# $Attempt(ExitCode と Lines を返す scriptblock)を、通信の失敗の時だけ間隔を空けて最大 $MaxAttempts 回まで
# 繰り返す。戻り値: ExitCode(成功なら 0、失敗なら最後の終了コード)・Attempts(試行の回数)・
# Retries(やり直しの回数)・NetworkFailure(通信の失敗で終わったか)・Matched(最後に一致した文)。
# $Sleep は待ち方(自己試験は待たずに秒数だけを記録する)。
function Invoke-WithNetworkRetry {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][scriptblock]$Attempt,
        [ValidateRange(1, 3)][int]$MaxAttempts = $script:NetworkRetryMaxAttempts,
        [int[]]$WaitSeconds = $script:NetworkRetryWaitSeconds,
        [scriptblock]$Sleep = { param([int]$Seconds) Start-Sleep -Seconds $Seconds }
    )
    $retries = 0
    $matched = $null
    $result = $null
    for ($number = 1; $number -le $MaxAttempts; $number++) {
        Write-Host ("[試行] {0} {1}/{2} 回目" -f $Name, $number, $MaxAttempts)
        $result = & $Attempt
        $exitCode = [int]$result.ExitCode
        if ($exitCode -eq 0) {
            Write-Host ("[成功] {0} は {1}/{2} 回目で成功しました(やり直し {3} 回)" -f $Name, $number, $MaxAttempts, $retries)
            return [pscustomobject]@{ ExitCode = 0; Attempts = $number; Retries = $retries; NetworkFailure = $false; Matched = $matched }
        }
        $matched = Find-NetworkFailure -Lines @($result.Lines)
        if ($null -eq $matched) {
            Write-Host ("[やり直さない] {0} は通信以外の理由で失敗しました({1}/{2} 回目、終了コード {3}、やり直し {4} 回)" -f `
                $Name, $number, $MaxAttempts, $exitCode, $retries) -ForegroundColor Yellow
            return [pscustomobject]@{ ExitCode = $exitCode; Attempts = $number; Retries = $retries; NetworkFailure = $false; Matched = $null }
        }
        if ($number -lt $MaxAttempts) {
            $wait = $WaitSeconds[[Math]::Min($number - 1, $WaitSeconds.Count - 1)]
            Write-Host ("[やり直し] {0} は通信の失敗(一致: {1})で失敗しました({2}/{3} 回目、終了コード {4})。{5} 秒後に {6}/{3} 回目を行います" -f `
                $Name, $matched, $number, $MaxAttempts, $exitCode, $wait, ($number + 1)) -ForegroundColor Yellow
            & $Sleep $wait
            $retries++
        }
    }
    Write-Host ("[やり直し上限] {0} は {1} 回とも通信の失敗でした(最後の一致: {2}、終了コード {3}、やり直し {4} 回)" -f `
        $Name, $MaxAttempts, $matched, [int]$result.ExitCode, $retries) -ForegroundColor Red
    return [pscustomobject]@{ ExitCode = [int]$result.ExitCode; Attempts = $MaxAttempts; Retries = $retries; NetworkFailure = $true; Matched = $matched }
}
