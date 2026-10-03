import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PORTABLE_CLEANUP_STAGE, PORTABLE_CLEANUP_START_TIMEOUT_MS, planPortableCleanup, portableCleanupArguments,
  registerPortableCleanup, stagePortableCleanup } from './portableCleanup.js';
import type { PortableCleanupContext } from './portableCleanup.js';
import cleanupScript from './portableCleanup.ps1?raw';
import startScript from './portableCleanupStart.ps1?raw';

const native = vi.hoisted(() => ({
  lstat: vi.fn(), realpath: vi.fn(), spawn: vi.fn(), mkdir: vi.fn(), write: vi.fn(), rename: vi.fn(), unlink: vi.fn(),
  mkdtemp: vi.fn(), rm: vi.fn(), rmdir: vi.fn(),
}));
vi.mock('node:fs', () => ({ lstatSync: native.lstat, realpathSync: { native: native.realpath },
  mkdirSync: native.mkdir, writeFileSync: native.write, renameSync: native.rename, unlinkSync: native.unlink,
  mkdtempSync: native.mkdtemp, rmSync: native.rm, rmdirSync: native.rmdir }));

const STAGE = 'C:\\Temp\\pointercad-cleanup-abc123';
const STAGED_CLEANUP = `${STAGE}\\portableCleanup.ps1`;
const STAGED_START = `${STAGE}\\start.ps1`;

const context: PortableCleanupContext = {
  platform: 'win32', isPackaged: true, executable: 'C:/Temp/nsiAD.tmp/app/PointerCAD.exe',
  temporary: 'C:/Temp', launcher: 'D:/配布 [1]/PointerCAD-portable.exe', launcherDirectory: 'D:/配布 [1]',
  appFilename: 'pointercad', systemRoot: 'C:/Windows', processId: 101, launcherId: 100,
  userData: 'C:/Users/test/PointerCAD',
};

beforeEach(() => {
  vi.clearAllMocks();
  native.lstat.mockImplementation((path: string) => ({
    isSymbolicLink: () => false, isDirectory: () => !path.endsWith('.exe'), isFile: () => path.endsWith('.exe'),
    birthtimeMs: 1000.75, dev: 12n, ino: 34n,
  }));
  native.realpath.mockImplementation((path: string) => path);
  native.mkdtemp.mockReturnValue(STAGE);
  native.spawn.mockReturnValue({ status: 0, signal: null, error: undefined });
  vi.spyOn(process.getBuiltinModule('child_process'), 'spawnSync').mockImplementation(native.spawn);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('ポータブル終了後の片付け対象', () => {
  it('実行中の本体から当該起動の展開先だけを特定する', () => {
    const plan = planPortableCleanup(context);
    expect(plan?.directory).toBe('C:/Temp/nsiAD.tmp');
    expect(plan?.createdAt).toBe(1000);
    expect(plan?.powershell).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(plan?.launcherId).toBe(100);
    expect(plan?.identities).toEqual(Array<string>(5).fill('12:34'));
    expect(plan?.logDirectory).toBe(context.userData);
  });

  it.each<Partial<PortableCleanupContext>>([
    { platform: 'linux' }, { isPackaged: false }, { launcher: undefined }, { launcherDirectory: undefined },
    { appFilename: 'different' }, { systemRoot: undefined }, { executable: 'C:/Programs/PointerCAD.exe' },
    { executable: 'C:/Temp/other/app/PointerCAD.exe' }, { executable: 'C:/Temp/nsiAD.tmp/PointerCAD.exe' },
    { executable: 'C:/Temp/nsiAD.tmp/app/Other.exe' }, { temporary: 'C:/Other' },
    { launcher: 'C:/Temp/nsiAD.tmp/app/PointerCAD.exe', launcherDirectory: 'C:/Temp/nsiAD.tmp/app' },
    { launcherDirectory: 'D:/Different' }, { launcher: 'D:/配布 [1]/document.pcad' },
    { temporary: '../Temp' }, { systemRoot: '//server/windows' }, { processId: 0 }, { launcherId: 101 },
    { processId: 1.5 }, { launcherId: -1 }, { processId: Number.MAX_SAFE_INTEGER },
    { userData: 'C:/Temp/nsiAD.tmp/userData' }, { userData: '../profile' },
  ])('通常導入・別の展開先・不正な入力は使わない: %j', (change) => {
    expect(planPortableCleanup({ ...context, ...change })).toBeNull();
  });

  it('リンク・参照先の違い・読めない展開先を拒否する', () => {
    native.realpath.mockReturnValue('C:/Other');
    expect(planPortableCleanup(context)).toBeNull();
    native.realpath.mockImplementation((path: string) => path);
    native.lstat.mockReturnValue({ isSymbolicLink: () => true });
    expect(planPortableCleanup(context)).toBeNull();
    native.lstat.mockImplementation(() => { throw new Error('denied'); });
    expect(planPortableCleanup(context)).toBeNull();
  });

  it('NSIS が3文字目を乱数で選んだ展開先(nsy3217.tmp 等)も当該起動の展開先として特定する', () => {
    for (const name of ['nsy3217.tmp', 'nsa0.tmp', 'nszffff.tmp']) {
      const plan = planPortableCleanup({ ...context, executable: `C:/Temp/${name}/app/PointerCAD.exe` });
      expect(plan?.directory, name).toBe(`C:/Temp/${name}`);
    }
    expect(planPortableCleanup({ ...context, executable: 'C:/Temp/nsz.tmp/app/PointerCAD.exe' })).toBeNull();
  });

  it('空白・日本語・引用符・シェル文字を実行命令へ展開せず、台本と計画は展開先の外の一時の場所へ写す', () => {
    const plan = planPortableCleanup({ ...context, launcher: "D:/O'Brien $x ` [1]/portable.exe", launcherDirectory: "D:/O'Brien $x ` [1]" });
    if (plan === null) throw new Error('plan missing');
    expect(stagePortableCleanup(plan)).toEqual({ directory: STAGE, start: STAGED_START, cleanup: STAGED_CLEANUP });
    // A new folder in the same temporary folder as the extraction: beside it, never inside it.
    expect(native.mkdtemp).toHaveBeenCalledWith('C:\\Temp\\pointercad-cleanup-');
    expect(native.write.mock.calls.map((call: readonly unknown[]) => call[0]))
      .toEqual([`${STAGE}\\${PORTABLE_CLEANUP_STAGE.plan}`, STAGED_CLEANUP, STAGED_START]);
    for (const call of native.write.mock.calls) expect(call[2]).toEqual({ encoding: 'utf8', flag: 'wx' });
    const data: unknown = JSON.parse(String(native.write.mock.calls[0]?.[1]));
    expect(data).toMatchObject({ launcher: plan.launcher, directory: plan.directory, identities: plan.identities });
    expect(data).toHaveProperty('requestedAt', expect.any(Number));
    // The shipped scripts with a UTF-8 byte order mark (Windows PowerShell 5.1 reads unmarked files as ANSI).
    expect(native.write.mock.calls[1]?.[1]).toBe(String.fromCharCode(0xfeff) + cleanupScript);
    expect(native.write.mock.calls[2]?.[1]).toBe(String.fromCharCode(0xfeff) + startScript);
    // The starter runs the staged cleanup beside itself with the same fixed switches.
    expect(startScript).toContain("'-NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File \"' + [IO.Path]::Combine($PSScriptRoot, 'portableCleanup.ps1')");
    const args = portableCleanupArguments(STAGED_START);
    expect(args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', STAGED_START]);
    for (const arg of args) expect(arg).not.toContain(plan.launcher);
    expect(args.join(' ')).not.toMatch(/Encoded|Base64|scriptblock|WindowStyle|-Command/iu);
  });

  it('写しの途中で失敗したら作った一時の場所を消して失敗を返す', () => {
    const plan = planPortableCleanup(context);
    if (plan === null) throw new Error('plan missing');
    native.write.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => stagePortableCleanup(plan)).toThrow('disk full');
    expect(native.rm.mock.calls.map((call: readonly unknown[]) => call[0]))
      .toEqual([STAGED_START, STAGED_CLEANUP, `${STAGE}\\${PORTABLE_CLEANUP_STAGE.plan}`]);
    expect(native.rmdir).toHaveBeenCalledWith(STAGE);
  });

  it('終了取消では起動せず、確定したquitで一度だけ窓なし・展開先外から起動役を待って起動する', () => {
    const plan = planPortableCleanup(context);
    if (plan === null) throw new Error('plan missing');
    const events = new EventEmitter();
    const app = { isPackaged: true, on: events.on.bind(events), getPath: () => context.userData };
    registerPortableCleanup(app, plan);
    events.emit('before-quit'); events.emit('will-quit'); events.emit('window-all-closed');
    expect(native.spawn).not.toHaveBeenCalled();
    expect(native.mkdtemp).not.toHaveBeenCalled();
    events.emit('quit'); events.emit('quit');
    expect(native.spawn).toHaveBeenCalledOnce();
    expect(native.mkdtemp).toHaveBeenCalledOnce();
    expect(native.spawn.mock.calls[0]?.[0]).toBe(plan.powershell);
    expect(native.spawn.mock.calls[0]?.[1]).toEqual(portableCleanupArguments(STAGED_START));
    // Not detached: Windows PowerShell does nothing without a console. The bounded wait ends before the app exits.
    expect(native.spawn.mock.calls[0]?.[2]).toEqual({ cwd: plan.temporary, windowsHide: true, stdio: 'ignore',
      timeout: PORTABLE_CLEANUP_START_TIMEOUT_MS });
    expect(native.rmdir).not.toHaveBeenCalled();
    expect(String(native.write.mock.calls.at(-1)?.[1])).toContain('"result":"started"');
  });

  it('通常の導入版では終了処理を追加しない', () => {
    const on = vi.fn();
    registerPortableCleanup({ isPackaged: true, on, getPath: () => context.userData }, null);
    expect(on).not.toHaveBeenCalled();
    expect(native.spawn).not.toHaveBeenCalled();
  });

  it('portableの環境指定がなければuserDataの取得も行わない', () => {
    const launcher = process.env['PORTABLE_EXECUTABLE_FILE'];
    delete process.env['PORTABLE_EXECUTABLE_FILE'];
    try {
      const getPath = vi.fn(() => { throw new Error('Profile must not be queried'); });
      const on = vi.fn();
      registerPortableCleanup({ isPackaged: true, on, getPath });
      expect(getPath).not.toHaveBeenCalled();
      expect(on).not.toHaveBeenCalled();
    } finally {
      if (launcher !== undefined) process.env['PORTABLE_EXECUTABLE_FILE'] = launcher;
    }
  });

  it.each(['throw', 'error', 'status', 'timeout'])('起動役の失敗(%s)を上限付きで永続記録する', mode => {
    const plan = planPortableCleanup(context);
    if (plan === null) throw new Error('plan missing');
    const events = new EventEmitter();
    const failure = Object.assign(new Error('denied'.repeat(2000)), { code: mode === 'timeout' ? 'ETIMEDOUT' : 'EPERM' });
    if (mode === 'throw') native.spawn.mockImplementation(() => { throw failure; });
    else if (mode === 'status') native.spawn.mockReturnValue({ status: 1, signal: null, error: undefined });
    else native.spawn.mockReturnValue({ status: null, signal: mode === 'timeout' ? 'SIGTERM' : null, error: failure });
    registerPortableCleanup({ isPackaged: true, on: events.on.bind(events), getPath: () => context.userData }, plan);
    events.emit('quit');
    const call: readonly unknown[] | undefined = native.write.mock.calls.at(-1);
    const destination = 'C:\\Users\\test\\PointerCAD\\portable-cleanup-startup.json';
    expect(call?.[0]).toBe(destination + `.${process.pid}.tmp`);
    expect(native.rename).toHaveBeenLastCalledWith(destination + `.${process.pid}.tmp`, destination);
    expect(call?.[2]).toEqual({ encoding: 'utf8', flag: 'wx' });
    const entry = call?.[1];
    if (typeof entry !== 'string') throw new Error('Missing startup record');
    expect(entry).toContain('start-failed');
    expect(entry).toContain('elapsedMs');
    expect(entry).toContain(mode === 'status' ? 'Portable cleanup starter ended with 1' : 'denied');
    expect(Buffer.byteLength(entry)).toBeLessThanOrEqual(4096);
    // A starter that never started the cleanup leaves no staged copy behind. One that timed out may have started it,
    // and the cleanup removes its own stage.
    if (mode === 'timeout') expect(native.rmdir).not.toHaveBeenCalled();
    else expect(native.rmdir).toHaveBeenCalledWith(STAGE);
  });
});
