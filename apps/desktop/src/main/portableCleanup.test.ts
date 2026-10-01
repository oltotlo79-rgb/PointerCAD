import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planPortableCleanup, portableCleanupArguments, registerPortableCleanup } from './portableCleanup.js';
import type { PortableCleanupContext } from './portableCleanup.js';

const native = vi.hoisted(() => ({
  lstat: vi.fn(), realpath: vi.fn(), spawn: vi.fn(), unref: vi.fn(), on: vi.fn(), mkdir: vi.fn(), write: vi.fn(), rename: vi.fn(), unlink: vi.fn(),
}));
vi.mock('node:fs', () => ({ lstatSync: native.lstat, realpathSync: { native: native.realpath },
  mkdirSync: native.mkdir, writeFileSync: native.write, renameSync: native.rename, unlinkSync: native.unlink }));

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
  native.spawn.mockReturnValue({ on: native.on, unref: native.unref });
  vi.spyOn(process.getBuiltinModule('child_process'), 'spawn').mockImplementation(native.spawn);
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

  it('空白・日本語・引用符・シェル文字を実行命令へ展開しない', () => {
    const plan = planPortableCleanup({ ...context, launcher: "D:/O'Brien $x ` [1]/portable.exe", launcherDirectory: "D:/O'Brien $x ` [1]" });
    if (plan === null) throw new Error('plan missing');
    const args = portableCleanupArguments(plan);
    expect(args.slice(0, -1)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand']);
    const script = Buffer.from(args.at(-1) ?? '', 'base64').toString('utf16le');
    expect(script).not.toContain(plan.launcher);
    const encoded = /FromBase64String\('([^']+)'\)/u.exec(script)?.[1];
    expect(encoded).toBeDefined();
    expect(Buffer.from(encoded ?? '', 'base64').toString('utf8')).toContain(JSON.stringify(plan.launcher));
    expect(args.join(' ').length + plan.powershell.length).toBeLessThan(32767);
  });

  it('終了取消では起動せず、確定したquitで一度だけ窓なし・展開先外から起動する', () => {
    const plan = planPortableCleanup(context);
    if (plan === null) throw new Error('plan missing');
    const events = new EventEmitter();
    const app = { isPackaged: true, on: events.on.bind(events), getPath: () => context.userData };
    registerPortableCleanup(app, plan);
    events.emit('before-quit'); events.emit('will-quit'); events.emit('window-all-closed');
    expect(native.spawn).not.toHaveBeenCalled();
    events.emit('quit'); events.emit('quit');
    expect(native.spawn).toHaveBeenCalledOnce();
    expect(native.spawn.mock.calls[0]?.[0]).toBe(plan.powershell);
    expect(native.spawn.mock.calls[0]?.[2]).toEqual({ cwd: plan.temporary, detached: true, windowsHide: true, stdio: 'ignore' });
    expect(native.unref).toHaveBeenCalledOnce();
    expect(native.on.mock.calls[0]?.[0]).toBe('error');
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

  it.each(['sync', 'async'])('補助処理の%s起動失敗を上限付きで永続記録する', mode => {
    const plan = planPortableCleanup(context);
    if (plan === null) throw new Error('plan missing');
    const events = new EventEmitter(), helper = new EventEmitter();
    if (mode === 'sync') native.spawn.mockImplementation(() => { throw new Error('denied'.repeat(2000)); });
    else native.spawn.mockReturnValue(Object.assign(helper, { unref: native.unref }));
    registerPortableCleanup({ isPackaged: true, on: events.on.bind(events), getPath: () => context.userData }, plan);
    events.emit('quit');
    if (mode === 'async') helper.emit('error', new Error('denied'.repeat(2000)));
    const call: readonly unknown[] | undefined = native.write.mock.calls.at(-1);
    const destination = 'C:\\Users\\test\\PointerCAD\\portable-cleanup-startup.json';
    expect(call?.[0]).toBe(destination + `.${process.pid}.tmp`);
    expect(native.rename).toHaveBeenLastCalledWith(destination + `.${process.pid}.tmp`, destination);
    expect(call?.[2]).toEqual({ encoding: 'utf8', flag: 'wx' });
    const entry = call?.[1];
    if (typeof entry !== 'string') throw new Error('Missing startup record');
    expect(entry).toContain('start-failed');
    expect(entry).toContain('elapsedMs');
    expect(entry).toContain('denied');
    expect(Buffer.byteLength(entry)).toBeLessThanOrEqual(4096);
  });
});
