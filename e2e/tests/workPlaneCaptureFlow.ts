/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import { openPlaneMenu, planeBadge } from './workPlaneCaptureSupport.js';

/**
 * 「作図面を選ぶ」章の1枚(`packages/help-content/docs/ja/work-plane.md`)。
 *
 * work-plane-menu: 「作図面」の一覧を開いた状態(既定のXYが選ばれている札、
 * 一覧に並ぶXY・XZ・YZ、その下の「3D」、作業平面の作り方・基準の道具まで見える)。
 */
export async function workPlaneCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  await expect(planeBadge(page)).toContainText('XY');

  const panel = await openPlaneMenu(page);
  await captureManualDetail(page, info, {
    name: 'work-plane-menu', dialog: panel,
    fixture: { currentPlane: 'xy' }, script: new URL(import.meta.url),
  });
}
