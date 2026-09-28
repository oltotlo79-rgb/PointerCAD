/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import {
  cancelPopover, chooseSketchTool, commitPopover, fillFields, popover, popoverInputs, popoverTitle, useAbsolute,
} from './sketchDrawCaptureSupport.js';

/**
 * 「数値と式の入れ方」章の2枚(`packages/help-content/docs/ja/numeric-input.md`)。
 *
 * 1) numeric-input-expression: 式`10*√2`を入れ、下に計算結果`= 14.14213562373`が
 *    薄く出た画面(§正しく書けているかの見かた)。「絶対」「相対」「極」の3ボタンも見える
 *    (§位置の決め方)。
 * 2) numeric-input-error: `1/0`を入れ、欄が赤くなり理由が出た画面(§正しく書けているかの見かた)。
 */
export async function numericInputCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await chooseSketchTool(page, '線分');
  await expect(popoverTitle(page)).toHaveText('線分の始点');
  await fillFields(page, ['0', '0', '0']);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('線分の終点');
  await useAbsolute(page);

  // 1) 式`10*√2`を入れた状態(下に計算結果が出る)。
  await popoverInputs(page).first().fill('10*√2');
  await expect(popover(page).locator('.pcad-field__message').first()).toHaveText(/^= 14\.1421356/);
  await captureManualDetail(page, info, {
    name: 'numeric-input-expression', dialog: popover(page),
    fixture: { expression: '10*√2', expected: 10 * Math.SQRT2 }, script: new URL(import.meta.url),
  });

  // 2) `1/0`を入れると欄が赤くなり、理由が出る。
  await popoverInputs(page).first().fill('1/0');
  await expect(popover(page)).toContainText('0 で割ることはできません。');
  await captureManualDetail(page, info, {
    name: 'numeric-input-error', dialog: popover(page),
    fixture: { expression: '1/0' }, script: new URL(import.meta.url),
  });
  await cancelPopover(page);
}
