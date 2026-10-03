# Started by the app with -File while it quits. This process belongs to the app's process job and ends with the app,
# so it only starts the cleanup (portableCleanup.ps1 beside this file) as a separate process without a window, which
# is not kept in that job, and exits at once. Windows PowerShell does nothing when it is started without a console
# (Node's detached start), so the app cannot start the cleanup directly. Nothing is encoded or inline: both are files.
$ErrorActionPreference = 'Stop'
$info = [Diagnostics.ProcessStartInfo]::new([IO.Path]::Combine($PSHOME, 'powershell.exe'))
# Windows paths cannot contain a double quote, so the quoted path stays one argument.
$info.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "' + [IO.Path]::Combine($PSScriptRoot, 'portableCleanup.ps1') + '"'
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
# A working directory cannot be removed while in use: keep the cleanup out of the stage and the user's folders.
$info.WorkingDirectory = [Environment]::SystemDirectory
$started = [Diagnostics.Process]::Start($info)
$started.Dispose()
exit 0
