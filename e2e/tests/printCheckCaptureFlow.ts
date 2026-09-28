/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import { KERNEL_TIMEOUT_MS } from './recompute.js';
import { menuTool, placeAndSelectBox, propertySection } from './measurementCaptureSupport.js';
import { openToolMenu } from './assemblyTestSupport.js';

/**
 * 「3D プリントの前に点検する」章の1枚(`packages/help-content/docs/ja/print-check.md`)。
 *
 * print-check-result: 立体を選んで「見た目」→「3D プリントの点検」を押した後の、
 * 右のプロパティ「3D プリントの点検」の節(既定の20×20×20の箱は薄すぎるところ・
 * せり出し・閉じていない箇所のいずれも無いので、そのまま出る結果を撮る)。
 */
export async function printCheckCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await placeAndSelectBox(page);

  const section = propertySection(page, '3D プリントの点検');
  await expect(section).toContainText('まだ点検していません。');

  await openToolMenu(page, '見た目');
  await menuTool(page, '見た目', '3D プリントの点検').click();
  await expect(section).not.toContainText('まだ点検していません。', { timeout: KERNEL_TIMEOUT_MS });
  await expect(section).toContainText('閉じています');

  await captureManualDetail(page, info, {
    name: 'print-check-result', dialog: section,
    fixture: { body: '箱1', watertight: true }, script: new URL(import.meta.url),
  });
}
