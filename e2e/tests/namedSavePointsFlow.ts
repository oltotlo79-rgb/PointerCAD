import { expect, type ElectronApplication, type Locator, type Page, type BrowserType, type BrowserContext, type TestInfo } from '@playwright/test';
import { zipPcadEntries, FIXED_ENTRY_MTIME, type PcadZipEntries } from '../../packages/io/src/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, writeFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { waitForStartupReady } from './startupHealth.js';
import { chooseToolMenuItem, readAssemblyStats } from './assemblyTestSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';

const KERNEL_TIMEOUT_MS = 90_000;

export async function writeSavePointEvidence(info: TestInfo, name: string, value: unknown): Promise<void> {
  const path = info.outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify(value, null, 2), { flag: 'wx' });
  await info.attach(name, { path, contentType: 'application/json' });
}

/** Observe both process lifetimes, including comparison, cancellation and cold restore. */
export function observeSavePointNetwork(context: BrowserContext, info: TestInfo, name: string): { finish(): Promise<void> } {
  const external: { kind: string; origin: string }[] = [];
  const observeUrl = (kind: string, value: string): void => {
    const url = new URL(value);
    if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) &&
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) external.push({ kind, origin: url.origin });
  };
  const request = (value: import('@playwright/test').Request): void => observeUrl('request', value.url());
  const socket = (value: import('@playwright/test').WebSocket): void => observeUrl('websocket', value.url());
  const pages = new Set<Page>();
  const attach = (page: Page): void => { if (!pages.has(page)) { pages.add(page); page.on('websocket', socket); } };
  context.on('request', request); context.on('page', attach);
  for (const page of context.pages()) attach(page);
  return { async finish() {
    context.off('request', request); context.off('page', attach);
    for (const page of pages) page.off('websocket', socket);
    await writeSavePointEvidence(info, name, { external, scope: 'HTTP(S) requests and page WebSockets from observation setup before save-point operations through cleanup' });
    expect(external, 'Save-point operations send no request or WebSocket outside this device').toEqual([]);
  } };
}
const savePointsDialog = (page: Page): Locator => page.getByRole('dialog', { name: '名前付き保存点', exact: true });
const point = (dialog: Locator, name: string, kind: string): Locator => dialog.getByRole('radio', { name: `${name} (${kind})`, exact: true });

async function createBox(page: Page): Promise<void> {
  await chooseToolMenuItem(page, '作る', '箱');
  const token = await beginRecompute(page);
  await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter');
  await waitForRecompute(page, token);
  if (await page.locator('.pcad-popover').count() > 0) await page.locator('.pcad-popover input').first().press('Escape');
}
async function open(page: Page): Promise<Locator> {
  await chooseToolMenuItem(page, 'ファイルのほかの操作', '名前付き保存点');
  const dialog = savePointsDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('保存点は100件まで、実体は合計512MiBまでです。上限を超える時は理由を表示し、保存点を自動では消しません。')).toBeVisible();
  return dialog;
}
async function create(dialog: Locator, name: string, kind: string): Promise<void> {
  await dialog.getByLabel('保存点の名前', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'いまの文書を保存点に残す', exact: true }).click();
  await expect(point(dialog, name, kind)).toBeVisible();
  await expect(dialog.getByLabel('保存点の名前', { exact: true })).toHaveValue('');
}
async function clone(dialog: Locator, source: string, name: string, kind: string): Promise<void> {
  await point(dialog, source, kind).check();
  await dialog.getByLabel('保存点の名前', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '選んだ保存点を複製', exact: true }).click();
  await expect(point(dialog, name, kind)).toBeVisible();
}
async function compare(page: Page, dialog: Locator, before: string, after: string, kind: string): Promise<Locator> {
  await point(dialog, before, kind).check(); await dialog.getByRole('button', { name: '比較前', exact: true }).click();
  await point(dialog, after, kind).check(); await dialog.getByRole('button', { name: '比較後', exact: true }).click();
  await expect(dialog.getByText(`比較前: ${before} / 比較後: ${after}`, { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '前後を比較', exact: true }).click();
  const diff = page.getByRole('dialog', { name: '2つの保存ファイルを比較', exact: true });
  await expect(diff).toBeVisible();
  return diff;
}
async function closeDiff(diff: Locator): Promise<void> {
  await diff.getByRole('button', { name: '比較を閉じる', exact: true }).click();
  await expect(diff).toHaveCount(0);
}
const boxButton = (page: Page, name: string): Locator => page.locator('.pcad-panel--left').getByRole('button', { name, exact: true });

/** 部品: 作成・複製・比較・復元・復元のUndo1回・別画面でも残る(実IndexedDB)。 */
export async function namedSavePointsPartFlow(page: Page, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createBox(page);
  await expect(boxButton(page, '箱1')).toBeVisible();
  let dialog = await open(page);
  await expect(dialog.getByText('保存点はありません', { exact: true })).toBeVisible();
  await create(dialog, '試作A', '部品');
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await createBox(page);
  await expect(boxButton(page, '箱2')).toBeVisible();
  dialog = await open(page);
  await create(dialog, '発注前', '部品');
  await clone(dialog, '試作A', '試作Aの複製', '部品');
  // 別の保存点の一覧を作り直しても、残した順の3点が端末の保存先から読める。
  await expect(dialog.getByRole('radio')).toHaveCount(3);
  const diff = await compare(page, dialog, '試作A', '発注前', '部品');
  await expect(diff.getByText('試作A.pcad', { exact: true })).toBeVisible();
  await expect(diff.getByText('発注前.pcad', { exact: true })).toBeVisible();
  await diff.getByLabel('2つのファイルの関係', { exact: true }).selectOption('versions');
  await diff.getByRole('button', { name: '変更を比較する', exact: true }).click();
  const results = diff.getByRole('region', { name: '比較結果', exact: true });
  await expect(results.locator('[data-diff-status="added"]')).toContainText('箱2', { timeout: KERNEL_TIMEOUT_MS });
  await closeDiff(diff);
  // 比較は現在の部品を変えない。
  await expect(boxButton(page, '箱2')).toBeVisible();
  // 復元は1回で試作Aへ戻り、元に戻す1回で直前の部品へ戻る。
  await point(dialog, '試作A', '部品').check();
  await dialog.getByRole('button', { name: '選んだ保存点へ戻す', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(boxButton(page, '箱2')).toHaveCount(0); await expect(boxButton(page, '箱1')).toBeVisible();
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z');
  await expect(boxButton(page, '箱2')).toBeVisible();
  // 開き直しても3点が残る。Webは別の画面(同じ端末の保存先)からも読める。
  dialog = await open(page);
  await expect(dialog.getByRole('radio')).toHaveCount(3);
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  if (app === undefined) {
    const other = await page.context().newPage();
    try {
      await other.goto('/');
      const second = await open(other);
      await expect(second.getByRole('radio')).toHaveCount(3);
      await expect(point(second, '試作Aの複製', '部品')).toBeVisible();
    } finally { await other.close(); }
  }
}

/** 組立: 空の組立でも作成・複製・比較・復元でき、部品の保存点は戻せない表示になる。 */
export async function namedSavePointsAssemblyFlow(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const token = await beginRecompute(page);
  await chooseToolMenuItem(page, 'ファイルのほかの操作', '新しいアセンブリ');
  await waitForRecompute(page, token);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
  const dialog = await open(page);
  await create(dialog, '組立A', '組立');
  await clone(dialog, '組立A', '組立Aの複製', '組立');
  const diff = await compare(page, dialog, '組立A', '組立Aの複製', '組立');
  await expect(diff.getByText('組立A.pcada', { exact: true })).toBeVisible();
  await expect(diff.getByRole('combobox', { name: '2つのファイルの関係', exact: true })).toHaveValue('versions');
  await diff.getByRole('button', { name: '変更を比較する', exact: true }).click();
  await expect(diff.getByRole('region', { name: '比較結果', exact: true }).getByRole('status').first()).toHaveText('履歴の定義と保存値に変更はありません。');
  await closeDiff(diff);
  await point(dialog, '組立A', '組立').check();
  await expect(dialog.getByRole('button', { name: '選んだ保存点へ戻す', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '選んだ保存点へ戻す', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
}

/** 図面: 部品から作った図面でも、作成・複製・比較・復元でき、別種類は戻せない表示になる。 */
export async function namedSavePointsDrawingFlow(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createBox(page);
  // 部品の保存点を残してから図面へ移り、別種類の保存点が戻せない表示になることを確かめる。
  let dialog = await open(page);
  await create(dialog, '部品の点', '部品');
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/u }).first().click();
  await page.getByRole('button', { name: 'この部品から図面を作成', exact: true }).click();
  await expect(page.locator('.pcad-drawing-svg svg')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
  await expect(page.locator('.pcad-statusbar')).not.toContainText('作り直しています', { timeout: KERNEL_TIMEOUT_MS });
  dialog = await open(page);
  await point(dialog, '部品の点', '部品').check();
  await expect(dialog.getByRole('button', { name: '選んだ保存点へ戻す', exact: true })).toBeDisabled();
  await create(dialog, '図面A', '図面');
  await clone(dialog, '図面A', '図面Aの複製', '図面');
  const diff = await compare(page, dialog, '図面A', '図面Aの複製', '図面');
  await expect(diff.getByText('図面A.pcadd', { exact: true })).toBeVisible();
  await diff.getByRole('button', { name: '変更を比較する', exact: true }).click();
  await expect(diff.getByRole('region', { name: '比較結果', exact: true }).getByRole('status').first()).toHaveText('履歴の定義と保存値に変更はありません。');
  await closeDiff(diff);
  await point(dialog, '図面A', '図面').check();
  await dialog.getByRole('button', { name: '選んだ保存点へ戻す', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.pcad-drawing-svg svg')).toBeVisible();
}

const executeColdRead = promisify(execFile);

interface SavePointArchive {
  readonly points: string;
  readonly blobs: string;
  readonly chunks: readonly { readonly key: string; readonly bytes: readonly number[] }[];
}

/** Read only the real shelf. Never manufacture or restore IndexedDB fixture records. */
export async function readSavePointColdArchive(page: Page): Promise<SavePointArchive> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('pointercad-save-points');
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('Existing save-point database missing')); };
      request.onsuccess = () => resolve(request.result);
    });
    try {
      const result = await new Promise<SavePointArchive>((resolve, reject) => {
        const transaction = database.transaction(['points', 'blobs', 'chunks'], 'readonly');
        const points = transaction.objectStore('points').getAll();
        const blobs = transaction.objectStore('blobs').getAll();
        const chunks = transaction.objectStore('chunks').getAll();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error('Shelf read aborted'));
        transaction.oncomplete = () => {
          try {
            const canonical = (value: unknown): string => {
              if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
              if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
              if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Unknown shelf metadata');
              return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(Reflect.get(value, key))).join(',') + '}';
            };
            const actualPoints: unknown = points.result, actualBlobs: unknown = blobs.result, actualChunks: unknown = chunks.result;
            if (!Array.isArray(actualPoints) || !Array.isArray(actualBlobs) || !Array.isArray(actualChunks)) throw new Error('Unknown shelf records');
            const rows = actualChunks.map((value: unknown) => {
              if (typeof value !== 'object' || value === null || !('key' in value) || typeof value.key !== 'string' ||
                !('bytes' in value) || !(value.bytes instanceof Uint8Array)) throw new Error('Unknown actual shelf chunk');
              return { key: value.key, bytes: Array.from(value.bytes) };
            }).sort((left, right) => left.key.localeCompare(right.key));
            if (rows.length === 0 || rows.reduce((total, row) => total + row.bytes.length, 0) > 512 * 1024 * 1024) throw new Error('Missing or oversized shelf archive');
            resolve({ points: '[' + actualPoints.map(canonical).sort().join(',') + ']',
              blobs: '[' + actualBlobs.map(canonical).sort().join(',') + ']', chunks: rows });
          } catch (error) { reject(error); }
        };
      });
      return result;
    } finally { database.close(); }
  });
}

export async function assertSavePointProcessCold(page: Page, before: SavePointArchive,
  kind: 'part' | 'assembly' | 'drawing'): Promise<void> {
  const after = await readSavePointColdArchive(page);
  expect(after.points).toBe(before.points);
  expect(after.blobs).toBe(before.blobs);
  expect(after.chunks.map(chunk => chunk.key)).toEqual(before.chunks.map(chunk => chunk.key));
  for (let index = 0; index < before.chunks.length; index += 1) {
    const oldBytes = Buffer.from(before.chunks[index]!.bytes), newBytes = Buffer.from(after.chunks[index]!.bytes);
    expect(newBytes.byteLength).toBe(oldBytes.byteLength);
    expect(Buffer.compare(newBytes, oldBytes), `Exact persisted shelf chunk ${before.chunks[index]!.key}`).toBe(0);
  }
  const currentKind = await page.locator('.pcad-shell').getAttribute('data-document-kind');
  if (kind === 'assembly' && currentKind !== 'assembly') {
    const token = await beginRecompute(page);
    await chooseToolMenuItem(page, 'ファイルのほかの操作', '新しいアセンブリ');
    await waitForRecompute(page, token);
  } else if (kind === 'drawing' && currentKind !== 'drawing') {
    expect(currentKind).toBe('part');
    await createBox(page);
    await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/u }).first().click();
    await page.getByRole('button', { name: 'この部品から図面を作成', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg svg')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
  }
  const dialog = await open(page);
  const names = kind === 'part' ? ['試作A', '発注前', '試作Aの複製'] : kind === 'assembly' ? ['組立A', '組立Aの複製'] : ['部品の点', '図面A', '図面Aの複製'];
  await expect(dialog.getByRole('radio')).toHaveCount(names.length);
  for (const name of names) await expect(dialog.getByRole('radio', { name: new RegExp('^' + name + ' \\(') })).toBeVisible();
  await point(dialog, names[0]!, kind === 'part' ? '部品' : kind === 'assembly' ? '組立' : '部品').check();
  if (kind === 'drawing') await expect(dialog.getByRole('button', { name: '選んだ保存点へ戻す', exact: true })).toBeDisabled();
  const restoreName = kind === 'part' ? '試作A' : kind === 'assembly' ? '組立A' : '図面A';
  await point(dialog, restoreName, kind === 'part' ? '部品' : kind === 'assembly' ? '組立' : '図面').check();
  await expect(dialog.getByRole('button', { name: '選んだ保存点へ戻す', exact: true })).toBeEnabled();
  const restoreToken = kind === 'drawing' ? undefined : await beginRecompute(page);
  await dialog.getByRole('button', { name: '選んだ保存点へ戻す', exact: true }).click();
  if (restoreToken !== undefined) await waitForRecompute(page, restoreToken);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', kind);
  if (kind === 'part') { await expect(boxButton(page, '箱1')).toBeVisible(); await expect(boxButton(page, '箱2')).toHaveCount(0); }
  if (kind === 'drawing') await expect(page.locator('.pcad-drawing-svg svg')).toBeVisible();
  if (kind === 'part') {
    await expect.poll(async () => page.evaluate(() => {
      const read: unknown = Reflect.get(window, 'pcadViewportMemoryStats');
      if (typeof read !== 'function') throw new Error('Actual viewport mesh observation missing');
      const mesh: unknown = Reflect.apply(read, window, []);
      if (typeof mesh !== 'object' || mesh === null || !('displayCopyBytes' in mesh) ||
        typeof mesh.displayCopyBytes !== 'number' || !('gpuMeshBytes' in mesh) || typeof mesh.gpuMeshBytes !== 'number')
        throw new Error('Actual viewport mesh observation unknown');
      return mesh.displayCopyBytes > 0 && mesh.gpuMeshBytes > 0;
    }), { timeout: KERNEL_TIMEOUT_MS, message: 'Restored one-box native mesh actually published' }).toBe(true);
  }
  if (kind === 'assembly') {
    // The existing saved Assembly is intentionally empty, not a nonempty native fixture.
    const assembly = await readAssemblyStats(page);
    expect(assembly.components).toEqual([]);
    expect(assembly.mateIds).toEqual([]);
    expect(assembly.jointIds).toEqual([]);
    expect(assembly.stepIds).toEqual([]);
    expect(assembly.diagnosis).toBeNull();
    expect(await page.evaluate(() => {
      const read: unknown = Reflect.get(window, 'pcadViewportFramedBodies');
      if (typeof read !== 'function') throw new Error('Actual current body observation missing');
      const bodies: unknown = Reflect.apply(read, window, []);
      if (!Array.isArray(bodies) || !bodies.every(body => typeof body === 'string')) throw new Error('Unknown current bodies');
      return bodies;
    })).toEqual([]);
  }
  expect((await readSavePointColdArchive(page)).points).toBe(before.points);
}

interface ColdProcessOwner { readonly pid: number; readonly created: string }
export async function readSavePointProcessOwner(profile: string, expectedPid?: number): Promise<ColdProcessOwner | null> {
  if (process.platform === 'linux') return readLinuxColdOwner(profile, expectedPid);
  if (process.platform !== 'win32') throw new Error('R16 process creation observation unavailable on this platform');
  const marker = Buffer.from(profile, 'utf8').toString('base64');
  const pid = expectedPid ?? 0;
  const script = `$ErrorActionPreference='Stop'; $marker=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${marker}')); ` +
    `$rows=@(Get-CimInstance Win32_Process | Where-Object { ${pid > 0 ? `[int]$_.ProcessId -eq ${pid}` : `$_.CommandLine -and $_.CommandLine.IndexOf($marker,[StringComparison]::OrdinalIgnoreCase) -ge 0`} }); ` +
    `$ids=@($rows | ForEach-Object {[int]$_.ProcessId}); $roots=@($rows | Where-Object {$ids -notcontains [int]$_.ParentProcessId}); ` +
    `ConvertTo-Json -Compress -InputObject @($roots | ForEach-Object {@{pid=[int]$_.ProcessId;created=$_.CreationDate.ToUniversalTime().Ticks.ToString()}})`;
  const { stdout } = await executeColdRead('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env } });
  const rows: unknown = JSON.parse(stdout);
  if (!Array.isArray(rows) || rows.length > 1) throw new Error('Ambiguous actual cold process owner');
  if (rows.length === 0) return null;
  const row: unknown = rows[0];
  if (typeof row !== 'object' || row === null || !('pid' in row) || typeof row.pid !== 'number' || !Number.isSafeInteger(row.pid) || row.pid <= 0 ||
    !('created' in row) || typeof row.created !== 'string' || !/^\d+$/u.test(row.created)) throw new Error('Unknown process creation identity');
  return { pid: row.pid, created: row.created };
}

async function readLinuxColdOwner(profile: string, expectedPid?: number): Promise<ColdProcessOwner | null> {
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const names = expectedPid === undefined ? await readdir('/proc') : [String(expectedPid)];
  const rows: { pid: number; parent: number; created: string }[] = [];
  for (const name of names) {
    if (!/^\d+$/u.test(name)) continue;
    let command: string, stat: string;
    try { command = await readFile(`/proc/${name}/cmdline`, 'utf8'); stat = await readFile(`/proc/${name}/stat`, 'utf8'); }
    catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (expectedPid === undefined && !command.split('\0').some(argument => argument === profile || argument === '--user-data-dir=' + profile)) continue;
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u), created = fields[19];
    const pid = Number(name), parent = Number(fields[1]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent) || created === undefined || !/^\d+$/u.test(created) || bootId.length === 0) throw new Error('Unknown Linux process owner');
    rows.push({ pid, parent, created: bootId + ':' + created });
  }
  const roots = rows.filter(row => !rows.some(parent => parent.pid === row.parent));
  if (roots.length > 1) throw new Error('Ambiguous Linux cold process owner');
  return roots[0] === undefined ? null : { pid: roots[0].pid, created: roots[0].created };
}

export async function readSavePointBuildPins(): Promise<string> {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const manifest: Record<string, string> = {};
  for (const name of ['e2e/tests/namedSavePointsFlow.ts', 'e2e/tests/named-save-points.spec.ts', 'e2e/tests/electron-named-save-points.spec.ts'])
    manifest[name] = createHash('sha256').update(await readFile(join(root, name))).digest('hex');
  const walk = async (relative: string): Promise<void> => {
    for (const item of (await readdir(join(root, relative), { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const name = relative + '/' + item.name;
      if (item.isDirectory()) await walk(name);
      else if (item.isFile()) manifest[name] = createHash('sha256').update(await readFile(join(root, name))).digest('hex');
      else throw new Error('Unknown build artifact entry');
    }
  };
  await walk('apps/web/dist'); await walk('apps/desktop/dist');
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

export async function attachSavePointColdArchives(info: TestInfo, archive: SavePointArchive): Promise<void> {
  const blobs: unknown = JSON.parse(archive.blobs);
  if (!Array.isArray(blobs) || blobs.length === 0) throw new Error('Actual ZIP blob metadata missing');
  const actualBlobs = new Map<string, Uint8Array>();
  for (const blob of blobs) {
    const value: unknown = blob;
    if (typeof value !== 'object' || value === null || !('sha256' in value) || typeof value.sha256 !== 'string' ||
      !('byteLength' in value) || typeof value.byteLength !== 'number' || !('chunkCount' in value) || typeof value.chunkCount !== 'number' ||
      !Number.isSafeInteger(value.chunkCount) || value.chunkCount <= 0) throw new Error('Unknown actual ZIP blob descriptor');
    const digest = value.sha256, byteLength = value.byteLength, chunkCount = value.chunkCount;
    const chunks: Buffer[] = [];
    for (let index = 0; index < chunkCount; index += 1) {
      const row = archive.chunks.find(chunk => chunk.key === digest + ':' + index);
      if (row === undefined) throw new Error('Actual ZIP chunk missing');
      chunks.push(Buffer.from(row.bytes));
    }
    const bytes = Buffer.concat(chunks);
    expect(bytes.byteLength).toBe(byteLength);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest);
    actualBlobs.set(digest, bytes);
  }
  const points: unknown = JSON.parse(archive.points);
  if (!Array.isArray(points)) throw new Error('Actual point metadata missing');
  let archiveIndex = 0;
  for (const candidate of points) {
    const point: unknown = candidate;
    if (typeof point !== 'object' || point === null) throw new Error('Unknown point metadata');
    if ('id' in point && point.id === '__meta__') continue;
    if (!('sourceSha256' in point) || typeof point.sourceSha256 !== 'string' ||
      !('sourceByteLength' in point) || typeof point.sourceByteLength !== 'number' ||
      !('entries' in point) || !Array.isArray(point.entries)) throw new Error('Unknown point archive identity');
    const entries: PcadZipEntries = new Map();
    for (const candidateEntry of point.entries) {
      const entry: unknown = candidateEntry;
      if (typeof entry !== 'object' || entry === null || !('name' in entry) || typeof entry.name !== 'string' ||
        !('sha256' in entry) || typeof entry.sha256 !== 'string' || !('byteLength' in entry) || typeof entry.byteLength !== 'number' ||
        !('level' in entry) || (entry.level !== 0 && entry.level !== 6)) throw new Error('Unknown actual point entry');
      const bytes = actualBlobs.get(entry.sha256);
      if (bytes === undefined || bytes.byteLength !== entry.byteLength || entries.has(entry.name)) throw new Error('Actual point entry backing missing');
      entries.set(entry.name, [bytes, { level: entry.level, mtime: FIXED_ENTRY_MTIME }]);
    }
    const bytes = zipPcadEntries(entries);
    expect(bytes.byteLength).toBe(point.sourceByteLength);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(point.sourceSha256);
    expect(Buffer.from(bytes.subarray(0, 4)).toString('hex')).toBe('504b0304');
    const name = `r16-actual-save-point-${archiveIndex++}-${point.sourceSha256}.zip`, path = info.outputPath(name);
    await writeFile(path, bytes, { flag: 'wx' });
    await info.attach(name, { path, contentType: 'application/zip' });
  }
}

export async function runNamedSavePointsWebCold(browserType: BrowserType, info: TestInfo,
  kind: 'part' | 'assembly' | 'drawing', flow: (page: Page) => Promise<void>): Promise<string[]> {
  const profile = info.outputPath('r16-real-persistent-profile');
  const use = info.project.use, errors: string[] = [];
  const launch = () => browserType.launchPersistentContext(profile, { ...use.launchOptions,
    headless: use.headless, channel: use.channel, baseURL: use.baseURL, viewport: use.viewport,
    userAgent: use.userAgent, deviceScaleFactor: use.deviceScaleFactor, isMobile: use.isMobile,
    hasTouch: use.hasTouch, locale: use.locale, colorScheme: use.colorScheme, acceptDownloads: use.acceptDownloads });
  const prepare = async (context: BrowserContext): Promise<Page> => {
    context.setDefaultTimeout(use.actionTimeout ?? 0); context.setDefaultNavigationTimeout(use.navigationTimeout ?? 0);
    await context.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    });
    const page = context.pages()[0] ?? await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/'); await waitForStartupReady(page);
    return page;
  };
  expect(await readSavePointProcessOwner(profile)).toBeNull();
  const buildPins = await readSavePointBuildPins();
  const first = await launch();
  const firstNetwork = observeSavePointNetwork(first, info, 'r16-network-before-cold');
  let archive: SavePointArchive, oldOwner: ColdProcessOwner;
  try {
    const owner = await readSavePointProcessOwner(profile);
    if (owner === null) throw new Error('Actual first browser process owner missing');
    oldOwner = owner;
    const page = await prepare(first); await flow(page); archive = await readSavePointColdArchive(page);
    await attachSavePointColdArchives(info, archive);
  } finally { try { await first.close(); } finally { await firstNetwork.finish(); } }
  await expect.poll(() => readSavePointProcessOwner(profile), { message: 'Old exact browser profile owner exited' }).toBeNull();
  const second = await launch();
  const secondNetwork = observeSavePointNetwork(second, info, 'r16-network-after-cold');
  try {
    const newOwner = await readSavePointProcessOwner(profile);
    if (newOwner === null) throw new Error('Actual cold browser process owner missing');
    expect(JSON.stringify(newOwner)).not.toBe(JSON.stringify(oldOwner));
    expect(await readSavePointBuildPins()).toBe(buildPins);
    const page = await prepare(second); await assertSavePointProcessCold(page, archive, kind);
    await writeSavePointEvidence(info, 'r16-real-process-cold', { kind, profile, oldOwner, newOwner,
      oldClosed: true, buildAndSourceSha256: buildPins, shelfMetadataAndEveryChunkByteEqual: true, unknown: ['unasserted original R16 conditions remain unaccepted'] });
  } finally { try { await second.close(); } finally { await secondNetwork.finish(); } }
  await expect.poll(() => readSavePointProcessOwner(profile), { message: 'Second owned browser process exited' }).toBeNull();
  return errors;
}

/** Actual UI reaches 100 persisted points; both 101st operations refuse without deletion. */
export async function namedSavePointsCountLimitFlow(page: Page, info: TestInfo): Promise<void> {
  const network = observeSavePointNetwork(page.context(), info, 'r16-network-count');
  try { await namedSavePointsCountLimitOperations(page); } finally { await network.finish(); }
}

async function namedSavePointsCountLimitOperations(page: Page): Promise<void> {
  await waitForStartupReady(page);
  const externalOrigins: string[] = [];
  const observe = (request: import('@playwright/test').Request): void => {
    const url = new URL(request.url());
    if ((url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname !== 'localhost' && url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') externalOrigins.push(url.origin);
  };
  page.context().on('request', observe);
  try {
    await createBox(page);
    const dialog = await open(page);
    await expect(dialog.getByRole('radio')).toHaveCount(0);
    await create(dialog, '上限元点', '部品');
    for (let index = 1; index < 100; index += 1) {
      await clone(dialog, '上限元点', `上限複製${index}`, '部品');
      await expect(dialog.getByRole('radio')).toHaveCount(index + 1);
    }
    const before = await readSavePointColdArchive(page);
    const metadata: unknown = JSON.parse(before.points);
    if (!Array.isArray(metadata)) throw new Error('Actual point metadata unavailable');
    const actualPoints = metadata.filter((point: unknown) => typeof point === 'object' && point !== null &&
      'id' in point && point.id !== '__meta__');
    expect(actualPoints).toHaveLength(100);
    expect(actualPoints.every((point: unknown) => typeof point === 'object' && point !== null &&
      'entries' in point && Array.isArray(point.entries) && point.entries.length > 0)).toBe(true);
    const assertRetained = async (): Promise<void> => {
      await expect(dialog.getByRole('radio')).toHaveCount(100);
      await expect(point(dialog, '上限元点', '部品')).toBeVisible();
      await expect(point(dialog, '上限複製99', '部品')).toBeVisible();
      const after = await readSavePointColdArchive(page);
      expect(after.points === before.points, 'Every actual point metadata byte retained after refusal').toBe(true);
      expect(after.blobs === before.blobs, 'Every actual blob descriptor retained after refusal').toBe(true);
      expect(after.chunks.map(chunk => chunk.key)).toEqual(before.chunks.map(chunk => chunk.key));
      for (let index = 0; index < before.chunks.length; index += 1) {
        const left = Buffer.from(before.chunks[index]!.bytes), right = Buffer.from(after.chunks[index]!.bytes);
        expect(right.byteLength).toBe(left.byteLength);
        expect(Buffer.compare(left, right), 'Actual persisted chunk bytes retained').toBe(0);
      }
    };
    await dialog.getByLabel('保存点の名前', { exact: true }).fill('拒否された101件目');
    await dialog.getByRole('button', { name: 'いまの文書を保存点に残す', exact: true }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveText("保存点は100件までです。");
    await expect(point(dialog, '拒否された101件目', '部品')).toHaveCount(0);
    await assertRetained();
    await point(dialog, '上限元点', '部品').check();
    await dialog.getByLabel('保存点の名前', { exact: true }).fill('拒否された101複製');
    await dialog.getByRole('button', { name: '選んだ保存点を複製', exact: true }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveText("保存点は100件までです。");
    await expect(point(dialog, '拒否された101複製', '部品')).toHaveCount(0);
    await assertRetained();
    expect(externalOrigins, 'No external HTTP request during actual save-point operations').toEqual([]);
    await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  } finally { page.context().off('request', observe); }
}

/** Nonempty shared source asset; every input is normal UI/PCAD, never store injection. */
export interface SharedSavePointFixture {
  readonly bytes: Buffer;
  readonly archive: SavePointArchive;
}

async function assertSharedAssembly(page: Page, actualBytes: Buffer, expectedBytes: Buffer): Promise<void> {
  const { readPcadaFile } = await import('../../packages/io/src/index.js');
  const actual = await readPcadaFile(actualBytes), expected = await readPcadaFile(expectedBytes);
  if (!actual.ok || !expected.ok) throw new Error('Actual shared Assembly PCAD decode refused');
  expect(actual.document).toEqual(expected.document);
  expect(Array.from(actual.parts.entries())).toEqual(Array.from(expected.parts.entries()));
  expect(actual.partFiles).toEqual(expected.partFiles);
  expect(Array.from(actual.partAttachmentDigests.entries())).toEqual(Array.from(expected.partAttachmentDigests.entries()));
  expect(actual.document.components).toHaveLength(2);
  expect(actual.parts.size).toBe(1);
  expect(actual.partFiles).toHaveLength(1);
  expect(actual.partAttachments.size).toBe(1);
  const refs = actual.document.components.map(component => {
    if (component.source.kind !== 'part') throw new Error('Shared source must remain a real embedded Part');
    return component.source.partRef;
  });
  expect(refs[0]).toBe(refs[1]);
  const current = actual.partAttachments.get(refs[0]!), original = expected.partAttachments.get(refs[0]!);
  if (current === undefined || original === undefined) throw new Error('Actual shared attachment owner missing');
  expect(current.canvases.size).toBeGreaterThan(0);
  expect(Array.from(current.canvases.keys())).toEqual(Array.from(original.canvases.keys()));
  for (const [id, bytes] of original.canvases) {
    const restored = current.canvases.get(id);
    if (restored === undefined) throw new Error('Shared real PNG disappeared');
    expect(restored.byteLength).toBe(bytes.byteLength);
    expect(Buffer.compare(Buffer.from(restored), Buffer.from(bytes)), 'Every real shared PNG byte').toBe(0);
  }
  const stats = await readAssemblyStats(page);
  expect(stats.components).toHaveLength(2);
  expect(stats.components.map(component => component.sourceRef)).toEqual(refs);
  expect(stats.components.every(component => component.resolved !== null && component.displayed !== null)).toBe(true);
  await expect.poll(async () => page.evaluate(() => {
    const read: unknown = Reflect.get(window, 'pcadViewportMemoryStats');
    if (typeof read !== 'function') throw new Error('Actual mesh observation missing');
    const mesh: unknown = Reflect.apply(read, window, []);
    if (typeof mesh !== 'object' || mesh === null || !('displayCopyBytes' in mesh) || typeof mesh.displayCopyBytes !== 'number' ||
      !('gpuMeshBytes' in mesh) || typeof mesh.gpuMeshBytes !== 'number') throw new Error('Unknown native mesh observation');
    return mesh.displayCopyBytes > 0 && mesh.gpuMeshBytes > 0;
  }), { timeout: KERNEL_TIMEOUT_MS, message: 'Nonempty shared Assembly native mesh published' }).toBe(true);
}

async function assertSharedShelf(page: Page, before: SavePointArchive): Promise<void> {
  const after = await readSavePointColdArchive(page);
  expect(after.points).toBe(before.points); expect(after.blobs).toBe(before.blobs);
  expect(after.chunks.map(chunk => chunk.key)).toEqual(before.chunks.map(chunk => chunk.key));
  for (let index = 0; index < before.chunks.length; index += 1) {
    const left = Buffer.from(before.chunks[index]!.bytes), right = Buffer.from(after.chunks[index]!.bytes);
    expect(right.byteLength).toBe(left.byteLength); expect(Buffer.compare(left, right), 'Shared shelf actual chunk byte equality').toBe(0);
  }
}

/** Use real UI documents and ordinary saved PCAD bytes; never manufacture shelf records. */
async function namedSavePointAssetRetention(page: Page, info: TestInfo, original: Buffer, png: Buffer,
  app?: ElectronApplication): Promise<void> {
  const canvas = await import('./canvasAssetLifetimeFlow.js');
  const originalPart = canvas.readPart(original);
  const assertPart = (actual: Buffer, expected: Buffer): void => {
    const left = canvas.readPart(actual), right = canvas.readPart(expected);
    expect(left.document).toEqual(right.document);
    expect(left.attachments).toEqual(right.attachments);
  };
  let dialog = await open(page);
  await create(dialog, '資産試作A', '部品');
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  await canvas.canvasRow(page, '実共有下絵.png').getByRole('button', { name: '実共有下絵.png を削除', exact: true }).click();
  await expect(canvas.canvasRow(page, '実共有下絵.png')).toHaveCount(0);
  const deleted = await canvas.save(page, info, '資産削除後.pcad', app), deletedPart = canvas.readPart(deleted);
  expect(deletedPart.document.canvases).toHaveLength(0);
  expect(deletedPart.attachments.canvases.size).toBe(0);
  await canvas.addImage(page, '同内容の別名.png', png);
  const renamed = await canvas.save(page, info, '資産別名.pcad', app), renamedPart = canvas.readPart(renamed);
  expect(renamedPart.document.canvases).toHaveLength(1);
  expect(renamedPart.document.canvases[0]!.imageId).not.toBe(originalPart.document.canvases[0]!.imageId);
  dialog = await open(page);
  await create(dialog, '資産発注前', '部品');
  const archive = await readSavePointColdArchive(page), pngSha256 = createHash('sha256').update(png).digest('hex');
  const metadata: unknown = JSON.parse(archive.points), blobs: unknown = JSON.parse(archive.blobs);
  if (!Array.isArray(metadata) || !Array.isArray(blobs)) throw new Error('Actual asset shelf metadata missing');
  const assetEntries = ['資産試作A', '資産発注前'].map(name => {
    const saved: unknown = metadata.find((value: unknown) => typeof value === 'object' && value !== null && 'name' in value && value.name === name);
    if (typeof saved !== 'object' || saved === null || !('entries' in saved) || !Array.isArray(saved.entries)) throw new Error('Actual asset point missing');
    const entry: unknown = saved.entries.find((value: unknown) => typeof value === 'object' && value !== null && 'sha256' in value && value.sha256 === pngSha256);
    if (typeof entry !== 'object' || entry === null || !('name' in entry) || typeof entry.name !== 'string') throw new Error('Actual PNG point entry missing');
    return entry.name;
  });
  expect(assetEntries[0]).not.toBe(assetEntries[1]);
  expect(blobs.filter((value: unknown) => typeof value === 'object' && value !== null && 'sha256' in value && value.sha256 === pngSha256)).toHaveLength(1);
  const chunks = archive.chunks.filter(chunk => chunk.key.startsWith(`${pngSha256}:`));
  expect(chunks).toHaveLength(1);
  expect(Buffer.from(chunks[0]!.bytes)).toEqual(png);
  await point(dialog, '資産試作A', '部品').check();
  const restore = dialog.getByRole('button', { name: '選んだ保存点へ戻す', exact: true });
  await expect(restore).toBeEnabled();
  // Both real DOM controls run before the browser can dispatch a Worker reply task.
  // The microtask only lets React publish its busy/cancel control; no timer or injected store/action.
  const cancelled = await restore.evaluate(async element => {
    if (!(element instanceof HTMLButtonElement)) throw new Error('Restore UI button missing');
    const dialog = element.closest('dialog');
    if (dialog === null) throw new Error('Save-point UI dialog missing');
    element.click();
    await Promise.resolve();
    const cancel = Array.from(dialog.querySelectorAll('button')).find(button => button.textContent === '操作を取り消す');
    if (cancel === undefined || cancel.disabled) throw new Error('Actual in-flight restore cancellation control missing');
    cancel.click();
    return true;
  });
  expect(cancelled).toBe(true);
  await expect(dialog.getByRole('status')).toHaveText('操作を取り消しました。確定済みの保存点は一覧で確認できます。');
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  assertPart(await canvas.save(page, info, '資産取消後.pcad', app), renamed);
  await assertSharedShelf(page, archive);
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z');
  assertPart(await canvas.save(page, info, '資産取消後Undo.pcad', app), deleted);
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+Shift+z');
  assertPart(await canvas.save(page, info, '資産取消後Redo.pcad', app), renamed);
  dialog = await open(page); await point(dialog, '資産試作A', '部品').check();
  const token = await beginRecompute(page);
  await dialog.getByRole('button', { name: '選んだ保存点へ戻す', exact: true }).click();
  await waitForRecompute(page, token); await expect(dialog).toHaveCount(0);
  const restored = canvas.readPart(await canvas.save(page, info, '資産旧点復元.pcad', app));
  expect(restored.document.canvases).toHaveLength(1);
  // Restoration allocates a fresh image owner when the old ID is retained by Undo.
  const restoredImageId = restored.document.canvases[0]!.imageId;
  expect(restoredImageId).not.toBe(renamedPart.document.canvases[0]!.imageId);
  expect(restored.document).toEqual({ ...originalPart.document,
    canvases: originalPart.document.canvases.map(item => ({ ...item, imageId: restoredImageId })) });
  expect(restored.attachments.shapes).toEqual(originalPart.attachments.shapes);
  expect(restored.attachments.meshes).toEqual(originalPart.attachments.meshes);
  expect([...restored.attachments.canvases.keys()]).toEqual([restoredImageId]);
  expect(Buffer.from(restored.attachments.canvases.get(restoredImageId) ?? [])).toEqual(png);
  await assertSharedShelf(page, archive);
  await writeSavePointEvidence(info, 'r16-assets-cancel-retention', { pngSha256, pngBytes: png.byteLength,
    assetEntries, sharedBlobCount: 1, restoreCancelledThroughUi: cancelled,
    cancelDocumentAttachmentsAndUndoUnchanged: true, deletedCurrentPngExcluded: true, retainedPointPngRestored: true });
}

export async function namedSavePointsSharedAssetFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<SharedSavePointFixture> {
  await waitForStartupReady(page);
  const canvas = await import('./canvasAssetLifetimeFlow.js');
  const io = await import('../../packages/io/src/index.js');
  const model = await import('../../packages/model/src/index.js');
  const { addThirdBoxAssemblyFile } = await import('./assemblyTestSupport.js');
  await createBox(page);
  const png = await canvas.samplePng(page, '#29a66a', 64);
  await canvas.addImage(page, '実共有下絵.png', png);
  const partBytes = await canvas.save(page, info, '実共有元.pcad', app);
  const part = io.readPcadFile(partBytes);
  if (!part.ok) throw new Error('Actual UI-created Part save failed normal PCAD decode');
  expect(part.document.solids.length).toBeGreaterThan(0);
  expect(part.attachments.canvases.size).toBe(1);
  for (const bytes of part.attachments.canvases.values()) expect(Buffer.compare(Buffer.from(bytes), png)).toBe(0);
  await namedSavePointAssetRetention(page, info, partBytes, png, app);
  const embedded = await model.embedPart(model.EMPTY_PART_LIBRARY, part.document, '実共有元.pcad', '',
    { attachments: part.attachments, importedAt: '2026-10-08T00:00:00.000Z' });
  const reused = await model.embedPart(embedded.library, part.document, '実共有元.pcad', '',
    { attachments: part.attachments, importedAt: '2026-10-08T00:00:00.000Z' });
  expect(reused.reused).toBe(true); expect(reused.partRef).toBe(embedded.partRef); expect(reused.library).toBe(embedded.library);
  let document = model.createAssemblyDocument('実共有組立');
  document = model.addComponent(document, model.createComponentFor(document, { kind: 'part', partRef: embedded.partRef }, { partName: '実共有元' }));
  document = model.addComponent(document, model.createComponentFor(document, { kind: 'part', partRef: embedded.partRef }, { partName: '実共有元' }));
  const fixture = await io.writeDocumentBundle(model.createAssemblyDocumentBundle(document, embedded.library));
  let token = await beginRecompute(page);
  await canvas.open(page, '実共有組立.pcada', Buffer.from(fixture), info, app);
  await waitForRecompute(page, token);
  const baseline = await canvas.save(page, info, '実共有基準.pcada', app);
  await assertSharedAssembly(page, baseline, Buffer.from(fixture));
  const dialog = await open(page);
  await create(dialog, '実共有A', '組立'); await clone(dialog, '実共有A', '実共有Aの複製', '組立');
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  const archive = await readSavePointColdArchive(page);
  const changed = await addThirdBoxAssemblyFile(baseline);
  token = await beginRecompute(page);
  await canvas.open(page, '実共有変更.pcada', Buffer.from(changed), info, app);
  await waitForRecompute(page, token); expect((await readAssemblyStats(page)).components).toHaveLength(3);
  await assertSharedSavePointCold(page, { bytes: baseline, archive }, info, app);
  token = await beginRecompute(page); await page.keyboard.press('Control+z'); await waitForRecompute(page, token);
  const undo = await io.readPcadaFile(await canvas.save(page, info, '実共有Undo.pcada', app)), expectedUndo = await io.readPcadaFile(changed);
  if (!undo.ok || !expectedUndo.ok) throw new Error('Actual shared Undo PCAD decode failed');
  expect(undo.document).toEqual(expectedUndo.document);
  expect(Array.from(undo.parts.entries())).toEqual(Array.from(expectedUndo.parts.entries()));
  expect(Array.from(undo.partAttachmentDigests.entries())).toEqual(Array.from(expectedUndo.partAttachmentDigests.entries()));
  expect(undo.partFiles).toEqual(expectedUndo.partFiles);
  expect(Array.from(undo.partAttachments.entries())).toEqual(Array.from(expectedUndo.partAttachments.entries()));
  token = await beginRecompute(page); await page.keyboard.press('Control+Shift+z'); await waitForRecompute(page, token);
  await assertSharedAssembly(page, await canvas.save(page, info, '実共有Redo.pcada', app), baseline);
  await assertSharedShelf(page, archive);
  return { bytes: baseline, archive };
}

export async function assertSharedSavePointCold(page: Page, fixture: SharedSavePointFixture, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await waitForStartupReady(page); await assertSharedShelf(page, fixture.archive);
  if (await page.locator('.pcad-shell').getAttribute('data-document-kind') !== 'assembly') {
    const token = await beginRecompute(page);
    await chooseToolMenuItem(page, 'ファイルのほかの操作', '新しいアセンブリ'); await waitForRecompute(page, token);
  }
  const dialog = await open(page);
  await expect(dialog.getByRole('radio')).toHaveCount(4);
  for (const name of ['資産試作A', '資産発注前']) {
    await expect(point(dialog, name, '部品')).toBeVisible();
    await point(dialog, name, '部品').check();
    await expect(dialog.getByRole('button', { name: '選んだ保存点へ戻す', exact: true })).toBeDisabled();
  }
  await expect(point(dialog, '実共有Aの複製', '組立')).toBeVisible();
  await point(dialog, '実共有A', '組立').check();
  await expect(dialog.getByRole('button', { name: '選んだ保存点へ戻す', exact: true })).toBeEnabled();
  const token = await beginRecompute(page);
  await dialog.getByRole('button', { name: '選んだ保存点へ戻す', exact: true }).click();
  await waitForRecompute(page, token); await expect(dialog).toHaveCount(0);
  const { save } = await import('./canvasAssetLifetimeFlow.js');
  await assertSharedAssembly(page, await save(page, info, '実共有復元.pcada', app), fixture.bytes);
  await assertSharedShelf(page, fixture.archive);
}

export async function runNamedSavePointsSharedWebCold(browserType: BrowserType, info: TestInfo): Promise<string[]> {
  // Chromium's Windows database paths must not inherit the long diagnostic/test title.
  // Use a separate root from Electron's age-based sweep and atomically own one directory.
  const workspace = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
  const profileRoot = join(workspace, 'scratchpad', 'temp', 'b');
  if (join(profileRoot, 'pXXXXXX').length > 90) throw new Error('Browser profile exceeds existing Chromium path budget');
  await mkdir(profileRoot, { recursive: true });
  const ownedRoot = await realpath(profileRoot);
  if (ownedRoot !== profileRoot) throw new Error('Browser profile root leaves owned workspace boundary');
  const profile = await mkdtemp(join(ownedRoot, 'p'));
  await writeSavePointEvidence(info, 'r16-shared-profile', { profile, retainOnFailure: true });
  const use = info.project.use, errors: string[] = [];
  const launch = () => browserType.launchPersistentContext(profile, { ...use.launchOptions,
    headless: use.headless, channel: use.channel, baseURL: use.baseURL, viewport: use.viewport,
    userAgent: use.userAgent, deviceScaleFactor: use.deviceScaleFactor, isMobile: use.isMobile,
    hasTouch: use.hasTouch, locale: use.locale, colorScheme: use.colorScheme, acceptDownloads: use.acceptDownloads });
  const prepare = async (context: BrowserContext): Promise<Page> => {
    context.setDefaultTimeout(use.actionTimeout ?? 0); context.setDefaultNavigationTimeout(use.navigationTimeout ?? 0);
    await context.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    });
    const page = context.pages()[0] ?? await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/'); await waitForStartupReady(page);
    return page;
  };
  expect(await readSavePointProcessOwner(profile)).toBeNull();
  const buildPins = await readSavePointBuildPins();
  const first = await launch();
  const firstNetwork = observeSavePointNetwork(first, info, 'r16-network-before-cold');
  let archive: SavePointArchive, oldOwner: ColdProcessOwner, fixture: SharedSavePointFixture;
  try {
    const owner = await readSavePointProcessOwner(profile);
    if (owner === null) throw new Error('Actual first browser process owner missing');
    oldOwner = owner;
    const page = await prepare(first); fixture = await namedSavePointsSharedAssetFlow(page, info); archive = fixture.archive;
    await attachSavePointColdArchives(info, archive);
  } finally { try { await first.close(); } finally { await firstNetwork.finish(); } }
  await expect.poll(() => readSavePointProcessOwner(profile), { message: 'Old exact browser profile owner exited' }).toBeNull();
  const second = await launch();
  const secondNetwork = observeSavePointNetwork(second, info, 'r16-network-after-cold');
  try {
    const newOwner = await readSavePointProcessOwner(profile);
    if (newOwner === null) throw new Error('Actual cold browser process owner missing');
    expect(JSON.stringify(newOwner)).not.toBe(JSON.stringify(oldOwner));
    expect(await readSavePointBuildPins()).toBe(buildPins);
    const page = await prepare(second); await assertSharedSavePointCold(page, fixture, info);
    await writeSavePointEvidence(info, 'r16-real-process-cold', { kind: 'nonempty-shared-assembly', profile, oldOwner, newOwner,
      oldClosed: true, buildAndSourceSha256: buildPins, shelfMetadataAndEveryChunkByteEqual: true, unknown: ['unasserted original R16 conditions remain unaccepted'] });
  } finally { try { await second.close(); } finally { await secondNetwork.finish(); } }
  await expect.poll(() => readSavePointProcessOwner(profile), { message: 'Second owned browser process exited' }).toBeNull();
  // Failures retain the profile for diagnosis. Delete only our successful, closed profile.
  if (errors.length === 0) {
    const actualProfile = await realpath(profile);
    if (actualProfile !== profile || dirname(actualProfile) !== ownedRoot) throw new Error('Owned profile boundary changed');
    await rm(actualProfile, { recursive: true });
  }
  return errors;
}

