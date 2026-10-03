import { lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { win32 } from 'node:path';
import cleanupScript from './portableCleanup.ps1?raw';
import startScript from './portableCleanupStart.ps1?raw';
import { nsisExtractionDirectory } from './portableExtraction.mjs';

interface QuitEvents {
  readonly isPackaged: boolean;
  getPath(name: 'userData'): string;
  on(event: 'quit', listener: () => void): unknown;
}

export interface PortableCleanupContext {
  readonly platform: string;
  readonly isPackaged: boolean;
  readonly executable: string;
  readonly temporary: string;
  readonly launcher: string | undefined;
  readonly launcherDirectory: string | undefined;
  readonly appFilename: string | undefined;
  readonly systemRoot: string | undefined;
  readonly processId: number;
  readonly launcherId: number;
  readonly userData: string;
}

export interface PortableCleanupPlan {
  readonly directory: string;
  readonly executable: string;
  readonly launcher: string;
  readonly powershell: string;
  readonly temporary: string;
  readonly processId: number;
  readonly launcherId: number;
  readonly createdAt: number;
  readonly identities: readonly string[];
  readonly logDirectory: string;
}

function samePath(left: string, right: string): boolean {
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

function localAbsolute(path: string): boolean {
  return /^[a-z]:[\\/]/iu.test(path) && !path.includes('\0');
}

/** Limit cleanup to this launch's NSIS directory. Never infer ownership from a TEMP glob. */
export function planPortableCleanup(context: PortableCleanupContext): PortableCleanupPlan | null {
  const { executable, temporary, launcher, launcherDirectory, appFilename, systemRoot, processId, launcherId, userData } = context;
  if (context.platform !== 'win32' || !context.isPackaged || launcher === undefined || launcherDirectory === undefined
    || appFilename !== 'pointercad' || systemRoot === undefined) return null;
  if (![executable, temporary, launcher, launcherDirectory, systemRoot, userData].every(localAbsolute)
    || !Number.isSafeInteger(processId) || processId <= 0 || processId > 2147483647
    || !Number.isSafeInteger(launcherId) || launcherId <= 0 || launcherId > 2147483647
    || processId === launcherId) return null;
  // The one shared judgement of this launch's NSIS extraction ("ns" + a..z + hex; see portableExtraction.mjs).
  const directory = nsisExtractionDirectory(executable, temporary);
  if (directory === null || !samePath(win32.dirname(launcher), launcherDirectory)
    || win32.extname(launcher).toLowerCase() !== '.exe') return null;
  const appDirectory = win32.dirname(executable);
  const launcherRelative = win32.relative(directory, launcher);
  if (!launcherRelative.startsWith('..' + win32.sep) && !win32.isAbsolute(launcherRelative)) return null;
  const logRelative = win32.relative(directory, userData);
  if (!logRelative.startsWith('..' + win32.sep) && !win32.isAbsolute(logRelative)) return null;
  try {
    // Reject junctions/symlinks anywhere along the extraction path. Recheck in the helper before deleting.
    for (const path of [temporary, directory, appDirectory, executable]) {
      if (lstatSync(path).isSymbolicLink() || !samePath(realpathSync.native(path), path)) return null;
    }
    if (!lstatSync(directory).isDirectory() || !lstatSync(executable).isFile()) return null;
    const identities = [directory, appDirectory, executable, win32.join(directory, 'StdUtils.dll'), win32.join(directory, 'System.dll')]
      .map(path => {
        const stat = lstatSync(path, { bigint: true });
        if (stat.isSymbolicLink() || stat.ino === 0n) throw new Error('Portable identity is unavailable.');
        return `${stat.dev}:${stat.ino}`;
      });
    return {
      directory, executable, launcher, temporary, processId, launcherId, identities, logDirectory: userData,
      powershell: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      createdAt: Math.floor(lstatSync(directory).birthtimeMs),
    };
  } catch {
    return null;
  }
}

/** The only files in a launch's stage folder. portableCleanup.ps1 deletes exactly these three, then the empty folder. */
export const PORTABLE_CLEANUP_STAGE = { start: 'start.ps1', cleanup: 'portableCleanup.ps1', plan: 'plan.json' } as const;

/** Paths of one launch's staged copies. */
export interface PortableCleanupStage {
  readonly directory: string;
  readonly start: string;
  readonly cleanup: string;
}

/**
 * How long the confirmed quit waits for the short starter (normally 0.2-1 s; Windows PowerShell's own start under
 * load took several seconds in the 2026-10-01 measurements). The window is already gone at this point.
 */
export const PORTABLE_CLEANUP_START_TIMEOUT_MS = 20000;

/** Windows PowerShell 5.1 reads a script without a byte order mark in the ANSI code page; mark it as UTF-8. */
const UTF8_BOM = String.fromCharCode(0xfeff);

function removeStage(stage: string): void {
  try {
    for (const name of Object.values(PORTABLE_CLEANUP_STAGE)) rmSync(win32.join(stage, name), { force: true });
    rmdirSync(stage);
  } catch (error) { console.error('Portable cleanup stage could not be removed:', error); }
}

/**
 * Copies the cleanup script, its starter and this launch's plan into a new folder in the same temporary folder as the
 * NSIS extraction (beside it, never inside it).
 *
 * 2026-10-01 02:00:07 Microsoft Defender blocked a PowerShell whose script was passed as an encoded command line
 * (gzip + base64 + a script block, v1.0.0) as Trojan:Win32/Commando.A!ml, judged from the command line alone.
 * Nothing is encoded or embedded in a command line any more: the scripts are ordinary files run with -File, and the
 * plan is JSON data the cleanup reads from beside itself, so quotes or metacharacters in paths cannot become code.
 * `cleanup` exists only for the real-file tests that add synchronization points; the app always uses the shipped one.
 */
export function stagePortableCleanup(plan: PortableCleanupPlan, cleanup: string = cleanupScript): PortableCleanupStage {
  const directory = mkdtempSync(win32.join(plan.temporary, 'pointercad-cleanup-'));
  const staged: PortableCleanupStage = { directory,
    start: win32.join(directory, PORTABLE_CLEANUP_STAGE.start), cleanup: win32.join(directory, PORTABLE_CLEANUP_STAGE.cleanup) };
  try {
    writeFileSync(win32.join(directory, PORTABLE_CLEANUP_STAGE.plan), JSON.stringify({ ...plan, requestedAt: Date.now() }),
      { encoding: 'utf8', flag: 'wx' });
    writeFileSync(staged.cleanup, UTF8_BOM + cleanup, { encoding: 'utf8', flag: 'wx' });
    writeFileSync(staged.start, UTF8_BOM + startScript, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    removeStage(directory);
    throw error;
  }
  return staged;
}

/**
 * A short, fixed command line whose only variable part is a staged script's path. No encoded command, no inline
 * code and no hidden-window switch (the processes are started without a visible window: windowsHide / CreateNoWindow).
 * RemoteSigned applies to this process only and lets the local, unsigned copy run where the default policy is Restricted.
 */
export function portableCleanupArguments(scriptPath: string): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', scriptPath];
}

function isTimeout(error: Error | undefined): boolean {
  return error !== undefined && 'code' in error && error.code === 'ETIMEDOUT';
}

function startPortableCleanup(plan: PortableCleanupPlan): void {
  const startedAt = Date.now();
  const record = (result: string, error?: unknown): void => {
    const destination = win32.join(plan.logDirectory, 'portable-cleanup-startup.json');
    const temporary = destination + `.${process.pid}.tmp`;
    let created = false;
    try {
      mkdirSync(plan.logDirectory, { recursive: true });
      // A separate, bounded latest-start record survives failure to launch PowerShell itself.
      const message = error === undefined ? '' : error instanceof Error ? error.message
        : typeof error === 'string' ? error : 'Unknown portable cleanup error';
      const lastError = message.slice(0, 256);
      writeFileSync(temporary, JSON.stringify({
        at: new Date().toISOString(), processId: plan.processId, result, elapsedMs: Date.now() - startedAt, lastError,
      }), { encoding: 'utf8', flag: 'wx' });
      created = true;
      // Concurrent launches replace complete records instead of interleaving truncated JSON.
      renameSync(temporary, destination);
      created = false;
    } catch (error) { console.error('Portable cleanup log could not be written:', error); }
    finally {
      if (created) {
        try { unlinkSync(temporary); }
        catch (error) { console.error('Portable cleanup temporary log could not be removed:', error); }
      }
    }
  };
  record('requested');
  let stage: PortableCleanupStage | undefined;
  try {
    stage = stagePortableCleanup(plan);
    // Windows PowerShell does nothing when started without a console (Node's detached start; measured 2026-10-01),
    // and an ordinary child is ended together with the app's process job. So wait, bounded, for the short starter: it
    // starts the cleanup as its own windowless process outside that job and exits.
    // Resolve Node built-ins at runtime: the existing main bundle external list is intentionally unchanged.
    const started = process.getBuiltinModule('child_process').spawnSync(plan.powershell, portableCleanupArguments(stage.start), {
      cwd: plan.temporary, windowsHide: true, stdio: 'ignore', timeout: PORTABLE_CLEANUP_START_TIMEOUT_MS,
    });
    if (started.error === undefined && started.status === 0) {
      record('started');
      return;
    }
    // A starter that timed out may already have started the cleanup, which removes the stage itself.
    if (!isTimeout(started.error)) removeStage(stage.directory);
    record('start-failed', started.error ?? `Portable cleanup starter ended with ${String(started.status ?? started.signal)}`);
  } catch (error) {
    if (stage !== undefined) removeStage(stage.directory);
    record('start-failed', error);
  }
}

/** quit is after the cancellable close/before-quit/will-quit events; cancelling a close never starts deletion. */
export function registerPortableCleanup(
  app: QuitEvents,
  plan: PortableCleanupPlan | null = currentPortableCleanupPlan(app),
): void {
  if (plan === null) return;
  let started = false;
  app.on('quit', () => {
    if (started) return;
    started = true;
    startPortableCleanup(plan);
  });
}

function currentPortableCleanupPlan(app: QuitEvents): PortableCleanupPlan | null {
  // Ordinary installations do not need a cleanup plan or access to a profile directory.
  if (process.platform !== 'win32' || !app.isPackaged || process.env['PORTABLE_EXECUTABLE_FILE'] === undefined) return null;
  let userData: string;
  try { userData = app.getPath('userData'); }
  catch (error) { console.error('Portable cleanup profile could not be resolved:', error); return null; }
  return planPortableCleanup({
    platform: process.platform, isPackaged: app.isPackaged, executable: process.execPath, temporary: process.getBuiltinModule('os').tmpdir(),
    launcher: process.env['PORTABLE_EXECUTABLE_FILE'], launcherDirectory: process.env['PORTABLE_EXECUTABLE_DIR'],
    appFilename: process.env['PORTABLE_EXECUTABLE_APP_FILENAME'], systemRoot: process.env['SystemRoot'],
    processId: process.pid, launcherId: process.ppid, userData,
  });
}
