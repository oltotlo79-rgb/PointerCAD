import { lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { win32 } from 'node:path';
import cleanupScript from './portableCleanup.ps1?raw';

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
  const appDirectory = win32.dirname(executable), directory = win32.dirname(appDirectory);
  if (win32.basename(executable) !== 'PointerCAD.exe' || win32.basename(appDirectory) !== 'app'
    || !/^nsi[0-9a-f]{1,4}\.tmp$/iu.test(win32.basename(directory)) || !samePath(win32.dirname(directory), temporary)
    || !samePath(win32.dirname(launcher), launcherDirectory) || win32.extname(launcher).toLowerCase() !== '.exe') return null;
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

/** Data is base64 JSON inside an encoded command: quotes/metacharacters in paths cannot become code. */
export function portableCleanupArguments(plan: PortableCleanupPlan): string[] {
  const data = Buffer.from(JSON.stringify({ ...plan, requestedAt: Date.now() }), 'utf8').toString('base64');
  // Compress the embedded helper to stay below Windows' 32767-character command-line limit.
  const source = process.getBuiltinModule('zlib').gzipSync(Buffer.from(cleanupScript, 'utf8')).toString('base64');
  const script = `$cleanup = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json
$bytes = [IO.MemoryStream]::new([Convert]::FromBase64String('${source}'))
$gzip = [IO.Compression.GZipStream]::new($bytes, [IO.Compression.CompressionMode]::Decompress)
$reader = [IO.StreamReader]::new($gzip, [Text.Encoding]::UTF8)
try { $source = $reader.ReadToEnd() } finally { $reader.Dispose(); $bytes.Dispose() }
& ([scriptblock]::Create($source))`;
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
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
  try {
    // Resolve Node built-ins at runtime: the existing main bundle external list is intentionally unchanged.
    const helper = process.getBuiltinModule('child_process').spawn(plan.powershell, portableCleanupArguments(plan), {
      cwd: plan.temporary, detached: true, windowsHide: true, stdio: 'ignore',
    });
    helper.on('error', (error: Error) => { record('start-failed', error); });
    helper.unref();
  } catch (error) {
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
