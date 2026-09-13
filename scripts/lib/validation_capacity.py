"""Observe local Windows compiler contention without modifying or reading other projects.

This is a scheduling aid, never a substitute for check.ps1 or a change to its pass criteria.
"""
import ctypes
from ctypes import wintypes
import json
import os

BUILDERS = {'rustc.exe', 'link.exe', 'cl.exe', 'cc1.exe', 'cc1plus.exe', 'ld.exe', 'lld.exe', 'lld-link.exe'}

class ProcessEntry(ctypes.Structure):
    _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD), ('th32ProcessID', wintypes.DWORD),
                ('th32DefaultHeapID', ctypes.c_size_t), ('th32ModuleID', wintypes.DWORD),
                ('cntThreads', wintypes.DWORD), ('th32ParentProcessID', wintypes.DWORD),
                ('pcPriClassBase', wintypes.LONG), ('dwFlags', wintypes.DWORD), ('szExeFile', wintypes.WCHAR * 260)]

def foreign_builders():
    if os.name != 'nt':
        raise RuntimeError('This local validation observer is for Windows.')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Process32FirstW.argtypes = kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    kernel.Process32FirstW.restype = kernel.Process32NextW.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        entry = ProcessEntry()
        entry.dwSize = ctypes.sizeof(entry)
        more = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
        if not more:
            raise ctypes.WinError(ctypes.get_last_error())
        result = []
        while more:
            if entry.szExeFile.casefold() in BUILDERS:
                result.append({'pid': entry.th32ProcessID, 'name': entry.szExeFile})
            more = kernel.Process32NextW(snapshot, ctypes.byref(entry))
        error = ctypes.get_last_error()
        if error != 18:  # ERROR_NO_MORE_FILES is the successful end of enumeration.
            raise ctypes.WinError(error)
        return sorted(result, key=lambda item: item['pid'])
    finally:
        if not kernel.CloseHandle(snapshot):
            raise ctypes.WinError(ctypes.get_last_error())

if __name__ == '__main__':
    print(json.dumps(foreign_builders()))
