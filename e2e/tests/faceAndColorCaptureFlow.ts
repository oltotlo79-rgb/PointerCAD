/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForRecompute } from './recompute.js';
import { waitForStartupHealth } from './startupHealth.js';
import { drawRectangle, propertyPanel, treeRow } from './sketchDrawCaptureSupport.js';

/**
 * 「面を張る・色を変える」章の1枚(`packages/help-content/docs/ja/face-and-color.md`)。
 *
 * face-and-color-swatches: 矩形を選んで面を張り、その面を選んだ状態のプロパティ。
 * 「色」の見本8つ(§色を変える)と、「境界」の並び(§何を囲んでいるかを見る)が見える。
 */
export async function faceAndColorCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await treeRow(page, '矩形1').click();
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '面', exact: true }).click();
  await page.locator('canvas.pcad-viewport__canvas').press('Enter');
  await expect(treeRow(page, '面1')).toBeVisible();

  await treeRow(page, '面1').click();
  const colorSection = propertyPanel(page).locator('.pcad-swatches[role="group"]');
  await expect(colorSection).toBeVisible();
  await waitForRecompute(page);
  await captureManualDetail(page, info, {
    name: 'face-and-color-swatches', dialog: propertyPanel(page),
    fixture: { selected: '面1' }, script: new URL(import.meta.url),
  });
}
