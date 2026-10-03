import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { planPortableCleanup, portableCleanupArguments, registerPortableCleanup, stagePortableCleanup } from './portableCleanup.js';
import type { PortableCleanupPlan } from './portableCleanup.js';
import cleanupScript from './portableCleanup.ps1?raw';

const fixtures: string[] = [];
let fixtureParentPath: string | undefined;
const powershell = join(process.env['SystemRoot'] ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');

/** One OS temporary folder per test file. The long path keeps 8.3 names (RUNNER~1) from failing the helper's realpath check. */
function fixtureParent(): string {
  fixtureParentPath ??= mkdtempSync(join(realpathSync.native(tmpdir()), 'pointercad-portable-cleanup-'));
  return fixtureParentPath;
}

let symbolicLinkProbe: { supported: boolean } | undefined;
/** Probe once whether this Windows account may create dir/file symbolic links (junctions never need the privilege). */
function symbolicLinksSupported(): boolean {
  if (symbolicLinkProbe !== undefined) return symbolicLinkProbe.supported;
  const probe = mkdtempSync(join(fixtureParent(), 'link-probe-'));
  try {
    mkdirSync(join(probe, 'target'));
    writeFileSync(join(probe, 'target.txt'), 'probe');
    symlinkSync(join(probe, 'target'), join(probe, 'dir-link'), 'dir');
    symlinkSync(join(probe, 'target.txt'), join(probe, 'file-link'), 'file');
    symbolicLinkProbe = { supported: true };
  } catch (error) {
    // Only the missing SeCreateSymbolicLinkPrivilege (no Developer Mode, not elevated) is an environment reason to skip.
    if (!(error instanceof Error) || !('code' in error) || !['EPERM', 'EACCES'].includes(String(error.code))) throw error;
    symbolicLinkProbe = { supported: false };
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
  return symbolicLinkProbe.supported;
}

function fixture() {
  const root = mkdtempSync(join(fixtureParent(), 'fs-'));
  fixtures.push(root);
  // NSIS picks the third letter at random; "nsy" is the shape the release CI actually saw (nsy3217.tmp).
  const directory = join(root, '日本語 [1] O\'Brien $x', 'nsy3217.tmp');
  const executable = join(directory, 'app', 'PointerCAD.exe');
  mkdirSync(join(directory, 'app'), { recursive: true });
  writeFileSync(executable, 'fixture only; never executable');
  for (const file of ['System.dll', 'StdUtils.dll']) writeFileSync(join(directory, file), 'fixture');
  const logDirectory = join(root, 'userData');
  mkdirSync(logDirectory);
  const plan: PortableCleanupPlan = {
    directory, executable, temporary: root, powershell, launcher: join(root, 'portable.exe'),
    // These absent PIDs model the usual state when the helper starts after both processes have exited.
    processId: 2147483647, launcherId: 2147483646, createdAt: Math.floor(statSync(directory).birthtimeMs),
    logDirectory,
    identities: [directory, dirname(executable), executable, join(directory, 'StdUtils.dll'), join(directory, 'System.dll')].map(path => {
      const stat = statSync(path, { bigint: true });
      return `${stat.dev}:${stat.ino}`;
    }),
  };
  return { root, plan };
}

/**
 * A fixture PowerShell (holder/cleaner) may start slowly while other heavy checks share the CPU
 * (2026-10-01 08:14: vitest import took 142 s and four shells missed a 5 s start wait; 09:04: the whole desktop
 * suite beside a screen test kept the helper's Add-Type compile from reaching its first marker within 20 s).
 * This only waits for a freshly started shell to reach its first marker; no behaviour is judged by it.
 */
const FIXTURE_START_TIMEOUT_MS = 60000;

/**
 * How long a holder shell keeps its handle when nobody releases it. The tests always release in finally;
 * this only ends an orphan. It must outlast a slow helper start plus the helper's own 30-35 s deadline
 * (08:46 under load: the helper started so late that a 45 s holder exited first and the deadline test saw exit 0).
 */
const HOLDER_SAFETY_LIMIT_MS = 120000;

/**
 * Harness timeout for these real-process tests: start waits above plus the helper's real 30 s deadline.
 * The deadline tests took 52-55 s under load against the shared 60 s default.
 * The judged values (30000-35000 ms, exit codes, files, log records) are unchanged.
 */
const SLOW_FIXTURE_TEST_TIMEOUT_MS = 180000;

function start(args: string[], cwd: string, ignoreOutput = false) {
  const env: NodeJS.ProcessEnv = { ...process.env, TEMP: cwd, TMP: cwd, TMPDIR: cwd };
  delete env['PSModulePath'];
  // Prove that the launch's own -ExecutionPolicy lets the staged file run, not a policy inherited from this shell.
  delete env['PSExecutionPolicyPreference'];
  const output = ignoreOutput ? 'ignore' : 'pipe';
  const child = spawn(powershell, args, { cwd, env, windowsHide: true, stdio: ['ignore', output, output] });
  let text = '';
  child.stdout?.on('data', (bytes: Buffer) => { text += bytes.toString('utf8'); });
  child.stderr?.on('data', (bytes: Buffer) => { text += bytes.toString('utf8'); });
  const done = new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
    child.on('error', reject);
    child.on('close', code => { resolveResult({ code, output: text }); });
  });
  return { child, done, get output() { return text; } };
}

/** A PowerShell single-quoted literal: only ' is special inside it, so paths with $, `, [ ] and Japanese stay data. */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

let scriptCount = 0;
/**
 * Test-only scripts run the same way as the product helper: an ordinary UTF-8 file started with -File.
 * 2026-10-01 02:00:07 Microsoft Defender blocked the former encoded command line (gzip/base64 + scriptblock) as
 * Trojan:Win32/Commando.A!ml, so neither the product nor these fixtures put code on the command line.
 */
function scriptFile(root: string, script: string): string[] {
  scriptCount += 1;
  const path = join(root, `fixture-${String(scriptCount)}.ps1`);
  writeFileSync(path, String.fromCharCode(0xfeff) + script, { encoding: 'utf8', flag: 'wx' });
  return portableCleanupArguments(path);
}

/** Starts the helper exactly like the app: staged copy and plan beside the extraction, then -File. */
function startCleanup(plan: PortableCleanupPlan, script = cleanupScript, ignoreOutput = false) {
  return start(portableCleanupArguments(stagePortableCleanup(plan, script).cleanup), plan.temporary, ignoreOutput);
}

function stages(folder: string): string[] {
  return readdirSync(folder).filter(name => name.startsWith('pointercad-cleanup-'));
}

function records(plan: PortableCleanupPlan) {
  return readFileSync(join(plan.logDirectory, 'portable-cleanup.log'), 'utf8').trim().split('\n').map(line => {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null || !('result' in value) || typeof value.result !== 'string'
      || !('elapsedMs' in value) || typeof value.elapsedMs !== 'number' || !('lastError' in value) || typeof value.lastError !== 'string'
      || !('attempts' in value) || typeof value.attempts !== 'number' || !('errorCode' in value) || typeof value.errorCode !== 'number'
      || !('processId' in value) || typeof value.processId !== 'number'
      || !('preparationMs' in value) || typeof value.preparationMs !== 'number'
      || !('stageRemoved' in value) || typeof value.stageRemoved !== 'boolean') throw new Error('Invalid cleanup record');
    return { result: value.result, elapsedMs: value.elapsedMs, lastError: value.lastError, attempts: value.attempts,
      errorCode: value.errorCode, processId: value.processId, preparationMs: value.preparationMs, stageRemoved: value.stageRemoved };
  });
}

function hold(root: string, key: string, executable?: string) {
  const ready = join(root, key + '-ready'), release = join(root, key + '-release');
  const running = start(scriptFile(root, `$ErrorActionPreference = 'Stop'
$stream = $null
try {
  ${executable === undefined ? '' : `$stream = [IO.File]::Open(${literal(executable)}, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)`}
  [IO.File]::WriteAllText(${literal(ready)}, 'ready')
  $wait = [Diagnostics.Stopwatch]::StartNew()
  while (-not [IO.File]::Exists(${literal(release)}) -and $wait.ElapsedMilliseconds -lt ${HOLDER_SAFETY_LIMIT_MS}) { Start-Sleep -Milliseconds 20 }
} finally { if ($null -ne $stream) { $stream.Dispose() } }`), root);
  return { ...running, ready, release };
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    const absolute = resolve(root), parent = resolve(fixtureParent());
    if (!absolute.startsWith(parent + sep) || !absolute.slice(parent.length + 1).startsWith('fs-')) {
      throw new Error('Fixture escaped the test temporary directory');
    }
    rmSync(absolute, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (fixtureParentPath !== undefined) rmSync(fixtureParentPath, { recursive: true, force: true });
  fixtureParentPath = undefined;
});

describe.skipIf(process.platform !== 'win32')('Windows実ファイルで終了後の片付けを確認（アプリ起動なし。製品と同じ -File の起動）', { timeout: SLOW_FIXTURE_TEST_TIMEOUT_MS }, () => {
  it('既知3ファイルと空の展開先だけ消し、別起動・文書・配布exeは保持し、写した台本も消す', async () => {
    const { root, plan } = fixture();
    const other = join(root, 'nsiAE.tmp');
    mkdirSync(other); writeFileSync(join(other, 'PointerCAD.exe'), 'other launch');
    writeFileSync(join(root, 'document.pcad'), 'saved document');
    writeFileSync(plan.launcher, 'portable download');
    const resolved = planPortableCleanup({
      platform: 'win32', isPackaged: true, executable: plan.executable, temporary: dirname(plan.directory),
      launcher: plan.launcher, launcherDirectory: root, appFilename: 'pointercad', systemRoot: process.env['SystemRoot'],
      processId: plan.processId, launcherId: plan.launcherId,
      userData: plan.logDirectory,
    });
    expect(resolved).not.toBeNull();
    if (resolved === null) throw new Error('Real extraction path was rejected');
    const staged = stagePortableCleanup(resolved);
    // The staged copy is beside the extraction in the same temporary folder, never inside it.
    expect(dirname(staged.directory)).toBe(resolved.temporary);
    expect(stages(resolved.temporary)).toHaveLength(1);
    const result = await start(portableCleanupArguments(staged.cleanup), root).done;
    // Windows PowerShell may emit module preparation progress as CLIXML even on success.
    expect(result.code, result.output).toBe(0);
    expect(existsSync(plan.directory)).toBe(false);
    expect(readFileSync(join(other, 'PointerCAD.exe'), 'utf8')).toBe('other launch');
    expect(readFileSync(join(root, 'document.pcad'), 'utf8')).toBe('saved document');
    expect(readFileSync(plan.launcher, 'utf8')).toBe('portable download');
    expect(stages(resolved.temporary)).toEqual([]);
    const entries = records(plan);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.result).toBe('completed');
    expect(entries[0]?.lastError).toBe('');
    expect(entries[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(entries[0]?.elapsedMs).toBeLessThan(30000);
    expect(entries[0]?.preparationMs).toBeGreaterThan(0);
    expect(entries[0]?.stageRemoved).toBe(true);
  });

  it('アプリと同じ起動（終了の確定で一度・起動役を待つ・窓なし・-File）で、展開先と写した台本が消える', async () => {
    const { root, plan } = fixture();
    const events = new EventEmitter();
    // The product passes no env: hide a policy inherited from this shell so the launch's own policy is what runs it.
    const inherited = process.env['PSExecutionPolicyPreference'];
    delete process.env['PSExecutionPolicyPreference'];
    try {
      registerPortableCleanup({ isPackaged: true, on: events.on.bind(events), getPath: () => plan.logDirectory }, plan);
      events.emit('quit');
    } finally {
      if (inherited !== undefined) process.env['PSExecutionPolicyPreference'] = inherited;
    }
    const startup: unknown = JSON.parse(readFileSync(join(plan.logDirectory, 'portable-cleanup-startup.json'), 'utf8'));
    // The quit waited for the starter, which started the cleanup as its own process and exited.
    expect(startup).toMatchObject({ result: 'started', lastError: '' });
    // The cleanup reports only through its log, written last. Allow its start (Add-Type) plus the 30 s deadline.
    await expect.poll(() => {
      try { return records(plan).length; } catch { return 0; }
    }, { timeout: FIXTURE_START_TIMEOUT_MS + 30000 }).toBeGreaterThan(0);
    const entries = records(plan);
    expect(entries.map(entry => entry.result)).toEqual(['completed']);
    expect(entries[0]?.stageRemoved).toBe(true);
    expect(existsSync(plan.directory)).toBe(false);
    expect(stages(root)).toEqual([]);
  });

  it('ロック中は残し、実際に解放された後に削除を再試行する', async () => {
    const { root, plan } = fixture();
    const holder = hold(root, 'lock', plan.executable);
    let cleaner: ReturnType<typeof start> | undefined;
    try {
      await expect.poll(() => existsSync(holder.ready), { timeout: FIXTURE_START_TIMEOUT_MS }).toBe(true);
      cleaner = startCleanup(plan, `Set-PSDebug -Trace 1\n${cleanupScript}`);
      const observed = cleaner;
      // Trace the real helper until it has actually tried twice while the real file lock is held.
      // The wait includes the helper shell's own start (Add-Type), so it uses the fixture start allowance.
      await expect.poll(() => observed.output.split('$lease = [PointerCadPortableCleanup]::Open').length - 1, { timeout: FIXTURE_START_TIMEOUT_MS }).toBeGreaterThanOrEqual(2);
      expect(existsSync(plan.executable)).toBe(true);
    } finally {
      writeFileSync(holder.release, 'release');
      expect((await holder.done).code).toBe(0);
      if (cleaner !== undefined) {
        const result = await cleaner.done;
        expect(result.code, result.output).toBe(0);
      }
    }
    expect(existsSync(plan.directory)).toBe(false);
    expect(stages(root)).toEqual([]);
  });

  it('想定外のファイルを再帰削除せず、失敗として残す', async () => {
    const { plan } = fixture();
    const document = join(plan.directory, 'app', 'document.pcad');
    writeFileSync(document, 'unspecified user file');
    const result = await startCleanup(plan).done;
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('Unexpected portable application residue.');
    expect(readFileSync(document, 'utf8')).toBe('unspecified user file');
  });

  it('展開先が置き換わっていたら既知名のファイルも削除しない', async () => {
    const { plan } = fixture();
    const result = await startCleanup({ ...plan, createdAt: plan.createdAt - 1000 }).done;
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('Portable extraction directory was replaced.');
    expect(existsSync(plan.executable)).toBe(true);
    expect(existsSync(join(plan.directory, 'System.dll'))).toBe(true);
  });

  it('PIDが別の実行ファイルを指すときは削除しない', async () => {
    const { plan } = fixture();
    const result = await startCleanup({ ...plan, processId: process.pid }).done;
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('Portable process identity differs.');
    expect(existsSync(plan.executable)).toBe(true);
  });

  it('展開後にappがジャンクションへ変わっても外側の同名ファイルを消さない', async () => {
    const { root, plan } = fixture();
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'PointerCAD.exe'), 'unrelated file');
    renameSync(join(plan.directory, 'app'), join(plan.directory, 'original-app'));
    symlinkSync(outside, join(plan.directory, 'app'), 'junction');
    const result = await startCleanup(plan).done;
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('Portable cleanup refuses a reparse point.');
    expect(readFileSync(join(outside, 'PointerCAD.exe'), 'utf8')).toBe('unrelated file');
  });

  // it.for (not it.each) passes the test context, so the privilege skip is reported with its reason.
  it.for([
    ['app', 'junction'], ['extraction', 'junction'], ['ancestor', 'junction'],
    ['app', 'dir'], ['extraction', 'dir'], ['ancestor', 'dir'], ['file', 'file'],
  ] as const)('確認直後の%s差し替えを保持ハンドルで拒否する（リンク種別%s）', async ([level, linkType], context) => {
    if (linkType !== 'junction' && !symbolicLinksSupported()) {
      context.skip(`環境の理由で省く: このWindowsのアカウントはシンボリックリンク（${linkType}）を作れない（開発者モード無し・管理者でない。EPERM/EACCES）`);
      return;
    }
    const { root, plan } = fixture();
    const victim = level === 'file' ? plan.executable : level === 'app' ? dirname(plan.executable)
      : level === 'extraction' ? plan.directory : dirname(plan.directory);
    const outside = join(root, 'outside');
    mkdirSync(outside);
    const outsideExtraction = level === 'ancestor' ? join(outside, 'nsy3217.tmp') : outside;
    const outsideApp = level === 'extraction' || level === 'ancestor' ? join(outsideExtraction, 'app') : outside;
    mkdirSync(outsideApp, { recursive: true });
    const bait = join(outsideApp, 'PointerCAD.exe');
    writeFileSync(bait, 'unrelated exe');
    writeFileSync(join(outsideExtraction, 'System.dll'), 'unrelated dll');
    writeFileSync(join(outsideExtraction, 'StdUtils.dll'), 'unrelated plugin');
    const prepared = join(root, 'prepared-link');
    // Create the real junction/symlink first, so missing OS link privileges cannot masquerade as protection.
    symlinkSync(level === 'file' ? bait : outside, prepared, linkType);
    const ready = join(root, 'checked'), release = join(root, 'continue');
    expect(cleanupScript.split('$lease.Remove()')).toHaveLength(2);
    const script = cleanupScript.replace('$lease.Remove()', `
      [IO.File]::WriteAllText(${literal(ready)}, 'all handles inspected')
      $wait = [Diagnostics.Stopwatch]::StartNew()
      while (-not [IO.File]::Exists(${literal(release)}) -and $wait.ElapsedMilliseconds -lt 10000) { Start-Sleep -Milliseconds 10 }
      if (-not [IO.File]::Exists(${literal(release)})) { throw 'Test barrier expired.' }
      $lease.Remove()`);
    const cleaner = startCleanup(plan, script);
    let blocked = false;
    try {
      await expect.poll(() => existsSync(ready), { timeout: FIXTURE_START_TIMEOUT_MS }).toBe(true);
      try { renameSync(victim, join(root, 'old-target')); }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || !['EPERM', 'EACCES', 'EBUSY'].includes(String(error.code))) throw error;
        blocked = true;
      }
      if (!blocked) renameSync(prepared, victim);
    } finally {
      writeFileSync(release, 'continue');
      const result = await cleaner.done;
      expect(result.code, result.output).toBe(0);
    }
    expect(blocked).toBe(true);
    expect(readFileSync(bait, 'utf8')).toBe('unrelated exe');
    expect(readFileSync(join(outsideExtraction, 'System.dll'), 'utf8')).toBe('unrelated dll');
    expect(readFileSync(join(outsideExtraction, 'StdUtils.dll'), 'utf8')).toBe('unrelated plugin');
    expect(existsSync(plan.directory)).toBe(false);
  });

  it('作成時刻を同じ値にした実際の別フォルダーをファイルIDで拒否する', async () => {
    const { root, plan } = fixture();
    renameSync(plan.directory, join(root, 'old-extraction'));
    mkdirSync(dirname(plan.executable), { recursive: true });
    writeFileSync(plan.executable, 'replacement exe');
    for (const file of ['StdUtils.dll', 'System.dll']) writeFileSync(join(plan.directory, file), 'replacement dll');
    const restoreTime = await start(scriptFile(root,
      `[IO.Directory]::SetCreationTimeUtc(${literal(plan.directory)}, [DateTimeOffset]::FromUnixTimeMilliseconds(${String(plan.createdAt)}).UtcDateTime)`),
    root).done;
    expect(restoreTime.code, restoreTime.output).toBe(0);
    expect(Math.floor(statSync(plan.directory).birthtimeMs)).toBe(plan.createdAt);
    const result = await startCleanup(plan, cleanupScript, true).done;
    expect(result.code).toBe(1);
    expect(records(plan)[0]?.lastError).toBe('Portable extraction identity was replaced.');
    expect(readFileSync(plan.executable, 'utf8')).toBe('replacement exe');
  });

  it('出力破棄でも失敗を記録し、上限を超えた既存ログを65536バイト以内に収め、写した台本は消す', async () => {
    const { root, plan } = fixture();
    writeFileSync(join(plan.logDirectory, 'portable-cleanup.log'), 'x'.repeat(65536));
    writeFileSync(join(plan.directory, 'app', 'document.pcad'), 'document');
    const result = await startCleanup(plan, cleanupScript, true).done;
    expect(result.code).toBe(1);
    const entries = records(plan);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.result).toBe('failed');
    expect(entries[0]?.lastError).toBe('Unexpected portable application residue.');
    expect(entries[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(entries[0]?.stageRemoved).toBe(true);
    expect(stages(root)).toEqual([]);
    expect(statSync(join(plan.logDirectory, 'portable-cleanup.log')).size).toBeLessThanOrEqual(65536);
    expect(readFileSync(join(plan.directory, 'app', 'document.pcad'), 'utf8')).toBe('document');
  });

  it.each(['lock', 'process'])('実際の%sが30秒続くと有限終了し、原因と経過時間をログへ残す', async mode => {
    const { root, plan } = fixture();
    const holder = hold(root, 'deadline', mode === 'lock' ? plan.executable : undefined);
    try {
      await expect.poll(() => existsSync(holder.ready), { timeout: FIXTURE_START_TIMEOUT_MS }).toBe(true);
      const heldId = holder.child.pid;
      if (heldId === undefined) throw new Error('Missing fixture process');
      const actual = mode === 'process' ? { ...plan, executable: powershell, processId: heldId } : plan;
      const result = await startCleanup(actual, cleanupScript, true).done;
      expect(result.code).toBe(1);
      const entry = records(plan)[0];
      expect(entry?.result).toBe('deadline');
      // The deadline clock starts after preparation (plan read and Add-Type), which is recorded separately.
      expect(entry?.elapsedMs).toBeGreaterThanOrEqual(30000);
      expect(entry?.elapsedMs).toBeLessThan(35000);
      expect(entry?.preparationMs).toBeGreaterThan(0);
      expect(entry?.lastError.length).toBeGreaterThan(0);
      if (mode === 'lock') {
        expect(entry?.errorCode).toBe(32);
        expect(entry?.attempts).toBeGreaterThan(1);
      } else {
        expect(entry?.lastError).toBe('Portable process did not exit.');
        expect(entry?.attempts).toBe(0);
      }
      expect(holder.child.exitCode).toBeNull();
      expect(existsSync(plan.executable)).toBe(true);
      expect(existsSync(join(plan.directory, 'StdUtils.dll'))).toBe(true);
      expect(existsSync(join(plan.directory, 'System.dll'))).toBe(true);
    } finally {
      writeFileSync(holder.release, 'release');
      const result = await holder.done;
      expect(result.code, result.output).toBe(0);
    }
  });

  it('期限は台本の準備（Add-Typeの型のコンパイル）の後から数える', async () => {
    const { plan } = fixture();
    // Model a slow machine: preparation itself takes longer than the whole 30 s deadline.
    const marker = '  Initialize-CleanupNative';
    expect(cleanupScript.split(marker)).toHaveLength(2);
    const result = await startCleanup(plan, cleanupScript.replace(marker, `${marker}\n  Start-Sleep -Seconds 31`), true).done;
    expect(result.code).toBe(0);
    const entry = records(plan)[0];
    expect(entry?.result).toBe('completed');
    expect(entry?.attempts).toBe(1);
    expect(entry?.preparationMs).toBeGreaterThanOrEqual(31000);
    expect(entry?.elapsedMs).toBeLessThan(30000);
    expect(existsSync(plan.directory)).toBe(false);
  });

  it('実プロセス2組と補助2つを同時起動し、一方の終了で他方を消さず共通ログへ両方を残す', async () => {
    const first = fixture(), second = fixture();
    const holders = [hold(first.root, 'app'), hold(first.root, 'launcher'), hold(second.root, 'app'), hold(second.root, 'launcher')];
    const cleaners: ReturnType<typeof start>[] = [];
    const ids: number[] = [];
    try {
      await expect.poll(() => holders.every(holder => existsSync(holder.ready)), { timeout: FIXTURE_START_TIMEOUT_MS }).toBe(true);
      for (const holder of holders) {
        if (holder.child.pid === undefined) throw new Error('Missing fixture process');
        ids.push(holder.child.pid);
      }
      for (const [index, current] of [first, second].entries()) {
        const processId = ids[index * 2], launcherId = ids[index * 2 + 1];
        if (processId === undefined || launcherId === undefined) throw new Error('Missing fixture identities');
        const plan = { ...current.plan, processId, launcherId, executable: powershell, launcher: powershell, logDirectory: first.plan.logDirectory };
        const script = cleanupScript.replace('  Wait-OwnedProcess $cleanup.processId $cleanup.executable',
          `  [IO.File]::WriteAllText(${literal(join(current.root, 'waiting'))}, 'waiting')
  Wait-OwnedProcess $cleanup.processId $cleanup.executable`);
        cleaners.push(startCleanup(plan, script, true));
      }
      await expect.poll(() => [first, second].every(current => existsSync(join(current.root, 'waiting'))), { timeout: FIXTURE_START_TIMEOUT_MS }).toBe(true);
      expect(existsSync(first.plan.executable)).toBe(true);
      expect(existsSync(second.plan.executable)).toBe(true);
      for (const holder of holders.slice(0, 2)) writeFileSync(holder.release, 'release');
      const firstResult = await cleaners[0]?.done;
      expect(firstResult?.code, firstResult?.output).toBe(0);
      expect(existsSync(first.plan.directory)).toBe(false);
      expect(existsSync(second.plan.executable)).toBe(true);
      expect(cleaners[1]?.child.exitCode).toBeNull();
      for (const holder of holders.slice(2)) writeFileSync(holder.release, 'release');
      const secondResult = await cleaners[1]?.done;
      expect(secondResult?.code, secondResult?.output).toBe(0);
      expect(existsSync(second.plan.directory)).toBe(false);
      const entries = records(first.plan);
      expect(entries.map(entry => entry.result)).toEqual(['completed', 'completed']);
      expect(entries.map(entry => entry.processId)).toEqual([ids[0], ids[2]]);
      expect(stages(first.root)).toEqual([]);
      expect(stages(second.root)).toEqual([]);
    } finally {
      for (const holder of holders) writeFileSync(holder.release, 'release');
      await Promise.all([...holders, ...cleaners].map(running => running.done));
    }
  });

  it('本物のプロセスの終了をハンドルで待ち、同じPIDでも新しい開始時刻を拒否する', async () => {
    const { root } = fixture();
    const main = '$preparation = [Diagnostics.Stopwatch]::StartNew()';
    expect(cleanupScript.split(main)).toHaveLength(2);
    const functions = cleanupScript.slice(0, cleanupScript.indexOf(main));
    // Sleep only keeps a disposable shell alive. The assertion checks actual exit, never elapsed time.
    // The child is a plain, readable -Command (nothing encoded): '' is a quote inside the PowerShell literal.
    const childArguments = "-NoLogo -NoProfile -NonInteractive -Command \"[Console]::Out.WriteLine(''ready''); [Console]::Out.Flush(); [Threading.Thread]::Sleep(3000)\"";
    const result = await start(scriptFile(root, `$cleanup = [pscustomobject]@{ requestedAt = 0; executable = ${literal(powershell)} }
${functions}
$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $cleanup.executable
$startInfo.Arguments = '${childArguments}'
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardOutput = $true
$held = [Diagnostics.Process]::Start($startInfo)
try {
  $ready = $held.StandardOutput.ReadLineAsync()
  if (-not $ready.Wait(${String(FIXTURE_START_TIMEOUT_MS)}) -or $ready.Result -ne 'ready') { throw 'Fixture shell did not start.' }
  $reusedRejected = $false
  try { Wait-OwnedProcess $held.Id $cleanup.executable }
  catch {
    if ($_.Exception.Message -ne 'Portable process identifier was reused.') { throw }
    $reusedRejected = $true
  }
  if (-not $reusedRejected) { throw 'Reused process identity was accepted.' }
  $cleanup.requestedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($held.HasExited) { throw 'Fixture exited before the wait.' }
  $timer = [Diagnostics.Stopwatch]::StartNew()
  Wait-OwnedProcess $held.Id $cleanup.executable
  if (-not $held.HasExited) { throw 'Wait returned while the process was still alive.' }
  [Console]::Out.WriteLine('real process exited; reused identity rejected')
} finally {
  $null = $held.WaitForExit(5000)
  $held.Dispose()
}`), root).done;
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('real process exited; reused identity rejected');
  });
});
