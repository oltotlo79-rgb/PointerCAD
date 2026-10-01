import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { planPortableCleanup, portableCleanupArguments } from './portableCleanup.js';
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
  const directory = join(root, '日本語 [1] O\'Brien $x', 'nsiAD.tmp');
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

/** A test-only script: the command line stays short and constant, and the script text goes through standard input. */
type ScriptLaunch = { args: string[]; input: string };

function start(launch: string[] | ScriptLaunch, cwd: string, ignoreOutput = false) {
  const env: NodeJS.ProcessEnv = { ...process.env, TEMP: cwd, TMP: cwd, TMPDIR: cwd };
  delete env['PSModulePath'];
  const args = Array.isArray(launch) ? launch : launch.args;
  const input = Array.isArray(launch) ? undefined : launch.input;
  const output = ignoreOutput ? 'ignore' : 'pipe';
  const child = spawn(powershell, args, { cwd, env, windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', output, output] });
  let text = '';
  child.stdout?.on('data', (bytes: Buffer) => { text += bytes.toString('utf8'); });
  child.stderr?.on('data', (bytes: Buffer) => { text += bytes.toString('utf8'); });
  // A shell that dies before reading its script closes the pipe; keep that in the output, the exit code decides.
  child.stdin?.on('error', (error: Error) => { text += `\n[stdin] ${error.message}`; });
  child.stdin?.end(input, 'utf8');
  const done = new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
    child.on('error', reject);
    child.on('close', code => { resolveResult({ code, output: text }); });
  });
  return { child, done, get output() { return text; } };
}

/**
 * Runs a test-only script without putting it on the command line.
 * 2026-10-01 02:00:07 Microsoft Defender blocked the former `-EncodedCommand` + gzip/base64 + scriptblock command line
 * of a fixture shell as Trojan:Win32/Commando.A!ml (a machine-learning verdict that depends on the random payload),
 * so the process was never created and spawn threw EPERM. The script itself is unchanged; only its transport is.
 */
function command(script: string): ScriptLaunch {
  const reader = '$r = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false)); '
    + 'try { $code = $r.ReadToEnd() } finally { $r.Dispose() }; & ([scriptblock]::Create($code))';
  return { args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', reader], input: script };
}

function scriptFor(plan: PortableCleanupPlan, script = cleanupScript): string {
  const data = Buffer.from(JSON.stringify({ ...plan, requestedAt: Date.now() }), 'utf8').toString('base64');
  return `$cleanup = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json\n${script}`;
}

function records(plan: PortableCleanupPlan) {
  return readFileSync(join(plan.logDirectory, 'portable-cleanup.log'), 'utf8').trim().split('\n').map(line => {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null || !('result' in value) || typeof value.result !== 'string'
      || !('elapsedMs' in value) || typeof value.elapsedMs !== 'number' || !('lastError' in value) || typeof value.lastError !== 'string'
      || !('attempts' in value) || typeof value.attempts !== 'number' || !('errorCode' in value) || typeof value.errorCode !== 'number'
      || !('processId' in value) || typeof value.processId !== 'number') throw new Error('Invalid cleanup record');
    return { result: value.result, elapsedMs: value.elapsedMs, lastError: value.lastError,
      attempts: value.attempts, errorCode: value.errorCode, processId: value.processId };
  });
}

function hold(root: string, key: string, executable?: string) {
  const ready = join(root, key + '-ready'), release = join(root, key + '-release');
  const data = Buffer.from(JSON.stringify({ ready, release, executable }), 'utf8').toString('base64');
  const running = start(command(`$ErrorActionPreference = 'Stop'
$d = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json
$stream = $null
try {
  if ($d.executable) { $stream = [IO.File]::Open($d.executable, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read) }
  [IO.File]::WriteAllText($d.ready, 'ready')
  $wait = [Diagnostics.Stopwatch]::StartNew()
  while (-not [IO.File]::Exists($d.release) -and $wait.ElapsedMilliseconds -lt ${HOLDER_SAFETY_LIMIT_MS}) { Start-Sleep -Milliseconds 20 }
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

/**
 * v1.0.1 does not call this cleanup from the product (main.ts; see noEncodedPowerShell.test.ts), so these cases no
 * longer prove shipped behaviour. They are kept as checks of the parts (the deletion-safety rules of the .ps1 helper
 * and its plan) that v1.0.2 resumes with a launch Defender does not block. When v1.0.2 replaces the launch, cases that
 * start the helper through portableCleanupArguments must move to the new launch together with the product.
 */
/**
 * v1.0.2 で起動の形を作り直すまで省く（Defender が -EncodedCommand を Trojan:Win32/Commando.A!ml と判定するため。製品は呼ばない）。
 * These cases start PowerShell with an encoded command line: the helper through portableCleanupArguments, or (the
 * process-identity case) a child shell. On 2026-10-01 02:00:07 Microsoft Defender blocked that launch shape, so they
 * can fail with spawn EPERM on Windows machines and CI. v1.0.1 does not call the cleanup from the product (main.ts).
 * Cases that pass their script on standard input (command()) keep running. Re-enable these with the new launch.
 */
const itEncodedLaunch = it.skip;

describe.skipIf(process.platform !== 'win32')('v1.0.2 で再開する機能の部品: Windows実ファイルで終了後の片付けを確認（アプリ起動なし）', { timeout: SLOW_FIXTURE_TEST_TIMEOUT_MS }, () => {
  itEncodedLaunch('既知3ファイルと空の展開先だけ消し、別起動・文書・配布exeは保持する', async () => {
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
    const result = await start(portableCleanupArguments(resolved), root).done;
    // Windows PowerShell may emit module preparation progress as CLIXML even on success.
    expect(result.code, result.output).toBe(0);
    expect(existsSync(plan.directory)).toBe(false);
    expect(readFileSync(join(other, 'PointerCAD.exe'), 'utf8')).toBe('other launch');
    expect(readFileSync(join(root, 'document.pcad'), 'utf8')).toBe('saved document');
    expect(readFileSync(plan.launcher, 'utf8')).toBe('portable download');
    const entries = records(plan);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.result).toBe('completed');
    expect(entries[0]?.lastError).toBe('');
    expect(entries[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(entries[0]?.elapsedMs).toBeLessThan(30000);
  });

  it('ロック中は残し、実際に解放された後に削除を再試行する', async () => {
    const { root, plan } = fixture();
    const ready = join(root, 'ready'), release = join(root, 'release');
    const data = Buffer.from(JSON.stringify({ executable: plan.executable, ready, release }), 'utf8').toString('base64');
    const holder = start(command(`$d = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json
$stream = [IO.File]::Open($d.executable, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  [IO.File]::WriteAllText($d.ready, 'ready')
  $timer = [Diagnostics.Stopwatch]::StartNew()
  while (-not [IO.File]::Exists($d.release) -and $timer.ElapsedMilliseconds -lt ${HOLDER_SAFETY_LIMIT_MS}) { Start-Sleep -Milliseconds 25 }
} finally { $stream.Dispose() }`), root);
    let cleaner: ReturnType<typeof start> | undefined;
    try {
      await expect.poll(() => existsSync(ready), { timeout: FIXTURE_START_TIMEOUT_MS }).toBe(true);
      cleaner = start(command(`Set-PSDebug -Trace 1\n${scriptFor(plan)}`), root);
      const observed = cleaner;
      // Trace the real helper until it has actually tried twice while the real file lock is held.
      // The wait includes the helper shell's own start (Add-Type), so it uses the fixture start allowance.
      await expect.poll(() => observed.output.split('$lease = [PointerCadPortableCleanup]::Open').length - 1, { timeout: FIXTURE_START_TIMEOUT_MS }).toBeGreaterThanOrEqual(2);
      expect(existsSync(plan.executable)).toBe(true);
    } finally {
      writeFileSync(release, 'release');
      expect((await holder.done).code).toBe(0);
      if (cleaner !== undefined) {
        const result = await cleaner.done;
        expect(result.code, result.output).toBe(0);
      }
    }
    expect(existsSync(plan.directory)).toBe(false);
  });

  itEncodedLaunch('想定外のファイルを再帰削除せず、失敗として残す', async () => {
    const { root, plan } = fixture();
    const document = join(plan.directory, 'app', 'document.pcad');
    writeFileSync(document, 'unspecified user file');
    const result = await start(portableCleanupArguments(plan), root).done;
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('Unexpected portable application residue.');
    expect(readFileSync(document, 'utf8')).toBe('unspecified user file');
  });

  itEncodedLaunch('展開先が置き換わっていたら既知名のファイルも削除しない', async () => {
    const { root, plan } = fixture();
    const result = await start(portableCleanupArguments({ ...plan, createdAt: plan.createdAt - 1000 }), root).done;
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('Portable extraction directory was replaced.');
    expect(existsSync(plan.executable)).toBe(true);
    expect(existsSync(join(plan.directory, 'System.dll'))).toBe(true);
  });

  itEncodedLaunch('PIDが別の実行ファイルを指すときは削除しない', async () => {
    const { root, plan } = fixture();
    const result = await start(portableCleanupArguments({ ...plan, processId: process.pid }), root).done;
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('Portable process identity differs.');
    expect(existsSync(plan.executable)).toBe(true);
  });

  itEncodedLaunch('展開後にappがジャンクションへ変わっても外側の同名ファイルを消さない', async () => {
    const { root, plan } = fixture();
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'PointerCAD.exe'), 'unrelated file');
    renameSync(join(plan.directory, 'app'), join(plan.directory, 'original-app'));
    symlinkSync(outside, join(plan.directory, 'app'), 'junction');
    const result = await start(portableCleanupArguments(plan), root).done;
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
    const outsideExtraction = level === 'ancestor' ? join(outside, 'nsiAD.tmp') : outside;
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
    const barrier = Buffer.from(JSON.stringify({ ready, release }), 'utf8').toString('base64');
    expect(cleanupScript.split('$lease.Remove()')).toHaveLength(2);
    const script = cleanupScript.replace('$lease.Remove()', `
      $barrier = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${barrier}')) | ConvertFrom-Json
      [IO.File]::WriteAllText($barrier.ready, 'all handles inspected')
      $wait = [Diagnostics.Stopwatch]::StartNew()
      while (-not [IO.File]::Exists($barrier.release) -and $wait.ElapsedMilliseconds -lt 10000) { Start-Sleep -Milliseconds 10 }
      if (-not [IO.File]::Exists($barrier.release)) { throw 'Test barrier expired.' }
      $lease.Remove()`);
    const cleaner = start(command(scriptFor(plan, script)), root);
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

  itEncodedLaunch('作成時刻を同じ値にした実際の別フォルダーをファイルIDで拒否する', async () => {
    const { root, plan } = fixture();
    renameSync(plan.directory, join(root, 'old-extraction'));
    mkdirSync(dirname(plan.executable), { recursive: true });
    writeFileSync(plan.executable, 'replacement exe');
    for (const file of ['StdUtils.dll', 'System.dll']) writeFileSync(join(plan.directory, file), 'replacement dll');
    const data = Buffer.from(JSON.stringify(plan), 'utf8').toString('base64');
    const restoreTime = await start(command(`$d = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json
[IO.Directory]::SetCreationTimeUtc($d.directory, [DateTimeOffset]::FromUnixTimeMilliseconds($d.createdAt).UtcDateTime)`), root).done;
    expect(restoreTime.code, restoreTime.output).toBe(0);
    expect(Math.floor(statSync(plan.directory).birthtimeMs)).toBe(plan.createdAt);
    const result = await start(portableCleanupArguments(plan), root, true).done;
    expect(result.code).toBe(1);
    expect(records(plan)[0]?.lastError).toBe('Portable extraction identity was replaced.');
    expect(readFileSync(plan.executable, 'utf8')).toBe('replacement exe');
  });

  itEncodedLaunch('出力破棄でも失敗を記録し、上限を超えた既存ログを65536バイト以内に収める', async () => {
    const { root, plan } = fixture();
    writeFileSync(join(plan.logDirectory, 'portable-cleanup.log'), 'x'.repeat(65536));
    writeFileSync(join(plan.directory, 'app', 'document.pcad'), 'document');
    const result = await start(portableCleanupArguments(plan), root, true).done;
    expect(result.code).toBe(1);
    const entries = records(plan);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.result).toBe('failed');
    expect(entries[0]?.lastError).toBe('Unexpected portable application residue.');
    expect(entries[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(statSync(join(plan.logDirectory, 'portable-cleanup.log')).size).toBeLessThanOrEqual(65536);
    expect(readFileSync(join(plan.directory, 'app', 'document.pcad'), 'utf8')).toBe('document');
  });

  itEncodedLaunch.each(['lock', 'process'])('実際の%sが30秒続くと有限終了し、原因と経過時間をログへ残す', async mode => {
    const { root, plan } = fixture();
    const holder = hold(root, 'deadline', mode === 'lock' ? plan.executable : undefined);
    try {
      await expect.poll(() => existsSync(holder.ready), { timeout: FIXTURE_START_TIMEOUT_MS }).toBe(true);
      const heldId = holder.child.pid;
      if (heldId === undefined) throw new Error('Missing fixture process');
      const actual = mode === 'process' ? { ...plan, executable: powershell, processId: heldId } : plan;
      const result = await start(portableCleanupArguments(actual), root, true).done;
      expect(result.code).toBe(1);
      const entry = records(plan)[0];
      expect(entry?.result).toBe('deadline');
      expect(entry?.elapsedMs).toBeGreaterThanOrEqual(30000);
      expect(entry?.elapsedMs).toBeLessThan(35000);
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
        const marker = Buffer.from(join(current.root, 'waiting'), 'utf8').toString('base64');
        const script = cleanupScript.replace('  Wait-OwnedProcess $cleanup.processId $cleanup.executable',
          `  [IO.File]::WriteAllText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${marker}')), 'waiting')
  Wait-OwnedProcess $cleanup.processId $cleanup.executable`);
        cleaners.push(start(command(scriptFor(plan, script)), current.root, true));
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
    } finally {
      for (const holder of holders) writeFileSync(holder.release, 'release');
      await Promise.all([...holders, ...cleaners].map(running => running.done));
    }
  });

  itEncodedLaunch('本物のプロセスの終了をハンドルで待ち、同じPIDでも新しい開始時刻を拒否する', async () => {
    const { root } = fixture();
    const functions = cleanupScript.slice(0, cleanupScript.indexOf('$timer = [Diagnostics.Stopwatch]::StartNew()'));
    const identity = Buffer.from(JSON.stringify({ requestedAt: 0, executable: powershell }), 'utf8').toString('base64');
    // Sleep only keeps a disposable shell alive. The assertion checks actual exit, never elapsed time.
    const childCode = Buffer.from("[Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); [Threading.Thread]::Sleep(3000)", 'utf16le').toString('base64');
    const result = await start(command(`$cleanup = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${identity}')) | ConvertFrom-Json
${functions}
$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $cleanup.executable
$startInfo.Arguments = '-NoLogo -NoProfile -NonInteractive -EncodedCommand ${childCode}'
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$startInfo.RedirectStandardOutput = $true
$held = [Diagnostics.Process]::Start($startInfo)
try {
  $ready = $held.StandardOutput.ReadLineAsync()
  if (-not $ready.Wait(5000) -or $ready.Result -ne 'ready') { throw 'Fixture shell did not start.' }
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
