import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { command, tree } from './sheetUiFlow.js';
import { savePart } from './scriptsFlow.js';
import { waitForStartupHealth } from './startupHealth.js';
import { uiMessage } from './uiMessages.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { beginRecompute, waitForRecompute, waitForSettledRecompute } from './recompute.js';
import { captureManualDetail } from './captureManualDetail.js';
import { expectSameCamera, observeControlsInput, rememberCamera } from './cameraControlsSettingsFlow.js';
import { closeInputBindings, inputBindingsWindow, openInputBindings } from './inputBindingsWindowSupport.js';

const settings = (page: Page) => page.getByRole('form', { name: 'キーの割当', exact: true });
/** 操作の割り当ての窓(B-06)のキーのタブを開く。 */
async function openSettings(page: Page): Promise<void> {
  if (await settings(page).isVisible()) return;
  await openInputBindings(page, 'keys');
  await expect(settings(page)).toBeVisible();
}
/** 表の行(操作)を選ぶ。 */
async function choose(page: Page, id: string): Promise<void> {
  const row = settings(page).locator(`[data-command-id="${id}"]`);
  await row.scrollIntoViewIfNeeded(); await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
}
async function assign(page: Page, id: string, key: string): Promise<void> {
  await choose(page, id);
  await settings(page).getByLabel('新しいキー', { exact: true }).press(key);
}
async function closeSettings(page: Page): Promise<void> {
  await closeInputBindings(page);
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
  // 窓は画面の中に収まり(A-21 と同じく、字の幅や行の高さの違いで画面の外へ伸びない)、中の操作はすべて窓の中へ送って届く。
  const windowBounds = await inputBindingsWindow(page).boundingBox(), viewport = page.viewportSize();
  if (windowBounds === null || viewport === null) throw new Error('キー設定の画面がありません。');
  expect(windowBounds.y).toBeGreaterThanOrEqual(0);
  expect(windowBounds.y + windowBounds.height).toBeLessThanOrEqual(viewport.height);
  for (const name of ['割当を適用', '全操作を元の割当へ戻す'] as const) {
    const control = settings(page).getByRole('button', { name, exact: true });
    await control.scrollIntoViewIfNeeded();
    const bounds = await control.boundingBox();
    if (bounds === null) throw new Error(`${name} がありません。`);
    expect(bounds.y).toBeGreaterThanOrEqual(windowBounds.y);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(windowBounds.y + windowBounds.height);
  }
  const settled = await waitForSettledRecompute(page);
  expect(settled.isComputing).toBe(false);
  expect(settled.lastOutcome).toBe('success');
  expect(settled.completedGeneration).toBe(settled.requestedGeneration);
  expect(settled.pendingWaiters).toBe(0);
  if (process.env.PCAD_MANUAL_CAPTURE === '1') {
    await captureManualDetail(page, info, { name: 'shortcut-settings', dialog: settings(page), fixture: before,
      script: new URL(import.meta.url) });
  }
  await closeSettings(page);
  await expect(page.getByRole('button', { name: '元に戻す', exact: true })).toHaveAttribute('title', '元に戻す (F2)');
  expect(await savePart(page, info, 'shortcut-after.pcad', app)).toEqual(before);
  await keyInViewport(page, 'F2'); await expect(tree(page, '点1')).toHaveCount(0);
  await keyInViewport(page, 'F3'); await expect(tree(page, '点1')).toBeVisible();
  await keyInViewport(page, 'Control+z'); await expect(tree(page, '点1')).toBeVisible();

  await page.reload();
  await waitForStartupHealth(page, info);
  await openSettings(page);
  await choose(page, 'history.undo');
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
    ['toolbar.view.home', 'F8'],
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
  await additionalHomeKey(page, info, app);
}

async function additionalHomeKey(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  // Restore the real model after the existing atomic Undo assertion above.
  const generation = await beginRecompute(page);
  await keyInViewport(page, 'Control+y'); await waitForRecompute(page, generation);
  await expect(tree(page, '点1')).toBeVisible();
  // F8 now replaces the default Home key of the home view command (an assignment overrides the command's default key).
  await keyInViewport(page, 'F8');
  const before = await rememberCamera(page, info, 'shortcut-home-default', app);
  const canvas = page.locator('canvas.pcad-viewport__canvas');
  const bounds = await canvas.boundingBox();
  if (bounds === null) throw new Error('Home shortcut viewport missing');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const observation = await observeControlsInput(page);
  try {
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(bounds.x + bounds.width / 2 + 48, bounds.y + bounds.height / 2 + 24, { steps: 6 });
    await page.mouse.up({ button: 'middle' });
    const rotated = await rememberCamera(page, info, 'shortcut-home-rotated', app);
    expect(rotated.view.position).not.toEqual(before.view.position);
    await keyInViewport(page, 'Home');
    const replaced = await rememberCamera(page, info, 'shortcut-home-replaced-default', app);
    expectSameCamera(replaced.view, rotated.view);
    await keyInViewport(page, 'Control+F8');
    const refused = await rememberCamera(page, info, 'shortcut-home-extra-ctrl', app);
    expectSameCamera(refused.view, rotated.view);
    await keyInViewport(page, 'F8');
    const restored = await rememberCamera(page, info, 'shortcut-home-added-key', app);
    expectSameCamera(restored.view, before.view);
    expect(restored.document.sketches).toEqual(before.document.sketches);
    expect(restored.document.solids).toEqual(before.document.solids);
    expect(restored.document.id).toBe(before.document.id);
    const events = await observation.evaluate(value => value.events);
    await info.attach('shortcut-home-added-key-native', { body: JSON.stringify(events), contentType: 'application/json' });
    expect(events.length).toBeGreaterThan(0); expect(events.every(event => event.isTrusted)).toBe(true);
    const added = events.filter(event => event.type === 'keydown' && event.key === 'F8' && !event.ctrl);
    expect(added).toHaveLength(1); expect(added[0]).toMatchObject({ alt: false, shift: false, ctrl: false, meta: false });
    expect(events.filter(event => event.type === 'keydown' && event.key === 'F8' && event.ctrl)).toHaveLength(1);
  } finally {
    await page.mouse.up({ button: 'middle' });
    await observation.evaluate(value => value.stop()); await observation.dispose();
  }
}
