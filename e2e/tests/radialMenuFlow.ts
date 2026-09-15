import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { command, tree } from './sheetUiFlow.js';
import { savePart } from './scriptsFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { captureManualDetail } from './captureManualDetail.js';
import { uiMessage } from './uiMessages.js';

const menu = (page: Page) => page.getByRole('menu', { name: uiMessage('commands', 'radial.title'), exact: true });
async function centre(locator: Locator): Promise<{ readonly x: number; readonly y: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('操作する画面が表示されていません。');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function select(page: Page): Promise<void> {
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '選択', exact: true }).click();
}
async function open(page: Page, position?: { readonly x: number; readonly y: number }): Promise<void> {
  const point = position ?? await centre(page.locator('canvas.pcad-viewport__canvas'));
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole('menuitem')).toHaveCount(8);
}
export async function radialMenuFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const generation = await beginRecompute(page);
  await command(page, 'PO'); await command(page, '12,34'); await page.keyboard.press('Escape');
  await waitForRecompute(page, generation); await select(page);
  const before = await savePart(page, info, 'radial-before.pcad', app);
  await open(page);
  await captureManualDetail(page, info, { name: 'radial-menu', dialog: menu(page), fixture: before, script: new URL(import.meta.url) });
  await menu(page).getByRole('button', { name: uiMessage('commands', 'radial.cancel'), exact: true }).click();
  await expect(menu(page)).toHaveCount(0);
  expect(await savePart(page, info, 'radial-cancel.pcad', app)).toEqual(before);

  // A held right gesture goes through the same circle input, then one ordinary Undo restores the file.
  const start = await centre(page.locator('canvas.pcad-viewport__canvas'));
  await page.mouse.move(start.x, start.y); await page.mouse.down({ button: 'right' });
  await expect(menu(page)).toBeVisible();
  const circle = await centre(menu(page).locator('[data-command-id="toolbar.shape.circle"]'));
  await page.mouse.move(circle.x, circle.y); await page.mouse.up({ button: 'right' });
  await expect(menu(page)).toHaveCount(0);
  const popup = page.locator('.pcad-popover'), title = page.locator('.pcad-popover__title');
  await expect(title).toHaveText('円の中心');
  const fields = popup.locator('input.pcad-field__input');
  for (const [index, value] of ['-20', '0', '0'].entries()) await fields.nth(index).fill(value);
  await fields.first().press('Enter'); await expect(title).toHaveText('円の半径');
  await fields.first().fill('15');
  const created = await beginRecompute(page);
  await fields.first().press('Enter');
  if (await popup.isVisible()) await popup.locator('input').first().press('Escape');
  await waitForRecompute(page, created); await expect(tree(page, '円弧1')).toBeVisible();
  expect(await savePart(page, info, 'radial-circle.pcad', app)).not.toEqual(before);
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z');
  await expect(tree(page, '円弧1')).toHaveCount(0);
  expect(await savePart(page, info, 'radial-undo.pcad', app)).toEqual(before);
  await select(page);

  // The moved centre and cancellation stay inside the viewport at its edge.
  const bounds = await page.locator('canvas.pcad-viewport__canvas').boundingBox();
  if (bounds === null) throw new Error('作図画面がありません。');
  await open(page, { x: bounds.x + 3, y: bounds.y + 3 });
  const shown = await menu(page).boundingBox();
  if (shown === null) throw new Error('道具の一覧がありません。');
  expect(shown.x).toBeGreaterThanOrEqual(bounds.x); expect(shown.y).toBeGreaterThanOrEqual(bounds.y);
  expect(shown.x + shown.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
  expect(shown.y + shown.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
  await page.keyboard.press('Escape'); await expect(menu(page)).toHaveCount(0);

  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByRole('group', { name: '拡大率', exact: true }).getByRole('button', { name: '150%', exact: true }).click();
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await open(page);
  const scaled = await menu(page).boundingBox();
  expect(scaled?.width).toBeCloseTo(456, 0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByRole('group', { name: '拡大率', exact: true }).getByRole('button', { name: '100%', exact: true }).click();
  await page.getByRole('button', { name: '設定', exact: true }).click();

  await open(page);
  await expect(menu(page).getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(menu(page).locator('#pcad-radial-hint')).toContainText(uiMessage('toolbar', 'toolbar.tool.lineTooltip'));
  await page.keyboard.press('Enter');
  await expect(title).toHaveText('線分の始点'); await fields.first().press('Escape'); await select(page);
  await open(page);
  await menu(page).locator('[data-command-id="toolbar.shape.circle"]').focus();
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('円');
  await expect(menu(page)).toHaveCount(0);
  await page.locator('.pcad-help').getByRole('button', { name: uiMessage('help', 'help.close'), exact: true }).click();
  expect(await savePart(page, info, 'radial-help.pcad', app)).toEqual(before);
}
