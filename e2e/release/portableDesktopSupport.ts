import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { expect, type Browser, type PlaywrightWorkerArgs } from '@playwright/test';
// The extraction judgement ("ns" + a..z + hex, e.g. nsy3217.tmp) is the one the product cleanup also uses.
import { portableDebuggerEndpoint, portableExtractionDirectory, portableLaunchPlan,
  type PortableCandidate } from '../../scripts/release/portableLaunch.mjs';
import { collectDesktopFiles } from '../../scripts/release/desktopFileInventory.mjs';
import { verifyDesktopDistribution } from '../../scripts/release/desktopDistribution.mjs';

const runFile = promisify(execFile);
export const LAUNCH_TIMEOUT_MS = 60_000;
export const EXIT_TIMEOUT_MS = 30_000;

export function remainingPortableTime(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Portable check deadline expired.');
  return remaining;
}

export interface PortableProcess { readonly pid: number; readonly parentId: number; readonly path: string }
export interface PortableIsolation { readonly base: string; readonly userData: string; readonly temporary: string; readonly executable: string }

export async function preparePortableIsolation(root: string, executable: string): Promise<PortableIsolation> {
  const base = join(root, 'scratchpad', 'temp', 'p', randomUUID().replace(/-/gu, '').slice(0, 6));
  const userData = join(base, 'u'), temporary = join(base, 't'), launch = join(base, 'l');
  // Same 90-character budget as packagedDesktop.spec.ts. Fail before creating a profile.
  if (userData.length > 90) throw new Error(`Portable userData path exceeds 90 characters: ${userData}`);
  for (const path of [userData, temporary, launch]) await mkdir(path, { recursive: true });
  const copied = join(launch, basename(executable));
  await copyFile(executable, copied);
  // Only the downloadable exe is placed here; resources/app and builder/win-unpacked are not supplied.
  expect(await readdir(launch)).toEqual([basename(executable)]);
  return { base, userData, temporary, executable: copied };
}

export function startPortable(isolation: PortableIsolation, output: string[]): ChildProcess {
  const plan = portableLaunchPlan(isolation, process.env, process.platform);
  const child = spawn(plan.executable, plan.args, plan.options);
  const record = (chunk: unknown): void => { if (output.length < 100) output.push(String(chunk).slice(0, 2_000)); };
  child.stdout?.on('data', record); child.stderr?.on('data', record);
  child.on('error', error => { record(error.message); });
  return child;
}

/** Failure recovery only. The test has already failed; preserve its extraction and report every stop. */
export async function stopFailedPortable(child: ChildProcess, temporary: string): Promise<string[]> {
  const stopped: string[] = [];
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    try {
      await runFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: EXIT_TIMEOUT_MS });
      stopped.push(`launcher tree ${String(child.pid)} stopped after failure`);
    } catch (error) { stopped.push(`launcher stop failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  for (const entry of await portableProcesses(temporary)) {
    try { process.kill(entry.pid, 'SIGKILL'); stopped.push(`extracted process ${String(entry.pid)} stopped after failure`); }
    catch (error) { stopped.push(`extracted process stop failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return stopped;
}

export async function connectPortable(
  playwright: PlaywrightWorkerArgs['playwright'], child: ChildProcess, isolation: PortableIsolation,
): Promise<Browser> {
  const started = Date.now();
  let endpoint: string | null = null;
  // NSIS ExecWait does not promise forwarding the inner Electron's stdout/stderr. Read Chromium's
  // own port file in the isolated profile instead of requiring _electron.launch's debugger log lines.
  await expect.poll(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Portable exited before window readiness: ${String(child.exitCode)}`);
    let contents: string;
    try { contents = await readFile(join(isolation.userData, 'DevToolsActivePort'), 'utf8'); }
    catch (error) { if (isMissing(error)) return false; throw error; }
    endpoint = portableDebuggerEndpoint(contents);
    return endpoint !== null;
  }, { timeout: LAUNCH_TIMEOUT_MS, intervals: [250], message: '単一 exe が展開・起動し、接続口を作ること' }).toBe(true);
  if (endpoint === null) throw new Error('Portable debugger endpoint is missing.');
  const remaining = LAUNCH_TIMEOUT_MS - (Date.now() - started);
  if (remaining <= 0) throw new Error('Portable launch exceeded 60 seconds.');
  return playwright.chromium.connectOverCDP(endpoint, { timeout: remaining });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (isMissing(error)) return false; throw error; }
}

/** Read processes, then filter paths in JS; no filesystem path is interpolated into PowerShell code. */
export async function portableProcesses(temporary: string, timeout = LAUNCH_TIMEOUT_MS): Promise<PortableProcess[]> {
  const command = ["$ErrorActionPreference = 'Stop'", '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    '$items = @(Get-CimInstance Win32_Process -Filter "Name = \'PointerCAD.exe\'" | Where-Object { $_.ExecutablePath } | '
      + 'ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; parentId = [int]$_.ParentProcessId; path = [string]$_.ExecutablePath } })',
    'ConvertTo-Json -InputObject $items -Compress'].join('; ');
  const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', windowsHide: true, timeout });
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('Portable process inventory is not an array.');
  return parsed.map((value: unknown) => {
    if (typeof value !== 'object' || value === null) throw new Error('Invalid portable process.');
    const pid: unknown = Reflect.get(value, 'pid'), parentId: unknown = Reflect.get(value, 'parentId'), path: unknown = Reflect.get(value, 'path');
    if (typeof pid !== 'number' || typeof parentId !== 'number' || typeof path !== 'string') throw new Error('Invalid portable process identity.');
    return { pid, parentId, path };
  }).filter(entry => {
    const local = relative(temporary, entry.path);
    return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
  });
}

export async function verifyPortableExtraction(
  root: string, isolation: PortableIsolation, child: ChildProcess, candidate: PortableCandidate,
): Promise<{ directory: string; main: PortableProcess }> {
  const processes = await portableProcesses(isolation.temporary);
  const mains = processes.filter(entry => entry.parentId === child.pid);
  expect(mains, '単一 exe の子として展開先の本体が1つ動くこと').toHaveLength(1);
  const main = mains[0];
  if (main === undefined) throw new Error('Portable main process is missing.');
  const directory = portableExtractionDirectory(main.path, isolation.temporary);
  expect((await realpath(main.path)).toLowerCase()).toBe(resolve(main.path).toLowerCase());
  const resources = join(dirname(main.path), 'resources', 'app');
  const manifestBytes = await readFile(join(resources, 'desktop-package.json'));
  const manifest: unknown = JSON.parse(manifestBytes.toString('utf8'));
  expect(manifest).toMatchObject({ version: candidate.version, sourceCommit: candidate.sourceCommit, platform: 'win32', arch: 'x64',
    application: { productName: 'PointerCAD', version: candidate.version } });
  const verified = verifyDesktopDistribution(await collectDesktopFiles(root, resources), manifestBytes);
  expect(verified).toMatchObject(candidate.application);
  return { directory, main };
}
