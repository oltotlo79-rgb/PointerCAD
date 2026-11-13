/// <reference lib="dom" />
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test, type Browser, type BrowserContext, type ElectronApplication, type Page,
  type PlaywrightWorkerArgs } from '@playwright/test';
import { DRAWING_FONT_ASSET } from '../../packages/drawing/src/text/fontAsset.js';
import { chooseToolMenuItem } from '../tests/assemblyTestSupport.js';
import { readPart } from '../tests/canvasAssetLifetimeFlow.js';
import { diskFile } from '../tests/electronAppFlow.js';
import { fileAction } from '../tests/fileCaptureSupport.js';
import { waitForMathEditorText } from '../tests/mathEditorReady.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, readRecomputeStats, waitForRecompute } from '../tests/recompute.js';
import { uiMessage } from '../tests/uiMessages.js';
import { verifyPackagedStartup } from './packagedStartup.js';
import { openCdpConnection, optionalField, probeFrameUrls, withDeadline, type CdpConnection } from './portableDesktopSupport.js';

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
 * loader を足さず、配布物は既定の本体だけを読む)。そのため electron.launch は、窓の最初の読込みの途中に
 * Chromium へつながることがある。接続の時点の文書が最初の空の文書だと、Playwright は次の確定の知らせ
 * (Page.frameNavigated)を待つが、その確定は別の描画の処理の中で起き、知らせが届かずに60秒で止まった
 * (2026-11-12 配布CI run 43228964079 の接続の記録。rules/06 §10.87 の起動の競合)。そこで配布物はこの検査が
 * 自分で起動し、製品が出す最初の文書の確定の行(apps/desktop/src/main/main.ts の document-ready)を見てから、
 * Chromium へは connectOverCDP、主の処理へは Node の検査口でつなぐ(launchPackaged)。起動の上限は明示し、
 * 窓の表示と最初の読込みの完了も main 側から確かめてから操作する。
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
/**
 * app.close() を待つ上限。(f) の正常な終了(PROCESS_EXIT_TIMEOUT_MS)の2倍。
 * (f) 自身の最初の close 呼出しと、失敗の後片付けの close 呼出しの両方で使う(2026-09-29: 外部の重い負荷と
 * 重なった手元の実行で (f) の `await app.close()` が戻らず、この保護の無い旧版は900秒のテスト上限まで
 * 止まって worker ごと強制終了された。(f) にも同じ上限を掛け、原因を記録に残してから失敗させる)。
 */
const CLEANUP_CLOSE_TIMEOUT_MS = 60_000;
/**
 * 「この部品から図面を作成」を製品が断る時にステータスバーへ出す文の鍵(packages/ui/src/drawing/createDrawingCommands.ts の
 * 計算中・図面を開いている時の断りと、catch で選ぶ理由の全て)。(d-3) はこの文が出たら、その文で直ちに落とす。
 */
const DRAWING_REFUSAL_KEYS = ['drawing.error.noSolid', 'drawing.error.viewFailed', 'drawing.error.partTooLarge',
  'drawing.error.selectSource', 'drawing.error.assemblyConstraints'] as const;
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
/** Windows で % と " を含むパスは、cmd.exe を介した起動(手での再現を含む)で書き換わるため先に断る。 */
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
  // Playwright の接続の記録の指定(DEBUG・DEBUG_FILE)は検査の側だけのもの。起動する配布物へは渡さない。
  delete env.DEBUG;
  delete env.DEBUG_FILE;
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

/** 本体が出した閉じるときの確認を、本体の標準出力へ書く行の印。(f) は閉じた後に子プロセスの出力から数える。 */
const CLOSE_CONFIRM_LOG = '[配布物の起動:閉じる確認]';
const CLOSE_CONFIRM_CHOICES = [uiMessage('file', 'file.closeGuard.save'), uiMessage('file', 'file.closeGuard.discard'),
  uiMessage('file', 'file.closeGuard.cancel')];

/**
 * 窓を閉じるときの未保存の確認(レビュー R03、apps/desktop/src/main/closeGuard.ts)に、利用者と同じく
 * 「保存せずに閉じる」で答える。検査の後片付けで確認を省く印(electronAppFlow.ts の launchDesktop)は使わない。
 * 確認の窓は OS の窓で Playwright から押せないので、本体の `dialog.showMessageBox` を、出されたボタンから
 * 画面の文言(ja.json)の「保存せずに閉じる」を選ぶものへ替える。未保存の判定・画面への問合せ・画面の答え・
 * 窓を閉じて終わる処理は配布物のまま通る。想定と違う確認(画面が固まったときの確認など)には「戻る」で答え、
 * 閉じられないまま上限で失敗させる。出された確認は本体の標準出力へ書く(閉じた後は Playwright から本体を読めない)。
 */
async function answerCloseConfirmWithDiscard(app: PackagedApplication): Promise<void> {
  await app.evaluate(({ dialog }, [marker, choices]) => {
    dialog.showMessageBox = (...args: unknown[]) => {
      const options: unknown = args.at(-1);
      const raw: unknown = typeof options === 'object' && options !== null ? Reflect.get(options, 'buttons') : undefined;
      const buttons = Array.isArray(raw) ? raw.map(String) : [];
      console.log(`${marker}${JSON.stringify(buttons)}`);
      const expected = buttons.length === choices.length && buttons.every((button, index) => button === choices[index]);
      // 1 は「保存せずに閉じる」(CLOSE_CONFIRM_CHOICES の順)。想定外なら最後のボタン(戻る)。
      return Promise.resolve({ response: expected ? 1 : Math.max(buttons.length - 1, 0), checkboxChecked: false });
    };
  }, [CLOSE_CONFIRM_LOG, CLOSE_CONFIRM_CHOICES] as const);
}

/** 保存と開き直しの確かめで、本体の標準出力へ書く行の印。失敗の時だけ packaged-desktop-output.log と evidence.saveOpen で読む。 */
const SAVE_OPEN_LOG = '[配布物の起動:保存と開く]';
/** 保存先と開く元のファイルの名前。置き場は検査の一時フォルダー(isolation.base)で、利用者の実際のフォルダーに触れない。 */
const SAVED_DOCUMENT_NAME = 'packaged-saved.pcad';

/**
 * 保存先と開く元の窓(OS の窓で Playwright から押せない)を、e2e/tests/electronAppFlow.ts の saveTarget・openTarget と同じ形で
 * 検査の一時フォルダーの 1 つのファイルへ差し替える。差し替えた窓は呼ばれた回数を数える(pcadPackagedDialogCalls で読む)。
 * あわせて、保存・開くの口(preload.ts の pcad:saveBegin・saveChunk・saveCommit・saveAbort、pcad:openBegin・openChunk・
 * openFinish・openAbort・openReread)の呼出し・戻り・例外を本体の標準出力へ書く。口の中身・戻り値・例外は変えない
 * (ipcMain の内部の表 _invokeHandlers の関数を包むだけ。読めない版ではその旨を書いて続ける)。行は出力の輪に入り、
 * 失敗した回だけ書き出す(成功の回の所要は、この 1 回の評価の分しか増えない)。
 */
async function installSaveOpenTargets(app: PackagedApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog, ipcMain }, [filePath, marker]) => {
    const log = (text: string): void => { console.log(`${marker} ${new Date().toISOString()} ${text}`); };
    const calls = { save: 0, open: 0 };
    Reflect.set(globalThis, 'pcadPackagedDialogCalls', () => ({ ...calls }));
    dialog.showSaveDialog = () => {
      calls.save += 1;
      log(`showSaveDialog ${String(calls.save)} 回目`);
      return Promise.resolve({ canceled: false, filePath });
    };
    dialog.showOpenDialog = () => {
      calls.open += 1;
      log(`showOpenDialog ${String(calls.open)} 回目`);
      return Promise.resolve({ canceled: false, filePaths: [filePath] });
    };
    const describe = (value: unknown): string => {
      if (value instanceof Uint8Array) return `bytes(${String(value.byteLength)})`;
      try { return (JSON.stringify(value) ?? String(value)).slice(0, 300); } catch { return Object.prototype.toString.call(value); }
    };
    const handlers: unknown = Reflect.get(ipcMain, '_invokeHandlers');
    if (!(handlers instanceof Map)) { log('ipcMain の口の表を読めません(口の記録なし)'); return; }
    const entries: [unknown, unknown][] = [...handlers.entries()];
    for (const [channel, handler] of entries) {
      if (typeof channel !== 'string' || typeof handler !== 'function'
        || !/^pcad:(?:save(?:Begin|Chunk|Commit|Abort)|open(?:Begin|Chunk|Finish|Abort|Reread))$/u.test(channel)) continue;
      handlers.set(channel, async (...args: unknown[]) => {
        log(`${channel} 呼出し ${args.slice(1).map(describe).join(' ')}`);
        try {
          const result: unknown = await Reflect.apply(handler, undefined, args);
          log(`${channel} 戻り ${describe(result)}`);
          return result;
        } catch (error) {
          log(`${channel} 例外 ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
          throw error;
        }
      });
    }
  }, [path, SAVE_OPEN_LOG] as const);
}

/** (d-1b) の保存と開き直しの進み。失敗した回だけ evidence.saveOpen へ残す。 */
interface SaveOpenRecord {
  stage: string;
  savedBytes: number | null;
  recomputeBeforeSave?: unknown;
  dialogCalls?: unknown;
  channelLog?: string[];
}

/** installSaveOpenTargets で差し替えた保存先・開く元の窓が呼ばれた回数({ save, open })。差し替える前は null。 */
async function readSaveOpenDialogCalls(app: PackagedApplication): Promise<unknown> {
  return app.evaluate(() => {
    const read: unknown = Reflect.get(globalThis, 'pcadPackagedDialogCalls');
    const counted: unknown = typeof read === 'function' ? Reflect.apply(read, undefined, []) : null;
    return counted;
  });
}

/** 配布物の起動の上限(以前の electron.launch と同じ値)。3 行の待ちと 2 つの接続をこの中で行う。 */
const LAUNCH_TIMEOUT_MS = 60_000;
/** 失敗の文へ入れる標準エラー・標準出力の末尾の行数。 */
const OUTPUT_TAIL_LINES = 15;
/** 配布物の出力の輪に残す行数(標準出力・標準エラー・読めなかった CDP の行の合計)。失敗の時だけ書き出す。 */
const OUTPUT_RING_LINES = 500;
// Playwright の electron.launch が待つ行と同じ形(Node の検査口と Chromium の接続口)。
const INSPECTOR_LINE = /^Debugger listening on (ws:\/\/\S+)/u;
const DEVTOOLS_LINE = /^DevTools listening on (ws:\/\/\S+)/u;
/** 製品の主の処理が起動の段ごとに標準出力へ出す行(apps/desktop/src/main/main.ts の createMainWindow)。 */
const STARTUP_STAGE_LINE = /^\[pcad:desktop-startup\] (\{.*\})$/u;
/** 検査口がつながったまま主の処理が終わろうとすると Node が出す行。これを見たら検査口を閉じる(Playwright と同じ)。 */
const DEBUGGER_DISCONNECT_LINE = 'Waiting for the debugger to disconnect...';

/** 起動で待つ 3 行の到着の状態。 */
interface LaunchSignals {
  readonly inspector: string | null;
  readonly devtools: string | null;
  readonly documentReady: boolean;
  readonly documentFailed: boolean;
}
const NO_LAUNCH_SIGNALS: LaunchSignals = { inspector: null, devtools: null, documentReady: false, documentFailed: false };

/** [pcad:desktop-startup] の行の段の名前。違う行や壊れた行は null。 */
function startupStage(line: string): string | null {
  const body = STARTUP_STAGE_LINE.exec(line)?.[1];
  if (body === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    const stage = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'stage') : undefined;
    return typeof stage === 'string' ? stage : null;
  } catch {
    return null;
  }
}

/** 配布物の出力の 1 行で、起動で待つ 3 行の状態を進める(一度来た行は戻さない)。 */
function updateLaunchSignals(signals: LaunchSignals, stream: 'stdout' | 'stderr', line: string): LaunchSignals {
  if (stream === 'stderr') {
    return { ...signals, inspector: signals.inspector ?? INSPECTOR_LINE.exec(line)?.[1] ?? null,
      devtools: signals.devtools ?? DEVTOOLS_LINE.exec(line)?.[1] ?? null };
  }
  const stage = startupStage(line);
  return { ...signals, documentReady: signals.documentReady || stage === 'document-ready',
    documentFailed: signals.documentFailed || stage === 'document-failed' };
}

/** 来なかった行の説明(失敗の文に入れる)。 */
function missingLaunchSignals(signals: LaunchSignals): string[] {
  const missing: string[] = [];
  if (signals.inspector === null) missing.push('標準エラーの「Debugger listening on ws://…」(主の処理の Node の検査口)');
  if (signals.devtools === null) missing.push('標準エラーの「DevTools listening on ws://…」(Chromium の接続口)');
  if (!signals.documentReady) missing.push('標準出力の「[pcad:desktop-startup] … "document-ready"」(最初の文書の確定)');
  return missing;
}

/** 配布物の出力の 1 行(届いた時刻・口・中身)。cdp は主の処理の検査口から届いた、JSON として読めなかった行。 */
interface OutputLine {
  readonly at: string;
  readonly stream: 'stdout' | 'stderr' | 'cdp';
  readonly text: string;
}
/** 配布物の出力の輪(末尾 OUTPUT_RING_LINES 行)。検査が失敗した時だけ packaged-desktop-output.log へ書く。 */
interface OutputRing {
  readonly lines: readonly OutputLine[];
  push(stream: OutputLine['stream'], text: string): void;
}
function createOutputRing(): OutputRing {
  const lines: OutputLine[] = [];
  return {
    lines,
    push: (stream, text) => {
      lines.push({ at: new Date().toISOString(), stream, text: text.slice(0, 2_000) });
      if (lines.length > OUTPUT_RING_LINES) lines.shift();
    },
  };
}
function formatOutputRing(ring: OutputRing): string {
  return ring.lines.map(line => `${line.at} [${line.stream}] ${line.text}`).join('\n') + '\n';
}
function outputTail(ring: OutputRing, stream: OutputLine['stream']): string[] {
  return ring.lines.filter(line => line.stream === stream).slice(-OUTPUT_TAIL_LINES).map(line => line.text.slice(0, 300));
}

interface LaunchFailure {
  readonly reason: string;
  readonly elapsedMs: number;
  readonly signals: LaunchSignals;
  readonly frameUrls: string;
  readonly stopped: string;
  readonly stderrTail: readonly string[];
  readonly stdoutTail: readonly string[];
  readonly cdpTail: readonly string[];
}

/** 起動の失敗の文。1 行目に理由と来なかった行、続けて getFrameTree の url・後始末・出力の末尾を書く。 */
function launchFailureMessage(failure: LaunchFailure): string {
  const missing = missingLaunchSignals(failure.signals);
  return [
    `配布物の起動に失敗しました(${String(failure.elapsedMs)}ms、上限 ${String(LAUNCH_TIMEOUT_MS)}ms): ${failure.reason} / `
      + `来なかった行: ${missing.length === 0 ? 'なし(3 行とも来た。止まったのは接続)' : missing.join('、')}`,
    `来た接続口: ${JSON.stringify({ inspector: failure.signals.inspector, devtools: failure.signals.devtools })}`,
    `接続の後の getFrameTree の url: ${failure.frameUrls}`,
    `後始末: ${failure.stopped}`,
    `標準エラーの末尾: ${JSON.stringify(failure.stderrTail)}`,
    `標準出力の末尾: ${JSON.stringify(failure.stdoutTail)}`,
    `読めなかった CDP の行: ${JSON.stringify(failure.cdpTail)}`,
  ].join('\n');
}

/**
 * 起動した本体を子の木ごと止める(Playwright の electron.launch の後始末と同じ。Windows は taskkill /T /F、Linux はプロセスの組)。
 * 「止める物なし」は 'close'(本体と、管を受け継いだ子の全てが管を閉じた)の後だけ。本体の 'exit' の後でも、子が管を持って
 * 残っていれば止めに行く(Linux の kill(-pid) は組の長が終わっていても組に届く)。
 */
function killProcessTree(child: ChildProcess, processClosed: boolean): string {
  const pid = child.pid;
  if (pid === undefined || processClosed) return '止める物なし';
  try {
    if (process.platform === 'win32') {
      const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true, encoding: 'utf8', timeout: PROCESS_EXIT_TIMEOUT_MS });
      return `taskkill /PID ${String(pid)} /T /F: 終了コード ${String(result.status)} ${result.stdout.trim()} ${result.stderr.trim()}`.slice(0, 500);
    }
    process.kill(-pid, 'SIGKILL');
    return `プロセスの組 ${String(pid)} を SIGKILL で停止`;
  } catch (error) {
    return `${String(pid)} を停止できず: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
  }
}

type MainFunction = Extract<Parameters<ElectronApplication['evaluate']>[0], (...args: never[]) => unknown>;
/** 主の処理の electron の型(Playwright の ElectronApplication.evaluate が本文へ渡す物と同じ)。 */
type ElectronModule = Parameters<MainFunction>[0];

/** この検査が起動した配布物。spec が使う ElectronApplication の口と同じ名前(と後始末の kill)だけを持つ。 */
interface PackagedApplication {
  /** 起動の記録(pid・接続口・3 行がそろうまでと接続までの所要)。 */
  readonly launchRecord: Readonly<Record<string, unknown>>;
  evaluate<R, A>(body: (electron: ElectronModule, arg: A) => R | Promise<R>, arg?: A): Promise<R>;
  process(): ChildProcess;
  firstWindow(options: { readonly timeout: number }): Promise<Page>;
  windows(): Page[];
  on(event: 'window', listener: (page: Page) => void): void;
  close(): Promise<void>;
  kill(): string;
  /** 配布物の主の処理の標準出力・標準エラー(と読めなかった CDP の行)の輪。launchPackaged に渡した物と同じ。 */
  readonly output: OutputRing;
}

/**
 * 配布物を起動し、製品が出す最初の文書の確定の行(document-ready)まで待ってから接続する。最初の読込みの途中に
 * つながないので、Playwright は確定の知らせ(Page.frameNavigated)を待たない(冒頭の注記)。引数は以前の electron.launch が
 * 付けていた物と同じ(--inspect=0 と --remote-debugging-port=0 は空いた番号を OS に選ばせる)。Linux の --no-sandbox は
 * 付けない(以前の chromiumSandbox: true と同じ。AppRun が `unshare -Ur true` で試し、使えないときだけ自分で足す。
 * 利用者が AppImage を開いたときと同じ判断をそのまま検査する)。失敗した時は本体を木ごと止め、理由を文にして投げる。
 * 出力は検査が渡した輪(output)へ入れる。起動に失敗して PackagedApplication を返せない時も、検査はその輪を書き出せる。
 */
async function launchPackaged(playwright: PlaywrightWorkerArgs['playwright'], target: LaunchTarget, isolation: Isolation,
  output: OutputRing): Promise<PackagedApplication> {
  const started = Date.now();
  const remaining = (): number => Math.max(started + LAUNCH_TIMEOUT_MS - Date.now(), 1);
  const env = { ...isolation.env };
  // Playwright の electron.launch と同じく、検査の側の NODE_OPTIONS は配布物へ渡さない。
  delete env.NODE_OPTIONS;
  const child = spawn(target.executable, ['--inspect=0', '--remote-debugging-port=0', ...SWIFTSHADER_ARGS,
    `--user-data-dir=${isolation.userData}`], {
    cwd: isolation.base, env, stdio: ['ignore', 'pipe', 'pipe'],
    // Linux は新しいプロセスの組にして、子ごと止められるようにする(Playwright と同じ)。
    detached: process.platform !== 'win32',
  });
  // 検査の worker が先に終わる時も本体を残さない(Playwright の起動と同じ保護)。本体と子が管を閉じ終えたら外す。
  let processClosed = false;
  const killOnExit = (): void => { killProcessTree(child, processClosed); };
  process.once('exit', killOnExit);
  const closed = new Promise<void>((done) => {
    child.once('close', () => { processClosed = true; process.off('exit', killOnExit); done(); });
  });
  let signals = NO_LAUNCH_SIGNALS;
  let inspector: CdpConnection | undefined;
  let notify = (): void => undefined;
  const listen = (stream: Readable | null, name: 'stdout' | 'stderr'): void => {
    if (stream === null) return;
    createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line: string) => {
      const text = line.trimEnd();
      output.push(name, text);
      signals = updateLaunchSignals(signals, name, text);
      if (name === 'stderr' && text.includes(DEBUGGER_DISCONNECT_LINE)) inspector?.close();
      notify();
    });
  };
  let spawnError: string | null = null;
  const signalsReady = new Promise<void>((done, fail) => {
    const settle = (error?: Error): void => {
      clearTimeout(timer);
      notify = (): void => undefined;
      if (error === undefined) done(); else fail(error);
    };
    const timer = setTimeout(() => { settle(new Error(`${String(LAUNCH_TIMEOUT_MS)}ms 以内に 3 行がそろいません`)); }, LAUNCH_TIMEOUT_MS);
    notify = (): void => {
      if (spawnError !== null) settle(new Error(`起動できません: ${spawnError}`));
      else if (signals.documentFailed) settle(new Error('最初の文書の読込みが失敗しました(document-failed)'));
      else if (signals.inspector !== null && signals.devtools !== null && signals.documentReady) settle();
      else if (child.exitCode !== null || child.signalCode !== null) {
        settle(new Error(`配布物が起動の途中で終わりました(終了コード ${String(child.exitCode)}、signal ${String(child.signalCode)})`));
      }
    };
    child.once('error', (error: Error) => { spawnError = error.message; notify(); });
    child.once('exit', () => { notify(); });
  });
  listen(child.stdout, 'stdout');
  listen(child.stderr, 'stderr');
  let browser: Browser | undefined;
  try {
    await signalsReady;
    const signalsMs = Date.now() - started;
    const { inspector: inspectorUrl, devtools: devtoolsUrl } = signals;
    if (inspectorUrl === null || devtoolsUrl === null) throw new Error('接続口の行を読めません');
    const main = await openCdpConnection(inspectorUrl, remaining(), (broken) => { output.push('cdp', broken); });
    inspector = main;
    await withDeadline(main.send('Runtime.enable'), remaining(), '主の処理の検査口の Runtime.enable');
    const connected = await playwright.chromium.connectOverCDP(devtoolsUrl, { timeout: remaining() });
    browser = connected;
    const context: BrowserContext | undefined = connected.contexts()[0];
    if (context === undefined) throw new Error('配布物の Chromium に既定の文脈がありません');
    const launchRecord = { pid: child.pid ?? null, inspector: inspectorUrl, devtools: devtoolsUrl, signalsMs,
      connectedMs: Date.now() - started };
    const evaluate = async <R, A>(body: (electron: ElectronModule, arg: A) => R | Promise<R>, arg?: A): Promise<R> => {
      // Playwright の ElectronApplication.evaluate と同じく、本文を文字にして主の処理で electron を渡して呼ぶ。require は
      // includeCommandLineAPI の時だけ使える(Electron 28 以降。Playwright も同じ指定)。値は JSON の形で返る(returnByValue)。
      const reply = await main.send('Runtime.evaluate', {
        expression: `(${body.toString()})(require('electron'), ${arg === undefined ? 'undefined' : JSON.stringify(arg)})`,
        includeCommandLineAPI: true, awaitPromise: true, returnByValue: true });
      const details = optionalField(reply, 'exceptionDetails');
      if (details !== undefined) {
        const description = optionalField(optionalField(details, 'exception'), 'description');
        throw new Error(`主の処理での評価が失敗しました: ${(typeof description === 'string' ? description : JSON.stringify(details)).slice(0, 1_000)}`);
      }
      // 戻り値は本文の戻り値を JSON にした物(Playwright の ElectronApplication.evaluate と同じ約束)。
      return optionalField(optionalField(reply, 'result'), 'value') as R;
    };
    return {
      launchRecord,
      evaluate,
      process: () => child,
      firstWindow: async ({ timeout }) => context.pages()[0] ?? await context.waitForEvent('page', { timeout }),
      windows: () => context.pages(),
      on: (_event, listener) => { context.on('page', listener); },
      close: async () => {
        if (child.exitCode === null && child.signalCode === null) {
          // Playwright の ElectronApplication.close と同じ道: 主の処理で app.quit() を呼び、検査口を閉じ、本体の終了を待つ。
          await evaluate(({ app: electronApp }) => { electronApp.quit(); }).catch(() => undefined);
          main.close();
        }
        await closed;
        await connected.close().catch(() => undefined);
      },
      kill: () => { main.close(); return killProcessTree(child, processClosed); },
      output,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const frameUrls = signals.devtools === null ? '接続口の行が来ていないため読めません' : await probeFrameUrls(signals.devtools);
    inspector?.close();
    await browser?.close().catch(() => undefined);
    const stopped = killProcessTree(child, processClosed);
    const ended = await withDeadline(closed, PROCESS_EXIT_TIMEOUT_MS, '止めた本体の終了').then(() => '本体は終了した',
      (waitError: unknown) => (waitError instanceof Error ? waitError.message : String(waitError)));
    throw new Error(launchFailureMessage({ reason, elapsedMs: Date.now() - started, signals, frameUrls,
      stopped: `${stopped}(${ended})`, stderrTail: outputTail(output, 'stderr'), stdoutTail: outputTail(output, 'stdout'),
      cdpTail: outputTail(output, 'cdp') }), { cause: error });
  }
}

/**
 * 失敗した回の画面の状態(ステータスバーの文・警告・図面の要素の件数・再計算の状態)。成果物と記録だけで
 * 「断られた・字体を読めなかった・計算が終わらない」のどれかを決められるようにする。読めない時はその理由を返す。
 */
async function readFailureState(page: Page): Promise<unknown> {
  const reason = (error: unknown): string => `読めません: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
  try {
    const screen = await page.evaluate(() => ({
      status: document.querySelector('.pcad-statusbar__text')?.textContent?.trim() ?? null,
      alerts: Array.from(document.querySelectorAll('[role="alert"]'), element => (element.textContent ?? '').trim().slice(0, 300))
        .filter(text => text !== ''),
      drawingSvg: document.querySelectorAll('.pcad-drawing-svg svg').length,
      drawingPaths: document.querySelectorAll('.pcad-drawing-svg path').length,
      progress: document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') ?? null,
    }));
    const recompute = await readRecomputeStats(page).catch(reason);
    return { ...screen, recompute };
  } catch (error) {
    return reason(error);
  }
}

function createItemRecorder(): { records: ItemRecord[]; run: <T>(id: string, label: string, body: () => Promise<T>) => Promise<T> } {
  const records: ItemRecord[] = [];
  const run = async <T>(id: string, label: string, body: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    // 段の終わりの行は終わった時にしか出ない。止まった段を記録から特定できるよう、始まりも時刻付きで出す。
    console.log(`[配布物の起動] 開始 ${new Date().toISOString()} ${id} ${label}`);
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
    app?: PackagedApplication; page?: Page; closed: boolean; target?: LaunchTarget; output?: OutputRing;
  } = { closed: false };
  const pageErrors: string[] = [], crashes: string[] = [], consoleErrors: string[] = [];
  let completed = false;
  const saveOpen: SaveOpenRecord = { stage: '未着手', savedBytes: null };
  try {
    const target = await run('(0-1)', '配布物と配布物の記録を読む', () => readLaunchTarget());
    session.target = target;
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
    const output = createOutputRing();
    session.output = output;
    const app = await run('(0-3)', '配布物を起動する', () => launchPackaged(playwright, target, isolation, output));
    session.app = app;
    evidence.launch = app.launchRecord;
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
      await verifyPackagedStartup(page, info);
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
    await run('(d-1b)', '配布物の形で名前を付けて保存し、開き直す(分けて送る保存・開くの口)', async () => {
      // 7・8 回目の版で作り直した保存・開くの口(8 MiB ずつ分けて送る)を、配布物の形(asar・app:// の配信・束ねた preload)で
      // 通す。手順は e2e/tests/saveResponsivenessFlow.ts の saveFlowFile・openSaveFlowFile と同じ(ツールバーの保存を Shift で
      // 押して名前を付けて保存、開くを押して開き直す。窓は差し替え)。箱だけの小さな文書なので、分けた送りは 1 回だけ通る。
      // 2 回以上に分かれる大きな文書は、所要が延びるので作らない(複数回は apps/desktop の単体の検査が受け持つ)。
      // 待ちの上限は既存の物(diskFile・waitForRecompute の KERNEL_TIMEOUT_MS、expect の既定)だけを使う。
      const savePath = join(isolation.base, SAVED_DOCUMENT_NAME);
      try {
        saveOpen.stage = '窓の差し替え';
        await installSaveOpenTargets(app, savePath);
        saveOpen.recomputeBeforeSave = await readRecomputeStats(page);
        await expect(page.locator('dialog[open]'), '保存の前に開いた dialog が無いこと').toHaveCount(0);
        await expect(page, '保存の前は未保存の印があること').toHaveTitle(/\*/u);
        saveOpen.stage = '保存';
        await fileAction(page, uiMessage('toolbar', 'toolbar.file.save')).click({ modifiers: ['Shift'] });
        const bytes = await diskFile(savePath);
        saveOpen.savedBytes = bytes.length;
        await expect(page.locator('[data-save-stage="complete"]'), '保存が終わったこと').toBeVisible();
        await expect(page, '保存の後の題名にファイル名があり、未保存の印が消えること').toHaveTitle(/^(?!.*\*).*packaged-saved\.pcad/u);
        saveOpen.stage = '保存したファイルの読み直し';
        const saved = readPart(new Uint8Array(bytes)).document.solids.find(solid => solid.kind === 'primitive' && solid.shape.kind === 'box');
        expect(saved, '保存したファイルが PCAD の部品として読め、20×30×40 mm の箱1 が入っていること').toMatchObject({
          kind: 'primitive', name: '箱1', shape: { kind: 'box', sizeX: { value: 20 }, sizeY: { value: 30 }, sizeZ: { value: 40 } } });
        saveOpen.stage = '開き直し';
        const reopened = await beginRecompute(page);
        await fileAction(page, uiMessage('toolbar', 'toolbar.file.open')).click();
        await waitForRecompute(page, reopened);
        await expect(page, '開き直した文書の題名にファイル名があり、未保存の印が無いこと').toHaveTitle(/^(?!.*\*).*packaged-saved\.pcad/u);
        await expect(page.locator('.pcad-panel--left').getByRole('button', { name: '箱1', exact: true }), '開き直した文書のツリーに箱1 があること')
          .toBeVisible();
        expect(await readSaveOpenDialogCalls(app), '差し替えた保存先と開く元の窓が 1 回ずつ使われたこと').toEqual({ save: 1, open: 1 });
        saveOpen.stage = '完了';
      } catch (error) {
        // 失敗した回だけ: 差し替えた窓が呼ばれた回数と、保存・開くの口の呼出し・戻り(本体の標準出力の行)を残す。画面の失敗の
        // 表示(ステータスバー・警告)は finally の readFailureState が残す。
        saveOpen.dialogCalls = await readSaveOpenDialogCalls(app)
          .catch((reason: unknown) => `読めません: ${reason instanceof Error ? reason.message : String(reason)}`);
        saveOpen.channelLog = output.lines.filter(line => line.text.includes(SAVE_OPEN_LOG)).slice(-40).map(line => line.text.slice(0, 400));
        evidence.saveOpen = saveOpen;
        throw error;
      }
    });
    await run('(d-2)', '同梱の数式の計算部で積分を求める', async () => {
      // e2e/release/offlineDomainCoverage.ts の verifyOfflineExactMath と同じ入口と式(通信の見張りは無い)。
      await page.getByRole('tab', { name: uiMessage('propertyPanel', 'propertyPanel.tabParameters'), exact: true }).click();
      // 媒介変数の追加と名前の確定は文書の媒介変数を変え、再計算を起こす(model の affectsShape)。(d-1) と同じく
      // 操作の前に世代を控え、今回の再計算の成功を待ってから数式の窓を開く(計算の途中の状態で次の操作へ進まない)。
      const edited = await beginRecompute(page);
      await page.getByRole('button', { name: uiMessage('parameters', 'parameterPanel.addTooltip'), exact: true }).click();
      const row = page.locator('.pcad-parameter').last();
      const dialog = page.locator('.pcad-math-dialog');
      // 名前は Enter で確定してから数式の窓を開く(通常の画面検査 mathAiryFlow.ts 等と同じ)。確定しないまま開くと、
      // 窓へ焦点が移った時の名前の確定で文書が変わり、窓は古い文書のものとして閉じる(2026-09-28 配布CIの試走)。
      const name = row.locator('.pcad-field').first().locator('input');
      await name.fill('厳密係数'); await name.press('Enter');
      await expect(page.getByRole('textbox', { name: `${uiMessage('parameters', 'parameterPanel.nameLabel')} 厳密係数`, exact: true }),
        '名前の確定が文書へ入ったこと').toHaveValue('厳密係数');
      await waitForRecompute(page, edited);
      await row.getByRole('button', { name: uiMessage('math', 'math.open'), exact: true }).click();
      await waitForMathEditorText(dialog);
      await dialog.locator('textarea').fill('integrate(t^2,t,0,3)');
      await expect(dialog.locator('.pcad-math-editor__result[role="status"]')).toHaveText('= 9', { timeout: 225_000 });
      // 「この式を使う」は媒介変数の値を文書へ入れ(ParameterMathDialog.tsx の applyDocument)、計算中の札を立てて
      // 再計算を起こす。計算中に「この部品から図面を作成」を押すと製品は断る(createDrawingCommands.ts の isComputing。
      // 2026-11-12 配布CI run 43180628085 の Linux で、断りの文「図にできる立体がありません。」のまま (d-3) が落ちた)。
      // 窓が閉じた後に、この操作で始まった再計算の成功まで待ってから (d-3) へ進む。
      const applied = await beginRecompute(page);
      await dialog.getByRole('button', { name: uiMessage('math', 'math.apply'), exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await waitForRecompute(page, applied);
    });
    await run('(d-3)', '同梱の字体で図面を描く', async () => {
      // 押す直前の再計算の状態(計算中か・世代・結末)を記録に残す。断られた時に、押した時点の状態を記録から読める。
      evidence.recomputeBeforeDrawing = await readRecomputeStats(page);
      await chooseToolMenuItem(page, uiMessage('toolbar', 'toolbar.fileMenu.groupLabel'), uiMessage('drawing', 'drawing.file.fromPart'));
      const drawn = page.locator('.pcad-drawing-svg svg');
      // 製品が図面の作成を断る時は、ステータスバーに理由の文を出して図面を開かない(createDrawingCommands.ts)。
      const statusText = page.locator('.pcad-statusbar__text');
      const refused = DRAWING_REFUSAL_KEYS.map(key => statusText.filter({ hasText: uiMessage('drawing', key) }))
        .reduce((all, next) => all.or(next));
      const fontRetry = page.getByRole('button', { name: uiMessage('drawing', 'drawing.font.retry'), exact: true });
      // 図面・断りの文・字体の再試行のどれかが出るまで待ち、断られた時と字体を読めなかった時は、
      // 図面の要素が無いという文でなく、その理由の文で落とす。
      await expect(drawn.or(refused).or(fontRetry).first(), '図面か、断りの文か、字体の再試行のボタンが出ること')
        .toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
      const status = (await statusText.first().textContent())?.trim() ?? '';
      expect(await refused.count(), `図面の作成が断られていないこと(ステータスバーの文: ${status})`).toBe(0);
      const alerts = (await page.getByRole('alert').allTextContents()).map(text => text.trim()).filter(text => text !== '');
      expect(await fontRetry.count(), `字体の読込みが失敗していないこと(警告: ${alerts.join(' / ')})`).toBe(0);
      await expect(drawn).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
      await expect.poll(() => page.locator('.pcad-drawing-svg [data-owner-id="view-1"] path').count(), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
      await expect(page.getByRole('alert').filter({ hasText: uiMessage('drawing', 'drawing.error.fontFailed') })).toHaveCount(0);
      await expect(page.getByRole('button', { name: uiMessage('drawing', 'drawing.font.retry'), exact: true })).toHaveCount(0);
      // 図面が読む字体(DRAWING_FONT_ASSET.url を画面の場所から解決した URL。fetchDrawingFont と同じ)を、同じ独自スキームで
      // 読み直して配布物の記録(desktop-package.json)と字体の資産の大きさ・SHA-256 に照らす。app:// の fetch は Resource Timing に
      // 載らない(2026-09-28 手元の配布物: 記録は起動時の script/link の9件だけで fetch は0件)ため、読込みの記録からは探さない。
      const fonts = await page.evaluate(async (fontUrl: string) => {
        const urls = [new URL(fontUrl, location.href).href];
        const results: { url: string; path: string; status: number; bytes: number; sha256: string }[] = [];
        for (const url of urls) {
          const response = await fetch(url);
          const bytes = await response.arrayBuffer();
          const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
            .map(byte => byte.toString(16).padStart(2, '0')).join('');
          results.push({ url, path: new URL(url).pathname, status: response.status, bytes: bytes.byteLength, sha256: digest });
        }
        return results;
      }, DRAWING_FONT_ASSET.url);
      evidence.fonts = fonts;
      // 読込みの記録の概要も証拠として残す(app:// の fetch が載らないことを後から確かめられるように)。
      evidence.resourceTiming = await page.evaluate(() => {
        const entries = performance.getEntriesByType('resource').filter(entry => entry instanceof PerformanceResourceTiming);
        return { total: entries.length, fetches: entries.filter(entry => entry.initiatorType === 'fetch').length,
          schemes: [...new Set(entries.map(entry => new URL(entry.name).protocol))],
          lastNames: entries.slice(-15).map(entry => `${entry.initiatorType} ${new URL(entry.name).pathname}`) };
      });
      expect(fonts.length, '図面が同梱の字体を読んだこと').toBeGreaterThan(0);
      for (const font of fonts) {
        const recorded = target.packaged.files.find(file => file.path === `dist/renderer${font.path}`);
        expect(recorded, `配布物の記録に ${font.path} があること`).toBeDefined();
        expect({ status: font.status, bytes: font.bytes, sha256: font.sha256 }, `${font.url} の中身`)
          .toEqual({ status: 200, bytes: recorded?.bytes, sha256: recorded?.sha256 });
        expect({ bytes: font.bytes, sha256: font.sha256 }, `${font.url} が図面の字体の資産(${DRAWING_FONT_ASSET.id})であること`)
          .toEqual({ bytes: DRAWING_FONT_ASSET.bytes, sha256: DRAWING_FONT_ASSET.sha256 });
      }
    });
    await run('(e)', 'pageerror が0件', async () => {
      expect(pageErrors, '配布物の画面で捕まらなかった例外(pageerror)が無いこと').toEqual([]);
      expect(crashes, '画面の処理が落ちていないこと').toEqual([]);
    });
    await run('(f)', '閉じた後に配布物のプロセスが残らない', async () => {
      // app.close() 自体が戻らないことがある(2026-09-29 手元の実行。外部の重い負荷と重なった)。上限を掛け、
      // 戻らなければ配布物のフォルダーの全プロセスを止めてから、900秒のテスト上限で無記録のまま止まる代わりに
      // 理由を記録して明確に失敗させる。
      // 2つ目のコールバックで拒否も飲み込む(タイムアウト後に closing が拒否されても、二重に投げず未処理の
      // 拒否も残さない。失敗した場合は closeError へ控えて、待ち切れた場合だけ元どおり投げ直す)。
      // (d) で作った箱と図面は保存していないので、閉じると本体が未保存の確認を1回出す(2026-09-29 手元の診断
      // RUN 20260929-032537: 答えない確認の窓で close が戻らず、出たボタンは3択だった)。利用者と同じく答えて閉じる。
      const unsaved = (await page.title()).includes('*');
      const mainOutput: string[] = [];
      child.stdout?.on('data', (chunk: unknown) => { mainOutput.push(String(chunk)); });
      await answerCloseConfirmWithDiscard(app);
      let closeError: unknown;
      const closing = app.close().then(() => 'closed' as const, (error: unknown) => { closeError = error; return 'closed' as const; });
      const outcome = await Promise.race([closing, new Promise<'timeout'>(done => { setTimeout(() => { done('timeout'); }, CLEANUP_CLOSE_TIMEOUT_MS); })]);
      session.closed = true;
      if (outcome === 'timeout') {
        const remaining = await packagedProcesses(target, false).catch(() => []);
        const stopped = stopLeftovers(remaining);
        throw new Error(`app.close() が${String(CLEANUP_CLOSE_TIMEOUT_MS / 1_000)}秒で戻らなかった: ${JSON.stringify(remaining)}(検査の片付けとして停止: ${stopped.join('、')})`);
      }
      if (closeError !== undefined) throw closeError;
      await expect.poll(() => [child.exitCode, child.signalCode], { message: '配布物が終了コード0で終わること', timeout: PROCESS_EXIT_TIMEOUT_MS })
        .toEqual([0, null]);
      const asked = mainOutput.join('').split('\n').filter(line => line.startsWith(CLOSE_CONFIRM_LOG))
        .map(line => line.slice(CLOSE_CONFIRM_LOG.length).trim());
      evidence.closeConfirmation = { unsavedBeforeClose: unsaved, asked };
      expect(asked, '未保存があれば閉じるときに本体の確認が1回だけ出て、3択であること(無ければ出ないこと)')
        .toEqual(unsaved ? [JSON.stringify(CLOSE_CONFIRM_CHOICES)] : []);
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
      // 閉じる前に、失敗した時の画面の状態を記録と標準出力の両方へ残す(Actions の記録だけでも原因を読めるように)。
      evidence.failureState = await readFailureState(session.page);
      console.log(`[配布物の起動] 失敗した時の画面: ${JSON.stringify(evidence.failureState).slice(0, 2_000)}`);
    }
    if (session.app !== undefined && !session.closed) {
      // 失敗の後片付け。閉じる処理が戻らないと結果の記録を書けず、worker ごと強制終了される(2026-09-28 手元の流し直し)。
      // 上限の後は起動した本体を止め、閉じられなかったことを記録に残す(判定は失敗のまま。成功の回の (f) は変えない)。
      // 途中で落ちた回も未保存が残り得る。(f) と同じく本体の確認に「保存せずに閉じる」で答えてから閉じる。
      await answerCloseConfirmWithDiscard(session.app).catch(() => undefined);
      const closing = session.app.close().then(() => 'closed' as const, () => 'closed' as const);
      const outcome = await Promise.race([closing, new Promise<'timeout'>(done => { setTimeout(() => { done('timeout'); }, CLEANUP_CLOSE_TIMEOUT_MS); })]);
      if (outcome === 'timeout') {
        // 起動したプロセスの子に本体が残る場合がある(2026-09-28 手元の ARM64 の Windows)。配布物のフォルダーから動く全てを止める。
        const remaining = session.target === undefined ? [] : await packagedProcesses(session.target, false).catch(() => []);
        evidence.cleanupClose = `${String(CLEANUP_CLOSE_TIMEOUT_MS / 1_000)}秒で閉じず、配布物のプロセスを止めた: ${stopLeftovers(remaining).join('、')}`;
      }
    }
    if (!completed && session.app !== undefined) {
      // どの道で失敗しても、起動した本体とその子を残さない(Windows は taskkill /T で木ごと)。閉じ終えていれば何もしない。
      // 成功の回は (f) が終了コード0とプロセスが残らないことを確かめ済みなので、ここへは来ない。
      const stopped = session.app.kill();
      if (stopped !== '止める物なし') evidence.forcedStopAfterFailure = stopped;
    }
    const output = session.app?.output ?? session.output;
    if (!completed && output !== undefined) {
      // 失敗した回だけ、配布物の主の処理の標準出力・標準エラー(と読めなかった CDP の行)を時刻つきで残す。どの段で落ちても
      // 主の処理の console.error や Chromium の ERROR を読めるようにする(test-results/packaged-desktop は release.yml の
      // 失敗の時の成果物)。書けなくても失敗の判定と結果の記録は止めない。
      await mkdir(info.outputDir, { recursive: true })
        .then(() => writeFile(info.outputPath('packaged-desktop-output.log'), formatOutputRing(output)))
        .catch((error: unknown) => { evidence.outputLogFailure = error instanceof Error ? error.message : String(error); });
    }
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
