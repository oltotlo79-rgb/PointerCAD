/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import {
  cancelPopover, chooseShapeTool, commitPopover, fillFields, popover, popoverTitle, useAbsolute,
} from './sketchDrawCaptureSupport.js';

/**
 * 「なめらかな曲線をかく(スプライン)」章の2枚(`packages/help-content/docs/ja/spline.md`)。
 *
 * 1) spline-points: 4点を置き終え、次の点(5点目)を聞かれている画面。「点を置き終える」
 *    ボタンが見える(§かき方)。
 * 2) spline-finish: 「点の使い方」(通過点/制御点)と「閉じる」を選ぶ画面(§点の使い方・閉じる)。
 */
export async function splineCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await chooseShapeTool(page, 'スプライン');
  await expect(popoverTitle(page)).toHaveText('曲線の点');
  const points: readonly (readonly [string, string])[] = [['0', '-40'], ['20', '-20'], ['40', '-40'], ['60', '-20']];
  for (const [index, point] of points.entries()) {
    if (index > 0) await useAbsolute(page);
    await fillFields(page, [point[0], point[1], '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('曲線の点');
  }

  // 1) 4点を置き終え、5点目を聞かれている画面(まだ点を置き終える前)。
  await captureManualDetail(page, info, {
    name: 'spline-points', dialog: popover(page),
    fixture: { points }, script: new URL(import.meta.url),
  });
  await popover(page).getByRole('button', { name: '点を置き終える', exact: true }).click();

  // 2) 「点の使い方」と「閉じる」を選ぶ画面。
  await expect(popoverTitle(page)).toHaveText('曲線の決め方');
  await captureManualDetail(page, info, {
    name: 'spline-finish', dialog: popover(page),
    fixture: { pointCount: points.length }, script: new URL(import.meta.url),
  });
  await commitPopover(page);
  await cancelPopover(page);
}
