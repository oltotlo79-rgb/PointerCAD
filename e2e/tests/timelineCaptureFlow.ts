/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { openToolMenu } from './assemblyTestSupport.js';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import { commitPopover, popoverTitle } from './solidCaptureSupport.js';
import { waitForRecompute } from './recompute.js';
import {
  closePopoverIfOpen, menuTool, placeAndSelectBox, rollbackBanner, solidRowBox, timelineStop,
} from './measurementCaptureSupport.js';

/** もう1つ、既定の20×20×20の箱を原点へ置く(`placeAndSelectBox` と違い選び直さない)。 */
async function placeAnotherBox(page: Page): Promise<void> {
  await openToolMenu(page, '作る');
  await menuTool(page, '作る', '箱').click();
  await expect(popoverTitle(page)).toHaveText('箱を置く');
  await commitPopover(page);
  await closePopoverIfOpen(page);
  await waitForRecompute(page);
}

/**
 * 「途中まで戻して確かめる(タイムライン)」章の2枚(`packages/help-content/docs/ja/timeline.md`)。
 *
 * 1) timeline-rollback-tree: 「箱1」のつまみへ戻した直後、「箱2」の行がうすく(ahead)なった
 *    モデルブラウザ(§つまみを動かす)。
 * 2) timeline-rollback-banner: 同じ状態で画面いちばん下に出る「途中まで戻しています」の帯
 *    (§戻しているあいだの目印)。
 */
export async function timelineCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await placeAndSelectBox(page); // 箱1
  await placeAnotherBox(page); // 箱2
  await expect(solidRowBox(page, '箱2')).toBeVisible();

  // つまみを「箱1」へ戻す。箱2はまだ木にあるが、つまみより後ろ(ahead)で薄く出る。
  await timelineStop(page, '箱1').click();
  await expect(rollbackBanner(page)).toHaveText('途中まで戻しています(1 件目 / 2 件)');
  await expect(solidRowBox(page, '箱2')).toHaveClass(/pcad-tree__row--ahead/);

  await captureManualDetail(page, info, {
    name: 'timeline-rollback-tree', dialog: solidRowBox(page, '箱2'),
    fixture: { rolledBackTo: '箱1', totalSteps: 2 }, script: new URL(import.meta.url),
  });

  await captureManualDetail(page, info, {
    name: 'timeline-rollback-banner', dialog: rollbackBanner(page),
    fixture: { rolledBackTo: '箱1', totalSteps: 2 }, script: new URL(import.meta.url),
  });
}
