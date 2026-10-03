# Runs after non-cancellable quit. $cleanup is JSON data, never shell syntax.
# The app copies this file, its starter (portableCleanupStart.ps1) and the plan into a folder made for this launch
# outside the extraction; the starter runs this copy with "powershell.exe -File <copy>". No code or data travels on a
# command line (portableCleanup.ts).
$ErrorActionPreference = 'Stop'

function Read-CleanupPlan {
  $text = [IO.File]::ReadAllText([IO.Path]::Combine($PSScriptRoot, 'plan.json'), [Text.Encoding]::UTF8)
  return ($text | ConvertFrom-Json)
}

function Remove-CleanupStage {
  # Delete only the three files the app wrote into the stage folder, then the folder itself without recursion.
  $stage = [IO.DirectoryInfo]::new($PSScriptRoot)
  if (($stage.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Portable cleanup stage was replaced.' }
  foreach ($name in @('plan.json', 'start.ps1', 'portableCleanup.ps1')) { [IO.File]::Delete([IO.Path]::Combine($stage.FullName, $name)) }
  $stage.Delete($false)
}

function Initialize-CleanupNative {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// Open ONE component relative to a validated handle: no intermediate path is resolved again.
public sealed class PointerCadPortableCleanup : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct UnicodeString {
        public ushort Length, MaximumLength;
        public IntPtr Buffer;
    }
    [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes {
        public int Length;
        public IntPtr RootDirectory, ObjectName;
        public uint Attributes;
        public IntPtr SecurityDescriptor, SecurityQualityOfService;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoStatus {
        public IntPtr Status, Information;
    }
    [StructLayout(LayoutKind.Sequential)] struct FileInfo {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share,
        IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("ntdll.dll")]
    static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref ObjectAttributes attributes,
        out IoStatus status, IntPtr allocation, uint fileAttributes, uint share, uint disposition,
        uint options, IntPtr ea, uint eaLength);
    [DllImport("ntdll.dll")]
    static extern uint RtlNtStatusToDosError(int status);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref byte info, uint size);

    readonly List<SafeFileHandle> held = new List<SafeFileHandle>();
    readonly List<SafeFileHandle> files = new List<SafeFileHandle>();
    SafeFileHandle directory, app;
    public bool Absent { get; private set; }
    const uint ReadAttributes = 0x80, Delete = 0x10000;

    static FileInfo Inspect(SafeFileHandle handle, bool isDirectory) {
        FileInfo info;
        if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if ((info.Attributes & 0x400) != 0) throw new InvalidOperationException("Portable cleanup refuses a reparse point.");
        if (((info.Attributes & 0x10) != 0) != isDirectory)
            throw new InvalidOperationException("Portable cleanup object type differs.");
        if (!isDirectory && info.Links != 1) throw new InvalidOperationException("Portable cleanup refuses hard links.");
        return info;
    }
    static void Identity(FileInfo info, string expected) {
        ulong index = ((ulong)info.IndexHigh << 32) | info.IndexLow;
        if (index == 0 || info.Volume.ToString() + ":" + index.ToString() != expected)
            throw new InvalidOperationException("Portable extraction identity was replaced.");
    }
    SafeFileHandle Child(SafeFileHandle parent, string name, bool isDirectory, bool delete, string expected) {
        if (name.Length == 0 || name == "." || name == ".." || name.IndexOfAny(new [] { Path.DirectorySeparatorChar, '/', ':' }) >= 0)
            throw new InvalidOperationException("Portable cleanup requires a single path component.");
        IntPtr buffer = Marshal.StringToHGlobalUni(name), namePointer = IntPtr.Zero;
        SafeFileHandle handle = null;
        try {
            var unicode = new UnicodeString { Length = checked((ushort)(name.Length * 2)),
                MaximumLength = checked((ushort)(name.Length * 2)), Buffer = buffer };
            namePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
            Marshal.StructureToPtr(unicode, namePointer, false);
            var attributes = new ObjectAttributes { Length = Marshal.SizeOf(typeof(ObjectAttributes)),
                RootDirectory = parent.DangerousGetHandle(), ObjectName = namePointer, Attributes = 0x40 };
            IoStatus io;
            // FILE_OPEN_REPARSE_POINT. Deny write/delete sharing through inspection and deletion.
            int status = NtCreateFile(out handle, ReadAttributes | (delete ? Delete : 0), ref attributes,
                out io, IntPtr.Zero, 0, 1, 1, 0x00200000, IntPtr.Zero, 0);
            if (status < 0) {
                int error = (int)RtlNtStatusToDosError(status);
                if (handle != null) handle.Dispose();
                if (error == 2 || error == 3) return null;
                throw new Win32Exception(error);
            }
            held.Add(handle);
            FileInfo info = Inspect(handle, isDirectory);
            if (expected != null) Identity(info, expected);
            return handle;
        } finally {
            if (namePointer != IntPtr.Zero) Marshal.FreeHGlobal(namePointer);
            Marshal.FreeHGlobal(buffer);
        }
    }
    public static PointerCadPortableCleanup Open(string path, long createdAt, string[] identities) {
        var lease = new PointerCadPortableCleanup();
        try {
            if (identities.Length != 5) throw new InvalidOperationException("Portable identities are missing.");
            string full = Path.GetFullPath(path), root = Path.GetPathRoot(full);
            if (root.Length != 3 || root[1] != ':' || !Char.IsLetter(root[0]))
                throw new InvalidOperationException("Portable cleanup requires a local drive.");
            var parent = CreateFileW(root, ReadAttributes, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            if (parent.IsInvalid) { int error = Marshal.GetLastWin32Error(); parent.Dispose(); throw new Win32Exception(error); }
            lease.held.Add(parent);
            Inspect(parent, true);
            string[] parts = full.Substring(root.Length).Split(new [] { Path.DirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries);
            for (int i = 0; i < parts.Length; ++i) {
                bool last = i == parts.Length - 1;
                parent = lease.Child(parent, parts[i], true, last, last ? identities[0] : null);
                if (parent == null) { lease.Absent = true; return lease; }
            }
            if (parts.Length == 0) throw new InvalidOperationException("Portable extraction root is missing.");
            lease.directory = parent;
            FileInfo directoryInfo = Inspect(parent, true);
            long creation = ((long)(uint)directoryInfo.Creation.dwHighDateTime << 32) | (uint)directoryInfo.Creation.dwLowDateTime;
            if (new DateTimeOffset(DateTime.FromFileTimeUtc(creation)).ToUnixTimeMilliseconds() != createdAt)
                throw new InvalidOperationException("Portable extraction directory was replaced.");
            lease.app = lease.Child(parent, "app", true, true, identities[1]);
            if (lease.app != null) lease.files.Add(lease.Child(lease.app, "PointerCAD.exe", false, true, identities[2]));
            lease.files.Add(lease.Child(parent, "StdUtils.dll", false, true, identities[3]));
            lease.files.Add(lease.Child(parent, "System.dll", false, true, identities[4]));
            return lease;
        } catch { lease.Dispose(); throw; }
    }
    static void RemoveHandle(SafeFileHandle handle, string residue) {
        if (handle == null) return;
        byte disposition = 1;
        // FileDispositionInfo deletes the inspected object, never a pathname.
        if (!SetFileInformationByHandle(handle, 4, ref disposition, 1)) {
            int error = Marshal.GetLastWin32Error();
            if (error == 145) throw new InvalidOperationException(residue);
            throw new Win32Exception(error);
        }
        handle.Dispose();
    }
    public void Remove() {
        if (Absent) return;
        foreach (var file in files) RemoveHandle(file, "Unexpected portable file residue.");
        RemoveHandle(app, "Unexpected portable application residue.");
        RemoveHandle(directory, "Unexpected portable plugin residue.");
    }
    public void Dispose() {
        for (int i = held.Count - 1; i >= 0; --i) held[i].Dispose();
        held.Clear();
    }
}
'@
}

function Wait-OwnedProcess([int] $processId, [string] $executable) {
  try { $observed = [Diagnostics.Process]::GetProcessById($processId) }
  catch [ArgumentException] { return }
  try {
    # Acquire a handle before inspecting identity, so PID reuse cannot change the wait target.
    $null = $observed.Handle
    if ($observed.HasExited) { return }
    if ($observed.MainModule.FileName -ine $executable) { throw 'Portable process identity differs.' }
    if ([DateTimeOffset]::new($observed.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds() -gt $cleanup.requestedAt) {
      throw 'Portable process identifier was reused.'
    }
    $remaining = [Math]::Max(0, 30000 - [int]$timer.ElapsedMilliseconds)
    if (-not $observed.WaitForExit($remaining)) { throw [TimeoutException]::new('Portable process did not exit.') }
  }
  catch [InvalidOperationException] {
    if (-not $observed.HasExited) { throw }
  }
  catch [ComponentModel.Win32Exception] {
    if (-not $observed.HasExited) { throw }
  }
  finally { $observed.Dispose() }
}

function Write-CleanupResult([string] $result, [string] $lastError, [int] $errorCode) {
  if ($null -eq $cleanup) { throw 'Portable cleanup plan is unavailable.' }
  # elapsedMs is the 30-second deadline clock; preparationMs is the plan read and Add-Type compile before it.
  $entry = [ordered]@{
    at = [DateTimeOffset]::UtcNow.ToString('o'); processId = $cleanup.processId
    result = $result; elapsedMs = $timer.ElapsedMilliseconds; preparationMs = $preparation.ElapsedMilliseconds
    attempts = $attempts; lastError = $lastError.Substring(0, [Math]::Min(512, $lastError.Length)); errorCode = $errorCode
    stageRemoved = $stageRemoved; stageError = $stageError.Substring(0, [Math]::Min(256, $stageError.Length))
  } | ConvertTo-Json -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($entry + [Environment]::NewLine)
  $log = [IO.Path]::Combine($cleanup.logDirectory, 'portable-cleanup.log')
  # Serialize writers using the actual file. Bound both size and contention waiting.
  for ($i = 0; $i -lt 10; $i++) {
    $stream = $null
    try {
      $stream = [IO.File]::Open($log, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
      if ($stream.Length + $bytes.Length -gt 65536) { $stream.SetLength(0) }
      $null = $stream.Seek(0, [IO.SeekOrigin]::End)
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush()
      return
    }
    catch [IO.IOException] { if ($i -eq 9) { throw }; Start-Sleep -Milliseconds 25 }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
  }
}

# Preparation (reading the plan, compiling the native helper with Add-Type) has its own clock. Under heavy load the
# compile alone took over 30 s (2026-10-01) and used up the deadline before the first attempt, so the 30-second
# deadline for waiting and retrying starts only after preparation.
$preparation = [Diagnostics.Stopwatch]::StartNew()
$timer = [Diagnostics.Stopwatch]::new()
$cleanup = $null
$result = 'failed'
$lastError = ''
$errorCode = 0
$attempts = 0
$exitCode = 1
$stageRemoved = $false
$stageError = ''
try {
  $cleanup = Read-CleanupPlan
  Initialize-CleanupNative
  $preparation.Stop()
  $timer.Start()
  Wait-OwnedProcess $cleanup.processId $cleanup.executable
  Wait-OwnedProcess $cleanup.launcherId $cleanup.launcher
  while ($timer.ElapsedMilliseconds -lt 30000) {
    $lease = $null
    $attempts++
    try {
      $lease = [PointerCadPortableCleanup]::Open($cleanup.directory, $cleanup.createdAt, [string[]]$cleanup.identities)
      $lease.Remove()
      $result = 'completed'
      $exitCode = 0
      break
    }
    catch {
      $cause = $_.Exception.GetBaseException()
      $lastError = $cause.Message
      if ($cause -isnot [ComponentModel.Win32Exception]) { throw }
      $errorCode = $cause.NativeErrorCode
      if ($errorCode -notin @(5, 32, 33)) { throw }
    }
    finally { if ($null -ne $lease) { $lease.Dispose() } }
    $remaining = 30000 - [int]$timer.ElapsedMilliseconds
    if ($remaining -gt 0) { Start-Sleep -Milliseconds ([Math]::Min(200, $remaining)) }
  }
  if ($exitCode -ne 0) { $result = 'deadline'; if (-not $lastError) { $lastError = 'Portable cleanup deadline expired.' } }
}
catch {
  $cause = $_.Exception.GetBaseException()
  $lastError = $cause.Message
  if ($cause -is [TimeoutException]) { $result = 'deadline' }
  if ($cause -is [ComponentModel.Win32Exception]) { $errorCode = $cause.NativeErrorCode }
}
finally {
  $preparation.Stop()
  try { Remove-CleanupStage; $stageRemoved = $true }
  catch { $stageError = $_.Exception.GetBaseException().Message }
  try { Write-CleanupResult $result $lastError $errorCode }
  catch { [Console]::Error.WriteLine('Portable cleanup log failed: ' + $_.Exception.Message); $exitCode = 1 }
  if ($exitCode -ne 0) { [Console]::Error.WriteLine($lastError) }
}
exit $exitCode
