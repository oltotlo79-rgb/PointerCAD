# The same directory-link operations are used by the gate and its self-test.
# Windows PowerShell 5.1 can create junctions without elevation; Unix needs symlinks.
function New-PortableDirectoryLink {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Target)
    $fullTarget = [IO.Path]::GetFullPath($Target)
    if (-not (Test-Path -LiteralPath $fullTarget -PathType Container)) {
        throw "Directory link target does not exist: $fullTarget"
    }
    $linkType = if ([IO.Path]::DirectorySeparatorChar -eq '\') { 'Junction' } else { 'SymbolicLink' }
    $item = New-Item -ItemType $linkType -Path $Path -Target $fullTarget -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -or
        -not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "Directory link was not created: $Path"
    }
}

function Get-DirectoryLinkTarget {
    param([Parameter(Mandatory)]$Item)
    $rawTarget = $Item.Target
    $target = if ($rawTarget -is [array]) { $rawTarget[0] } else { $rawTarget }
    if ([string]::IsNullOrWhiteSpace($target)) { throw "Directory link has no target: $($Item.FullName)" }
    if (-not [IO.Path]::IsPathRooted($target)) {
        $target = Join-Path (Split-Path -Parent $Item.FullName) $target
    }
    return [IO.Path]::GetFullPath($target)
}
