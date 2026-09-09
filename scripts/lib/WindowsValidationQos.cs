// Keep Windows' automatic background power policy out of strict timing checks.
// API contract: learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-setprocessinformation
// Changes only EXECUTION_SPEED for this process and descendants created in this scope.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace PointerCad
{
    public sealed class WindowsValidationQos : IDisposable
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct Policy { public uint Version, ControlMask, StateMask; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct Entry
        {
            public uint Size, Usage, Id;
            public UIntPtr Heap;
            public uint Module, Threads, Parent;
            public int Priority;
            public uint Flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
        }
        private sealed class Owned
        {
            public IntPtr Handle;
            public Policy Original;
        }
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessInformation(IntPtr handle, int kind, ref Policy policy, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetProcessInformation(IntPtr handle, int kind, ref Policy policy, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint id);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);

        private readonly Dictionary<uint, Owned> owned = new Dictionary<uint, Owned>();
        private readonly ManualResetEvent stopping = new ManualResetEvent(false);
        private readonly Thread watcher;
        private readonly uint rootId = (uint)Process.GetCurrentProcess().Id;
        private readonly long started = DateTime.UtcNow.ToFileTimeUtc();
        private string failure;
        private bool disposed;
        private int observedCount;
        public int ObservedCount { get { return observedCount; } }

        private static bool Alive(IntPtr handle)
        {
            uint code;
            return GetExitCodeProcess(handle, out code) && code == 259;
        }
        private static Policy Read(IntPtr handle)
        {
            Policy policy = new Policy { Version = 1 };
            if (!GetProcessInformation(handle, 4, ref policy, 12)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return policy;
        }
        // Read-only probe used by the behavioral self-test.
        public static Policy ReadPolicy(int processId)
        {
            IntPtr handle = OpenProcess(0x1000, false, (uint)processId);
            if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try { return Read(handle); } finally { CloseHandle(handle); }
        }
        public WindowsValidationQos()
        {
            Remember(rootId, true);
            watcher = new Thread(Watch);
            watcher.IsBackground = true;
            watcher.Start();
        }
        private bool Remember(uint id, bool isRoot)
        {
            IntPtr handle = OpenProcess(0x1200, false, id);
            if (handle == IntPtr.Zero)
            {
                if (isRoot) throw new Win32Exception(Marshal.GetLastWin32Error());
                return false; // A short-lived child can exit before its handle is opened.
            }
            bool retained = false;
            try
            {
                long created, exited, kernel, user;
                if (!GetProcessTimes(handle, out created, out exited, out kernel, out user))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if (!isRoot && created < started) return false;
                Policy original = Read(handle);
                Policy high = original;
                high.ControlMask |= 1;
                high.StateMask &= ~1u;
                if (!SetProcessInformation(handle, 4, ref high, 12))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                owned.Add(id, new Owned { Handle = handle, Original = original });
                retained = true;
                Interlocked.Increment(ref observedCount);
                return true;
            }
            catch (Win32Exception)
            {
                if (isRoot || Alive(handle)) throw;
                return false;
            }
            finally { if (!retained) CloseHandle(handle); }
        }
        private void Sweep()
        {
            var alive = new HashSet<uint>();
            var exited = new List<uint>();
            foreach (var pair in owned)
            {
                if (Alive(pair.Value.Handle)) alive.Add(pair.Key);
                else exited.Add(pair.Key);
            }
            foreach (uint id in exited) { CloseHandle(owned[id].Handle); owned.Remove(id); }
            IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
            if (snapshot == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                var rows = new List<Entry>();
                Entry entry = new Entry { Size = (uint)Marshal.SizeOf(typeof(Entry)) };
                bool next = Process32FirstW(snapshot, ref entry);
                while (next) { rows.Add(entry); next = Process32NextW(snapshot, ref entry); }
                bool added;
                do
                {
                    added = false;
                    foreach (Entry row in rows)
                        if (alive.Contains(row.Parent) && !owned.ContainsKey(row.Id) && Remember(row.Id, false))
                        { alive.Add(row.Id); added = true; }
                } while (added);
            }
            finally { CloseHandle(snapshot); }
        }
        private void Watch()
        {
            try { while (!stopping.WaitOne(200)) Sweep(); }
            catch (Exception error) { failure = error.Message; }
        }
        public void Dispose()
        {
            if (disposed) return;
            stopping.Set();
            watcher.Join();
            disposed = true;
            foreach (Owned process in owned.Values)
            {
                try
                {
                    if (!Alive(process.Handle)) continue;
                    Policy current = Read(process.Handle);
                    // Preserve independent timer-resolution flags changed by the child.
                    current.ControlMask = (current.ControlMask & ~1u) | (process.Original.ControlMask & 1u);
                    current.StateMask = (current.StateMask & ~1u) | (process.Original.StateMask & 1u);
                    if (!SetProcessInformation(process.Handle, 4, ref current, 12) && Alive(process.Handle))
                        failure = "Could not restore validation process power policy: " + Marshal.GetLastWin32Error();
                }
                catch (Win32Exception error) { if (Alive(process.Handle)) failure = error.Message; }
                finally { CloseHandle(process.Handle); }
            }
            owned.Clear();
            stopping.Dispose();
            if (failure != null) throw new InvalidOperationException(failure);
        }
    }
}
