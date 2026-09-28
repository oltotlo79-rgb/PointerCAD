/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import {
  chooseEditTool, chooseShapeTool, commitPopover, fillFields, popover, popoverTitle, treeRow,
} from './sketchDrawCaptureSupport.js';

/** 矩形を1つかく(対角の2点を相対で入れる。sketch-extended.spec.tsのdrawRectangleと同じ)。 */
async function drawRectangle(page: Page, corner1: readonly [string, string], corner2: readonly [string, string]): Promise<void> {
  await chooseShapeTool(page, '矩形');
  await expect(popoverTitle(page)).toHaveText('矩形の 1 つ目の角');
  await fillFields(page, [corner1[0], corner1[1]]);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('矩形の 2 つ目の角');
  await fillFields(page, [corner2[0], corner2[1]]);
  await commitPopover(page);
}

/**
 * 「オフセット・トリム・延長」章の1枚(`packages/help-content/docs/ja/edit-curves.md`)。
 *
 * edit-curves-offset: 矩形を選び「オフセット」を開いた画面。距離(既定5mm)・側・角の
 * 入力欄が見える(§オフセットで複製を作る)。
 */
export async function editCurvesCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await treeRow(page, '矩形1').click();
  await chooseEditTool(page, 'オフセット');
  await expect(popoverTitle(page)).toHaveText('オフセットの距離');
  await expect(popover(page).locator('input.pcad-field__input').first()).toHaveValue('5');
  await captureManualDetail(page, info, {
    name: 'edit-curves-offset', dialog: popover(page),
    fixture: { target: '矩形1', defaultDistanceMm: 5 }, script: new URL(import.meta.url),
  });
}
