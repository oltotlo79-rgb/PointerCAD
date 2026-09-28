/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { createOriginCoincidentMate, placeTwoBoxesCapture, selectComponent, startNewAssemblyCapture } from './assemblyCaptureSupport.js';

/**
 * 「分解した見せ方を作る」章の1枚(`packages/help-content/docs/ja/explode.md`)。
 *
 * 1) explode-dialog: 2つ目の部品を選んで「分解」を開き、既定の離す向き(Z)と距離(50mm)が
 *    入った画面(§離す向きと距離を入力し、Enterで分解ステップを作ります)。
 */
export async function explodeCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startNewAssemblyCapture(page);
  await placeTwoBoxesCapture(page);
  await createOriginCoincidentMate(page);
  await selectComponent(page, 1);

  await page.getByRole('group', { name: '組む' })
    .getByRole('button', { name: '分解図', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '分解ステップを作る' });
  await expect(dialog).toBeVisible();

  await captureManualDetail(page, info, {
    name: 'explode-dialog', dialog,
    fixture: { direction: 'z', distance: '50' }, script: new URL(import.meta.url),
  });
  await dialog.getByRole('button', { name: '取り消す', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
