import { expect, type Page, type TestInfo } from '@playwright/test';
import { openToolMenu, toolMenuPanel } from '../assemblyTestSupport.js';
import { drawRectangle, fillFields, makeFace, popover, popoverInputs, popoverTitle, propertyPanel, treeRow } from '../solidCaptureSupport.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from '../recompute.js';
import { waitForStartupHealth } from '../startupHealth.js';

async function expectVolume(page: Page, name: string, volume: number): Promise<void> {
  await treeRow(page, name).click();
  const value = propertyPanel(page).locator('dt.pcad-properties__key').filter({ hasText: /^体積$/u })
    .locator('xpath=following-sibling::dd[1]');
  await expect(value).toHaveAttribute('title', `${String(volume)} mm³`, { timeout: KERNEL_TIMEOUT_MS });
}

/** 2 枚を木で選び、同じ距離を一度だけ確定して両方の実体積を読む。 */
export async function extrudeMultipleFacesFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  await drawRectangle(page, ['0', '0'], ['20', '10']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await waitForRecompute(page);
  await drawRectangle(page, ['30', '0'], ['5', '10']);
  await makeFace(page, ['線分5', '線分6', '線分7', '線分8']);
  await waitForRecompute(page);
  await treeRow(page, '面2').click();
  await treeRow(page, '面1').click({ modifiers: ['Shift'] });
  await openToolMenu(page, '作る');
  await toolMenuPanel(page, '作る').getByRole('button', { name: '押し出し', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('押し出す');
  await expect(popover(page).getByRole('button', { name: '形を確かめる', exact: true })).toHaveCount(0);
  await fillFields(page, ['8']);
  await popoverInputs(page).first().press('Enter');
  await expect(popover(page)).toHaveCount(0, { timeout: KERNEL_TIMEOUT_MS });
  await expect(page.locator('.pcad-statusbar__text')).toContainText('押し出した面の数 2');
  const folder = page.locator('.pcad-panel--left .pcad-feature-folder');
  await expect(folder).toHaveCount(1);
  for (const name of ['押し出し1', '押し出し2']) {
    await expect(folder.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expectVolume(page, '押し出し1', 400);
  await expectVolume(page, '押し出し2', 1600);
  const undo = await beginRecompute(page);
  await page.keyboard.press('Control+z');
  await waitForRecompute(page, undo);
  await expect(folder).toHaveCount(0);
  await expect(treeRow(page, '押し出し1')).toHaveCount(0);
  await expect(treeRow(page, '押し出し2')).toHaveCount(0);
  await expect(treeRow(page, '面1')).toBeVisible();
  await expect(treeRow(page, '面2')).toBeVisible();
}
