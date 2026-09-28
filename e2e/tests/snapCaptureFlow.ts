/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { waitForStartupHealth } from './startupHealth.js';
import { captureManualDetail } from './captureManualDetail.js';
import { openSnapKindsMenu } from './sketchDrawCaptureSupport.js';

/**
 * 「点にぴったり合わせる(吸着)」章の1枚(`packages/help-content/docs/ja/snap.md`)。
 *
 * snap-kinds-menu: 「吸着」の畳んだ一覧を開いた画面。点に合わせる5つ(端点・交点・中点・
 * 中心・方眼)と、向きをそろえる4つ(角度・延長線・垂線・平行線)、角度の刻みが見える
 * (§合わせられる場所)。既定でどれも入になっている(青い下地)。
 */
export async function snapCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  const panel = await openSnapKindsMenu(page);
  await captureManualDetail(page, info, {
    name: 'snap-kinds-menu', dialog: panel,
    fixture: { snapEnabled: true }, script: new URL(import.meta.url),
  });
}
