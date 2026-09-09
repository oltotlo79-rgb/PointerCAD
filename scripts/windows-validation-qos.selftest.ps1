# Behavioral check of real Windows process policies. No global settings change.
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    Write-Output '[SKIP] Windows process policy is not available on this platform.'
    exit 0
}
Add-Type -Path (Join-Path $PSScriptRoot 'lib\WindowsValidationQos.cs')
$scope = $null
$existing = $null
$created = $null
$exitCode = 1
function Assert-Policy([bool]$Condition, [string]$Label) {
    if (-not $Condition) { throw $Label }
    Write-Output "[OK] $Label"
}
try {
    $before = [PointerCad.WindowsValidationQos]::ReadPolicy($PID)
    $existing = Start-Process -FilePath powershell.exe -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 60')
    $existingBefore = [PointerCad.WindowsValidationQos]::ReadPolicy($existing.Id)
    $scope = New-Object PointerCad.WindowsValidationQos
    $active = [PointerCad.WindowsValidationQos]::ReadPolicy($PID)
    Assert-Policy (($active.ControlMask -band 1) -eq 1 -and ($active.StateMask -band 1) -eq 0) 'Current validation process uses HighQoS.'
    $created = Start-Process -FilePath powershell.exe -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 60')
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        Start-Sleep -Milliseconds 100
        $childPolicy = [PointerCad.WindowsValidationQos]::ReadPolicy($created.Id)
    } while (($childPolicy.ControlMask -band 1) -eq 0 -and [DateTime]::UtcNow -lt $deadline)
    Assert-Policy (($childPolicy.ControlMask -band 1) -eq 1 -and ($childPolicy.StateMask -band 1) -eq 0) 'New validation child uses HighQoS.'
    $existingDuring = [PointerCad.WindowsValidationQos]::ReadPolicy($existing.Id)
    Assert-Policy ($existingBefore.ControlMask -eq $existingDuring.ControlMask -and $existingBefore.StateMask -eq $existingDuring.StateMask) 'Existing child outside the validation scope is unchanged.'
    Assert-Policy ($scope.ObservedCount -ge 2) 'The actual child process was observed.'
    $scope.Dispose()
    $scope.Dispose()
    $after = [PointerCad.WindowsValidationQos]::ReadPolicy($PID)
    $childAfter = [PointerCad.WindowsValidationQos]::ReadPolicy($created.Id)
    Assert-Policy ($after.ControlMask -eq $before.ControlMask -and $after.StateMask -eq $before.StateMask) 'Parent policy is restored; repeated cleanup is safe.'
    Assert-Policy (($childAfter.ControlMask -band 1) -eq ($existingBefore.ControlMask -band 1) -and ($childAfter.StateMask -band 1) -eq ($existingBefore.StateMask -band 1)) 'A still-running owned child returns to its default execution policy.'
    $exitCode = 0
}
catch { Write-Error $_ -ErrorAction Continue }
finally {
    if ($null -ne $scope) { $scope.Dispose() }
    foreach ($child in @($created, $existing)) {
        if ($null -ne $child -and -not $child.HasExited) {
            Stop-Process -Id $child.Id -Force
            $child.WaitForExit()
        }
    }
}
exit $exitCode
