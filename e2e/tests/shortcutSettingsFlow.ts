import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { command, tree } from './sheetUiFlow.js';
import { savePart } from './scriptsFlow.js';
import { waitForStartupHealth } from './startupHealth.js';
import { uiMessage } from './uiMessages.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { captureManualDetail } from './captureManualDetail.js';

const settings = (page: Page) => page.getByRole('form', { name: 'キーの割当', exact: true });
async function openSettings(page: Page): Promise<void> {
  if (await settings(page).isVisible()) return;
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(settings(page)).toBeVisible();
}
async function assign(page: Page, id: string, key: string): Promise<void> {
  const form = settings(page);
  await form.getByLabel('割当を変える操作', { exact: true }).selectOption(id);
  await form.getByLabel('新しいキー', { exact: true }).press(key);
}
async function closeSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(settings(page)).toHaveCount(0);
}
async function point(page: Page): Promise<void> {
  const generation = await beginRecompute(page);
  await command(page, 'PO'); await command(page, '12,34');
  await page.keyboard.press('Escape');
  await expect(tree(page, '点1')).toBeVisible();
  await waitForRecompute(page, generation);
}
async function keyInViewport(page: Page, key: string): Promise<void> {
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press(key);
}

export async function shortcutSettingsFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await point(page);
  const before = await savePart(page, info, 'shortcut-before.pcad', app);
  await openSettings(page);
  await assign(page, 'history.undo', 'F2');
  await assign(page, 'history.redo', 'F3');
  await settings(page).getByRole('button', { name: '割当を適用', exact: true }).click();
  await expect(settings(page).getByRole('status')).toHaveText('キーの割当を適用しました。');
  await settings(page).scrollIntoViewIfNeeded();
  const settingBounds = await settings(page).boundingBox(), panelBounds = await page.locator('.pcad-settings').boundingBox();
  if (settingBounds === null || panelBounds === null) throw new Error('キー設定の画面がありません。');
  expect(settingBounds.y).toBeGreaterThanOrEqual(panelBounds.y);
  expect(settingBounds.y + settingBounds.height).toBeLessThanOrEqual(panelBounds.y + panelBounds.height);
  await captureManualDetail(page, info, { name: 'shortcut-settings', dialog: settings(page), fixture: before,
    script: new URL(import.meta.url) });
  await closeSettings(page);
  await expect(page.getByRole('button', { name: '元に戻す', exact: true })).toHaveAttribute('title', '元に戻す (F2)');
  expect(await savePart(page, info, 'shortcut-after.pcad', app)).toEqual(before);
  await keyInViewport(page, 'F2'); await expect(tree(page, '点1')).toHaveCount(0);
  await keyInViewport(page, 'F3'); await expect(tree(page, '点1')).toBeVisible();
  await keyInViewport(page, 'Control+z'); await expect(tree(page, '点1')).toBeVisible();

  await page.reload();
  await waitForStartupHealth(page, info);
  await openSettings(page);
  await settings(page).getByLabel('割当を変える操作', { exact: true }).selectOption('history.undo');
  await expect(settings(page).getByLabel('新しいキー', { exact: true })).toHaveValue('F2');
  await settings(page).getByLabel('新しいキー', { exact: true }).press('F1');
  const help = page.locator('.pcad-help');
  await expect(help).toBeVisible();
  await expect(help.locator('.pcad-help__article')).toContainText('F2');
  await expect(help.locator('.pcad-help__article')).toContainText('文字入力・メニュー・ダイアログを除く');
  await help.getByRole('button', { name: uiMessage('help', 'help.close'), exact: true }).click();
  await openSettings(page);
  await settings(page).getByRole('button', { name: '全操作を元の割当へ戻す', exact: true }).click();
  await settings(page).getByRole('button', { name: '割当を適用', exact: true }).click();
  await closeSettings(page);
}

export async function shortcutConflictFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await point(page);
  const before = await savePart(page, info, 'conflict-before.pcad', app);
  await openSettings(page);
  await assign(page, 'history.undo', 'F2');
  await assign(page, 'history.redo', 'F2');
  await expect(settings(page).getByRole('alert')).toContainText('同じキー');
  await expect(settings(page).getByRole('button', { name: '割当を適用', exact: true })).toBeDisabled();
  await settings(page).getByRole('button', { name: '割当の変更を取り消す', exact: true }).click();
  await expect(settings(page).getByRole('alert')).toHaveCount(0);
  await assign(page, 'history.undo', 'F5');
  await expect(settings(page).getByRole('alert')).toContainText('割り当てられません');
  await settings(page).getByRole('button', { name: '割当の変更を取り消す', exact: true }).click();
  await assign(page, 'history.undo', 'u');
  await settings(page).getByRole('button', { name: '割当を適用', exact: true }).click();
  await closeSettings(page);

  const input = page.locator('#pcad-command-line-input');
  await input.fill('ab'); await input.press('u'); await expect(input).toHaveValue('abu');
  await expect(tree(page, '点1')).toBeVisible();
  await page.locator('canvas.pcad-viewport__canvas').evaluate(canvas => {
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', bubbles: true, isComposing: true }));
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', bubbles: true, modifierAltGraph: true }));
  });
  await expect(tree(page, '点1')).toBeVisible();
  expect(await savePart(page, info, 'conflict-after.pcad', app)).toEqual(before);
  await keyInViewport(page, 'u'); await expect(tree(page, '点1')).toHaveCount(0);
}

export async function shortcutToolFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await point(page);
  const before = await savePart(page, info, 'shortcut-tools-before.pcad', app);
  await openSettings(page);
  for (const [id, key] of [
    ['toolbar.shape.circle', 'F2'], ['toolbar.view.grid', 'F3'], ['toolbar.solidCreate.extrude', 'F4'],
    ['toolbar.sheetMetal.sheetBase', 'F7'], ['toolbar.drawing.note', 'F2'],
  ] as const) await assign(page, id, key);
  // The same chord in part-only and drawing-only commands is unambiguous.
  await expect(settings(page).getByRole('alert')).toHaveCount(0);
  await settings(page).getByRole('button', { name: '割当を適用', exact: true }).click();
  await closeSettings(page);

  await keyInViewport(page, 'F2');
  const popup = page.getByRole('dialog', { name: '円の中心', exact: true });
  await expect(popup).toBeVisible();
  const fields = popup.locator('input.pcad-field__input');
  await fields.first().fill('12+3');
  await fields.first().press('F1');
  const help = page.locator('.pcad-help');
  await expect(help.locator('.pcad-help__article')).toContainText('四角・多角形・長穴・円をかく');
  await help.getByRole('button', { name: uiMessage('help', 'help.close'), exact: true }).click();
  await expect(fields.first()).toHaveValue('12+3');
  await popup.getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('.pcad-toolbar').getByRole('button', { name: '選択', exact: true }).click();
  await chooseToolMenuItem(page, '作図', '円');
  await expect(popup).toBeVisible();
  await expect(fields.first()).toHaveValue('0');
  await popup.getByRole('button', { name: '取消', exact: true }).click();

  const grid = page.locator('[data-command-id="toolbar.view.grid"]');
  const previousGrid = await grid.getAttribute('aria-pressed');
  await keyInViewport(page, 'F3'); await expect(grid).toHaveAttribute('aria-pressed', previousGrid === 'true' ? 'false' : 'true');
  await grid.click(); await expect(grid).toHaveAttribute('aria-pressed', previousGrid ?? 'false');
  await keyInViewport(page, 'F4');
  await expect(page.locator('.pcad-popover')).toHaveCount(0);
  await page.locator('.pcad-toolbar').getByRole('button', { name: '選択', exact: true }).click();
  await keyInViewport(page, 'F7');
  const sheet = page.getByRole('form', { name: uiMessage('sheetMetal', 'sheetMetal.base'), exact: true });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: uiMessage('sheetMetal', 'sheetMetal.cancel'), exact: true }).click();
  expect(await savePart(page, info, 'shortcut-tools-after.pcad', app)).toEqual(before);
  await keyInViewport(page, 'Control+z'); await expect(tree(page, '点1')).toHaveCount(0);
}
