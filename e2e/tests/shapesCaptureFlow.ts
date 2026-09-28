/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import {
  cancelPopover, chooseShapeTool, commitPopover, fillFields, popover, popoverTitle,
} from './sketchDrawCaptureSupport.js';

/**
 * 「四角・多角形・長穴・円をかく」章の2枚(`packages/help-content/docs/ja/shapes.md`)。
 *
 * 1) shapes-circle: 「円」の中心を決めた後、半径を入れる画面(既定10mm、§円をかく)。
 * 2) shapes-polygon: 「正多角形」の中心を決めた後、辺数・半径・半径の測り方を入れる画面
 *    (§正多角形をかく)。
 */
export async function shapesCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  // 1) 円。中心(0,0)、半径は既定の10。
  await chooseShapeTool(page, '円');
  await expect(popoverTitle(page)).toHaveText('円の中心');
  await fillFields(page, ['0', '0']);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('円の半径');
  await expect(popover(page).locator('input.pcad-field__input').first()).toHaveValue('10');
  await captureManualDetail(page, info, {
    name: 'shapes-circle', dialog: popover(page),
    fixture: { center: [0, 0], defaultRadiusMm: 10 }, script: new URL(import.meta.url),
  });
  await cancelPopover(page);

  // 2) 正多角形。中心(0,0)、既定は六角形。
  await chooseShapeTool(page, '正多角形');
  await expect(popoverTitle(page)).toHaveText('正多角形の中心');
  await fillFields(page, ['0', '0']);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('正多角形の形');
  await captureManualDetail(page, info, {
    name: 'shapes-polygon', dialog: popover(page),
    fixture: { center: [0, 0] }, script: new URL(import.meta.url),
  });
  await cancelPopover(page);
}
