/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import {
  chooseEditTool, commitPopover, drawRectangle, fillFields, pickInPopover, popover, popoverTitle, treeRow,
} from './sketchDrawCaptureSupport.js';

/**
 * 「ミラー・複写・並べる」章の2枚(`packages/help-content/docs/ja/copy-array.md`)。
 *
 * 1) copy-array-mirror: 矩形を選び「ミラー」を開いた画面。「鏡にするもの」の3択が見える
 *    (§ミラー(左右対称に折り返す))。
 * 2) copy-array-linear-count: 「直線配列」の1段目(向き・間隔)を決めた後、
 *    個数を入れる画面(既定3、§直線配列(まっすぐ並べる))。
 */
export async function copyArrayCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await drawRectangle(page, ['10', '0'], ['50', '30']);
  await treeRow(page, '矩形1').click();

  // 1) ミラー。「鏡にするもの」の3択が見える画面。
  await chooseEditTool(page, 'ミラー');
  await expect(popoverTitle(page)).toHaveText('ミラー');
  await captureManualDetail(page, info, {
    name: 'copy-array-mirror', dialog: popover(page),
    fixture: { target: '矩形1' }, script: new URL(import.meta.url),
  });
  await pickInPopover(page, '作図面の縦軸');
  await commitPopover(page);
  await expect(treeRow(page, '複製1')).toBeVisible();

  // 2) 直線配列。1段目(向き90・間隔40)を決めた後、個数(既定3)を入れる画面。
  await treeRow(page, '矩形1').click();
  await chooseEditTool(page, '直線配列');
  await expect(popoverTitle(page)).toHaveText('直線配列(向きと間隔)');
  await fillFields(page, ['90', '40']);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('直線配列(個数)');
  await expect(popover(page).locator('input.pcad-field__input').first()).toHaveValue('3');
  await captureManualDetail(page, info, {
    name: 'copy-array-linear-count', dialog: popover(page),
    fixture: { target: '矩形1', direction: 90, spacingMm: 40, defaultCount: 3 }, script: new URL(import.meta.url),
  });
  await commitPopover(page);
  await expect(treeRow(page, '複製2')).toBeVisible();
}
