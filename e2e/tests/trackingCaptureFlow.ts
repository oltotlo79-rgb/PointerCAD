/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { waitForStartupHealth } from './startupHealth.js';
import { captureManualDetail } from './captureManualDetail.js';
import { openSnapKindsMenu } from './sketchDrawCaptureSupport.js';

/**
 * 「向きをそろえる(直交・角度・延長線)」章の1枚(`packages/help-content/docs/ja/tracking.md`)。
 *
 * tracking-angle-step: 「吸着」の畳んだ一覧で、角度の刻みを90°に選び直した画面
 * (§角度の刻みを変える)。向きをそろえる4つ(角度・延長線・垂線・平行線)も同じ一覧に
 * 見える(§そろえられる向き)。
 */
export async function trackingCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  const panel = await openSnapKindsMenu(page);
  await panel.getByRole('button', { name: '90°', exact: true }).click();
  await expect(panel.getByRole('button', { name: '90°', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await captureManualDetail(page, info, {
    name: 'tracking-angle-step', dialog: panel,
    fixture: { angleStepDegrees: 90 }, script: new URL(import.meta.url),
  });
}
