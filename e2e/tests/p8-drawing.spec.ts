/// <reference lib="dom" />
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';
import { twoBoxAssemblyFile } from './assemblyTestSupport.js';
import { configurableBoxPartFile, offsetHolePartFile } from './drawingTestSupport.js';

// E2Eの操作ラベルだけを正本から読む。UIプロジェクトのJSONを別のTSプロジェクトで再ビルドしない。
const drawingMessages: unknown = JSON.parse(readFileSync(new URL('../../packages/ui/src/i18n/ja/drawing.json', import.meta.url), 'utf8'));
function drawingMessage(key: string): string {
  const value: unknown = typeof drawingMessages === 'object' && drawingMessages !== null ? Reflect.get(drawingMessages, key) : undefined;
  if (typeof value !== 'string') throw new Error(`図面の操作ラベルがありません: ${key}`);
  return value;
}

type ClientBounds = Readonly<{ x: number; y: number; width: number; height: number }>;

/** SVGの再生成をまたぐElementHandleを保持せず、現在の文字と矩形を同じDOM処理で読む。 */
async function readTextBounds(locator: Locator): Promise<ClientBounds | null> {
  return locator.evaluateAll((elements) => {
    if (elements.length !== 1) return null;
    const element = elements[0];
    if (element === undefined || !element.isConnected) return null;
    const { x, y, width, height } = element.getBoundingClientRect();
    return width > 0 && height > 0 ? { x, y, width, height } : null;
  });
}

async function waitForTextBounds(locator: Locator): Promise<ClientBounds> {
  const result: { current: ClientBounds | null } = { current: null };
  await expect.poll(async () => {
    result.current = await readTextBounds(locator);
    return result.current !== null;
  }, { message: '現在のSVGに寸法文字の実矩形が現れる' }).toBe(true);
  if (result.current === null) throw new Error('寸法文字の実矩形なし');
  return result.current;
}

/** 縦線・横線は矩形の一辺が0でも描かれる。共通の長さ/塗り検査で誤判定を防ぐ。 */
async function expectDrawingStroke(locator: Locator): Promise<void> {
  await expect.poll(() => locator.evaluateAll((elements) => elements.some((element) => {
    if (!(element instanceof SVGPathElement)) return false;
    const style = getComputedStyle(element), matrix = element.getScreenCTM();
    return element.getTotalLength() > 0 && style.stroke !== 'none' && Number.parseFloat(style.strokeWidth) > 0
      && style.display !== 'none' && style.visibility === 'visible' && matrix !== null && Math.hypot(matrix.a, matrix.b) > 0;
  }))).toBe(true);
}

async function createBox(page: Page): Promise<void> {
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^作る/ }).first().click();
  await page.getByRole('group', { name: '作る', exact: true }).getByRole('button', { name: '箱', exact: true }).click();
  const token = await beginRecompute(page);
  await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter');
  await waitForRecompute(page, token);
  if (await page.locator('.pcad-popover').count() > 0) await page.locator('.pcad-popover input').first().press('Escape');
}

async function drawingFromBox(page: Page): Promise<void> {
  await createBox(page);
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/ }).first().click();
  await page.getByRole('button', { name: 'この部品から図面を作成', exact: true }).click();
  await expect(page.locator('.pcad-drawing-svg svg')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
  await expect.poll(() => page.locator('.pcad-drawing-svg [data-owner-id="view-1"] path').count(), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
  await expect(page.locator('.pcad-statusbar')).not.toContainText('作り直しています');
}

/** 保存文書を注入せず、実際に画面へ描かれた輪郭の中点を押す。 */
async function clickFrontEdge(page: Page): Promise<void> {
  const point = await page.locator('.pcad-drawing-svg [data-owner-id="view-1"] path').first().evaluate((element) => {
    if (!(element instanceof SVGPathElement)) throw new Error('投影線なし');
    const local = element.getPointAtLength(element.getTotalLength() / 2), matrix = element.getScreenCTM();
    if (matrix === null) throw new Error('用紙なし');
    const client = new DOMPoint(local.x, local.y).matrixTransform(matrix);
    return { x: client.x, y: client.y };
  });
  await page.mouse.click(point.x, point.y);
}

test.describe('P8 図面の実操作', () => {
  test('構成を切り替えるとパラメータと実体積が変わり、Undoと保存往復で残る(P8-62・63)', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    });
    await page.goto('/');
    const openButton = page.getByRole('button', { name: '開く', exact: true });
    await expect(openButton).toBeVisible();
    const opening = page.waitForEvent('filechooser'); await openButton.click();
    await (await opening).setFiles({ name: '構成の箱.pcad', mimeType: 'application/zip', buffer: Buffer.from(configurableBoxPartFile()) });
    const parametersTab = page.getByRole('tab', { name: 'パラメータ', exact: true });
    const propertiesTab = page.getByRole('tab', { name: 'プロパティ', exact: true });
    const box = page.locator('.pcad-panel--left').getByRole('button', { name: '箱1', exact: true });
    const volume = page.locator('.pcad-panel--right dt.pcad-properties__key', { hasText: /^体積$/u }).locator('xpath=following-sibling::dd[1]');
    const expectVolume = async (expected: number): Promise<void> => {
      await propertiesTab.click(); await box.click();
      await expect.poll(async () => Math.abs(Number.parseFloat(await volume.innerText()) - expected), { timeout: KERNEL_TIMEOUT_MS }).toBeLessThan(0.01);
    };
    await expectVolume(8000);
    await parametersTab.click();
    const configuration = page.getByRole('region', { name: '構成', exact: true });
    const select = configuration.getByRole('combobox', { name: '構成', exact: true });
    const source = page.locator('.pcad-parameter').first().locator('.pcad-field').nth(1).locator('input');
    await configuration.getByRole('textbox', { name: '構成の名前', exact: true }).fill('長い');
    await configuration.getByRole('button', { name: '追加', exact: true }).click();
    await select.selectOption({ label: '長い' });
    await source.fill('40'); await source.press('Enter');
    await expectVolume(16000);
    await parametersTab.click(); await select.selectOption({ label: '既定' }); await expect(source).toHaveValue('20');
    await expectVolume(8000);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expectVolume(16000);
    await parametersTab.click(); await expect(source).toHaveValue('40');
    await expect(select.locator('option:checked')).toHaveText('長い');
    await page.screenshot({ path: testInfo.outputPath('configuration-long.png'), fullPage: true });
    const saving = page.waitForEvent('download'); await page.keyboard.press('Control+s');
    const download = await saving; expect(download.suggestedFilename()).toMatch(/\.pcad$/u);
    const savedPath = await download.path(); if (savedPath === null) throw new Error('部品を保存できませんでした');
    const bytes = await readFile(savedPath);
    await page.reload(); await expect(openButton).toBeVisible();
    const reopening = page.waitForEvent('filechooser'); await openButton.click();
    await (await reopening).setFiles({ name: '構成の箱.pcad', mimeType: 'application/zip', buffer: bytes });
    await expectVolume(16000);
    await parametersTab.click(); await expect(select.locator('option:checked')).toHaveText('長い'); await expect(source).toHaveValue('40');
    await select.selectOption({ label: '既定' }); await expect(source).toHaveValue('20'); await expectVolume(8000);
    expect(errors).toEqual([]);
  });

  test.use({ viewport: { width: 1440, height: 900 } });
  test('実際の貫通穴から穴表とA1の引出線を作り、基準点の変更とUndoが追従する(P8-56・57)', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    });
    await page.goto('/');
    const open = page.locator('.pcad-toolbar').getByRole('button', { name: '開く', exact: true });
    await expect(open).toBeVisible();
    const choosing = page.waitForEvent('filechooser'); await open.click();
    const token = await beginRecompute(page);
    await (await choosing).setFiles({ name: '偏心穴.pcad', mimeType: 'application/zip', buffer: Buffer.from(offsetHolePartFile()) });
    await waitForRecompute(page, token);
    await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/u }).first().click();
    await page.getByRole('button', { name: 'この部品から図面を作成', exact: true }).click();
    await expect.poll(() => page.locator('.pcad-drawing-svg [data-owner-id="view-2"] path').count(), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
    const tables = page.locator('.pcad-drawing-table-editor');
    await tables.getByLabel('表と部品番号', { exact: true }).selectOption('hole');
    await tables.getByLabel('穴の座標を測る図', { exact: true }).selectOption('view-2');
    await tables.getByLabel('穴座標の基準点（元部品のmm） X', { exact: true }).fill('1');
    await tables.getByLabel('穴座標の基準点（元部品のmm） Y', { exact: true }).fill('-2');
    await tables.getByRole('button', { name: '表を配置', exact: true }).click();
    const table = page.locator('.pcad-drawing-svg [data-owner-id="table-1"]');
    await expect(table.locator('[aria-label="A1"]')).toHaveCount(2, { timeout: KERNEL_TIMEOUT_MS });
    for (const text of ['2', '6', 'φ4', '貫通']) await expect(table.locator(`[aria-label="${text}"]`)).toHaveCount(1);
    await tables.getByLabel('穴座標の基準点（元部品のmm） X', { exact: true }).fill('0');
    await tables.getByRole('button', { name: '表を更新', exact: true }).click();
    await expect(table.locator('[aria-label="3"]')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(table.locator('[aria-label="2"]')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
    await expect(page.locator('.pcad-drawing-notice')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('drawing-hole-table.png'), fullPage: true });
    await tables.getByLabel('表と部品番号', { exact: true }).selectOption('revision');
    await tables.getByLabel('左からの位置（mm）', { exact: true }).fill('220');
    await tables.getByLabel('下からの位置（mm）', { exact: true }).fill('210');
    // 操作用ラベルは製品の辞書を使う。入力値・図面に残る結果は独立に確かめる。
    for (const [label, value] of [[drawingMessage('drawing.table.revision'), 'A'], [drawingMessage('drawing.table.date'), '2026-09-10'],
      [drawingMessage('drawing.table.description'), '穴の寸法を確定'], [drawingMessage('drawing.table.approvedBy'), '設計担当']]) {
      await tables.getByLabel(`1 ${label}`, { exact: true }).fill(value);
    }
    await tables.getByRole('button', { name: drawingMessage('drawing.table.addRow'), exact: true }).click();
    await tables.getByLabel(`2 ${drawingMessage('drawing.table.revision')}`, { exact: true }).fill('B');
    await tables.getByLabel(`2 ${drawingMessage('drawing.table.description')}`, { exact: true }).fill('備考を追加');
    await tables.getByRole('button', { name: '表を配置', exact: true }).click();
    const revision = page.locator('.pcad-drawing-svg [data-owner-id="table-2"]');
    await expect(revision.locator('[aria-label="穴の寸法を確定"]')).toHaveCount(1);
    await expect(revision.locator('[aria-label="備考を追加"]')).toHaveCount(1);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click(); await expect(revision).toHaveCount(0);
    await page.getByRole('button', { name: 'やり直す', exact: true }).click(); await expect(revision.locator('[aria-label="B"]')).toHaveCount(1);
    const saving = page.waitForEvent('download'); await page.getByRole('button', { name: '保存', exact: true }).click();
    const savedPath = await (await saving).path(); if (savedPath === null) throw new Error('穴表と改訂欄を保存できませんでした');
    const savedBytes = await readFile(savedPath);
    await page.reload(); await expect(open).toBeVisible();
    const reopening = page.waitForEvent('filechooser'); await open.click();
    await (await reopening).setFiles({ name: '穴表と改訂.pcadd', mimeType: 'application/zip', buffer: savedBytes });
    await expect(table.locator('[aria-label="A1"]')).toHaveCount(2, { timeout: KERNEL_TIMEOUT_MS });
    await expect(revision.locator('[aria-label="穴の寸法を確定"]')).toHaveCount(1);
    await expect(revision.locator('[aria-label="備考を追加"]')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('drawing-hole-revision-reopened.png'), fullPage: true });
    expect(errors).toEqual([]);
  });

  test('組図の部品表・風船が双方向に連動し、参照部品ごと保存して開き直せる(P8-55・59・64)', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    });
    await page.goto('/');
    const openButton = page.locator('.pcad-toolbar').getByRole('button', { name: '開く', exact: true });
    await expect(openButton).toBeVisible();
    const opening = page.waitForEvent('filechooser'); await openButton.click();
    const token = await beginRecompute(page);
    await (await opening).setFiles({ name: '2部品.pcada', mimeType: 'application/zip', buffer: Buffer.from(await twoBoxAssemblyFile()) });
    await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
    await waitForRecompute(page, token);
    await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/u }).first().click();
    await page.getByRole('button', { name: 'この組立から図面を作成', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg svg')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
    const paths = page.locator('.pcad-drawing-svg [data-owner-id^="projection:"] path');
    await expect.poll(() => paths.count(), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
    const tables = page.locator('.pcad-drawing-table-editor');
    await tables.getByLabel('表と部品番号', { exact: true }).selectOption('bom');
    await tables.getByRole('checkbox', { name: '構成', exact: true }).check();
    await tables.getByRole('button', { name: '表を配置', exact: true }).click();
    const row = page.locator('.pcad-drawing-svg [data-owner-id^="bom-row:"]');
    await expect(row.locator('[aria-label="既定"]')).toHaveCount(1);
    await expect(row.locator('[aria-label="2"]')).toHaveCount(1); // 同じ参照の2配置を数量2と集計
    const clickEdge = async (): Promise<void> => {
      const point = await paths.first().evaluate((element) => {
        if (!(element instanceof SVGPathElement)) throw new Error('投影線がありません');
        const local = element.getPointAtLength(element.getTotalLength() / 2), matrix = element.getScreenCTM();
        if (matrix === null) throw new Error('用紙がありません');
        const client = new DOMPoint(local.x, local.y).matrixTransform(matrix); return { x: client.x, y: client.y };
      });
      await page.mouse.click(point.x, point.y);
    };
    await clickEdge();
    await expect(row.locator('path[fill="#2563eb"]').first()).toBeVisible();
    await page.getByRole('button', { name: '部品番号の風船', exact: true }).click();
    // 直前の投影線の選択を使って、紙上320,220mmへ風船を置く。
    const position = await page.locator('.pcad-drawing-svg svg').evaluate((element) => {
      if (!(element instanceof SVGSVGElement)) throw new Error('図面がありません');
      const matrix = element.getScreenCTM(); if (matrix === null) throw new Error('用紙がありません');
      const point = new DOMPoint(320, element.viewBox.baseVal.height - 220).matrixTransform(matrix);
      return { x: point.x, y: point.y };
    });
    await page.mouse.click(position.x, position.y);
    const balloon = page.locator('.pcad-drawing-svg [data-owner-id="balloon-1"]');
    await expect(balloon.locator('[aria-label="1"]')).toHaveCount(1);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click(); await expect(balloon).toHaveCount(0);
    await page.getByRole('button', { name: 'やり直す', exact: true }).click(); await expect(balloon.locator('[aria-label="1"]')).toHaveCount(1);
    // 表の行からも対応する配置と風船が強調される。選択で文書や番号は変えない。
    const rowNumber = row.locator('[aria-label="2"]');
    const rowBounds = await waitForTextBounds(rowNumber);
    await page.mouse.click(rowBounds.x + rowBounds.width / 2, rowBounds.y + rowBounds.height / 2);
    await expectDrawingStroke(balloon.locator('path[stroke="#2563eb"]'));
    await expectDrawingStroke(page.locator('.pcad-drawing-svg [data-owner-id^="projection:"] path[stroke="#2563eb"]'));
    await page.screenshot({ path: testInfo.outputPath('drawing-bom-balloon.png'), fullPage: true });
    // 図面モードかつ入力欄に焦点がある場合も、共通の保存処理へ届く。
    await page.locator('details.pcad-drawing-settings').getByLabel('図面ひな形の名前', { exact: true }).focus();
    const saving = page.waitForEvent('download'); await page.keyboard.press('Control+s');
    const download = await saving; expect(download.suggestedFilename()).toMatch(/\.pcadd$/u);
    await expect(page.locator('.pcad-statusbar')).toContainText('保存しました');
    const savedPath = await download.path(); if (savedPath === null) throw new Error('図面を保存できませんでした');
    const bytes = await readFile(savedPath);
    await page.reload(); // 元のアセンブリもカーネルの形も無い新しい実行環境で開く
    await expect(openButton).toBeVisible();
    const reopening = page.waitForEvent('filechooser'); await openButton.click();
    await (await reopening).setFiles({ name: '組図.pcadd', mimeType: 'application/zip', buffer: bytes });
    await expect.poll(() => paths.count(), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
    await expect(row.locator('[aria-label="2"]')).toHaveCount(1);
    await expect(balloon.locator('[aria-label="1"]')).toHaveCount(1);
    await expect(page.locator('.pcad-drawing-notice')).toHaveCount(0);
    await expect(row.locator('[aria-label="既定"]')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('4分割の実描画性能・区画ごとの立体選択と1画面復帰(FR-113)', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await createBox(page);
    const namedMenu = page.locator('details').filter({ has: page.locator('summary', { hasText: /^保存した視点$/u }) });
    await namedMenu.locator('summary').click(); await page.getByRole('button', { name: '4分割で見る', exact: true }).click();
    await namedMenu.locator('summary').click();
    const canvas = page.locator('canvas.pcad-viewport__canvas');
    await expect(canvas).toHaveCount(1); await expect(page.locator('.pcad-quad__pane')).toHaveCount(4);
    const box = await canvas.boundingBox(); if (box === null) throw new Error('描画面がありません');
    // 4区画の中心に同じ実ボディが見え、実際のraycastで各方向から選べる。
    for (const [x, y] of [[0.25, 0.25], [0.25, 0.75], [0.75, 0.75], [0.75, 0.25]]) {
      await canvas.focus(); await page.keyboard.press('Escape'); await page.keyboard.press('4');
      await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
      const selected = page.locator('.pcad-panel--right dt').filter({ hasText: /^選んでいるもの$/u }).locator('xpath=following-sibling::dd[1]');
      await expect(selected).toHaveText('立体');
    }
    await page.screenshot({ path: testInfo.outputPath('quad-four-views.png'), fullPage: true });
    const center = { x: box.x + box.width * 0.75, y: box.y + box.height * 0.25 };
    await page.mouse.move(center.x, center.y);
    const stats = () => page.evaluate(() => {
      const value = window.pcadViewportRenderStats?.(); if (value === undefined) throw new Error('描画統計がありません');
      return { ...value, now: performance.now() };
    });
    await page.mouse.down({ button: 'middle' });
    const before = await stats();
    try {
      const end = Date.now() + 2000; let index = 0;
      while (Date.now() < end) {
        const sign = index++ % 2 === 0 ? 1 : -1;
        await page.mouse.move(center.x + sign * 36, center.y + sign * 18);
      }
    } finally { await page.mouse.up({ button: 'middle' }); }
    const after = await stats(), elapsedMs = after.now - before.now, frames = after.completedRenders - before.completedRenders;
    const fps = frames * 1000 / elapsedMs;
    console.log(`[実測] 4分割ビューポート: ${fps.toFixed(1)} fps (${frames}画面/${elapsedMs.toFixed(1)}ms、1画面は4カメラ分)`);
    expect(fps).toBeGreaterThanOrEqual(30);
    await namedMenu.locator('summary').click(); await page.getByRole('button', { name: '1画面に戻す', exact: true }).click();
    await expect(page.locator('.pcad-quad')).toHaveCount(0); await expect(canvas).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('用紙と表題欄をひな形へ保存し、空の図面から保存した視点で投影図を作る(P8-58〜60)', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await createBox(page);
    const namedMenu = page.locator('details').filter({ has: page.locator('summary', { hasText: /^保存した視点$/u }) });
    await namedMenu.locator('summary').click();
    await namedMenu.getByLabel('視点を選ぶ', { exact: true }).selectOption('namedView-top');
    await namedMenu.getByRole('button', { name: 'この視点へ', exact: true }).click();
    await namedMenu.getByLabel('視点の名前', { exact: true }).fill('検査用の平面');
    await namedMenu.getByRole('button', { name: '今の視点を保存', exact: true }).click();
    await namedMenu.getByLabel('視点を選ぶ', { exact: true }).selectOption({ label: '検査用の平面' });
    await namedMenu.getByRole('button', { name: 'この視点へ', exact: true }).click();
    await namedMenu.locator('summary').click();
    const savingPart = page.waitForEvent('download'); await page.keyboard.press('Control+s');
    const partDownload = await savingPart, partPath = await partDownload.path();
    if (partPath === null) throw new Error('視点を含む部品を保存できませんでした');
    const partBytes = await readFile(partPath);
    await page.reload();
    const openButton = page.getByRole('button', { name: '開く', exact: true }); await expect(openButton).toBeVisible();
    const reopeningPart = page.waitForEvent('filechooser'); await openButton.click();
    const reopeningGeneration = await beginRecompute(page);
    await (await reopeningPart).setFiles({ name: '視点を含む部品.pcad', mimeType: 'application/zip', buffer: partBytes });
    await waitForRecompute(page, reopeningGeneration);
    await namedMenu.locator('summary').click();
    await namedMenu.getByLabel('視点を選ぶ', { exact: true }).selectOption({ label: '検査用の平面' });
    await namedMenu.getByRole('button', { name: 'この視点へ', exact: true }).click();
    await namedMenu.locator('summary').click();
    await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/u }).first().click();
    await page.getByRole('button', { name: 'この部品から図面を作成', exact: true }).click();
    await expect.poll(() => page.locator('.pcad-drawing-svg [data-owner-id="view-1"] path').count(), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
    const settings = page.locator('details.pcad-drawing-settings');
    await settings.getByLabel('図名', { exact: true }).fill('ひな形の製品図');
    await settings.getByLabel('文字の高さ（mm）', { exact: true }).fill('2.5');
    await settings.getByRole('button', { name: '用紙設定を適用', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="ひな形の製品図"]')).toHaveCount(1);
    await settings.getByLabel('図面ひな形の名前', { exact: true }).fill('社内A3標準');
    const downloading = page.waitForEvent('download');
    await settings.getByRole('button', { name: '図面ひな形として保存', exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('社内A3標準.pcadt');
    const path = await download.path(); if (path === null) throw new Error('ひな形の保存先がありません');
    page.once('dialog', (dialog) => { void dialog.accept(); });
    await page.getByRole('button', { name: '部品へ戻る', exact: true }).click();
    await expect(page.locator('canvas.pcad-viewport__canvas')).toHaveCount(1);
    await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/u }).first().click();
    const choosing = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '図面ひな形から作成', exact: true }).click();
    await (await choosing).setFiles({ name: '社内A3標準.pcadt', mimeType: 'application/zip', buffer: await readFile(path) });
    await expect(page.locator('.pcad-drawing-svg svg')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
    await expect(page.locator('.pcad-drawing-svg [data-owner-id^="view-"]')).toHaveCount(0);
    await expect(settings.getByLabel('図名', { exact: true })).toHaveValue('ひな形の製品図');
    const view = page.locator('section.pcad-drawing-settings');
    await view.getByLabel('元の部品で保存した視点', { exact: true }).selectOption({ label: '検査用の平面' });
    await view.getByRole('button', { name: '投影図を追加', exact: true }).click();
    await expect.poll(() => page.locator('.pcad-drawing-svg [data-owner-id="view-1"] path').count(), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [data-owner-id="view-1"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'やり直す', exact: true }).click();
    await expect.poll(() => page.locator('.pcad-drawing-svg [data-owner-id="view-1"] path').count(), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath('drawing-template-view.png'), fullPage: true });
    expect(errors).toEqual([]);
  });

  test('箱の三面図→寸法→公差・はめあい→Undo→自動寸法→実字体SVG', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await drawingFromBox(page);
    // 垂直/水平のSVG線は矩形の幅/高さが0でもstrokeが見える。長さと実クリックで検査する。
    for (const id of ['view-1', 'view-2', 'view-3']) expect(await page.locator(`.pcad-drawing-svg [data-owner-id="${id}"] path`).first()
      .evaluate((element) => element instanceof SVGPathElement ? element.getTotalLength() : 0)).toBeGreaterThan(0);
    await clickFrontEdge(page); await page.keyboard.press('Enter');
    const form = page.getByRole('form', { name: '寸法の公差・はめあい' });
    await expect(form).toBeVisible(); await expect(form.locator('output')).toHaveText('20');
    await form.getByRole('combobox', { name: '記入方法', exact: true }).selectOption('symmetric');
    await form.getByLabel('対称公差', { exact: true }).fill('0.1');
    await form.getByRole('button', { name: '決定', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="20±0.1"]')).toHaveCount(1);
    await form.getByRole('combobox', { name: '記入方法', exact: true }).selectOption('fit');
    await form.getByRole('button', { name: '決定', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="20H7"]')).toHaveCount(1);
    await expect(page.locator('.pcad-drawing-svg [aria-label="+0.021"]')).toHaveCount(1);
    // 決定ボタンに焦点が残っていても、Ctrl+Zは図面の履歴へ届く。
    await page.keyboard.press('Control+z');
    await expect(page.locator('.pcad-drawing-svg [aria-label="20±0.1"]')).toHaveCount(1);
    const text = page.locator('.pcad-drawing-svg [aria-label="20±0.1"]');
    const beforeDrag = await waitForTextBounds(text);
    await page.mouse.move(beforeDrag.x + beforeDrag.width / 2, beforeDrag.y + beforeDrag.height / 2);
    await page.mouse.down();
    await page.mouse.move(beforeDrag.x + beforeDrag.width / 2 + 15, beforeDrag.y + beforeDrag.height / 2 - 12, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await readTextBounds(text))?.x).toBeCloseTo(beforeDrag.x + 15, 0);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect.poll(async () => (await readTextBounds(text))?.x).toBeCloseTo(beforeDrag.x, 0);
    await page.getByRole('button', { name: '自動寸法', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="20"]')).toHaveCount(6);
    // 手動の公差文字を動かさずに、追加する自動寸法を実字体の囲みから避ける。
    // 全7文字を同じ再描画の状態から読み、途中のDOM交換による混在も防ぐ。
    await expect.poll(() => page.locator('.pcad-drawing-svg').evaluate((element) => {
      const manual = element.querySelector('[aria-label="20±0.1"]')?.getBoundingClientRect();
      const automatic = Array.from(element.querySelectorAll('[aria-label="20"]'), (item) => item.getBoundingClientRect());
      if (manual === undefined || manual.width <= 0 || manual.height <= 0 || automatic.length !== 6
        || automatic.some((item) => item.width <= 0 || item.height <= 0)) return null;
      return automatic.map((bounds) => bounds.x < manual.x + manual.width && manual.x < bounds.x + bounds.width
        && bounds.y < manual.y + manual.height && manual.y < bounds.y + bounds.height);
    }), { message: '手動1件と自動6件の実文字が重ならない' }).toEqual([false, false, false, false, false, false]);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'SVGで書き出す', exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.svg$/);
    const path = await download.path();
    if (path === null) throw new Error('SVGが保存されなかった');
    const svg = await readFile(path, 'utf8');
    expect(svg).toContain('width="420mm"'); expect(svg).not.toContain('<text'); expect(svg).toContain('20±0.1');
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('drawing-dimensions.png'), fullPage: true });
    const toolbar = await page.locator('.pcad-toolbar').boundingBox();
    expect(toolbar?.height).toBeLessThanOrEqual(100);
  });
  test('図面の面を選び、その場の入力で表面性状を配置できる', async ({ page }, testInfo) => {
    await drawingFromBox(page);
    const box = await page.locator('.pcad-drawing-svg [data-owner-id="view-1"]').evaluateAll((elements) => {
      const boxes = elements.map((element) => element.getBoundingClientRect());
      return { left: Math.min(...boxes.map((item) => item.left)), right: Math.max(...boxes.map((item) => item.right)),
        top: Math.min(...boxes.map((item) => item.top)), bottom: Math.max(...boxes.map((item) => item.bottom)) };
    });
    await page.mouse.click((box.left + box.right) / 2, (box.top + box.bottom) / 2);
    await page.locator('summary').filter({ hasText: /^寸法・注記$/ }).click();
    await page.getByRole('group', { name: '寸法・注記', exact: true }).getByRole('button', { name: '注記', exact: true }).click();
    const form = page.getByRole('form', { name: '注記', exact: true });
    await expect(form).toBeVisible();
    await form.getByRole('button', { name: '決定', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="Ra 3.2"]')).toHaveCount(1);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="Ra 3.2"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'やり直す', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="Ra 3.2"]')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('drawing-surface-finish.png'), fullPage: true });
  });
});

test.describe('P8 図面の出力と文字注記', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  async function addNote(page: Page): Promise<void> {
    await page.locator('summary').filter({ hasText: /^寸法・注記$/ }).click();
    await page.getByRole('group', { name: '寸法・注記', exact: true }).getByRole('button', { name: '文字注記', exact: true }).click();
    const point = await page.locator('.pcad-drawing-svg svg').evaluate((element) => {
      if (!(element instanceof SVGSVGElement)) throw new Error('図面のSVGが無い');
      const matrix = element.getScreenCTM();
      if (matrix === null) throw new Error('用紙の位置が無い');
      const client = new DOMPoint(80, 77).matrixTransform(matrix);
      return { x: client.x, y: client.y };
    });
    await page.mouse.click(point.x, point.y);
    const form = page.getByRole('form', { name: '文字注記', exact: true });
    await expect(form).toBeVisible();
    await form.getByLabel('注記の文章', { exact: true }).fill('8 日 φ\n加工面は清掃する');
    await form.getByRole('button', { name: '決定', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="8 日 φ"]')).toHaveCount(1);
    await expect(page.locator('.pcad-drawing-svg [aria-label="加工面は清掃する"]')).toHaveCount(1);
    await form.getByRole('button', { name: '閉じる', exact: true }).click();
  }

  async function downloadFormat(page: Page, format: 'pdf' | 'svg' | 'dxf' | 'png' | 'jpg', dpi?: number) {
    await page.getByRole('button', { name: '図面を書き出す', exact: true }).click();
    const form = page.getByRole('form', { name: '図面を書き出す', exact: true });
    await form.getByLabel('ファイルの種類', { exact: true }).selectOption(format);
    if (dpi !== undefined) await form.getByLabel('画像の解像度', { exact: true }).selectOption(String(dpi));
    const pending = page.waitForEvent('download');
    await form.getByRole('button', { name: '書き出す', exact: true }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toMatch(new RegExp(`\\.${format}$`));
    const path = await download.path();
    if (path === null) throw new Error('書き出したファイルが無い');
    return { download, bytes: await readFile(path) };
  }

  test('複数行の文字注記を編集・移動してもUndo一回ずつで戻る', async ({ page }, testInfo) => {
    await drawingFromBox(page); await addNote(page);
    const text = page.locator('.pcad-drawing-svg [aria-label="8 日 φ"]');
    const before = await waitForTextBounds(text);
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 20, before.y + before.height / 2 - 10, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await readTextBounds(text))?.x).toBeCloseTo(before.x + 20, 0);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect.poll(async () => (await readTextBounds(text))?.x).toBeCloseTo(before.x, 0);
    // Undoは選択を解除するので、画面上の注記を選び直して編集する。
    const restored = await waitForTextBounds(text);
    await page.mouse.click(restored.x + restored.width / 2, restored.y + restored.height / 2);
    const form = page.getByRole('form', { name: '文字注記', exact: true });
    await form.getByLabel('注記の文章', { exact: true }).fill('検査済み');
    await form.getByRole('button', { name: '決定', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="検査済み"]')).toHaveCount(1);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(text).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('drawing-note.png'), fullPage: true });
  });

  test('部品へ戻る際の破棄を断ると図面とUndoが残り、同意した時だけ閉じる（R03）', async ({ page }) => {
    await drawingFromBox(page); await addNote(page);
    const text = page.locator('.pcad-drawing-svg [aria-label="8 日 φ"]');
    const dialogOpened = page.waitForEvent('dialog');
    const clicked = page.getByRole('button', { name: '部品へ戻る', exact: true }).click();
    const dialog = await dialogOpened;
    expect(dialog.type()).toBe('confirm'); expect(dialog.message()).toContain('保存していない変更');
    await dialog.dismiss(); await clicked;
    await expect(text).toHaveCount(1);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(text).toHaveCount(0);
    const confirmed = page.waitForEvent('dialog');
    const returnClick = page.getByRole('button', { name: '部品へ戻る', exact: true }).click();
    await (await confirmed).accept(); await returnClick;
    await expect(page.locator('.pcad-drawing-svg')).toHaveCount(0);
    await expect(page.locator('canvas.pcad-viewport__canvas')).toBeVisible();
  });

  test('注記を含む同じ図面をPDF・SVG・R12 DXFへ書き出す', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await drawingFromBox(page); await addNote(page);
    for (const format of ['pdf', 'svg', 'dxf'] as const) {
      const { bytes, download } = await downloadFormat(page, format);
      await download.saveAs(testInfo.outputPath(`drawing-output.${format}`));
      const content = bytes.toString('utf8');
      if (format === 'pdf') {
        expect(content.startsWith('%PDF-1.4')).toBe(true);
        expect(content).toMatch(/\/MediaBox\s*\[0 0 1190\.5512 841\.8898\]/u);
        expect(content).not.toContain('/Subtype /Image');
      } else if (format === 'svg') {
        expect(content).toContain('width="420mm"'); expect(content).toContain('8 日 φ'); expect(content).not.toContain('<text');
      } else {
        expect(content).toContain('AC1009'); expect(content).toContain('TEXT'); expect(content).toContain('\\U+65E5');
        await expect(page.locator('.pcad-statusbar')).toContainText('線の太さは保存されません');
      }
      console.log(`[実測] 図面${format}: ${bytes.length}バイト`);
    }
    expect(errors).toEqual([]);
  });

  test('図面の印刷ボタンが実寸の紙面を渡し、印刷後も図面とUndoを保つ', async ({ page, context }, testInfo) => {
    await drawingFromBox(page); await addNote(page);
    // window.printは置き換えず、ブラウザーの実際のbeforeprintで紙面を採取する。
    await page.evaluate(() => {
      window.addEventListener('beforeprint', () => {
        const image = document.querySelector('.pcad-drawing-print-sheet img');
        if (!(image instanceof HTMLImageElement)) return;
        const style = Array.from(document.querySelectorAll('style')).find((item) => item.textContent.includes('.pcad-drawing-print-sheet'));
        document.documentElement.dataset.printCss = style?.textContent ?? '';
        // Blob URLの読取は印刷中に開始する。アプリによる後始末を遅らせない。
        void fetch(image.src).then((response) => response.text()).then((svg) => {
          document.documentElement.dataset.printSvg = svg;
        });
      }, { once: true });
    });
    await page.getByRole('button', { name: '図面を印刷', exact: true }).click();
    await expect.poll(() => page.locator('html').getAttribute('data-print-svg')).toContain('8 日 φ');
    await expect(page.locator('.pcad-drawing-print-sheet')).toHaveCount(0);
    const output = await page.locator('html').evaluate((element) => ({ svg: element.dataset.printSvg ?? '', css: element.dataset.printCss ?? '' }));
    expect(output.css).toContain('@page { size: A3 landscape; margin: 0; }');
    expect(output.svg).toContain('width="420mm"'); expect(output.svg).not.toContain('<text');
    const printed = await context.newPage();
    try {
      await printed.evaluate(async ({ svg, css }) => {
        const style = document.createElement('style'); style.textContent = css; document.head.append(style);
        const sheet = document.createElement('section'); sheet.className = 'pcad-drawing-print-sheet';
        const image = document.createElement('img');
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        sheet.append(image); document.body.append(sheet); await image.decode();
      }, output);
      const bytes = await printed.pdf({ preferCSSPageSize: true, printBackground: true, path: testInfo.outputPath('drawing-browser-print.pdf') });
      expect(bytes.length).toBeGreaterThan(1000);
    } finally { await printed.close(); }
    await expect(page.locator('.pcad-drawing-svg [aria-label="8 日 φ"]')).toHaveCount(1);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="8 日 φ"]')).toHaveCount(0);
  });

  test('A3の実画像を600dpi PNGと150dpi JPEGで保存し、白い背景で開ける', async ({ page }, testInfo) => {
    await drawingFromBox(page); await addNote(page);
    for (const [format, dpi, width, height] of [['png', 600, 9921, 7016], ['jpg', 150, 2480, 1754]] as const) {
      const started = Date.now();
      const { bytes, download } = await downloadFormat(page, format, dpi);
      await download.saveAs(testInfo.outputPath(`drawing-${dpi}.${format}`));
      const decoded = await page.evaluate(async ({ base64, mime }) => {
        const data = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([data], { type: mime }));
        const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
        const context = canvas.getContext('2d'); if (context === null) throw new Error('画像の読取に失敗');
        try {
          context.drawImage(bitmap, 0, 0, 1, 1, 0, 0, 1, 1);
          return { width: bitmap.width, height: bitmap.height, corner: Array.from(context.getImageData(0, 0, 1, 1).data) };
        } finally { bitmap.close(); canvas.width = 0; canvas.height = 0; }
      }, { base64: bytes.toString('base64'), mime: format === 'png' ? 'image/png' : 'image/jpeg' });
      expect(decoded).toEqual({ width, height, corner: [255, 255, 255, 255] });
      expect(bytes.length).toBeGreaterThan(1000);
      console.log(`[実測] A3 ${dpi}dpi ${format}: ${decoded.width}×${decoded.height}, ${bytes.length}バイト, ${Date.now() - started}ms`);
    }
  });
});

test('P8 文字の輪郭を作図面へ置き、全ての辺をUndo一回で戻せる', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  const sketch = page.locator('.pcad-panel--left .pcad-tree__sections > li').filter({ hasText: 'スケッチ' });
  const rows = sketch.locator('.pcad-tree__children > li');
  await expect(rows).toHaveCount(0);
  await page.getByRole('group', { name: 'スケッチ' }).locator('.pcad-menu__trigger').first().click();
  await page.locator('.pcad-menu__panel[aria-label="作図"]').getByRole('button', { name: '文字をかく', exact: true }).click();
  await page.locator('canvas.pcad-viewport__canvas').click();
  const form = page.getByRole('form', { name: '文字をかく', exact: true });
  await expect(form).toBeVisible();
  await form.getByLabel('文字列', { exact: true }).fill('8日φ');
  await form.getByLabel('文字の高さ (mm)', { exact: true }).fill('12');
  await form.getByLabel('文字の角度 (°)', { exact: true }).fill('30');
  await form.getByRole('button', { name: '決定', exact: true }).click();
  await expect(form).toBeHidden();
  await expect.poll(() => rows.count()).toBeGreaterThan(10);
  const featureCount = await rows.count();
  await page.keyboard.press('Control+z'); await expect(rows).toHaveCount(0);
  await page.keyboard.press('Control+y'); await expect(rows).toHaveCount(featureCount);
  await page.screenshot({ path: testInfo.outputPath('sketch-text-outlines.png'), fullPage: true });
});
