/// <reference lib="dom" />
import { readFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { readDrawingBundle } from '../../packages/io/src/index.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { chooseDrawingMenu, waitForDrawingReady } from './drawingManufacturingFixture.js';
import { diskFile, openTarget, saveTarget } from './electronAppFlow.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';
import { waitForStartupHealth } from './startupHealth.js';

async function defaults(page: Page, group: string, values: readonly (readonly [string, string])[]) {
  await page.getByRole('button', { name: '設定', exact: true }).click();
  const form = page.getByRole('form', { name: '道具の初期値', exact: true });
  await form.getByLabel('変更する入力', { exact: true }).selectOption({ label: group });
  for (const [name, value] of values) await form.getByRole('textbox', { name: new RegExp(`^${name}`, 'u') }).fill(value);
  await form.getByRole('button', { name: '初期値を適用', exact: true }).click();
  await page.getByRole('button', { name: '設定', exact: true }).click();
}

async function save(page: Page, info: TestInfo, name: string, app?: ElectronApplication) {
  await waitForDrawingReady(page);
  const path = info.outputPath(name);
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  if (app !== undefined) await saveTarget(app, path);
  await page.locator('.pcad-drawing-sheet').focus();
  await expect(page.locator('.pcad-drawing-sheet')).toBeFocused();
  if (app === undefined) {
    const [file] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+Shift+s')]);
    await file.saveAs(path);
  } else { await page.keyboard.press('Control+Shift+s'); await diskFile(path); }
  const result = await readDrawingBundle(await readFile(path));
  if (!result.ok) throw new Error('保存した図面を読み戻せません');
  return result.document;
}

async function openNote(page: Page) {
  await chooseDrawingMenu(page, '記入', '文字注記');
  const point = await page.locator('.pcad-drawing-svg svg').evaluate(element => {
    if (!(element instanceof SVGSVGElement)) throw new Error('用紙の描画領域がありません');
    const matrix = element.getScreenCTM();
    if (matrix === null) throw new Error('用紙の位置がありません');
    const client = new DOMPoint(80, 77).matrixTransform(matrix); return { x: client.x, y: client.y };
  });
  await page.mouse.click(point.x, point.y);
  const form = page.getByRole('form', { name: '文字注記', exact: true });
  await expect(form).toBeVisible(); return form;
}

/** 図面の新規注記と既存注記の値を、通常の保存・再開を含めて確認する。 */
export async function drawingToolDefaultsFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 }); await waitForStartupHealth(page, info);
  await chooseToolMenuItem(page, '作る', '箱');
  const token = await beginRecompute(page);
  await page.locator('.pcad-popover input').first().press('Enter'); await waitForRecompute(page, token);
  if (await page.locator('.pcad-popover').count() > 0) await page.locator('.pcad-popover input').first().press('Escape');
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/u }).first().click();
  await page.getByRole('button', { name: 'この部品から図面を作成', exact: true }).click();
  await expect(page.locator('.pcad-drawing-svg svg')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS }); await waitForDrawingReady(page);
  const original = await save(page, info, 'drawing-defaults-original.pcadd', app);
  await defaults(page, '文字注記', [['文字の高さ', '2*3']]);
  expect(await save(page, info, 'drawing-defaults-settings-only.pcadd', app)).toEqual(original);

  const form = await openNote(page);
  await expect(form.getByLabel('文字の高さ (mm)', { exact: true })).toHaveValue('6');
  await defaults(page, '文字注記', [['文字の高さ', '8']]);
  await expect(form.getByLabel('文字の高さ (mm)', { exact: true })).toHaveValue('6');
  await form.getByLabel('注記の文章', { exact: true }).fill('設定前の文字');
  await form.getByRole('button', { name: '決定', exact: true }).click();
  await expect(page.locator('.pcad-drawing-svg [aria-label="設定前の文字"]')).toHaveCount(1);
  await form.getByRole('button', { name: '閉じる', exact: true }).click();
  await openNote(page); await expect(form.getByLabel('文字の高さ (mm)', { exact: true })).toHaveValue('8');
  await form.getByLabel('注記の文章', { exact: true }).fill('設定後の文字');
  await form.getByLabel('横の位置 (mm)', { exact: true }).fill('120');
  await form.getByRole('button', { name: '決定', exact: true }).click();
  await expect(page.locator('.pcad-drawing-svg [aria-label="設定後の文字"]')).toHaveCount(1);
  await form.getByRole('button', { name: '閉じる', exact: true }).click();
  const created = await save(page, info, 'drawing-defaults-created.pcadd', app);
  expect(created.annotations.map(item => [item.text, item.height])).toEqual([['設定前の文字', 6], ['設定後の文字', 8]]);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click(); await waitForDrawingReady(page);
  expect((await save(page, info, 'drawing-defaults-undone.pcadd', app)).annotations.map(item => [item.text, item.height])).toEqual([['設定前の文字', 6]]);

  await page.reload(); await waitForStartupHealth(page, info);
  const path = info.outputPath('drawing-defaults-created.pcadd');
  if (app === undefined) {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: '開く', exact: true }).click()]);
    await chooser.setFiles(path);
  } else { await openTarget(app, path); await page.getByRole('button', { name: '開く', exact: true }).click(); }
  await expect(page.locator('.pcad-drawing-svg [aria-label="設定前の文字"]')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
  expect(await save(page, info, 'drawing-defaults-reopened.pcadd', app)).toEqual(created);
  await page.locator('.pcad-panel--left').getByRole('button', { name: '設定前の文字', exact: true }).click();
  await expect(form.getByLabel('文字の高さ (mm)', { exact: true })).toHaveValue('6');
  await form.getByRole('button', { name: '閉じる', exact: true }).click();
  expect(await save(page, info, 'drawing-defaults-edit-cancelled.pcadd', app)).toEqual(created);
}
