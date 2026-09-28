/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import { propertyPanel, treeRow } from './solidCaptureSupport.js';

/**
 * 「球・箱・円柱・円錐・トーラスを置く」章の2枚(`packages/help-content/docs/ja/primitive.md`)。
 *
 * 1) primitive-menu: 「作る」を開いた一覧の下段、球・箱・円柱・円錐・トーラスが並ぶ様子(§置き方)。
 * 2) primitive-properties: 箱を置いた後のプロパティ(基本形状・向き・中心の3つ、§あとから直す)。
 */
export async function primitiveCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  // 1) 「作る」の一覧を開き、下段の5つの基本形状を撮る。
  await openToolMenu(page, '作る');
  const menu = toolMenuPanel(page, '作る');
  for (const shape of ['球', '箱', '円柱', '円錐', 'トーラス']) {
    await expect(menu.getByRole('button', { name: shape, exact: true })).toBeVisible();
  }
  await captureManualDetail(page, info, {
    name: 'primitive-menu', dialog: menu,
    fixture: { shapes: ['球', '箱', '円柱', '円錐', 'トーラス'] }, script: new URL(import.meta.url),
  });

  // 2) 箱を既定(20×20×20mm)のまま置き、プロパティの3つの並びを撮る。
  await menu.getByRole('button', { name: '箱', exact: true }).click();
  await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter');
  // 既定値のままのEnterで閉じない実装もあるため、残っていたらEscで閉じる
  // (`e2e/tests/drawingManufacturingFixture.ts` のcreateBoxと同じ確認)。
  if (await page.locator('.pcad-popover').count() > 0) await page.locator('.pcad-popover input').first().press('Escape');
  await expect(page.locator('.pcad-popover')).toHaveCount(0);
  await expect(treeRow(page, '箱1')).toBeVisible();
  await treeRow(page, '箱1').click();
  await expect(propertyPanel(page)).toContainText('基本形状');
  await captureManualDetail(page, info, {
    name: 'primitive-properties', dialog: propertyPanel(page),
    fixture: { shape: 'box', size: [20, 20, 20] }, script: new URL(import.meta.url),
  });
}
