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
  // Playwright の接続の記録の指定(release.yml の DEBUG・DEBUG_FILE)は検査の側だけのもの。単一 exe へは渡さない。
  const environment = { ...process.env };
  delete environment.DEBUG;
  delete environment.DEBUG_FILE;
  const plan = portableLaunchPlan(isolation, environment, process.platform);
  const child = spawn(plan.executable, plan.args, plan.options);
  // 失敗の時に読む末尾を残す(古い塊から捨てる。NSIS の起動器は中の本体の出力を渡さないことがある)。
  const record = (chunk: unknown): void => { output.push(String(chunk).slice(0, 2_000)); if (output.length > 100) output.shift(); };
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

/** 単一 exe への接続が、どこまで進んだか(失敗の時だけ evidence へ残す)。 */
export interface PortableConnectRecord {
  stage: 'DevToolsActivePort を待つ' | '最初の文書の確定を待つ' | 'connectOverCDP' | '接続済み';
  /** 最初の文書の確定を Page.getFrameTree で確かめた回数。 */
  polls: number;
  /** 接続の前に最後に読んだ、ページの target の url と確定済みの文書の url。 */
  lastFrameUrls: string;
  /** 確定の確かめで最後に起きた誤り。 */
  lastError: string | null;
  /** 確定を見るまでの所要(起動の開始から)。 */
  committedMs: number | null;
  /** connectOverCDP が失敗した後に、別の接続で読んだ確定済みの文書の url。 */
  afterFailure: string | null;
}
export function createPortableConnectRecord(): PortableConnectRecord {
  return { stage: 'DevToolsActivePort を待つ', polls: 0, lastFrameUrls: '', lastError: null, committedMs: null, afterFailure: null };
}

/**
 * 単一 exe を起動した後、主の窓の最初の文書が確定してから connectOverCDP する。上限は起動の開始から 60 秒(以前と同じ)。
 * - 接続口: NSIS の ExecWait は中の Electron の標準出力・標準エラーを渡さない(2026-11-12 run 43308623017 の成果物でも
 *   output は空)。Chromium が隔離した userData に書く DevToolsActivePort から読む。
 * - 確定の待ち: DevToolsActivePort は Chromium の接続口が開いた時に書かれ、窓の最初の読込みより前のことがある。最初の
 *   読込みの途中に connectOverCDP すると、Playwright はページの初期化で、最初の空の文書から次の文書への確定の知らせ
 *   (Page.frameNavigated)を待つ。確定が別の描画の処理の中で起きると、その知らせが届かず時間切れになる(配布物の検査
 *   packagedDesktop.spec.ts の冒頭の注記。同じ run で、この接続も ws connected の後 55 秒止まった)。そこで、接続の前に
 *   自前の CDP の接続で、Playwright が判定に使う値(Page.getFrameTree の主の窓の url。playwright-core 1.62.1 の
 *   coreBundle.js 37373 行は "" か ":" の時だけ確定の知らせを待つ)が、確定した文書の url になるまで読み直す。知らせ
 *   (event)は使わず、命令の返事だけを読むので、同じ取りこぼしは起きない。確定した後の文書は製品が読み直さない
 *   (apps/desktop/src/main/main.ts は loadURL を 1 回だけ呼ぶ)ので、続く connectOverCDP は確定の知らせを待たない。
 */
export async function connectPortable(
  playwright: PlaywrightWorkerArgs['playwright'], child: ChildProcess, isolation: PortableIsolation, record: PortableConnectRecord,
): Promise<Browser> {
  const started = Date.now();
  const deadline = started + LAUNCH_TIMEOUT_MS;
  let endpoint: string | null = null;
  let socketUrl: string | null = null;
  record.stage = 'DevToolsActivePort を待つ';
  await expect.poll(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Portable exited before window readiness: ${String(child.exitCode)}`);
    let contents: string;
    try { contents = await readFile(join(isolation.userData, 'DevToolsActivePort'), 'utf8'); }
    catch (error) { if (isMissing(error)) return false; throw error; }
    endpoint = portableDebuggerEndpoint(contents);
    socketUrl = endpoint === null ? null : devtoolsSocketUrl(contents);
    return endpoint !== null;
  }, { timeout: LAUNCH_TIMEOUT_MS, intervals: [250], message: '単一 exe が展開・起動し、接続口を作ること' }).toBe(true);
  if (endpoint === null || socketUrl === null) throw new Error('Portable debugger endpoint is missing.');
  record.stage = '最初の文書の確定を待つ';
  await waitForCommittedDocument(socketUrl, deadline, record);
  record.committedMs = Date.now() - started;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Portable launch exceeded 60 seconds.');
  record.stage = 'connectOverCDP';
  try {
    const browser = await playwright.chromium.connectOverCDP(endpoint, { timeout: remaining });
    record.stage = '接続済み';
    return browser;
  } catch (error) {
    record.afterFailure = await probeFrameUrls(socketUrl);
    throw error;
  }
}

/** DevToolsActivePort(1 行目は番号、2 行目は /devtools/browser/…。portableDebuggerEndpoint が確かめた後に呼ぶ)のブラウザの ws の口。 */
function devtoolsSocketUrl(contents: string): string {
  const [port, path] = contents.trim().split(/\r?\n/u);
  if (port === undefined || path === undefined) throw new Error('Portable DevToolsActivePort is incomplete.');
  return `ws://127.0.0.1:${port}${path}`;
}

/** Playwright の判定(coreBundle.js 37373 行)の逆。"" と ":" は最初の空の文書で、確定の知らせを待たれてしまう。 */
function isCommittedDocumentUrl(url: unknown): boolean {
  return typeof url === 'string' && url !== '' && url !== ':';
}

/** 主の窓の最初の文書が確定するまで、Page.getFrameTree の url を読み直す(上限は起動の上限の残り)。 */
async function waitForCommittedDocument(devtools: string, deadline: number, record: PortableConnectRecord): Promise<void> {
  const connection = await openCdpConnection(devtools, remainingPortableTime(deadline));
  try {
    await expect.poll(async () => {
      record.polls += 1;
      try {
        const pages = await readPageFrameUrls(connection, Math.min(FAILURE_PROBE_TIMEOUT_MS, remainingPortableTime(deadline)));
        record.lastFrameUrls = formatPageFrameUrls(pages);
        return pages.some(page => isCommittedDocumentUrl(page.frameUrl));
      } catch (error) {
        record.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        return false;
      }
    }, { timeout: remainingPortableTime(deadline), intervals: [250],
      message: '単一 exe の主の窓の最初の文書が確定すること(Page.getFrameTree の url が "" でも ":" でもない)' }).toBe(true);
  } finally {
    connection.close();
  }
}

// ---- 配布物の起動の検査(packagedDesktop.spec.ts・portableDesktop.spec.ts)が共有する、Chrome DevTools Protocol の最小の接続 ----

/** 確定の確かめと、失敗の時の読取りで、1 つの命令を待つ上限。 */
const FAILURE_PROBE_TIMEOUT_MS = 5_000;

export function optionalField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

export async function withDeadline<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_done, fail) => {
      timer = setTimeout(() => { fail(new Error(`${label}が${String(timeoutMs)}ms 以内に終わりません`)); }, timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

export interface CdpConnection {
  send(method: string, payload?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  close(): void;
}

/**
 * Chrome DevTools Protocol の最小の接続(Node 主の処理の検査口、接続の前の確定の確かめ、失敗の時の Chromium の読取りに使う)。
 * WebSocket は Node の組み込み(CI の Node 22.23.3 も既定で有効)。新しい依存は足さない。知らせ(event)は読まない。
 * JSON として読めない行は捨てずに onMalformed へ渡し、どの返事か決められないので、返事を待つ全てをその行を入れた文で失敗にする。
 */
export async function openCdpConnection(url: string, timeoutMs: number, onMalformed?: (text: string) => void): Promise<CdpConnection> {
  const socket = new WebSocket(url);
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => { socket.close(); fail(new Error(`${url} へ ${String(timeoutMs)}ms 以内に接続できません`)); }, timeoutMs);
    socket.addEventListener('open', () => { clearTimeout(timer); done(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); fail(new Error(`${url} へ接続できません`)); }, { once: true });
  });
  const pending = new Map<number, { done: (value: unknown) => void; fail: (error: Error) => void }>();
  let lastId = 0;
  socket.addEventListener('message', (event) => {
    const data: unknown = event.data;
    const text = typeof data === 'string' ? data : `(文字でない行: ${Object.prototype.toString.call(data)})`;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch (error) {
      const broken = `${url} の CDP の行を JSON として読めません(${error instanceof Error ? error.message : String(error)}): ${text.slice(0, 300)}`;
      onMalformed?.(broken);
      for (const waiter of pending.values()) waiter.fail(new Error(broken));
      pending.clear();
      return;
    }
    const id = optionalField(message, 'id');
    const waiter = typeof id === 'number' ? pending.get(id) : undefined;
    if (typeof id !== 'number' || waiter === undefined) return;
    pending.delete(id);
    const failure = optionalField(message, 'error');
    if (failure === undefined) waiter.done(optionalField(message, 'result'));
    else waiter.fail(new Error(`CDP の返事が失敗です: ${JSON.stringify(failure).slice(0, 500)}`));
  });
  socket.addEventListener('close', () => {
    for (const waiter of pending.values()) waiter.fail(new Error(`${url} の接続が切れました`));
    pending.clear();
  });
  return {
    send: (method, payload = {}, sessionId) => new Promise<unknown>((done, fail) => {
      if (socket.readyState !== WebSocket.OPEN) { fail(new Error(`${url} の接続は閉じています`)); return; }
      lastId += 1;
      pending.set(lastId, { done, fail });
      socket.send(JSON.stringify({ id: lastId, method, params: payload, ...(sessionId === undefined ? {} : { sessionId }) }));
    }),
    close: () => { socket.close(); },
  };
}

interface PageFrameUrl { readonly targetUrl: unknown; readonly frameUrl: unknown }

/** 全てのページの target へ別に入り、確定済みの文書の url(Page.getFrameTree)を読んで出る。命令の返事だけを使う。 */
async function readPageFrameUrls(connection: CdpConnection, timeoutMs: number): Promise<PageFrameUrl[]> {
  const ask = (method: string, payload?: Record<string, unknown>, sessionId?: string): Promise<unknown> =>
    withDeadline(connection.send(method, payload, sessionId), timeoutMs, method);
  const targets = optionalField(await ask('Target.getTargets'), 'targetInfos');
  const pages = Array.isArray(targets) ? targets.filter((info: unknown) => optionalField(info, 'type') === 'page') : [];
  const found: PageFrameUrl[] = [];
  for (const info of pages) {
    const targetId = optionalField(info, 'targetId');
    if (typeof targetId !== 'string') continue;
    const sessionId = optionalField(await ask('Target.attachToTarget', { targetId, flatten: true }), 'sessionId');
    if (typeof sessionId !== 'string') continue;
    try {
      const frame = optionalField(optionalField(await ask('Page.getFrameTree', {}, sessionId), 'frameTree'), 'frame');
      found.push({ targetUrl: optionalField(info, 'url'), frameUrl: optionalField(frame, 'url') });
    } finally {
      await ask('Target.detachFromTarget', { sessionId }).catch(() => undefined);
    }
  }
  return found;
}

function formatPageFrameUrls(pages: readonly PageFrameUrl[]): string {
  return pages.length === 0 ? 'ページの target がありません'
    : pages.map(page => `target の url ${JSON.stringify(page.targetUrl)}・getFrameTree の url ${JSON.stringify(page.frameUrl)}`).join('、');
}

/**
 * 起動に失敗した時だけ呼ぶ。接続口から全てのページの target へ別に入り、確定済みの文書の URL(Page.getFrameTree)を読む。
 * "" なら最初の空の文書のまま(確定の前)、app://pointercad/index.html なら確定の後。
 */
export async function probeFrameUrls(devtools: string): Promise<string> {
  let connection: CdpConnection | undefined;
  try {
    connection = await openCdpConnection(devtools, FAILURE_PROBE_TIMEOUT_MS);
    return formatPageFrameUrls(await readPageFrameUrls(connection, FAILURE_PROBE_TIMEOUT_MS));
  } catch (error) {
    return `読めません: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
  } finally {
    connection?.close();
  }
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
