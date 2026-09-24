/// <reference lib="dom" />
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test, type ElectronApplication, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import { chooseToolMenuItem } from '../tests/assemblyTestSupport.js';
import { waitForMathEditorText } from '../tests/mathEditorReady.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from '../tests/recompute.js';
import { waitForStartupHealth } from '../tests/startupHealth.js';
import { uiMessage } from '../tests/uiMessages.js';

/*
 * 配布物の起動の確認(P13-8・P13-9・P13-10・P13-17)。設定は e2e/packaged-desktop.config.ts、
 * 実行の手順は scripts/release/README.md の「配布物の起動確認」。環境変数(相対パスはリポジトリの根から):
 * - PCAD_PACKAGED_EXECUTABLE: 起動する実行ファイル。Windows は win-unpacked か導入先の PointerCAD.exe。
 *   Linux は AppImage を --appimage-extract で展開した squashfs-root/AppRun(AppImage の実行時と同じ入口)。
 * - PCAD_PACKAGED_CANDIDATE: その配布物を作ったときの candidate.json(scripts/release/package-desktop.mjs が書く)。
 *
 * 利用者の実際のプロファイルは触らない。Chromium の --user-data-dir で userData を scratchpad/temp/p/ の下の
 * 使い捨てのフォルダーへ向け(Linux は XDG_* も向ける)、起動の直後に app.getPath('userData') がその下に
 * あることを確かめ、外れたら他の操作をせずに閉じて失敗にする。起動の前後で実際のプロファイルのフォルダーの
 * 一覧(名前・大きさ・更新時刻)が変わらないことも確かめる。製品のコードに検査用の口は足さない。
 * swiftshader の3つの指定は launchDesktop(e2e/tests/electronAppFlow.ts)と同じく検査の起動だけに渡す。
 *
 * 配布物には Playwright の起動の保留(loader)を入れられない(executablePath を渡すと Playwright は
 * loader を足さず、配布物は既定の本体だけを読む)。rules/06 §10.87 の起動の競合を避けられないため、
 * 起動の上限を明示し、窓の表示と最初の読込みの完了を main 側から確かめてから操作する。
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const ISOLATION_PARENT = join(root, 'scratchpad', 'temp', 'p');
// e2e/tests/electronAppFlow.ts の USER_DATA_PATH_BUDGET と同じ根拠(Windows の MAX_PATH 260 から、Chromium が
// userData の下に作る最も深い内部パスの実測164文字を170へ切り上げて引いた値)。
const USER_DATA_PATH_BUDGET = 90;
// 失敗した回の一時フォルダーは証拠として残し、次の実行で古いものだけ消す(1回の上限15分より十分長い)。
const STALE_ISOLATION_AGE_MS = 60 * 60_000;
const SWIFTSHADER_ARGS = ['--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader'];
const PROCESS_EXIT_TIMEOUT_MS = 30_000;
const runFile = promisify(execFile);

interface CandidateRecord {
  readonly version: string;
  readonly sourceCommit: string;
  readonly platform: string;
  readonly arch: string;
  readonly files: number;
  readonly manualBuildId: string;
  readonly pdfVolumes: number;
  readonly applicationMetadataSha256: string;
}
interface InventoryFile { readonly path: string; readonly bytes: number; readonly sha256: string }
interface PackagedRecord {
  readonly version: string;
  readonly sourceCommit: string;
  readonly platform: string;
  readonly arch: string;
  readonly electronVersion: string;
  readonly manualBuildId: string;
  readonly pdfVolumes: number;
  readonly productName: string;
  readonly applicationVersion: string;
  readonly files: readonly InventoryFile[];
}
interface LaunchTarget {
  readonly executable: string;
  readonly appDirectory: string;
  readonly resourcesApp: string;
  readonly candidatePath: string;
  readonly candidate: CandidateRecord;
  readonly packaged: PackagedRecord;
  readonly metadataSha256: string;
  readonly packagedFiles: number;
}
interface Isolation {
  readonly base: string;
  readonly userData: string;
  readonly xdgConfigHome: string | null;
  readonly env: Record<string, string>;
}
interface TreeEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'link' | 'other';
  readonly bytes: number;
  readonly modifiedMs: number;
}
interface TreeSnapshot { readonly root: string; readonly exists: boolean; readonly entries: readonly TreeEntry[] }
interface ProcessEntry { readonly pid: number; readonly path: string }
interface ItemRecord {
  readonly id: string;
  readonly label: string;
  readonly result: '成功' | '失敗';
  readonly ms: number;
  readonly error?: string;
}

function field(value: unknown, key: string, where: string): unknown {
  if (typeof value !== 'object' || value === null) throw new Error(`${where}の形が違います(${key} を読めません)`);
  return Reflect.get(value, key);
}
function textField(value: unknown, key: string, where: string): string {
  const read = field(value, key, where);
  if (typeof read !== 'string' || read === '') throw new Error(`${where}の ${key} が文字列ではありません`);
  return read;
}
function countField(value: unknown, key: string, where: string): number {
  const read = field(value, key, where);
  if (typeof read !== 'number' || !Number.isSafeInteger(read) || read < 0) throw new Error(`${where}の ${key} が0以上の整数ではありません`);
  return read;
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
/** Windows の path.relative は大文字小文字を区別しないため、同じ判定で両OSを扱える。 */
function isWithin(path: string, directory: string): boolean {
  const local = relative(directory, path);
  return local === '' || (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local));
}
function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
/** Playwright は Windows で cmd.exe を介して起動する。% と " は cmd.exe が書き換えるため先に断る。 */
function assertCommandSafe(path: string, meaning: string): void {
  if (process.platform === 'win32' && /[%"]/u.test(path)) throw new Error(`${meaning}のパスに % や " を含めないでください: ${path}`);
}

function readCandidate(value: unknown): CandidateRecord {
  const where = 'candidate.json';
  if (textField(value, 'format', where) !== 'pointercad-desktop-candidate/1') throw new Error(`${where}の形式が違います`);
  const application = field(value, 'application', where);
  const inner = `${where}の application`;
  return {
    version: textField(value, 'version', where), sourceCommit: textField(value, 'sourceCommit', where),
    platform: textField(value, 'platform', where), arch: textField(value, 'arch', where),
    files: countField(application, 'files', inner), manualBuildId: textField(application, 'manualBuildId', inner),
    pdfVolumes: countField(application, 'pdfVolumes', inner),
    applicationMetadataSha256: textField(application, 'applicationMetadataSha256', inner),
  };
}

function readPackaged(value: unknown): PackagedRecord {
  const where = '配布物の desktop-package.json';
  if (textField(value, 'format', where) !== 'pointercad-desktop-package/1') throw new Error(`${where}の形式が違います`);
  const application = field(value, 'application', where);
  const files = field(value, 'files', where);
  if (!Array.isArray(files)) throw new Error(`${where}の files が配列ではありません`);
  return {
    version: textField(value, 'version', where), sourceCommit: textField(value, 'sourceCommit', where),
    platform: textField(value, 'platform', where), arch: textField(value, 'arch', where),
    electronVersion: textField(value, 'electronVersion', where), manualBuildId: textField(value, 'manualBuildId', where),
    pdfVolumes: countField(value, 'pdfVolumes', where),
    productName: textField(application, 'productName', `${where}の application`),
    applicationVersion: textField(application, 'version', `${where}の application`),
    files: files.map((file: unknown) => ({
      path: textField(file, 'path', where), bytes: countField(file, 'bytes', where), sha256: textField(file, 'sha256', where),
    })),
  };
}

function requiredPath(name: 'PCAD_PACKAGED_EXECUTABLE' | 'PCAD_PACKAGED_CANDIDATE', meaning: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`環境変数 ${name} に${meaning}を指定してください(相対パスはリポジトリの根から)。手順は scripts/release/README.md の「配布物の起動確認」。`);
  }
  return resolve(root, value.trim());
}

async function readJson(path: string): Promise<unknown> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  return parsed;
}

async function countRegularFiles(directory: string): Promise<number> {
  let total = 0;
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory()) pending.push(join(current, entry.name));
      else if (entry.isFile()) total += 1;
    }
  }
  return total;
}

async function readLaunchTarget(): Promise<LaunchTarget> {
  const given = requiredPath('PCAD_PACKAGED_EXECUTABLE', '起動する配布物の実行ファイル');
  const executable = await realpath(given).catch((error: unknown) => {
    throw new Error(`配布物の実行ファイルが見つかりません: ${given}`, { cause: error });
  });
  const candidatePath = requiredPath('PCAD_PACKAGED_CANDIDATE', 'その配布物の candidate.json');
  assertCommandSafe(executable, '配布物の実行ファイル');
  if (!(await stat(executable)).isFile()) throw new Error(`配布物の実行ファイルがファイルではありません: ${executable}`);
  const appDirectory = dirname(executable);
  const resourcesApp = join(appDirectory, 'resources', 'app');
  const candidate = readCandidate(await readJson(candidatePath));
  if (candidate.platform !== process.platform) {
    throw new Error(`candidate.json は ${candidate.platform} 用です。この検査は ${process.platform} で動いています。`);
  }
  let packaged: PackagedRecord;
  try { packaged = readPackaged(await readJson(join(resourcesApp, 'desktop-package.json'))); }
  catch (error) {
    throw new Error(`実行ファイルの隣に配布物の resources/app/desktop-package.json がありません(ポータブル版の .exe は直接起動できない。展開後・導入後の本体を渡す): ${executable}`, { cause: error });
  }
  return { executable, appDirectory, resourcesApp, candidatePath, candidate, packaged,
    metadataSha256: sha256(await readFile(join(resourcesApp, 'package.json'))),
    packagedFiles: await countRegularFiles(resourcesApp) };
}

/** 前の実行の一時フォルダーのうち、十分古いものだけを消す(今の実行のものは作る前なので含まれない)。 */
async function sweepStaleIsolation(): Promise<void> {
  let names: string[];
  try { names = await readdir(ISOLATION_PARENT); }
  catch { return; }
  const cutoff = Date.now() - STALE_ISOLATION_AGE_MS;
  await Promise.all(names.map(async (name) => {
    const path = join(ISOLATION_PARENT, name);
    try { if ((await stat(path)).mtimeMs < cutoff) await rm(path, { recursive: true, force: true }); }
    catch { /* 片付けは最善努力。既に無ければ何もしない */ }
  }));
}

async function prepareIsolation(): Promise<Isolation> {
  await sweepStaleIsolation();
  const base = join(ISOLATION_PARENT, randomUUID().replace(/-/gu, '').slice(0, 6));
  const userData = join(base, 'u');
  if (process.platform === 'win32' && userData.length > USER_DATA_PATH_BUDGET) {
    throw new Error(`一時の userData のパスが長すぎます(${userData.length}文字。上限${USER_DATA_PATH_BUDGET}文字): ${userData}`);
  }
  assertCommandSafe(userData, '一時の userData');
  await mkdir(userData, { recursive: true });
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  // Electron を Node として動かす指定が残っていると、配布物の画面が起動しない。
  delete env.ELECTRON_RUN_AS_NODE;
  let xdgConfigHome: string | null = null;
  if (process.platform === 'linux') {
    // --user-data-dir が効かなかった場合も、Linux の既定の置き場(~/.config など)へ書かないようにする。
    for (const [name, folder] of [['XDG_CONFIG_HOME', 'config'], ['XDG_CACHE_HOME', 'cache'],
      ['XDG_DATA_HOME', 'data'], ['XDG_STATE_HOME', 'state']] as const) {
      const path = join(base, 'x', folder);
      await mkdir(path, { recursive: true });
      env[name] = path;
    }
    xdgConfigHome = join(base, 'x', 'config');
  }
  return { base, userData, xdgConfigHome, env };
}

/** 利用者の実際のプロファイルの置き場。起動の前後の一覧の比較にだけ使い、書き込まない。 */
function realProfileRoots(productName: string): string[] {
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA, local = process.env.LOCALAPPDATA;
    if (roaming === undefined || local === undefined) throw new Error('APPDATA と LOCALAPPDATA を読めません');
    return [join(roaming, productName), join(local, productName)];
  }
  const home = homedir();
  return [join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), productName),
    join(process.env.XDG_CACHE_HOME ?? join(home, '.cache'), productName)];
}

/** 読むだけの一覧(名前・種類・大きさ・更新時刻)。リンクの先へは入らない。 */
async function snapshotTree(directory: string): Promise<TreeSnapshot> {
  const describe = async (path: string): Promise<TreeEntry> => {
    const info = await lstat(path);
    const kind: TreeEntry['kind'] = info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
    return { path: relative(directory, path).split(sep).join('/') || '.', kind, bytes: info.size, modifiedMs: info.mtimeMs };
  };
  let top: TreeEntry;
  try { top = await describe(directory); }
  catch (error) {
    if (isMissing(error)) return { root: directory, exists: false, entries: [] };
    throw error;
  }
  const entries: TreeEntry[] = [top];
  const pending = top.kind === 'directory' ? [directory] : [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const name of (await readdir(current)).sort()) {
      const entry = await describe(join(current, name));
      entries.push(entry);
      if (entry.kind === 'directory') pending.push(join(current, name));
    }
  }
  return { root: directory, exists: true, entries };
}

function treeDifferences(before: TreeSnapshot, after: TreeSnapshot): string[] {
  if (before.exists !== after.exists) return [`${before.root}: 有無が変わった(${String(before.exists)} → ${String(after.exists)})`];
  const earlier = new Map(before.entries.map(entry => [entry.path, entry]));
  const differences: string[] = [];
  for (const entry of after.entries) {
    const previous = earlier.get(entry.path);
    if (previous === undefined) differences.push(`${before.root}: 追加 ${entry.path}`);
    else if (previous.kind !== entry.kind || previous.bytes !== entry.bytes || previous.modifiedMs !== entry.modifiedMs) {
      differences.push(`${before.root}: 変更 ${entry.path}`);
    }
    earlier.delete(entry.path);
  }
  for (const path of earlier.keys()) differences.push(`${before.root}: 削除 ${path}`);
  return differences;
}

function summarizeTree(snapshot: TreeSnapshot): Record<string, unknown> {
  return { root: snapshot.root, exists: snapshot.exists, entries: snapshot.entries.length,
    bytes: snapshot.entries.reduce((total, entry) => total + (entry.kind === 'file' ? entry.bytes : 0), 0),
    latestModifiedMs: snapshot.entries.reduce((latest, entry) => Math.max(latest, entry.modifiedMs), 0) };
}

// Windows は全プロセスの実行ファイルのパスを CIM から読む(wmic は Windows 11 で廃止)。
const WINDOWS_PROCESS_QUERY = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  '$items = @(Get-CimInstance -ClassName Win32_Process | Where-Object { $_.ExecutablePath } | '
    + 'ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; path = [string]$_.ExecutablePath } })',
  'ConvertTo-Json -InputObject $items -Compress',
].join('; ');

async function listProcesses(): Promise<ProcessEntry[]> {
  if (process.platform === 'win32') {
    const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_QUERY],
      { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
    const parsed: unknown = JSON.parse(stdout.trim() === '' ? '[]' : stdout);
    if (!Array.isArray(parsed)) throw new Error('プロセスの一覧を読めません');
    return parsed.map((item: unknown) => ({ pid: countField(item, 'pid', 'プロセスの一覧'), path: textField(item, 'path', 'プロセスの一覧') }));
  }
  if (process.platform === 'linux') {
    const entries: ProcessEntry[] = [];
    for (const name of await readdir('/proc')) {
      if (!/^\d+$/u.test(name)) continue;
      try { entries.push({ pid: Number(name), path: await readlink(join('/proc', name, 'exe')) }); }
      catch { /* 他の利用者のプロセスや、読む間に終わったプロセスは読めない */ }
    }
    return entries;
  }
  throw new Error('配布物の起動確認は Windows と Linux だけに対応します');
}

/**
 * 配布物のフォルダーから動いているプロセス。起動前は、同じ名前の本体(導入版・ポータブル版など)も
 * 実際のプロファイルを書き換え得るため Windows では含めて確かめる。
 */
async function packagedProcesses(target: LaunchTarget, includeSameName: boolean): Promise<ProcessEntry[]> {
  const name = basename(target.executable);
  return (await listProcesses()).filter(entry => isWithin(entry.path, target.appDirectory)
    || (includeSameName && samePath(basename(entry.path), name)));
}

/** (f) の失敗の後片付け。閉じた後も残ったプロセスだけを止め、止めた事実を失敗の理由に書く。 */
function stopLeftovers(entries: readonly ProcessEntry[]): string[] {
  return entries.map((entry) => {
    try { process.kill(entry.pid, 'SIGKILL'); return `${String(entry.pid)} を停止`; }
    catch (error) { return `${String(entry.pid)} を停止できず: ${error instanceof Error ? error.message : String(error)}`; }
  });
}

async function launchPackaged(playwright: PlaywrightWorkerArgs['playwright'], target: LaunchTarget, isolation: Isolation): Promise<ElectronApplication> {
  return playwright._electron.launch({
    executablePath: target.executable,
    args: [...SWIFTSHADER_ARGS, `--user-data-dir=${isolation.userData}`],
    cwd: isolation.base,
    env: isolation.env,
    // Playwright 1.62.1 は Linux で chromiumSandbox が true でない限り --no-sandbox を足す。検査からは足さない。
    // Linux の AppRun(electron-builder 26.15.3 の AppImage の入口)は `unshare -Ur true` で利用者の名前空間を
    // 試し、使えないときだけ自分で --no-sandbox を足して本体を起動する。利用者が AppImage を開いたときと同じ判断を
    // そのまま検査する(Windows ではこの指定は何も変えない)。
    chromiumSandbox: true,
    timeout: 60_000,
  });
}

function createItemRecorder(): { records: ItemRecord[]; run: <T>(id: string, label: string, body: () => Promise<T>) => Promise<T> } {
  const records: ItemRecord[] = [];
  const run = async <T>(id: string, label: string, body: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    try {
      const value = await test.step(`${id} ${label}`, body);
      records.push({ id, label, result: '成功', ms: Math.round(performance.now() - started) });
      return value;
    } catch (error) {
      records.push({ id, label, result: '失敗', ms: Math.round(performance.now() - started),
        error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000) });
      throw error;
    }
  };
  return { records, run };
}

test('配布物を一時の userData で起動し、名前・版・画面・同梱の資源・終了を確かめる', async ({ playwright }, info) => {
  test.setTimeout(900_000);
  const { records, run } = createItemRecorder();
  const evidence: Record<string, unknown> = {};
  const session: {
    isolation?: Isolation; profiles?: readonly string[]; before?: readonly TreeSnapshot[];
    app?: ElectronApplication; page?: Page; closed: boolean;
  } = { closed: false };
  const pageErrors: string[] = [], crashes: string[] = [], consoleErrors: string[] = [];
  let completed = false;
  try {
    const target = await run('(0-1)', '配布物と配布物の記録を読む', () => readLaunchTarget());
    evidence.target = { executable: target.executable, candidate: target.candidatePath, version: target.candidate.version,
      sourceCommit: target.candidate.sourceCommit, packagedFiles: target.packagedFiles };
    const isolation = await prepareIsolation();
    session.isolation = isolation;
    evidence.isolation = { base: isolation.base, userData: isolation.userData, xdgConfigHome: isolation.xdgConfigHome };
    const profiles = realProfileRoots(target.packaged.productName);
    session.profiles = profiles;
    const before = await run('(0-2)', '起動前: 配布物のプロセスが無く、実際のプロファイルの一覧を控える', async () => {
      const running = await packagedProcesses(target, process.platform === 'win32');
      expect(running, '起動前に配布物と同じ名前の本体が動いていないこと(PointerCAD を全て終了してから実行する)').toEqual([]);
      return Promise.all(profiles.map(snapshotTree));
    });
    session.before = before;
    evidence.realProfilesBefore = before.map(summarizeTree);
    const app = await run('(0-3)', '配布物を起動する', () => launchPackaged(playwright, target, isolation));
    session.app = app;
    // Playwright は閉じた後に子プロセスの参照を返せない。生きている間に保持する(rules/06 §10.87)。
    const child = app.process();
    await run('(1)', 'userData が一時フォルダーの下にある(外れたら直ちに閉じて失敗)', async () => {
      const reported = await app.evaluate(({ app: electronApp, BrowserWindow }) => {
        // 自動操作の窓へ利用者の入力を入れない(launchDesktop と同じ。Playwright の入力は webContents へ直接届く)。
        for (const window of BrowserWindow.getAllWindows()) { window.setFocusable(false); window.setIgnoreMouseEvents(true); }
        electronApp.on('browser-window-created', (_event, window) => { window.setFocusable(false); window.setIgnoreMouseEvents(true); });
        return { userData: electronApp.getPath('userData'), argv: process.argv };
      });
      const actual = await realpath(reported.userData);
      expect(isWithin(actual, await realpath(isolation.base)),
        `userData(${reported.userData})が一時フォルダー(${isolation.base})の下にあること`).toBe(true);
      // userData を確かめた後にだけ、作られ得る他の置き場を読む(外れていたら実際のプロファイルへ作らせない)。
      const others = await app.evaluate(({ app: electronApp }) => {
        const read = (name: 'sessionData' | 'crashDumps'): string | null => {
          try { return electronApp.getPath(name); } catch { return null; }
        };
        return { sessionData: read('sessionData'), crashDumps: read('crashDumps') };
      });
      for (const [name, path] of Object.entries(others)) {
        if (path !== null) expect(isWithin(resolve(path), isolation.base), `${name}(${path})も一時フォルダーの下にあること`).toBe(true);
      }
      const mechanism = samePath(actual, await realpath(isolation.userData)) ? '--user-data-dir'
        : isolation.xdgConfigHome !== null && isWithin(actual, isolation.xdgConfigHome) ? 'XDG_CONFIG_HOME' : 'その他';
      evidence.userData = { reported: reported.userData, mechanism, ...others,
        sandbox: process.platform !== 'linux' ? 'Windows の既定'
          : reported.argv.includes('--no-sandbox') ? 'AppRun が --no-sandbox を追加' : '有効' };
    });
    const page = await run('(a)', '窓が表示されて最初の読込みが終わる', async () => {
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows();
        return windows.length > 0 && windows.every(window => window.isVisible() && !window.webContents.isLoadingMainFrame());
      }), { message: '配布物の窓が表示され、最初の読込みが終わること', timeout: 60_000 }).toBe(true);
      const first = await app.firstWindow({ timeout: 30_000 }).catch((error: unknown) => {
        throw new Error('窓は表示されたが Playwright が画面へ接続できなかった(配布物には起動の保留が無い。rules/06 §10.87 の競合の疑い)', { cause: error });
      });
      await expect(first.getByRole('button', { name: uiMessage('toolbar', 'toolbar.file.open'), exact: true })).toBeVisible();
      return first;
    });
    session.page = page;
    const observe = (opened: Page): void => {
      opened.on('pageerror', error => { pageErrors.push(`${opened.url()}: ${error.message}`.slice(0, 2_000)); });
      opened.on('crash', () => { crashes.push(opened.url()); });
      opened.on('console', message => {
        if (message.type() === 'error' && consoleErrors.length < 50) consoleErrors.push(message.text().slice(0, 1_000));
      });
    };
    for (const opened of app.windows()) observe(opened);
    app.on('window', observe);
    await run('(b)', '製品の名前と版が配布物の記録と一致する', async () => {
      const identity = await app.evaluate(({ app: electronApp, BrowserWindow }) => ({
        name: electronApp.getName(), version: electronApp.getVersion(), isPackaged: electronApp.isPackaged,
        appPath: electronApp.getAppPath(), execPath: process.execPath, electron: process.versions.electron,
        platform: process.platform, arch: process.arch, titles: BrowserWindow.getAllWindows().map(window => window.getTitle()),
      }));
      evidence.identity = identity;
      const { candidate, packaged } = target;
      expect(identity.isPackaged, '配布物として起動していること').toBe(true);
      expect(samePath(dirname(await realpath(identity.execPath)), target.appDirectory), `本体(${identity.execPath})が渡したフォルダーのものであること`).toBe(true);
      expect(samePath(resolve(identity.appPath), target.resourcesApp), `読んだアプリ(${identity.appPath})が配布物の resources/app であること`).toBe(true);
      expect(identity.name, '製品の名前').toBe(packaged.productName);
      expect(identity.titles, '空の文書の窓の題名(利用者が見る製品の名前)').toEqual([uiMessage('view', 'app.title')]);
      expect([identity.version, packaged.version, packaged.applicationVersion], '版').toEqual([candidate.version, candidate.version, candidate.version]);
      expect(identity.electron, 'Electron の版').toBe(packaged.electronVersion);
      expect([identity.platform, identity.arch, packaged.platform, packaged.arch], 'OS と CPU')
        .toEqual([candidate.platform, candidate.arch, candidate.platform, candidate.arch]);
      expect(packaged.sourceCommit, '作った commit').toBe(candidate.sourceCommit);
      expect(target.metadataSha256, 'アプリの package.json の SHA-256').toBe(candidate.applicationMetadataSha256);
      expect([packaged.manualBuildId, packaged.pdfVolumes], '同梱の説明書の版と PDF の巻数').toEqual([candidate.manualBuildId, candidate.pdfVolumes]);
      expect([target.packagedFiles, packaged.files.length + 1], 'resources/app のファイル数').toEqual([candidate.files, candidate.files]);
    });
    await run('(c)', '主要な画面の要素(electron-startup.spec.ts と同じもの)', async () => {
      // 同じ検査のうち、起動の保留の記録(bootstrap.json)と窓の焦点は対象外。配布物には loader を入れられず、
      // 焦点を外す指定も窓が表示された後にしか掛けられないため。
      expect(page.url()).toBe('app://pointercad/index.html');
      expect(await page.evaluate(() => globalThis.crossOriginIsolated), '独自スキームの隔離の見出しが効いていること').toBe(true);
      await chooseToolMenuItem(page, uiMessage('toolbar', 'toolbar.shape.groupLabel'), uiMessage('sketch', 'functionPlot.menuTitle'));
      await expect(page.locator('.pcad-function-dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.pcad-function-dialog')).toHaveCount(0);
      await waitForStartupHealth(page, info);
      const search = page.locator('.pcad-panel--left input').first();
      await search.fill('startup-input'); await expect(search).toHaveValue('startup-input'); await search.fill('');
      // 最初の読込みは Playwright の接続より前に始まるため、例外の見張りを付けた状態で読み直して確かめる。
      await page.reload();
      await expect(page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.file.open'), exact: true })).toBeVisible();
      await waitForStartupHealth(page, info);
      expect(await app.evaluate(({ app: electronApp }) => electronApp.isReady())).toBe(true);
      // (d-3) で図面が字体を読んだ記録を確かめるため、資源の読込みの記録を取りこぼさない大きさにする。
      await page.evaluate(() => { performance.setResourceTimingBufferSize(100_000); });
    });
    await run('(d-1)', '同梱の形状の計算部(OCCT WASM)で箱を作る', async () => {
      await chooseToolMenuItem(page, uiMessage('toolbar', 'toolbar.create.groupLabel'), uiMessage('toolbar', 'toolbar.solid.box'));
      const fields = page.locator('.pcad-popover input.pcad-field__input');
      await expect(fields).toHaveCount(3);
      for (const [index, size] of ['20mm', '30mm', '40mm'].entries()) await fields.nth(index).fill(size);
      const token = await beginRecompute(page);
      await fields.first().press('Enter');
      await waitForRecompute(page, token);
      const box = page.locator('.pcad-panel--left').getByRole('button', { name: '箱1', exact: true });
      await expect(box).toBeVisible();
      if (await page.locator('.pcad-popover').count() > 0) await page.locator('.pcad-popover input').first().press('Escape');
      await box.click();
      const volume = page.locator('.pcad-panel--right dt.pcad-properties__key', { hasText: uiMessage('propertyPanel', 'propertyPanel.volume') })
        .locator('xpath=following-sibling::dd[1]');
      await expect(volume).toHaveText('24000 mm³', { timeout: KERNEL_TIMEOUT_MS });
    });
    await run('(d-2)', '同梱の数式の計算部で積分を求める', async () => {
      // e2e/release/offlineDomainCoverage.ts の verifyOfflineExactMath と同じ入口と式(通信の見張りは無い)。
      await page.getByRole('tab', { name: uiMessage('propertyPanel', 'propertyPanel.tabParameters'), exact: true }).click();
      await page.getByRole('button', { name: uiMessage('parameters', 'parameterPanel.addTooltip'), exact: true }).click();
      const row = page.locator('.pcad-parameter').last();
      const dialog = page.locator('.pcad-math-dialog');
      await row.locator('.pcad-field').first().locator('input').fill('厳密係数');
      await row.getByRole('button', { name: uiMessage('math', 'math.open'), exact: true }).click();
      await waitForMathEditorText(dialog);
      await dialog.locator('textarea').fill('integrate(t^2,t,0,3)');
      await expect(dialog.locator('.pcad-math-editor__result[role="status"]')).toHaveText('= 9', { timeout: 225_000 });
      await dialog.getByRole('button', { name: uiMessage('math', 'math.apply'), exact: true }).click();
      await expect(dialog).toHaveCount(0);
    });
    await run('(d-3)', '同梱の字体で図面を描く', async () => {
      await chooseToolMenuItem(page, uiMessage('toolbar', 'toolbar.fileMenu.groupLabel'), uiMessage('drawing', 'drawing.file.fromPart'));
      await expect(page.locator('.pcad-drawing-svg svg')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
      await expect.poll(() => page.locator('.pcad-drawing-svg [data-owner-id="view-1"] path').count(), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
      await expect(page.getByRole('alert').filter({ hasText: uiMessage('drawing', 'drawing.error.fontFailed') })).toHaveCount(0);
      await expect(page.getByRole('button', { name: uiMessage('drawing', 'drawing.font.retry'), exact: true })).toHaveCount(0);
      // 図面が実際に読んだ字体を、同じ独自スキームで読み直して配布物の記録(desktop-package.json)の大きさと SHA-256 に照らす。
      const fonts = await page.evaluate(async () => {
        const urls = [...new Set(performance.getEntriesByType('resource')
          .filter(entry => entry instanceof PerformanceResourceTiming && entry.initiatorType === 'fetch'
            && new URL(entry.name).pathname.startsWith('/fonts/'))
          .map(entry => entry.name))];
        const results: { url: string; path: string; status: number; bytes: number; sha256: string }[] = [];
        for (const url of urls) {
          const response = await fetch(url);
          const bytes = await response.arrayBuffer();
          const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
            .map(byte => byte.toString(16).padStart(2, '0')).join('');
          results.push({ url, path: new URL(url).pathname, status: response.status, bytes: bytes.byteLength, sha256: digest });
        }
        return results;
      });
      evidence.fonts = fonts;
      expect(fonts.length, '図面が同梱の字体を読んだこと').toBeGreaterThan(0);
      for (const font of fonts) {
        const recorded = target.packaged.files.find(file => file.path === `dist/renderer${font.path}`);
        expect(recorded, `配布物の記録に ${font.path} があること`).toBeDefined();
        expect({ status: font.status, bytes: font.bytes, sha256: font.sha256 }, `${font.url} の中身`)
          .toEqual({ status: 200, bytes: recorded?.bytes, sha256: recorded?.sha256 });
      }
    });
    await run('(e)', 'pageerror が0件', async () => {
      expect(pageErrors, '配布物の画面で捕まらなかった例外(pageerror)が無いこと').toEqual([]);
      expect(crashes, '画面の処理が落ちていないこと').toEqual([]);
    });
    await run('(f)', '閉じた後に配布物のプロセスが残らない', async () => {
      await app.close();
      session.closed = true;
      await expect.poll(() => [child.exitCode, child.signalCode], { message: '配布物が終了コード0で終わること', timeout: PROCESS_EXIT_TIMEOUT_MS })
        .toEqual([0, null]);
      let remaining: ProcessEntry[] = [];
      try {
        await expect.poll(async () => {
          remaining = await packagedProcesses(target, false);
          return remaining.length;
        }, { message: '配布物のフォルダーから動くプロセスが無くなること', timeout: PROCESS_EXIT_TIMEOUT_MS, intervals: [1_000] }).toBe(0);
      } catch (error) {
        const stopped = stopLeftovers(remaining);
        throw new Error(`閉じてから${String(PROCESS_EXIT_TIMEOUT_MS / 1_000)}秒後も配布物のプロセスが残った: ${JSON.stringify(remaining)}(検査の片付けとして停止: ${stopped.join('、')})`, { cause: error });
      }
    });
    await run('(2)', '実際のプロファイルの一覧が起動の前後で変わらない', async () => {
      const after = await Promise.all(profiles.map(snapshotTree));
      evidence.realProfilesAfter = after.map(summarizeTree);
      const differences = before.flatMap((snapshot, index) => treeDifferences(snapshot, after[index] ?? snapshot));
      expect(differences, '実際のプロファイルの名前・大きさ・更新時刻が変わらないこと').toEqual([]);
      const used = await readdir(isolation.userData);
      evidence.temporaryUserData = used.sort();
      expect(used.length, '起動した配布物が一時の userData を使ったこと').toBeGreaterThan(0);
    });
    completed = true;
  } finally {
    if (!completed && session.page !== undefined && !session.closed) {
      await session.page.screenshot({ path: info.outputPath('packaged-desktop-failure.png') }).catch(() => undefined);
    }
    if (session.app !== undefined && !session.closed) await session.app.close().catch(() => undefined);
    const { profiles, before, isolation } = session;
    if (!completed && profiles !== undefined && before !== undefined) {
      // 失敗の回も、実際のプロファイルが変わったかどうかを記録に残す(判定は失敗のまま)。
      evidence.realProfilesAfterFailure = await Promise.all(profiles.map(snapshotTree))
        .then(after => before.flatMap((snapshot, index) => treeDifferences(snapshot, after[index] ?? snapshot)))
        .catch((error: unknown) => `読めません: ${error instanceof Error ? error.message : String(error)}`);
    }
    evidence.pageErrors = pageErrors; evidence.crashes = crashes; evidence.consoleErrors = consoleErrors;
    const summary = JSON.stringify({ records, evidence }, null, 2);
    for (const record of records) {
      console.log(`[配布物の起動] ${record.id} ${record.label}: ${record.result} ${String(record.ms)}ms${record.error === undefined ? '' : ` (${record.error.split('\n')[0] ?? ''})`}`);
    }
    await mkdir(info.outputDir, { recursive: true });
    await writeFile(info.outputPath('packaged-desktop-results.json'), summary + '\n');
    await info.attach('packaged-desktop-results', { body: summary, contentType: 'application/json' });
    // 成功した回だけ一時フォルダーを消す。失敗の回は証拠として残し、次の実行が古いものを片付ける。
    if (completed && isolation !== undefined) await rm(isolation.base, { recursive: true, force: true });
  }
});
