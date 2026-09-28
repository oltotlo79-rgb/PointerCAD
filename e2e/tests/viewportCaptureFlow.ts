/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';

/**
 * 「画面を回す・動かす・拡大する」章の2枚(`packages/help-content/docs/ja/viewport.md`)。
 *
 * 1) viewport-cube: 起動直後の既定の向き(前・上・右が見える等角)を示す右上の向きの立方体
 *    (§最初の向き)。
 * 2) viewport-named-views: 「保存した視点」を開いた画面(§同じ視点へ戻る)。
 */
export async function viewportCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  // 1) 起動直後の向きの立方体(既定は前・上・右が見える等角)。
  const viewCube = page.locator('canvas.pcad-viewcube');
  await expect(viewCube).toBeVisible();
  await captureManualDetail(page, info, {
    name: 'viewport-cube', dialog: viewCube,
    fixture: { view: 'default-isometric' }, script: new URL(import.meta.url),
  });

  // 2) 「保存した視点」を開いた画面。
  const summary = page.locator('.pcad-named-views > summary');
  await summary.click();
  const namedViewsPanel = page.locator('.pcad-named-views .pcad-menu__panel[role="group"][aria-label="保存した視点"]');
  await expect(namedViewsPanel).toBeVisible();
  await captureManualDetail(page, info, {
    name: 'viewport-named-views', dialog: namedViewsPanel,
    fixture: { opened: true }, script: new URL(import.meta.url),
  });
}
