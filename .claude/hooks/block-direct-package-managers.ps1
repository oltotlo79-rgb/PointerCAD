# PointerCAD 規約フック: 統括による pnpm / npm / npx / yarn の直接実行を拒否する。
# 根拠: rules/01-役割と委譲.md §1、rules/02-禁止事項.md。
# 検査は scripts/check.ps1 を使い、それ以外は作業担当へ委譲する。
# フック自身が判定不能な場合は警告を出して通す(fail-open。rules/00-施行の仕組み.md)。
$ErrorActionPreference = 'Stop'
function Get-ElementText {
    param($Element)

    if ($Element -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
        return [string]$Element.Value
    }
    if ($Element -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
        return [string]$Element.Value
    }
    return [string]$Element.Extent.Text
}

function Get-LeafName {
    param([string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return ''
    }

    $clean = $Text.Trim()
    $trimChars = [char[]]@(
        0x22, 0x27, 0x60, 0x26, 0x28, 0x29,
        0x5B, 0x5D, 0x7B, 0x7D, 0x20, 0x09
    )
    $clean = $clean.Trim($trimChars)
    $clean = $clean.Replace('/', '\')
    return [System.IO.Path]::GetFileName($clean).ToLowerInvariant()
}

function Test-ProhibitedProgram {
    param([string]$Text)

    $leaf = Get-LeafName $Text
    return $leaf -match '^(?:pnpm|npm|npx|yarn)(?:\.(?:exe|cmd|bat|ps1|cjs|js))?$'
}

function Test-CommandText {
    param(
        [string]$CommandText,
        [int]$Depth = 0
    )

    if ([string]::IsNullOrWhiteSpace($CommandText)) {
        return $false
    }
    if ($Depth -gt 8) {
        throw 'nested shell command depth exceeded the policy limit'
    }

    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput(
        $CommandText,
        [ref]$tokens,
        [ref]$parseErrors
    )

    $commandAsts = @(
        $ast.FindAll(
            {
                param($node)
                $node -is [System.Management.Automation.Language.CommandAst]
            },
            $true
        )
    )

    foreach ($commandAst in $commandAsts) {
        $elements = @($commandAst.CommandElements)
        if ($elements.Count -eq 0) {
            continue
        }

        $name = [string]$commandAst.GetCommandName()
        if ([string]::IsNullOrWhiteSpace($name)) {
            $name = Get-ElementText $elements[0]
        }

        if (Test-ProhibitedProgram $name) {
            return $true
        }

        $leaf = Get-LeafName $name
        $args = @()
        if ($elements.Count -gt 1) {
            $args = @(
                $elements[1..($elements.Count - 1)] |
                    ForEach-Object { Get-ElementText $_ }
            )
        }

        if ($leaf -match '^cmd(?:\.exe)?$') {
            for ($i = 0; $i -lt $args.Count; $i++) {
                if ($args[$i] -match '^/[ck]$') {
                    if (
                        $i + 1 -lt $args.Count -and
                        (Test-CommandText (($args[($i + 1)..($args.Count - 1)]) -join ' ') ($Depth + 1))
                    ) {
                        return $true
                    }
                    break
                }

                if ($args[$i] -match '^/[ck](.+)$') {
                    $payload = @($Matches[1])
                    if ($i + 1 -lt $args.Count) {
                        $payload += $args[($i + 1)..($args.Count - 1)]
                    }
                    if (Test-CommandText ($payload -join ' ') ($Depth + 1)) {
                        return $true
                    }
                    break
                }
            }
        }
        elseif ($leaf -match '^(?:powershell|pwsh)(?:\.exe)?$') {
            for ($i = 0; $i -lt $args.Count; $i++) {
                $arg = $args[$i].ToLowerInvariant()

                if ($arg -match '^[-/](?:c|command|commandwithargs)$') {
                    if (
                        $i + 1 -lt $args.Count -and
                        (Test-CommandText (($args[($i + 1)..($args.Count - 1)]) -join ' ') ($Depth + 1))
                    ) {
                        return $true
                    }
                    break
                }

                if ($arg -match '^[-/](?:enc|encodedcommand)$') {
                    if ($i + 1 -lt $args.Count) {
                        $decoded = [Text.Encoding]::Unicode.GetString(
                            [Convert]::FromBase64String($args[$i + 1])
                        )
                        if (Test-CommandText $decoded ($Depth + 1)) {
                            return $true
                        }
                    }
                    break
                }
            }
        }
        elseif ($leaf -match '^(?:bash|sh|zsh|dash)(?:\.exe)?$') {
            for ($i = 0; $i -lt $args.Count; $i++) {
                if ($args[$i] -match '^-[A-Za-z]*c[A-Za-z]*$') {
                    if (
                        $i + 1 -lt $args.Count -and
                        (Test-CommandText (($args[($i + 1)..($args.Count - 1)]) -join ' ') ($Depth + 1))
                    ) {
                        return $true
                    }
                    break
                }
            }
        }
        elseif ($leaf -match '^(?:invoke-expression|iex)$') {
            if (
                $args.Count -gt 0 -and
                (Test-CommandText ($args -join ' ') ($Depth + 1))
            ) {
                return $true
            }
        }
        elseif ($leaf -match '^(?:start-process|start)$') {
            $candidate = $null
            for ($i = 0; $i -lt $args.Count; $i++) {
                if ($args[$i] -match '^-FilePath$') {
                    if ($i + 1 -lt $args.Count) {
                        $candidate = $args[$i + 1]
                    }
                    break
                }
                if ($args[$i] -match '^-FilePath:(.+)$') {
                    $candidate = $Matches[1]
                    break
                }
            }

            if ($null -eq $candidate) {
                foreach ($arg in $args) {
                    if ($arg -notmatch '^-') {
                        $candidate = $arg
                        break
                    }
                }
            }

            if (
                $null -ne $candidate -and
                (Test-ProhibitedProgram ([string]$candidate))
            ) {
                return $true
            }
        }
        elseif ($leaf -match '^(?:call|command|exec|env|nohup|sudo|winpty|corepack)$') {
            for ($i = 0; $i -lt $args.Count; $i++) {
                if ($args[$i] -eq '--') {
                    continue
                }
                if ($args[$i] -match '^[A-Za-z_][A-Za-z0-9_]*=') {
                    continue
                }
                if ($args[$i] -match '^-') {
                    continue
                }
                $nestedCommand = ($args[$i..($args.Count - 1)]) -join ' '
                if (Test-CommandText $nestedCommand ($Depth + 1)) {
                    return $true
                }
                break
            }
        }
    }

    return $false
}

try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $inputStream = [Console]::OpenStandardInput()
    $inputReader = New-Object System.IO.StreamReader(
        $inputStream,
        (New-Object System.Text.UTF8Encoding($false)),
        $true
    )
    try {
        $rawInput = $inputReader.ReadToEnd()
    }
    finally {
        $inputReader.Dispose()
    }

    $normalizedInput = [string]$rawInput
    while ($normalizedInput.Length -gt 0) {
        $normalizedInput = $normalizedInput.TrimStart()
        if (
            $normalizedInput.Length -eq 0 -or
            $normalizedInput[0] -ne [char]0xFEFF
        ) {
            break
        }
        $normalizedInput = $normalizedInput.Substring(1)
    }
    if ([string]::IsNullOrWhiteSpace($normalizedInput)) {
        exit 0
    }

    $hookInput = ConvertFrom-Json -InputObject $normalizedInput

    if ($hookInput.hook_event_name -ne 'PreToolUse') {
        exit 0
    }

    if (@('Bash', 'PowerShell') -notcontains [string]$hookInput.tool_name) {
        exit 0
    }

    $command = [string]$hookInput.tool_input.command
    if (-not (Test-CommandText $command)) {
        exit 0
    }

    $response = [ordered]@{
        hookSpecificOutput = [ordered]@{
            hookEventName = 'PreToolUse'
            permissionDecision = 'deny'
            permissionDecisionReason = (
                '規約(rules/01-役割と委譲.md §1、rules/02-禁止事項.md)により、' +
                '統括は pnpm / npm / npx / yarn を直接実行できません。' +
                '検査は scripts/check.ps1 を使い、それ以外は作業担当へ委譲して結果を報告させてください。'
            )
        }
    }

    [Console]::Out.WriteLine(
        ($response | ConvertTo-Json -Compress -Depth 4)
    )
    exit 0
}
catch {
    $errorId = [string]$_.FullyQualifiedErrorId
    $errorLine = [int]$_.InvocationInfo.ScriptLineNumber
    $errorStack = [string]$_.ScriptStackTrace
    $warningText = (
        "`nPOINTERCAD_HOOK_FAIL_OPEN:`n" +
        '警告: パッケージマネージャ規約フックが判定できなかったので、この実行は止めずに通しました。' +
        '規約(rules/02-禁止事項.md)に反する直接実行でないことを手動で確認してください。詳細: ' +
        ('errorId={0}; line={1}; message={2}; stack={3}' -f
            $errorId,
            $errorLine,
            $_.Exception.Message,
            $errorStack)
    )
    Write-Error -Message $warningText -ErrorAction Continue
    exit 0
}
